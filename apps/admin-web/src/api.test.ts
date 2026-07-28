/**
 * Admin API client (#98) — the methods added for the console screens must hit
 * the right method + path + body, since the screens depend on them.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./api.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
    text: async () => "",
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

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

test("subscribers() encodes the search query", async () => {
  await api.subscribers("acme", "a b@x");
  expect(lastCall().url).toMatch(/\/orgs\/acme\/subscribers\?q=a%20b%40x$/);
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
