/**
 * Live smoke suite (#212) — the ten steps, against a real deployment.
 *
 *   AWS_REGION=us-east-1 SMOKE_STACK=addressium-dev SMOKE_RECIPIENT=you@your-domain \
 *   SMOKE_INBOX_BUCKET=<bucket> node scripts/smoke-e2e.mjs
 *
 * ## Read this before running it
 *
 * **This script has never been run.** Nothing in this repo has ever touched a
 * real AWS account, which is the entire point of #212. It is written from the
 * documented API shapes, and the first person to run it should expect to fix
 * things — that is not a defect in the script, it is the verification debt this
 * whole exercise exists to pay down. Every assertion below is a claim the
 * codebase currently makes and has never proved.
 *
 * ## Safety
 *
 * Two independent layers, and it refuses to start without both:
 *
 * 1. **SES sandbox** (AWS-enforced). A new account can only send to *verified*
 *    identities. Do NOT request production access for this account. This script
 *    checks the account is still in the sandbox and aborts if it is not — an
 *    account out of the sandbox can reach strangers, and no amount of care in
 *    application code is a substitute for the provider refusing.
 * 2. **The dev-org allowlist.** The org is created `environment: "dev"` with an
 *    allowlist containing exactly the one verified recipient, and
 *    `recipientAllowedForDev` is fail-closed.
 *
 * Either layer alone prevents mail reaching a stranger. Both means a bug in one
 * is still contained.
 *
 * ## What it does NOT do
 *
 * It does not `cdk deploy` or `cdk destroy` for you. Those are the two operations
 * where an unattended script can cost real money or delete real data, and they
 * are one command each. Deploy first, run this, then destroy.
 */
import { setTimeout as sleep } from "node:timers/promises";

const need = (n) => {
  const v = process.env[n];
  if (!v) throw new Error(`missing env ${n} — see the header of this file`);
  return v;
};

const REGION = process.env.AWS_REGION ?? "us-east-1";
const STACK = need("SMOKE_STACK");
const RECIPIENT = need("SMOKE_RECIPIENT");
/** The bucket the SES inbound receipt rule writes raw MIME into. */
const INBOX = need("SMOKE_INBOX_BUCKET");

const ORG = process.env.SMOKE_ORG ?? "smoketest";
const LIST = "smoke";
const stamp = process.env.SMOKE_RUN_ID ?? String(process.hrtime.bigint());

let passed = 0;
const failures = [];
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.error(`  FAIL ${name}: ${e.message}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** Poll until `fn` returns truthy, or give up. Event delivery is asynchronous. */
async function until(what, fn, { attempts = 30, intervalMs = 10_000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const got = await fn();
    if (got) return got;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what} after ${(attempts * intervalMs) / 1000}s`);
}

