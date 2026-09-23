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

test("the org's own domain is used ONLY behind the apiViaSite gate", () => {
  // The org's domain is better — the List-Unsubscribe host then matches the
  // From domain — but only once that distribution actually forwards `/api/*`.
  // Without the behaviour a one-click POST hits CloudFront-over-S3 and gets 403.
  const src = readFileSync(SENDER, "utf8");
  const builder = src.slice(src.indexOf("async function unsubscribeLink"), src.indexOf("export async function handler"));

  assert.ok(
    /UNSUBSCRIBE_URL_BASE/.test(builder),
    "the API base must remain the fallback — it is the origin that always accepts POST",
  );
  assert.ok(
    /apiViaSite/.test(builder),
    "the org's domain must be gated on apiViaSite, not used unconditionally",
  );
  // The gate and the site URL must appear together: a `siteUrl` read with no
  // `apiViaSite` check beside it is the regression this guards.
  const siteBranch = builder.slice(builder.indexOf("apiViaSite"));
  assert.ok(
    /\/api\/unsubscribe/.test(siteBranch),
    "when the org's domain IS used it must go through /api/, which is the behaviour that accepts POST",
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
