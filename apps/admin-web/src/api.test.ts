/**
 * Admin API client (#98) — the methods added for the console screens must hit
 * the right method + path + body, since the screens depend on them.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, UnauthorizedError } from "./api.js";
import { login } from "./auth.js";

// `login()` navigates to the Cognito Hosted UI, which jsdom refuses. Everything
// else in auth.js stays real, so the token read/clear paths are the shipped ones.
vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  login: vi.fn(async () => undefined),
}));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
    text: async () => "",
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  vi.mocked(login).mockClear();
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), init: init as RequestInit };
}

test("campaigns() GETs the org campaign list", async () => {
  await api.campaigns("acme");
  const { url, init } = lastCall();
  expect(url).toMatch(/\/orgs\/acme\/campaigns$/);
  expect(init.method).toBe("GET");
});

test("subscribers() encodes the search query and carries the cursor (#182)", async () => {
  // The endpoint returns ONE page. It used to load every subscriber in the org
  // and filter by substring in Node, so typing in the search box was a
  // self-inflicted DoS on the tenant's own table.
  await api.subscribers("acme", "a b@x");
  expect(lastCall().url).toMatch(/\/orgs\/acme\/subscribers\?q=a\+b%40x$/);

  await api.subscribers("acme", undefined, "CURSOR+TOKEN==", 25);
  const url = lastCall().url;
  expect(url).toContain("cursor=CURSOR%2BTOKEN%3D%3D");
  expect(url).toContain("limit=25");
  expect(url).not.toContain("q=");
});

test("importCsv() POSTs listId + csv + dryRun", async () => {
  await api.importCsv("acme", "ledger", "email\nx@y.com", true);
  const { url, init } = lastCall();
  expect(url).toMatch(/\/orgs\/acme\/import$/);
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toMatchObject({ listId: "ledger", dryRun: true });
});

test("privacy() erase POSTs the action", async () => {
  await api.privacy("acme", "erase", "x@y.com");
  const { url, init } = lastCall();
  expect(url).toMatch(/\/privacy$/);
  expect(JSON.parse(init.body as string)).toMatchObject({ action: "erase", email: "x@y.com" });
});

test("sends the ID token as Bearer, not the access token (#161)", async () => {
  // Cognito access tokens never carry custom:* attributes, so sending one made
  // server-side RBAC 403 on every call.
  sessionStorage.setItem(
    "addressium.tokens",
    JSON.stringify({ idToken: "ID.TOKEN.VALUE", accessToken: "ACCESS.TOKEN.VALUE" }),
  );
  try {
    await api.campaigns("acme");
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ID.TOKEN.VALUE");
    expect(headers.authorization).not.toContain("ACCESS");
  } finally {
    sessionStorage.removeItem("addressium.tokens");
  }
});

test("a corrupt token blob does not throw — it self-heals", async () => {
  sessionStorage.setItem("addressium.tokens", "{not json");
  try {
    await expect(api.campaigns("acme")).resolves.toBeDefined();
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(sessionStorage.getItem("addressium.tokens")).toBeNull();
  } finally {
    sessionStorage.removeItem("addressium.tokens");
  }
});

test("a 401 drops the dead token and sends the operator back to Cognito (#197)", async () => {
  // The old behaviour: a generic Error into `.catch(() => undefined)`, so an
  // expired session showed empty panels and no way to notice why.
  sessionStorage.setItem("addressium.tokens", JSON.stringify({ idToken: "stale" }));
  fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized" });
  await expect(api.campaigns("acme")).rejects.toBeInstanceOf(UnauthorizedError);
  expect(sessionStorage.getItem("addressium.tokens")).toBeNull();
  expect(login).toHaveBeenCalledTimes(1);
});

test("a persistent 401 redirects ONCE, not in a loop (#197)", async () => {
  // Cognito's SSO cookie re-issues a token instantly, so a 401 with a non-expiry
  // cause (disabled operator, revoked client) would bounce forever on an
  // unguarded redirect — a blank screen that never settles.
  fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "Unauthorized" });
  await expect(api.campaigns("acme")).rejects.toBeInstanceOf(UnauthorizedError);
  await expect(api.lists("acme")).rejects.toBeInstanceOf(UnauthorizedError);
  await expect(api.segments("acme")).rejects.toBeInstanceOf(UnauthorizedError);
  expect(login).toHaveBeenCalledTimes(1);
});

test("a 403 is an RBAC verdict, not an expiry — no re-auth (#197)", async () => {
  // Re-authenticating returns the same claims and the same 403. Bouncing the
  // operator through the Hosted UI would only hide which capability they lack.
  sessionStorage.setItem("addressium.tokens", JSON.stringify({ idToken: "good" }));
  fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "forbidden" });
  await expect(api.team("acme")).rejects.toThrow(/403/);
  expect(login).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("addressium.tokens")).not.toBeNull();
});

test("a successful call re-arms the redirect for the next expiry (#197)", async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized" });
  await expect(api.campaigns("acme")).rejects.toBeInstanceOf(UnauthorizedError);
  // Signed back in.
  await api.campaigns("acme");
  fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized" });
  await expect(api.campaigns("acme")).rejects.toBeInstanceOf(UnauthorizedError);
  expect(login).toHaveBeenCalledTimes(2);
});

test("alertConfig() GETs the org's deliverability thresholds", async () => {
  await api.alertConfig("acme");
  const { url, init } = lastCall();
  expect(url).toMatch(/\/orgs\/acme\/alerts$/);
  expect(init.method).toBe("GET");
});

test("saveAlertConfig() POSTs the rules", async () => {
  await api.saveAlertConfig({
    orgId: "acme",
    snsTopicArn: "arn:aws:sns:us-east-1:1:ops",
    rules: [{ metric: "complaint_rate", warnAt: 0.003, haltAt: 0.005, enabled: true }],
    notifyTargets: [],
  });
  const { url, init } = lastCall();
  expect(url).toMatch(/\/orgs\/alerts$/);
  expect(init.method).toBe("POST");
  const body = JSON.parse(String(init.body));
  expect(body.orgId).toBe("acme");
  expect(body.rules[0].haltAt).toBe(0.005);
});

test("saveAlertConfig() omits an empty topic rather than sending a blank string", async () => {
  // A blank ARN would be stored and then used as a publish target. Absent means
  // "halt quietly", which is a real supported mode (#217).
  await api.saveAlertConfig({ orgId: "acme", rules: [], notifyTargets: [] });
  const body = JSON.parse(String(lastCall().init.body));
  expect(body.snsTopicArn).toBeUndefined();
});

test("importPreview() POSTs the csv and writes nothing", async () => {
  await api.importPreview("acme", "email\na@x.com", "implicit");
  const { url, init } = lastCall();
  expect(url).toMatch(/\/orgs\/acme\/import\/preview$/);
  expect(init.method).toBe("POST");
  const body = JSON.parse(String(init.body));
  expect(body.csv).toContain("a@x.com");
  expect(body.consentBasis).toBe("implicit");
});

test("importMapped() POSTs the operator-confirmed plan", async () => {
  await api.importMapped("acme", {
    csv: "Address\na@x.com",
    plan: { columns: { Address: { kind: "email" } } },
    sourceFile: "export.csv",
    dryRun: true,
  });
  const { url, init } = lastCall();
  expect(url).toMatch(/\/orgs\/acme\/import\/mapped$/);
  const body = JSON.parse(String(init.body));
  expect(body.plan.columns.Address.kind).toBe("email");
  expect(body.sourceFile).toBe("export.csv");
  expect(body.dryRun).toBe(true);
});

test("importMapped() carries newListDefaults when the plan creates a list", async () => {
  // A list with no footer or physical address is a CAN-SPAM violation, so these
  // are required rather than defaulted server-side (#216).
  await api.importMapped("acme", {
    csv: "Address,Ski\na@x.com,true",
    plan: {
      columns: {
        Address: { kind: "email" },
        Ski: { kind: "audience", list: { createNamed: "Ski" }, consentBasis: "implicit" },
      },
    },
    newListDefaults: { fromAddress: "n@x.com", complianceFooter: "f", physicalAddress: "p" },
  });
  const body = JSON.parse(String(lastCall().init.body));
  expect(body.newListDefaults.physicalAddress).toBe("p");
});

test("exportData() returns a presigned link, not the file (#224)", async () => {
  // The export streams to S3 and the response is a pointer: an API Gateway
  // response is capped at 6MB, so returning the file failed for exactly the org
  // large enough to want one. The CALL is still authorized — hence the header —
  // while the URL it hands back is pre-authorized and carries none.
  sessionStorage.setItem("addressium.tokens", JSON.stringify({ idToken: "id-token-abc" }));
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      format: "csv",
      bytes: 4096,
      url: "https://s3.example/exports/acme/x.csv?X-Amz-Signature=abc",
      expiresAt: "2026-07-28T12:05:00.000Z",
    }),
  });
  const link = await api.exportData("acme", "csv", true);
  const { url, init } = lastCall();
  expect(url).toMatch(/\/orgs\/acme\/export\?format=csv&includeUnsubscribed=true$/);
  expect((init.headers as Record<string, string>).authorization).toContain("id-token-abc");
  expect(link.url).toContain("X-Amz-Signature");
  // The expiry is surfaced because the URL is a bearer credential for the whole
  // subscriber base and cannot be revoked once handed out.
  expect(link.expiresAt).toBe("2026-07-28T12:05:00.000Z");
  sessionStorage.removeItem("addressium.tokens");
});

test("exportData() surfaces a failed export instead of downloading an error page", async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "forbidden" });
  await expect(api.exportData("acme", "jsonl", false)).rejects.toThrow(/403/);
});

test("team() GETs the deployment's members", async () => {
  await api.team("acme");
  const { url, init } = lastCall();
  expect(url).toMatch(/\/orgs\/acme\/team$/);
  expect(init.method).toBe("GET");
});

test("inviteMember() POSTs the grant", async () => {
  await api.inviteMember("acme", "new@x.com", "editor", ["acme"]);
  const body = JSON.parse(String(lastCall().init.body));
  expect(body.action).toBe("invite");
  expect(body.role).toBe("editor");
  expect(body.orgs).toEqual(["acme"]);
});

test("setMemberEnabled() maps the boolean to an explicit action", async () => {
  await api.setMemberEnabled("acme", "u1", false);
  expect(JSON.parse(String(lastCall().init.body)).action).toBe("disable");
  await api.setMemberEnabled("acme", "u1", true);
  expect(JSON.parse(String(lastCall().init.body)).action).toBe("enable");
});

test("health() GETs a single derived verdict, not alarm state", async () => {
  await api.health("acme");
  const { url, init } = lastCall();
  expect(url).toMatch(/\/orgs\/acme\/health$/);
  expect(init.method).toBe("GET");
  // The SPA holds no CloudWatch permission; composition happens server-side.
});

test("createOrg() POSTs the provisioning payload", async () => {
  await api.createOrg({
    name: "Northwind Times",
    primaryDomain: "mail.northwind.example",
    siteDomain: "www.northwind.example",
    magicLinks: true,
    subscriberPool: { poolId: "us-east-1_abc" },
    environment: "prod",
  });
  const { url, init } = lastCall();
  expect(url).toMatch(/\/orgs$/);
  expect(init.method).toBe("POST");
  const body = JSON.parse(String(init.body));
  // Magic links on requires a linked pool — the server refuses the pair
  // otherwise, so the form must send them together.
  expect(body.magicLinks).toBe(true);
  expect(body.subscriberPool.poolId).toBe("us-east-1_abc");
});

test("createOrg() omits subscriberPool when magic links are off", async () => {
  await api.createOrg({
    name: "Plain Sender",
    primaryDomain: "mail.plain.example",
    siteDomain: "www.plain.example",
    magicLinks: false,
    environment: "prod",
  });
  const body = JSON.parse(String(lastCall().init.body));
  expect(body.subscriberPool).toBeUndefined();
});

test("importBatches() lists runs; importBatch() asks for one run's rows", async () => {
  await api.importBatches("acme");
  expect(lastCall().url).toMatch(/\/orgs\/acme\/import\/batches$/);
  expect(lastCall().init.method).toBe("GET");

  await api.importBatch("acme", "imp_2026-07-28T00:00:00.000Z");
  // The id is a timestamp, so its colons must survive the round trip encoded —
  // an unescaped one would be read as a URL delimiter.
  expect(lastCall().url).toMatch(/batchId=imp_2026-07-28T00%3A00%3A00\.000Z$/);
});

test("saveList() posts every CAN-SPAM-required field (#130)", async () => {
  // `saveList` existed and was called by nothing — there was no way to create a
  // newsletter from the console at all. The footer and physical address are
  // legal requirements on every message the list sends, so the client must send
  // them rather than let the server default something plausible.
  await api.saveList({
    orgId: "acme",
    listId: "ledger",
    name: "The Ledger",
    optInPolicy: "double",
    fromAddress: "ledger@acme.example",
    access: "free",
    visibility: "open",
    complianceFooter: "You subscribed at acme.example",
    physicalAddress: "1 Main St, Springfield",
  });
  const { url, init } = lastCall();
  expect(url).toMatch(/\/lists$/);
  expect(init.method).toBe("POST");
  const body = JSON.parse(String(init.body));
  expect(body.complianceFooter).toBe("You subscribed at acme.example");
  expect(body.physicalAddress).toBe("1 Main St, Springfield");
  expect(body.optInPolicy).toBe("double");
});

test("setVisibility() closes and reopens a newsletter (#130)", async () => {
  // Closing keeps subscribers and stops new signups — and removes the list from
  // the public directory (#124).
  await api.setVisibility("acme", "ledger", "closed");
  expect(JSON.parse(String(lastCall().init.body)).visibility).toBe("closed");
  await api.setVisibility("acme", "ledger", "open");
  expect(JSON.parse(String(lastCall().init.body)).visibility).toBe("open");
});