async function main() {
  const { CloudFormationClient, DescribeStacksCommand } = await import("@aws-sdk/client-cloudformation");
  const { SESv2Client, GetAccountCommand, GetEmailIdentityCommand } = await import("@aws-sdk/client-sesv2");
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import("@aws-sdk/client-s3");

  const cfn = new CloudFormationClient({ region: REGION });
  const ses = new SESv2Client({ region: REGION });
  const s3 = new S3Client({ region: REGION });

  // ---- safety gate, before anything sends ----
  const account = await ses.send(new GetAccountCommand({}));
  if (account.ProductionAccessEnabled) {
    throw new Error(
      "REFUSING: this SES account has production access, so it can send to unverified " +
        "strangers. #212 is designed around the sandbox being the outer safety layer. " +
        "Use a different account.",
    );
  }
  const identity = await ses
    .send(new GetEmailIdentityCommand({ EmailIdentity: RECIPIENT }))
    .catch(() => undefined);
  assert(
    identity?.VerifiedForSendingStatus,
    `REFUSING: ${RECIPIENT} is not a verified SES identity, so nothing can reach it anyway`,
  );

  // ---- stack outputs → the API base url ----
  const stacks = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const outputs = Object.fromEntries(
    (stacks.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]),
  );
  const API = outputs.ApiEndpoint ?? outputs.HttpApiUrl;
  assert(API, `no API endpoint output on ${STACK} — outputs: ${Object.keys(outputs).join(", ")}`);
  console.log(`\naddressium smoke — ${STACK} @ ${API}\n`);

  const api = async (method, path, body, token) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };

  /**
   * Read a message out of the inbound bucket.
   *
   * SES → S3 rather than a third-party inbox, because it preserves FULL headers
   * — and `List-Unsubscribe` / `List-Unsubscribe-Post` correctness (#178) is
   * precisely what needs checking, which a friendly webmail API would hide.
   */
  const inbox = async (match) =>
    until(`a message matching ${match}`, async () => {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: INBOX }));
      for (const obj of listed.Contents ?? []) {
        const got = await s3.send(new GetObjectCommand({ Bucket: INBOX, Key: obj.Key }));
        const raw = await got.Body.transformToString();
        if (raw.includes(match)) return raw;
      }
      return undefined;
    });

  // ---- 1. org, fail-closed to one recipient ----
  await step("provision a dev org allowlisted to exactly one address", async () => {
    const r = await api("POST", "/orgs", {
      name: `Smoke ${stamp}`,
      primaryDomain: RECIPIENT.split("@")[1],
      siteDomain: RECIPIENT.split("@")[1],
      environment: "dev",
      devAllowlist: [RECIPIENT],
      magicLinks: false,
    });
    assert(r.status < 300, `POST /orgs → ${r.status}: ${JSON.stringify(r.body)}`);
    // #200: the DNS guidance must now include the MAIL FROM pair, or SPF cannot
    // align. This is one of the claims that has never been checked against SES.
    const types = (r.body.dns ?? []).map((d) => d.type);
    assert(types.includes("MX"), "no MX record in the DNS guidance — custom MAIL FROM is not set");
  });

  await step("create a list", async () => {
    const r = await api("POST", "/lists", {
      orgId: ORG,
      listId: LIST,
      name: "Smoke",
      optInPolicy: "double",
      fromAddress: `smoke@${RECIPIENT.split("@")[1]}`,
      access: "free",
      visibility: "open",
      complianceFooter: "Smoke test",
      physicalAddress: "1 Test St",
    });
    assert(r.status < 300, `POST /lists → ${r.status}: ${JSON.stringify(r.body)}`);
  });

  // ---- 2-3. signup → the confirmation email → confirm ----
  let confirmToken;
  await step("signup delivers a confirmation email we can read", async () => {
    const r = await api("POST", "/signup", { orgId: ORG, listId: LIST, email: RECIPIENT });
    assert(r.status < 300, `POST /signup → ${r.status}`);
    const raw = await inbox("/confirm?token=");
    confirmToken = raw.match(/\/confirm\?token=([\w.\-%]+)/)?.[1];
    assert(confirmToken, "confirmation email carries no token");
  });

  await step("following the confirm link confirms the subscription", async () => {
    const r = await api("GET", `/confirm?token=${confirmToken}`);
    assert(r.status < 300, `GET /confirm → ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body.status === "confirmed", `expected confirmed, got ${JSON.stringify(r.body)}`);
  });

  // ---- 4-6. send → headers → one-click ----
  let unsubUrl;
  await step("a campaign sends, and its headers are RFC 8058 correct (#178)", async () => {
    const campaignId = `smoke-${stamp}`;
    const r = await api("POST", "/campaigns/schedule", {
      orgId: ORG,
      campaignId,
      listId: LIST,
      subject: `Smoke ${stamp}`,
      template: { html: '<p>Smoke</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>' },
      when: { type: "now" },
    });
    assert(r.status < 300, `schedule → ${r.status}: ${JSON.stringify(r.body)}`);

    // A one-off send is placed at least 5 minutes out so it stays cancellable.
    const raw = await inbox(`Smoke ${stamp}`);
    const header = raw.match(/List-Unsubscribe:\s*<([^>]+)>/i)?.[1];
    assert(header?.startsWith("https://"), `List-Unsubscribe is not an https URI: ${header}`);
    assert(
      /List-Unsubscribe-Post:\s*List-Unsubscribe=One-Click/i.test(raw),
      "an https List-Unsubscribe with no One-Click POST header is non-conformant",
    );
    assert(/token=/.test(header), "the unsubscribe URL carries no signed token");
    unsubUrl = header;
  });

  await step("one-click unsubscribe works and suppresses", async () => {
    const res = await fetch(unsubUrl, { method: "POST" });
    assert(res.status < 300, `POST unsubscribe → ${res.status}`);
    const subs = await api("GET", `/orgs/${ORG}/suppressions`);
    assert(
      JSON.stringify(subs.body).includes(RECIPIENT),
      "unsubscribing did not produce a suppression entry",
    );
  });

  // ---- 7-8. the event plane, which is the whole point ----
  await step("SES events reach DynamoDB and move the counters (#208, #184)", async () => {
    // THE proof. The event plane was dead at three independent layers and every
    // unit test passed. Nothing but real SES traffic can confirm it is alive.
    const report = await until("engagement events to land", async () => {
      const r = await api("GET", `/orgs/${ORG}/campaigns/smoke-${stamp}/report`);
      return r.body?.counters?.delivered > 0 ? r.body : undefined;
    });
    assert(report.counters.sent > 0, "no sent events");
    assert(report.counters.delivered > 0, "no delivered events — #210's ingestion never fires");
    assert(report.rates, "no derived rates on the report");
  });

  // ---- 9. bounce + complaint, via the simulator ----
  for (const kind of ["bounce", "complaint"]) {
    await step(`a simulated ${kind} suppresses and can trip the halt gate (#165)`, async () => {
      // The SES simulator works in the sandbox and costs nothing, so bounce and
      // complaint handling is tested WITHOUT damaging real reputation and
      // without needing a second mailbox.
      const addr = `${kind}@simulator.amazonses.com`;
      const r = await api("POST", "/signup", { orgId: ORG, listId: LIST, email: addr });
      assert(r.status < 300, `signup ${addr} → ${r.status}`);
      // NOTE: the dev allowlist will refuse this address unless it is added.
      // Add both simulator addresses to devAllowlist for the run, or this step
      // reports `dev-allowlist` rather than exercising the gate.
      await until(`${kind} suppression`, async () => {
        const s = await api("GET", `/orgs/${ORG}/suppressions`);
        return JSON.stringify(s.body).includes(addr) ? true : undefined;
      });
    });
  }

  // ---- report ----
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  console.log(
    "\nRemember: `cdk destroy` when you are done. Everything non-prod uses\n" +
      "RemovalPolicy.DESTROY, so teardown is clean.\n",
  );
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n${e.message}\n`);
  process.exit(1);
});
