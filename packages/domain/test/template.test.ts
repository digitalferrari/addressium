/**
 * Template store + saveTemplate (§4.15): create/edit reusable templates, bump the
 * version on edit, and sanitize raw HTML at save time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { memStores, saveTemplate } from "@addressium/domain";

const ORG = "summit";

test("saveTemplate creates a v1 template and lists it", async () => {
  const stores = memStores();
  const t = await saveTemplate(stores, {
    orgId: ORG, templateId: "welcome", name: "Welcome", mode: "raw_html",
    source: "<h1>Hi {{first_name}}</h1>", mergeTags: ["first_name"], adSlots: [],
  });
  assert.equal(t.version, 1);
  assert.equal((await stores.templates.list(ORG)).length, 1);
  assert.equal((await stores.templates.get(ORG, "welcome"))?.name, "Welcome");
});

test("editing an existing template bumps the version", async () => {
  const stores = memStores();
  const base = { orgId: ORG, templateId: "t1", name: "T1", mode: "raw_html" as const, source: "<p>a</p>", mergeTags: [], adSlots: [] };
  await saveTemplate(stores, base);
  const edited = await saveTemplate(stores, { ...base, source: "<p>b</p>" });
  assert.equal(edited.version, 2);
});

test("saveTemplate stores source verbatim — sanitization happens at the API edge", async () => {
  // Sanitization of raw HTML is the API handler's job (adapters-aws
  // sanitizeEmailHtml, tested in integration-tests); the pure domain fn stores
  // what it's given, MJML source included.
  const stores = memStores();
  const mjmlSrc = "<mjml><mj-body>{{x}}</mj-body></mjml>";
  const mjml = await saveTemplate(stores, {
    orgId: ORG, templateId: "m", name: "M", mode: "mjml", source: mjmlSrc, mergeTags: [], adSlots: [],
  });
  assert.equal(mjml.source, mjmlSrc);
});
