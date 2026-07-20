/**
 * Branding + presentation toggles: set org branding, set per-list presentation,
 * audience counts by entitlement, and the public list view honoring toggles
 * (counts appear only when enabled; never a roster).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { List, Organization, Subscriber } from "@addressium/core";
import {
  memStores,
  setBranding,
  setListPresentation,
  listAudienceCounts,
  publicListView,
} from "@addressium/domain";

const ORG = "summit";
const LIST = "ledger";

function org(): Organization {
  return {
    orgId: ORG,
    name: "Summit",
    domains: ["summitdaily.com"],
    subscriberPoolId: "pool",
    magicLink: { kmsKeyArn: "arn", kid: "k", issuer: "i", audience: "a" },
    sesConfigSet: "cs",
    ipMode: "shared",
    suppressionScope: "hybrid",
    defaultTimezone: "UTC",
    setupComplete: true,
  };
}
function list(): List {
  return {
    orgId: ORG,
    listId: LIST,
    name: "Ledger",
    description: "Daily markets",
    optInPolicy: "single",
    fromAddress: "l@summitdaily.com",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "a",
  };
}

async function seedAudience(stores: ReturnType<typeof memStores>, free: number, paid: number) {
  let i = 0;
  const add = async (entitlement: "free" | "paid") => {
    const s: Subscriber = { orgId: ORG, sub: `s${i}`, email: `s${i}@x.com`, attributes: {}, status: "active", entitlement };
    await stores.subscribers.put(s);
    await stores.subscriptions.put({ orgId: ORG, subscriberId: `s${i}`, listId: LIST, status: "confirmed", updatedAt: "t" });
    i++;
  };
  for (let n = 0; n < free; n++) await add("free");
  for (let n = 0; n < paid; n++) await add("paid");
}

test("setBranding stores theme (logo, colors, gradient background)", async () => {
  const stores = memStores();
  await stores.organizations.put(org());
  const updated = await setBranding(stores, ORG, {
    logoUrl: "https://cdn/logo.png",
    primaryColor: "#0a3",
    secondaryColor: "#f80",
    background: { type: "gradient", from: "#fff", to: "#eef", angle: 135 },
  });
  assert.equal(updated.branding?.primaryColor, "#0a3");
  assert.equal(updated.branding?.background.type, "gradient");
});

test("listAudienceCounts splits confirmed subscribers by entitlement", async () => {
  const stores = memStores();
  await stores.lists.put(list());
  await seedAudience(stores, 3, 2);
  const counts = await listAudienceCounts(stores, ORG, LIST);
  assert.deepEqual(counts, { total: 5, free: 3, paid: 2 });
});

test("publicListView hides counts unless their toggle is on", async () => {
  const stores = memStores();
  await stores.lists.put(list());
  await seedAudience(stores, 3, 2);

  // Default (no presentation set) → description shown, counts hidden.
  const def = await publicListView(stores, ORG, LIST);
  assert.equal(def?.description, "Daily markets");
  assert.equal(def?.readerCount, undefined);
  assert.equal(def?.freePaidCount, undefined);

  await setListPresentation(stores, ORG, LIST, {
    showFrequency: true,
    showSendTime: false,
    showDescription: false,
    showReaderCount: true,
    showFreePaidCount: true,
    frequencyLabel: "Daily",
    sendTimeLabel: "Weekday mornings",
  });
  const view = await publicListView(stores, ORG, LIST);
  assert.equal(view?.description, undefined); // toggle off
  assert.equal(view?.frequencyLabel, "Daily"); // toggle on
  assert.equal(view?.sendTimeLabel, undefined); // toggle off
  assert.equal(view?.readerCount, 5);
  assert.deepEqual(view?.freePaidCount, { free: 3, paid: 2 });
});
