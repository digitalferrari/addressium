/**
 * Importing a provider's segment definitions (docs/ARCHITECTURE.md §4.7, #243).
 *
 * This provides dynamic segment translation from AWS Pinpoint SegmentResponse JSON
 * (with `SegmentDimensions`) into Addressium's `SegmentPredicate` structure.
 * It maps standard attributes, user attributes, platforms, and locations so
 * dynamic segments can be ported over during a migration.
 */
import type { Segment } from "@addressium/core";
import type { Stores } from "./ports.js";

export interface PinpointSegmentAttributeDimension {
  AttributeType: "INCLUSIVE" | "EXCLUSIVE" | "CONTAINS" | "BEFORE" | "AFTER" | "ON" | "BETWEEN";
  Values: string[];
}

export interface PinpointSegmentDemographicDimension {
  DimensionType: "INCLUSIVE" | "EXCLUSIVE";
  Values: string[];
}

export interface PinpointSegmentDimensions {
  Attributes?: Record<string, PinpointSegmentAttributeDimension>;
  Behavior?: {
    Recency?: {
      Duration: "DAY_30" | "DAY_60" | "DAY_90" | "MONTH_6" | "MONTH_12";
      RecencyType: "ACTIVE" | "INACTIVE";
    };
  };
  Demographic?: {
    AppVersion?: PinpointSegmentDemographicDimension;
    DeviceType?: PinpointSegmentDemographicDimension;
    Make?: PinpointSegmentDemographicDimension;
    Model?: PinpointSegmentDemographicDimension;
    Platform?: PinpointSegmentDemographicDimension;
  };
  Location?: {
    Country?: PinpointSegmentDemographicDimension;
  };
  UserAttributes?: Record<string, PinpointSegmentAttributeDimension>;
}

export interface PinpointSegmentResponse {
  Id: string;
  Name: string;
  Dimensions?: PinpointSegmentDimensions;
}

export interface SegmentImportCondition {
  field: string;
  op: "in" | "eq" | "neq" | "exists" | "before" | "after";
  value?: string;
}

export interface SegmentImportPredicate {
  match: "all" | "any";
  conditions: SegmentImportCondition[];
}

/**
 * Translate an AWS Pinpoint segment definition response into an Addressium segment.
 */
export function translatePinpointSegment(
  orgId: string,
  segmentId: string,
  resp: PinpointSegmentResponse,
): Segment {
  const conditions: SegmentImportCondition[] = [];
  const match = "all";

  const dims = resp.Dimensions;
  if (dims) {
    // 1. Attributes
    if (dims.Attributes) {
      for (const [attrName, dim] of Object.entries(dims.Attributes)) {
        if (!dim) continue;
        const op = dim.AttributeType === "EXCLUSIVE" ? "neq" : "eq";
        const val = dim.Values?.[0];
        if (val !== undefined) {
          conditions.push({ field: attrName, op, value: val });
        } else {
          conditions.push({ field: attrName, op: "exists" });
        }
      }
    }

    // 2. UserAttributes
    if (dims.UserAttributes) {
      for (const [attrName, dim] of Object.entries(dims.UserAttributes)) {
        if (!dim) continue;
        const op = dim.AttributeType === "EXCLUSIVE" ? "neq" : "eq";
        const val = dim.Values?.[0];
        const fieldName = `User.UserAttributes.${attrName}`;
        if (val !== undefined) {
          conditions.push({ field: fieldName, op, value: val });
        } else {
          conditions.push({ field: fieldName, op: "exists" });
        }
      }
    }

    // 3. Demographic (e.g. Platform)
    if (dims.Demographic) {
      for (const [key, dim] of Object.entries(dims.Demographic)) {
        if (!dim) continue;
        const op = dim.DimensionType === "EXCLUSIVE" ? "neq" : "eq";
        const val = dim.Values?.[0];
        const fieldName = `Demographic.${key}`;
        if (val !== undefined) {
          conditions.push({ field: fieldName, op, value: val });
        }
      }
    }

    // 4. Location (Country)
    if (dims.Location?.Country) {
      const dim = dims.Location.Country;
      const op = dim.DimensionType === "EXCLUSIVE" ? "neq" : "eq";
      const val = dim.Values?.[0];
      if (val !== undefined) {
        conditions.push({ field: "Location.Country", op, value: val });
      }
    }
  }

  const predicate: SegmentImportPredicate = {
    match,
    conditions,
  };

  return {
    orgId,
    segmentId,
    name: resp.Name || "Imported Segment",
    predicate,
  };
}

/**
 * Import a Pinpoint segment response directly into the Segment store.
 */
export async function importPinpointSegment(
  stores: Stores,
  orgId: string,
  segmentId: string,
  resp: PinpointSegmentResponse,
): Promise<Segment> {
  const segment = translatePinpointSegment(orgId, segmentId, resp);
  await stores.segments.put(segment);
  return segment;
}
