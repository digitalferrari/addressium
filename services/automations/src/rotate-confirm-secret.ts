/**
 * Secrets Manager rotation for `ConfirmSecret` (#234).
 *
 * ## Why this is not the usual rotation function
 *
 * The ordinary shape of a rotation is "generate a new credential, teach the
 * service about it, throw the old one away". Doing that here would be a
 * compliance failure, not a security improvement.
 *
 * `ConfirmSecret` signs two things that live in people's inboxes:
 *
 * - the **double opt-in** confirmation link, clicked days after signup, and
 * - the **RFC 8058 one-click unsubscribe** link, which is in *every message ever
 *   sent* and which the law requires to keep working.
 *
 * So a rotation that replaced the key would invalidate every outstanding link at
 * the instant it ran — including the unsubscribe link in a two-year-old archived
 * message. Attaching a `RotationSchedule` to a single-key secret would have been
 * actively worse than no rotation at all: it would break those links *on a
 * schedule*, quietly, forever.
 *
 * This function therefore **appends**. The secret holds a keyring; rotation puts
 * a fresh key at the front and keeps the rest. Signing uses the newest key,
 * verification accepts any key in the ring, and a key leaves the ring only when
 * an operator removes it deliberately — see `rotateKeyring` and
 * `docs/SECURITY.md` §4.6 for the retention reasoning.
 *
 * ## The four steps
 *
 * Secrets Manager drives rotation as four invocations against one `ClientRequestToken`:
 *
 * | Step | What it means here |
 * |---|---|
 * | `createSecret` | Build the new keyring and stage it as `AWSPENDING`. |
 * | `setSecret` | Nothing to do — there is no external system holding this credential. |
 * | `testSecret` | Prove the pending keyring parses, signs, and still verifies a token signed by the PREVIOUS key. |
 * | `finishSecret` | Move `AWSCURRENT` onto the pending version. |
 *
 * `testSecret` is the step that earns its keep: it is where "rotation did not
 * orphan the outstanding links" is actually checked, against the real staged
 * value, before anything is promoted.
 */
import { randomBytes } from "node:crypto";
import {
  HmacConfirmationSigner,
  parseKeyring,
  rotateKeyring,
  serializeKeyring,
} from "@addressium/domain";

export interface RotationEvent {
  SecretId: string;
  ClientRequestToken: string;
  Step: "createSecret" | "setSecret" | "testSecret" | "finishSecret";
}

/** 32 bytes of CSPRNG output, base64url — the same shape the bootstrap value has. */
export const newKeyMaterial = (): string => randomBytes(32).toString("base64url");

/**
 * Just enough of the Secrets Manager client to drive rotation.
 *
 * Injectable so the four-step protocol — and specifically the `testSecret`
 * guard, which is the only thing standing between a rotation and every
 * unsubscribe link in every inbox — is exercised in tests rather than discovered
 * against a live secret a year from now, on a schedule, at 3am.
 */
export interface SecretsClientLike {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown>;
}

export async function rotateConfirmSecretHandler(
  event: RotationEvent,
  injected?: SecretsClientLike,
): Promise<{ ok: true; step: string }> {
  const {
    SecretsManagerClient,
    GetSecretValueCommand,
    PutSecretValueCommand,
    UpdateSecretVersionStageCommand,
    DescribeSecretCommand,
  } = await import("@aws-sdk/client-secrets-manager");
  // Structural, not the SDK type: the fake in the tests implements exactly
  // this and nothing else.
  const client = (injected ?? new SecretsManagerClient({})) as { send(c: unknown): Promise<any> };
  const { SecretId, ClientRequestToken, Step } = event;

  const read = async (stage: "AWSCURRENT" | "AWSPENDING", versionId?: string): Promise<string> => {
    const res = await client.send(
      new GetSecretValueCommand({
        SecretId,
        VersionStage: stage,
        ...(versionId ? { VersionId: versionId } : {}),
      }),
    );
    return res.SecretString ?? "";
  };

  switch (Step) {
    case "createSecret": {
      // Idempotent: Secrets Manager retries steps, and a retry must not append a
      // SECOND key. If AWSPENDING already exists for this token, leave it.
      try {
        await read("AWSPENDING", ClientRequestToken);
        return { ok: true, step: Step };
      } catch {
        // No pending version yet — fall through and create one.
      }
      const current = parseKeyring(await read("AWSCURRENT"));
      const next = rotateKeyring(current, newKeyMaterial());
      if (next.length < current.length) {
        // Only reachable at the runaway guard in `rotateKeyring`. Loud, because
        // the dropped key may still be verifying links in live inboxes.
        console.warn("rotate-confirm-secret: keyring hit its size cap — a key was dropped", {
          before: current.length,
          after: next.length,
        });
      }
      await client.send(
        new PutSecretValueCommand({
          SecretId,
          ClientRequestToken,
          SecretString: serializeKeyring(next),
          VersionStages: ["AWSPENDING"],
        }),
      );
      return { ok: true, step: Step };
    }

    case "setSecret":
      // Nothing external holds this credential — it is verified in-process by
      // handlers that read the secret at cold start. There is no database user
      // to update and no third party to notify.
      return { ok: true, step: Step };

    case "testSecret": {
      const pending = new HmacConfirmationSigner(await read("AWSPENDING", ClientRequestToken));
      const claims = { orgId: "rotation-check", sub: "rotation-check", listId: "l", exp: 2 ** 31 - 1 };

      // 1. The new key signs and verifies.
      const fresh = pending.sign(claims);
      if (pending.verify(fresh).sub !== claims.sub) throw new Error("pending keyring cannot verify its own token");

      // 2. THE POINT OF ALL OF THIS: a token signed by the key that was current
      //    BEFORE this rotation must still verify afterwards. If it does not,
      //    promoting this version would break every unsubscribe link already in
      //    an inbox, so the rotation fails here instead.
      const previous = new HmacConfirmationSigner(await read("AWSCURRENT"));
      const old = previous.sign(claims);
      // The failure is caught and re-thrown with a message that says what is at
      // stake. A rotation failure surfaces to an operator as a notification, and
      // "retired key 90acf9a86740" does not tell them that promoting this
      // version would have broken every unsubscribe link in every inbox.
      let verified: string | undefined;
      try {
        verified = pending.verify(old).sub;
      } catch (e) {
        throw new Error(
          `pending keyring cannot verify tokens signed by the outgoing key — promoting it would ` +
            `invalidate every outstanding opt-in and unsubscribe link (${(e as Error).message})`,
        );
      }
      if (verified !== claims.sub) {
        throw new Error("pending keyring cannot verify tokens signed by the outgoing key");
      }
      if (pending.activeKid === previous.activeKid) {
        throw new Error("rotation produced no new key");
      }
      return { ok: true, step: Step };
    }

    case "finishSecret": {
      const meta = await client.send(new DescribeSecretCommand({ SecretId }));
      const currentVersionId = Object.entries(
        (meta.VersionIdsToStages ?? {}) as Record<string, string[]>,
      ).find(([, stages]) => (stages ?? []).includes("AWSCURRENT"))?.[0];
      if (currentVersionId === ClientRequestToken) return { ok: true, step: Step };
      await client.send(
        new UpdateSecretVersionStageCommand({
          SecretId,
          VersionStage: "AWSCURRENT",
          MoveToVersionId: ClientRequestToken,
          ...(currentVersionId ? { RemoveFromVersionId: currentVersionId } : {}),
        }),
      );
      return { ok: true, step: Step };
    }

    default:
      throw new Error(`unknown rotation step ${Step as string}`);
  }
}
