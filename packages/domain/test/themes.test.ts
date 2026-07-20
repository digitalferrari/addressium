/**
 * Branding/theme presets (#53): every preset is a well-formed Branding value
 * with unique ids and valid hex colors, and lookup resolves by id.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BRANDING_PRESETS, brandingPreset } from "@addressium/domain";

const HEX = /^#[0-9a-f]{6}$/i;

test("presets include the personas and are uniquely identified", () => {
  const ids = BRANDING_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ["light", "dark", "broadsheet", "marquee", "contrast"]);
  assert.equal(new Set(ids).size, ids.length); // unique
  // The two personas the issue calls out are represented.
  const personas = BRANDING_PRESETS.map((p) => p.persona);
  assert.ok(personas.includes("Editor"));
  assert.ok(personas.includes("Advertising Director"));
});

test("every preset is a valid Branding value", () => {
  for (const p of BRANDING_PRESETS) {
    assert.match(p.branding.primaryColor, HEX, `${p.id} primary`);
    assert.match(p.branding.secondaryColor, HEX, `${p.id} secondary`);
    const bg = p.branding.background;
    if (bg.type === "solid") {
      assert.match(bg.color, HEX, `${p.id} bg`);
    } else {
      assert.match(bg.from, HEX, `${p.id} from`);
      assert.match(bg.to, HEX, `${p.id} to`);
      assert.ok(bg.angle >= 0 && bg.angle <= 360, `${p.id} angle`);
    }
  }
});

test("brandingPreset resolves by id, undefined otherwise", () => {
  assert.equal(brandingPreset("broadsheet")?.primaryColor, "#8a2f24");
  assert.equal(brandingPreset("nope"), undefined);
});
