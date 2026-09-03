import assert from "node:assert/strict";
import test from "node:test";
import {
  translatePinpointSegment,
  importPinpointSegment,
  memStores,
  type PinpointSegmentResponse,
} from "@addressium/domain";

const ORG = "summit";

test("translatePinpointSegment maps attributes, user attributes, demographics and location", () => {
  const resp: PinpointSegmentResponse = {
    Id: "seg-123",
    Name: "VIP Sports Members",
    Dimensions: {
      Attributes: {
        "SD_Sports": {
          AttributeType: "INCLUSIVE",
          Values: ["true"],
        },
        "Promo": {
          AttributeType: "EXCLUSIVE",
          Values: ["black-friday"],
        },
      },
      UserAttributes: {
        "tier": {
          AttributeType: "INCLUSIVE",
          Values: ["gold"],
        },
      },
      Demographic: {
        Platform: {
          DimensionType: "INCLUSIVE",
          Values: ["iOS"],
        },
      },
      Location: {
        Country: {
          DimensionType: "INCLUSIVE",
          Values: ["US"],
        },
      },
    },
  };

  const segment = translatePinpointSegment(ORG, "seg-123", resp);

  assert.equal(segment.orgId, ORG);
  assert.equal(segment.segmentId, "seg-123");
  assert.equal(segment.name, "VIP Sports Members");

  const predicate = segment.predicate as { match: string; conditions: any[] };
  assert.equal(predicate.match, "all");
  assert.equal(predicate.conditions.length, 5);

  // Asserting expected mapped conditions
  const conditions = predicate.conditions;
  
  const sdSports = conditions.find((c) => c.field === "SD_Sports");
  assert.ok(sdSports);
  assert.equal(sdSports.op, "eq");
  assert.equal(sdSports.value, "true");

  const promo = conditions.find((c) => c.field === "Promo");
  assert.ok(promo);
  assert.equal(promo.op, "neq");
  assert.equal(promo.value, "black-friday");

  const tier = conditions.find((c) => c.field === "User.UserAttributes.tier");
  assert.ok(tier);
  assert.equal(tier.op, "eq");
  assert.equal(tier.value, "gold");

  const platform = conditions.find((c) => c.field === "Demographic.Platform");
  assert.ok(platform);
  assert.equal(platform.op, "eq");
  assert.equal(platform.value, "iOS");

  const country = conditions.find((c) => c.field === "Location.Country");
  assert.ok(country);
  assert.equal(country.op, "eq");
  assert.equal(country.value, "US");
});

test("importPinpointSegment saves segment into the store", async () => {
  const stores = memStores();
  const resp: PinpointSegmentResponse = {
    Id: "seg-vip",
    Name: "VIPs",
    Dimensions: {
      Attributes: {
        "VIP": {
          AttributeType: "INCLUSIVE",
          Values: ["yes"],
        },
      },
    },
  };

  const imported = await importPinpointSegment(stores, ORG, "seg-vip", resp);
  assert.equal(imported.segmentId, "seg-vip");
  assert.equal(imported.name, "VIPs");

  const stored = await stores.segments.get(ORG, "seg-vip");
  assert.ok(stored);
  assert.equal(stored.name, "VIPs");
});
