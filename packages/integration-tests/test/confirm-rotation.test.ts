/**
 * ConfirmSecret rotation (#234).
 *
 * The four-step Secrets Manager protocol, and above all the `testSecret` guard.
 * Rotation of THIS secret is unusual: it appends rather than replaces, because
 * the key signs the one-click unsubscribe link that sits in every message ever
 * sent and that the law requires to keep working. An ordinary rotation attached
 * to this secret would break those links on a schedule, quietly, forever — which
 * is why the rotation function exists at all rather than just a RotationSchedule.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HmacConfirmationSigner, parseKeyring, rotateKeyring, serializeKeyring } from "@addressium/domain";
import { rotateConfirmSecretHandler, newKeyMaterial } from "@addressium/svc-automations";

/** A Secrets Manager stand-in holding staged versions in memory. */
function fakeSecrets(initialCurrent: string) {
  const versions = new Map<string, string>([["v-current", initialCurrent]]);
  const stages = new Map<string, string[]>([["v-current", ["AWSCURRENT"]]]);
  const calls: string[] = [];
  const versionFor = (stage: string) =>
    [...stages.entries()].find(([, s]) => s.includes(stage))?.[0];
  return {
    versions,
    stages,
    calls,
    current: () => versions.get(versionFor("AWSCURRENT")!)!,
    async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
      const name = cmd.constructor.name;
      calls.push(name);
      const i = cmd.input;
      if (name === "GetSecretValueCommand") {
        const id = i.VersionId ?? versionFor(i.VersionStage ?? "AWSCURRENT");
        if (!id || !versions.has(id)) throw Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
        // A VersionId that exists but is not in the requested stage is a miss —
        // this is what makes createSecret's "already staged?" probe meaningful.
        if (i.VersionStage && !(stages.get(id) ?? []).includes(i.VersionStage)) {
          throw Object.assign(new Error("not staged"), { name: "ResourceNotFoundException" });
        }
        return { SecretString: versions.get(id) };
      }
      if (name === "PutSecretValueCommand") {
        versions.set(i.ClientRequestToken, i.SecretString);
        stages.set(i.ClientRequestToken, [...(i.VersionStages ?? [])]);
        return {};
      }
      if (name === "DescribeSecretCommand") {
        return { VersionIdsToStages: Object.fromEntries(stages) };
      }
      if (name === "UpdateSecretVersionStageCommand") {
        if (i.RemoveFromVersionId) {
          stages.set(i.RemoveFromVersionId, (stages.get(i.RemoveFromVersionId) ?? []).filter((s) => s !== i.VersionStage));
        }
        stages.set(i.MoveToVersionId, [...(stages.get(i.MoveToVersionId) ?? []), i.VersionStage]);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
}

const run = (secrets: ReturnType<typeof fakeSecrets>, Step: "createSecret" | "setSecret" | "testSecret" | "finishSecret") =>
  rotateConfirmSecretHandler({ SecretId: "arn:confirm", ClientRequestToken: "v-new", Step }, secrets);

const claims = { orgId: "o", sub: "s-1", listId: "l", exp: 2 ** 31 - 1 };

test("a full rotation leaves links from the OUTGOING key still working", async () => {
  const secrets = fakeSecrets("original-secret");
  const linkInAnInbox = new HmacConfirmationSigner(secrets.current()).sign(claims);

  for (const step of ["createSecret", "setSecret", "testSecret", "finishSecret"] as const) {
    await run(secrets, step);
  }

  const after = new HmacConfirmationSigner(secrets.current());
  assert.equal(after.verify(linkInAnInbox).sub, "s-1", "rotation orphaned a live unsubscribe link");
  assert.equal(after.acceptedKids.length, 2);
  // New links use the new key.
  assert.notEqual(after.activeKid, new HmacConfirmationSigner("original-secret").activeKid);
});

test("testSecret REFUSES a pending version that drops the outgoing key", async () => {
  // The guard, tested by staging exactly the thing it exists to stop: a
  // replacement rather than an append. Promoting this would invalidate every
  // outstanding opt-in and unsubscribe link at once.
  const secrets = fakeSecrets("original-secret");
  secrets.versions.set("v-new", serializeKeyring(parseKeyring("a-completely-new-secret")));
  secrets.stages.set("v-new", ["AWSPENDING"]);

  await assert.rejects(() => run(secrets, "testSecret"), /tokens signed by the outgoing key/);
});

test("testSecret refuses a pending version that rotated nothing", async () => {
  // A no-op rotation verifies old links perfectly well and is still wrong: the
  // schedule reports success while the key has not actually changed.
  const secrets = fakeSecrets("original-secret");
  secrets.versions.set("v-new", serializeKeyring(parseKeyring("original-secret")));
  secrets.stages.set("v-new", ["AWSPENDING"]);

  await assert.rejects(() => run(secrets, "testSecret"), /no new key/);
});

test("createSecret is idempotent — a retry does not append a SECOND key", async () => {
  // Secrets Manager retries steps. Two appends per rotation would double the
  // ring's growth and, worse, make "which key is current" depend on retry luck.
  const secrets = fakeSecrets("original-secret");
  await run(secrets, "createSecret");
  const first = secrets.versions.get("v-new");
  await run(secrets, "createSecret");
  assert.equal(secrets.versions.get("v-new"), first);
  assert.equal(parseKeyring(first!).length, 2);
});

test("finishSecret is idempotent once AWSCURRENT has moved", async () => {
  const secrets = fakeSecrets("original-secret");
  for (const step of ["createSecret", "setSecret", "testSecret", "finishSecret"] as const) await run(secrets, step);
  const before = secrets.current();
  await run(secrets, "finishSecret");
  assert.equal(secrets.current(), before);
});

test("rotating a keyring that has already rotated keeps every key", async () => {
  // Five rotations is what an unsubscribe token's five-year TTL implies at a
  // yearly cadence. Dropping any one of them breaks links still in inboxes.
  const secrets = fakeSecrets(serializeKeyring(rotateKeyring(parseKeyring("k1"), "k2")));
  const oldest = new HmacConfirmationSigner(parseKeyring("k1")).sign(claims);
  for (const step of ["createSecret", "setSecret", "testSecret", "finishSecret"] as const) await run(secrets, step);
  const after = new HmacConfirmationSigner(secrets.current());
  assert.equal(after.acceptedKids.length, 3);
  assert.equal(after.verify(oldest).sub, "s-1");
});

test("generated key material is high-entropy and distinct per call", async () => {
  const a = newKeyMaterial();
  const b = newKeyMaterial();
  assert.notEqual(a, b);
  // 32 bytes base64url — no padding, url-safe alphabet only.
  assert.equal(a.length, 43);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});
