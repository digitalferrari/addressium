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
