// Prints the nav each role actually sees, derived from Sidebar.tsx GROUPS and
// the ROLES matrix in packages/rbac. Used to regenerate the tables in
// docs/PERSONAS.md so they cannot drift from the console.
//
// The matrix is READ, never restated here: a third hand-written copy would be
// the one copy rbac-client-drift.test.ts does not guard, and the doc derived
// from it could go wrong while every test stayed green.
//
// Run: node scripts/persona-nav.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

/** Capability list for each role, parsed from the server matrix. */
function serverRoles() {
  const src = read("packages/rbac/src/roles.ts");
  const caps = (name) => {
    const decl = src.match(new RegExp(`const ${name}: Capability\\[\\] = \\[([\\s\\S]*?)\\];`));
    if (!decl) throw new Error(`roles.ts: could not find the ${name} capability list`);
    return [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  // ROLES maps each role to one of these consts (developer_admin -> ALL).
  return { developer_admin: caps("ALL"), editor: caps("EDITOR"), analyst: caps("ANALYST"), support: caps("SUPPORT") };
}

/** Nav items in order, with the capability each is gated on (null = ungated). */
function navItems() {
  const src = read("apps/admin-web/src/Sidebar.tsx");
  // Sidebar.tsx closes GROUPS with `] as const satisfies ...` — match the bare
  // bracket at column 0 so a change to that suffix cannot silently truncate.
  const block = src.match(/const GROUPS = \[([\s\S]*?)\n\]/);
  if (!block) throw new Error("Sidebar.tsx: could not find the GROUPS literal");
  return [...block[1].matchAll(/\{ id: "([^"]+)",([^}]*)\}/g)].map(([, id, rest]) => ({
    id,
    label: (rest.match(/label: "([^"]+)"/) ?? [, id])[1],
    // Read from the whole entry rather than an optional trailing group, so a
    // reordered field cannot drop the cap and silently widen a nav list.
    cap: (rest.match(/cap: "([^"]+)"/) ?? [, null])[1],
  }));
}

const ROLES = serverRoles();
const items = navItems();
const ungated = items.filter((i) => !i.cap).map((i) => i.id);

// Guards: a parse that silently degrades would widen every low-privilege list.
const EXPECT_ITEMS = 30;
const EXPECT_UNGATED = ["dashboard", "setup", "apiwebhooks", "settings"];
if (items.length !== EXPECT_ITEMS) {
  throw new Error(`parsed ${items.length} nav items, expected ${EXPECT_ITEMS} — check the Sidebar.tsx parse`);
}
if (JSON.stringify([...ungated].sort()) !== JSON.stringify([...EXPECT_UNGATED].sort())) {
  throw new Error(`ungated nav items are ${JSON.stringify(ungated)}, expected ${JSON.stringify(EXPECT_UNGATED)}`);
}

for (const [role, caps] of Object.entries(ROLES)) {
  const visible = items.filter((i) => !i.cap || caps.includes(i.cap));
  console.log(`${role} (${visible.length}/${items.length}): ${visible.map((v) => v.label).join(", ")}`);
}

const unused = [...new Set(Object.values(ROLES).flat())].filter((c) => !items.some((i) => i.cap === c));
console.log(`\nCapabilities gating no nav item (API-only): ${unused.join(", ") || "none"}`);
