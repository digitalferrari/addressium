/**
 * Hardened email-HTML sanitizer (adapters-aws, §4.15). Applied to raw pasted
 * bodies at the API boundary: active content and dangerous URL schemes are
 * removed while the tags/attributes real email needs survive.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeEmailHtml } from "@addressium/adapters-aws";

test("strips scripts, event handlers, and javascript:/data: URLs", () => {
  const dirty = `<p onclick="steal()">hi</p><script>evil()</script>` +
    `<a href="javascript:alert(1)">x</a><iframe src="//e"></iframe>` +
    `<img src="data:image/svg+xml,<svg onload=alert(1)>">`;
  const clean = sanitizeEmailHtml(dirty);
  assert.doesNotMatch(clean, /<script/i);
  assert.doesNotMatch(clean, /onclick/i);
  assert.doesNotMatch(clean, /javascript:/i);
  assert.doesNotMatch(clean, /<iframe/i);
  assert.match(clean, /<p>hi<\/p>/); // benign text survives
});

test("keeps the tables, inline styles, links and images email needs", () => {
  const html = `<table cellpadding="0"><tr><td style="color:#333" align="center">` +
    `<a href="https://x.example/a" data-linkid="l0">Read</a>` +
    `<img src="https://x.example/i.png" alt="pic" width="100"></td></tr></table>`;
  const clean = sanitizeEmailHtml(html);
  assert.match(clean, /<table/);
  assert.match(clean, /style="color:#333"/);
  assert.match(clean, /href="https:\/\/x\.example\/a"/);
  assert.match(clean, /data-linkid="l0"/);
  assert.match(clean, /<img[^>]+src="https:\/\/x\.example\/i\.png"/);
});

test("is idempotent — re-sanitizing already-clean HTML is a no-op", () => {
  const once = sanitizeEmailHtml(`<p>Hi <a href="https://x/a">link</a></p><script>x()</script>`);
  assert.equal(sanitizeEmailHtml(once), once);
});
