/**
 * New-install onboarding (§9): the setup checklist is computed purely from an
 * org + its lists; required steps gate `setupComplete`; refreshSetupComplete
 * flips the flag once (idempotent) and never flips it back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { List, Organization } from "@addressium/core";
import { computeSetupState, evaluateSetup, refreshSetupComplete, memStores } from "@addressium/domain";

const ORG = "summit";
const org = (over: Partial<Organization> = {}): Organization => ({
  orgId: ORG, name: "Summit", domains: [], subscriberPoolId: "pool",
  magicLink: { kmsKeyArn: "arn", kid: "k", issuer: "i", audience: "a" },
  sesConfigSet: "cs", ipMode: "shared", suppressionScope: "org", defaultTimezone: "UTC",
  setupComplete: false, ...over,
});
const list = (over: Partial<List> = {}): List => ({
  orgId: ORG, listId: "ledger", name: "Ledger", optInPolicy: "double",
  fromAddress: "l@northwindtimes.example", access: "free", visibility: "open",
  complianceFooter: "Unsubscribe anytime.", physicalAddress: "1 Main St", ...over,
});

test("a bare org fails every required step", () => {
  const s = computeSetupState(org(), []);
  assert.equal(s.complete, false);
  assert.equal(s.requiredDone, 0);
  assert.equal(s.requiredTotal, 3);
  assert.equal(s.steps.find((x) => x.id === "sending_domain")?.done, false);
});

test("domain + compliant list + branding = complete", () => {
  const s = computeSetupState(org({ domains: ["x.com"], branding: { primaryColor: "#000", secondaryColor: "#fff", background: { type: "solid", color: "#fff" } } }), [list()]);
  assert.equal(s.complete, true);
  assert.equal(s.requiredDone, 3);
  assert.equal(s.steps.find((x) => x.id === "branding")?.done, true);
});

test("a list missing its physical address fails the compliance step (but not first_list)", () => {
  const s = computeSetupState(org({ domains: ["x.com"] }), [list({ physicalAddress: "  " })]);
  assert.equal(s.steps.find((x) => x.id === "first_list")?.done, true);
  assert.equal(s.steps.find((x) => x.id === "compliance")?.done, false);
  assert.equal(s.complete, false);
});

test("branding is recommended, not required — complete without it", () => {
  const s = computeSetupState(org({ domains: ["x.com"] }), [list()]);
  assert.equal(s.complete, true); // branding still 'done: false'
  assert.equal(s.steps.find((x) => x.id === "branding")?.done, false);
});

test("evaluateSetup reads the org + lists from the stores", async () => {
  const stores = memStores();
  await stores.organizations.put(org({ domains: ["x.com"] }));
  await stores.lists.put(list());
  const s = await evaluateSetup(stores, ORG);
  assert.equal(s.complete, true);
});

test("refreshSetupComplete flips the flag once, then is a no-op", async () => {
  const stores = memStores();
  await stores.organizations.put(org({ domains: ["x.com"] }));
  await stores.lists.put(list());

  const first = await refreshSetupComplete(stores, ORG);
  assert.equal(first.changed, true);
  assert.equal(first.setupComplete, true);
  assert.equal((await stores.organizations.get(ORG))?.setupComplete, true);

  const second = await refreshSetupComplete(stores, ORG);
  assert.equal(second.changed, false);
  assert.equal(second.setupComplete, true);
});

test("refreshSetupComplete does not flip while a required step is unmet", async () => {
  const stores = memStores();
  await stores.organizations.put(org({ domains: ["x.com"] })); // no list
  const r = await refreshSetupComplete(stores, ORG);
  assert.equal(r.state.complete, false);
  assert.equal(r.setupComplete, false);
  assert.equal((await stores.organizations.get(ORG))?.setupComplete, false);
});
