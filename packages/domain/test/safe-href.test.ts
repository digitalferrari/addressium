/**
 * `safeHref` control-character bypass (#201).
 *
 * Browsers discard C0 control characters and DEL anywhere inside a URL before
 * resolving it, so a tab spliced into the scheme still loads as `javascript:`.
 * The old check only trimmed the ENDS of the string, so an INTERIOR control
 * character meant the scheme pattern failed to match, the function concluded
 * "no scheme ⇒ relative, allowed", and the url went into an email body as a
 * live link.
 *
 * Payloads are built from `\u00xx` escapes rather than literal control
 * characters, so they survive copy-paste and are visible in review — a literal
 * tab in a test string is exactly the sort of thing an editor normalises away,
 * quietly turning the test into one that proves nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderForRecipient } from "@addressium/domain";

/** Render one editorial link and pull its href back out. */
function hrefOf(url: string): string {
  const html = renderForRecipient(
    { blocks: [{ kind: "editorial", label: "x", url }] },
    {},
    undefined,
  );
  return /href="([^"]*)"/.exec(html)?.[1] ?? "";
}

const TAB = "\u0009";
const LF = "\u000a";
const CR = "\u000d";
const NUL = "\u0000";
const DEL = "\u007f";

test("a control character spliced into the scheme does not get through", () => {
  for (const bad of [
    `java${TAB}script:alert(1)`,
    `java${LF}script:alert(1)`,
    `java${CR}script:alert(1)`,
    `java${NUL}script:alert(1)`,
    `java${DEL}script:alert(1)`,
    `da${TAB}ta:text/html;base64,PHNjcmlwdD4=`,
    `vb${TAB}script:msgbox(1)`,
  ]) {
    assert.equal(hrefOf(bad), "#", `bypass survived: ${JSON.stringify(bad)}`);
  }
});

test("a plain disallowed scheme is still blocked", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd"]) {
    assert.equal(hrefOf(bad), "#", bad);
  }
});

test("the urls a newsletter actually uses are untouched", () => {
  // A sanitizer that blocks everything is not a fix. Editorial links, tracking
  // urls with query strings, and root-relative assets all have to survive.
  for (const ok of [
    "https://example.com/a?b=1#c",
    "http://example.com",
    "mailto:editor@example.com",
    "//cdn.example.com/x.png",
    "/relative/path",
    "#anchor",
    "relative/path.html",
  ]) {
    assert.equal(hrefOf(ok), ok, `wrongly blocked: ${ok}`);
  }
});
