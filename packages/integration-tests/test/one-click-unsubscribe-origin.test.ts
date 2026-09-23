/**
 * The one-click unsubscribe URL must be the API route, not the subscriber site.
 *
 * This URL is also the `List-Unsubscribe` header value, and `SesEmailSender`
 * pairs it with `List-Unsubscribe-Post: One-Click` — so Gmail and Yahoo POST to
 * it directly, with no browser involved.
 *
 * The org's subscriber site is CloudFront in front of S3, which answers a POST
 * with 403. Measured against the live dev stack, not assumed:
 *
 *   POST https://news.identithing.com/unsubscribe  -> HTTP/2 403 (server: CloudFront)
 *   POST https://<api>/unsubscribe                 -> HTTP/2 400 (handler, bad token)
 *
 * A regression here is invisible: mail still sends, the header is still
 * present, and the only symptom is subscribers who cannot leave — a CAN-SPAM
 * problem rather than a cosmetic one. #294 moved confirm and preference links
 * per-org, which is right (a human opens those with GET), and took this one
 * with them, which was not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { workspaces?: unknown };
      if (pkg.workspaces) return dir;
    } catch { /* keep walking */ }
    dir = dirname(dir);
  }
  throw new Error("workspace root not found");
}

const SENDER = resolve(workspaceRoot(), "services/sender/src/index.ts");

test("the unsubscribe link is built from the API base, not the org site", () => {
  const src = readFileSync(SENDER, "utf8");
  const builder = src.slice(src.indexOf("async function unsubscribeLink"), src.indexOf("export async function handler"));

  assert.ok(
    /UNSUBSCRIBE_URL_BASE/.test(builder),
    "the unsubscribe builder no longer reads UNSUBSCRIBE_URL_BASE — a mailbox provider's one-click POST would hit a static origin and 403",
  );
  assert.ok(
    !/requireSiteUrl|siteUrl/.test(builder),
    "the unsubscribe link must NOT come from the org's subscriber site: that origin answers POST with 403",
  );
});

test("the CDK still points UNSUBSCRIBE_URL_BASE at the API, not a site", () => {
  const stack = readFileSync(resolve(workspaceRoot(), "infra/cdk/lib/control-plane-stack.ts"), "utf8");
  const line = stack.split("\n").find((l) => l.includes("UNSUBSCRIBE_URL_BASE"));
  assert.ok(line, "UNSUBSCRIBE_URL_BASE is no longer set");
  assert.ok(
    /apiEndpoint/.test(line),
    `UNSUBSCRIBE_URL_BASE must resolve to the API endpoint, got: ${line.trim()}`,
  );
});
