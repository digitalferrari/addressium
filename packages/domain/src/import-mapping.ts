/**
 * Import field mapping (docs/ARCHITECTURE.md §4.7, #216).
 *
 * Uploaded files never have the columns we want. A Pinpoint export uses
 * `Address` and `Attributes.SD_Skiing`; Mailchimp uses `Email Address` and
 * `FNAME`; a hand-built list uses whatever the operator typed. This module is
 * the layer between "operator uploaded a file" and "rows are written": it reads
 * the headers, proposes a mapping, lets the caller correct it, validates the
 * result, and applies it row by row.
 *
 * THE RULE THAT DRIVES THE DESIGN — an audience column is THREE-state, not
 * boolean. `true` is subscribed, `false` is declined, and **empty means the
 * subscriber was never asked** (#209: 26 of 50 columns were empty in a real
 * export). Collapsing empty into `false` fabricates a decline; collapsing it
 * into `true` resurrects an opt-out. `TriState` keeps the three apart all the
 * way through, and `unknown` never produces a subscription.
 *
 * Nothing here writes. `applyMapping` is pure so the console can preview a file
 * honestly before the operator commits to it.
 */
import type { SubscriptionConsent } from "@addressium/core";
import { parseCsv } from "./importer.js";

/**
 * Why we believe this person agreed to be mailed (#60, #223). *explicit* is
 * double opt-in evidence; *implicit* is an existing relationship. It is declared
 * per mapped column rather than per file, because one export routinely mixes
 * both — a paid-subscriber column and a scraped-interest column are not the
 * same promise.
 *
 * Re-exported from the shared `SubscriptionConsent` shape (#220) rather than
 * declared separately, so an imported subscription and a double-opt-in one
 * carry provenance in the same field and a single lookup answers both.
 */
export type ConsentBasis = NonNullable<SubscriptionConsent["basis"]>;

/** What a source column becomes. `discard` is explicit so a dropped column is counted, never silent. */
export type ColumnMapping =
  | { kind: "email" }
  /** Into `Subscriber.attributes` under `key` — an existing key or a new one the operator named. */
  | { kind: "attribute"; key: string }
  /** Subscribes rows whose value reads as subscribed. `list` is an existing id or a name to create. */
  | {
      kind: "audience";
      list: { existingId: string } | { createNamed: string };
      rule?: TriStateRule;
      consentBasis: ConsentBasis;
    }
  /** Row-level opt-out signal (Pinpoint `OptOut`); a match makes the row non-mailable. */
  | { kind: "optOut"; optedOutValues: string[] }
  /** Row-level status (Pinpoint `EndpointStatus`); anything outside `activeValues` is non-mailable. */
  | { kind: "endpointStatus"; activeValues: string[] }
  /** Row-level channel (Pinpoint `ChannelType`); anything outside `emailValues` is not an email subscriber. */
  | { kind: "channel"; emailValues: string[] }
  | { kind: "discard" };

export type TriState = "subscribed" | "declined" | "unknown";

/** Which literal cell values mean what. Comparison is trimmed + case-insensitive. */
export interface TriStateRule {
  subscribed: string[];
  declined: string[];
}

export const DEFAULT_TRISTATE: TriStateRule = {
  subscribed: ["true", "yes", "y", "1", "subscribed", "opt-in", "optin"],
  declined: ["false", "no", "n", "0", "unsubscribed", "opt-out", "optout"],
};

/** Header text that commonly denotes the address. Pinpoint uses `Address`, Mailchimp `Email Address`. */
const EMAIL_HEADERS = [
  "email",
  "email address",
  "emailaddress",
  "e-mail",
  "e-mail address",
  "mail",
  "address",
  "primary email",
  "email_address",
];

const PINPOINT_OPT_OUT = "OptOut";
const PINPOINT_STATUS = "EndpointStatus";
const PINPOINT_CHANNEL = "ChannelType";

/**
 * Columns that live under `Attributes.` but are ordinary attributes, not
 * newsletters. Auto-suggestion must not offer these as audiences — inventing a
 * list called "companyname" that someone can then send to is worse than leaving
 * it unmapped.
 */
const NOT_AUDIENCES = new Set(["audiences", "companyname", "contactowner", "promotionstest"]);

/** Endpoint metadata that carries no subscriber value; suggested as discard. */
const NOISE_HEADERS = new Set([
  "id",
  "requestid",
  "location.latitude",
  "location.longitude",
  "effectivedate",
]);

export interface MappingPlan {
  /** Keyed by the exact header text as it appears in the file. */
  columns: Record<string, ColumnMapping>;
}

export interface FilePreview {
  headers: string[];
  /** First N rows, for the console to render a live preview. */
  sample: Record<string, string>[];
  rowCount: number;
  /** Stable identity for the header set, so a saved mapping can be re-offered. */
  fingerprint: string;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Order-insensitive so a re-export with shuffled columns still matches a saved mapping. */
export function headerFingerprint(headers: string[]): string {
  return [...headers].map(norm).sort().join("|");
}

export function previewCsv(csv: string, sampleSize = 20): FilePreview {
  const rows = parseCsv(csv);
  const headers = rows.length > 0 ? Object.keys(rows[0] as Record<string, string>) : [];
  return {
    headers,
    sample: rows.slice(0, sampleSize),
    rowCount: rows.length,
    fingerprint: headerFingerprint(headers),
  };
}

/** Strip a dotted prefix: `User.UserAttributes.firstName` → `firstName`. */
function leaf(header: string): string {
  const i = header.lastIndexOf(".");
  return i === -1 ? header : header.slice(i + 1);
}

export function readTriState(value: string, rule: TriStateRule = DEFAULT_TRISTATE): TriState {
  const v = norm(value);
  if (v === "") return "unknown";
  if (rule.subscribed.some((s) => norm(s) === v)) return "subscribed";
  if (rule.declined.some((s) => norm(s) === v)) return "declined";
  return "unknown";
}

/**
 * True when every non-empty value in the column reads as subscribed/declined —
 * i.e. the column is a toggle rather than free text. Shape beats name here: a
 * publisher's list column can be called anything, but its values give it away.
 */
function looksLikeToggle(values: string[]): boolean {
  const present = values.filter((v) => v.trim() !== "");
  if (present.length === 0) return false;
  return present.every((v) => readTriState(v) !== "unknown");
}

function looksLikeEmail(values: string[]): boolean {
  const present = values.filter((v) => v.trim() !== "");
  if (present.length === 0) return false;
  return present.every((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()));
}

export interface SuggestOptions {
  /** Existing attribute keys on this org, so a column can bind to one instead of creating a duplicate. */
  knownAttributes?: string[];
  /** Existing lists, matched by name, so a column binds to a real list rather than proposing a new one. */
  knownLists?: { listId: string; name: string }[];
  /** Consent basis to stamp on suggested audience columns. The operator must confirm it (#60). */
  consentBasis?: ConsentBasis;
}

/**
 * Propose a mapping so the common case is confirm-and-go rather than mapping 73
 * columns by hand. Suggestions are always overridable — this returns a starting
 * point, not a decision. In particular an audience is only ever *proposed*;
 * creating a list stays an explicit operator action.
 */
export function suggestMapping(
  preview: FilePreview,
  opts: SuggestOptions = {},
): MappingPlan {
  const { headers, sample } = preview;
  const columns: Record<string, ColumnMapping> = {};
  const consentBasis = opts.consentBasis ?? "implicit";
  const knownAttr = new Map((opts.knownAttributes ?? []).map((a) => [norm(a), a]));
  const knownList = new Map((opts.knownLists ?? []).map((l) => [norm(l.name), l.listId]));
  const valuesOf = (h: string): string[] => sample.map((r) => r[h] ?? "");

  let emailChosen = false;
  for (const h of headers) {
    const n = norm(h);
    const l = leaf(h);
    const nl = norm(l);
    const values = valuesOf(h);

    // The address, by header name or — more reliably — by value shape.
    if (!emailChosen && (EMAIL_HEADERS.includes(n) || EMAIL_HEADERS.includes(nl) || looksLikeEmail(values))) {
      columns[h] = { kind: "email" };
      emailChosen = true;
      continue;
    }

    // Pinpoint's three row-level safety columns. Getting these wrong is the
    // compliance failure in #209, so they are recognised by name and never
    // silently treated as attributes.
    if (l === PINPOINT_OPT_OUT) {
      columns[h] = { kind: "optOut", optedOutValues: ["ALL", "EMAIL"] };
      continue;
    }
    if (l === PINPOINT_STATUS) {
      columns[h] = { kind: "endpointStatus", activeValues: ["ACTIVE"] };
      continue;
    }
    if (l === PINPOINT_CHANNEL) {
      columns[h] = { kind: "channel", emailValues: ["EMAIL"] };
      continue;
    }

    if (NOISE_HEADERS.has(n) || n.startsWith("location.")) {
      columns[h] = { kind: "discard" };
      continue;
    }

    // A toggle-shaped column under `Attributes.` is a newsletter — unless it is
    // one of the known non-list attribute columns.
    if (h.startsWith("Attributes.") && !NOT_AUDIENCES.has(nl) && looksLikeToggle(values)) {
      const existingId = knownList.get(nl);
      columns[h] = {
        kind: "audience",
        list: existingId ? { existingId } : { createNamed: l },
        consentBasis,
      };
      continue;
    }

    columns[h] = { kind: "attribute", key: knownAttr.get(nl) ?? l };
  }
  return { columns };
}

export interface MappingProblem {
  column?: string;
  problem: string;
}

/**
 * Reject a mapping that cannot produce a correct import. Returning every problem
 * at once matters: the console shows them all rather than making the operator
 * fix 73 columns one round-trip at a time.
 */
export function validateMapping(plan: MappingPlan, headers: string[]): MappingProblem[] {
  const problems: MappingProblem[] = [];
  const mapped = Object.keys(plan.columns);

  for (const h of mapped) {
    if (!headers.includes(h)) problems.push({ column: h, problem: "mapped column is not in the file" });
  }
  for (const h of headers) {
    if (!(h in plan.columns)) problems.push({ column: h, problem: "column has no mapping (choose one, or discard it)" });
  }

  const emails = mapped.filter((h) => plan.columns[h]?.kind === "email");
  if (emails.length === 0) problems.push({ problem: "no column is mapped to the email address" });
  if (emails.length > 1) {
    problems.push({ problem: `${emails.length} columns are mapped to email; exactly one is required` });
  }

  const attrKeys = new Map<string, string[]>();
  const listKeys = new Map<string, string[]>();
  for (const h of mapped) {
    const m = plan.columns[h];
    if (!m) continue;
    if (m.kind === "attribute") {
      if (m.key.trim() === "") problems.push({ column: h, problem: "attribute key is empty" });
      attrKeys.set(norm(m.key), [...(attrKeys.get(norm(m.key)) ?? []), h]);
    }
    if (m.kind === "audience") {
      const key = "existingId" in m.list ? `id:${m.list.existingId}` : `new:${norm(m.list.createNamed)}`;
      if ("createNamed" in m.list && m.list.createNamed.trim() === "") {
        problems.push({ column: h, problem: "new audience name is empty" });
      }
      listKeys.set(key, [...(listKeys.get(key) ?? []), h]);
    }
  }
  for (const [key, cols] of attrKeys) {
    if (cols.length > 1) {
      problems.push({ problem: `attribute "${key}" is the target of ${cols.length} columns: ${cols.join(", ")}` });
    }
  }
  // Two columns feeding one audience is the `Sports` / `SD_Sports` case, where
  // the pair can disagree. Silent last-write-wins would pick a subscription
  // state by column order, so require the operator to resolve it (#209).
  for (const [key, cols] of listKeys) {
    if (cols.length > 1) {
      problems.push({ problem: `audience ${key} is the target of ${cols.length} columns: ${cols.join(", ")} — resolve the duplicate` });
    }
  }
  return problems;
}

export interface MappedRow {
  email: string;
  attributes: Record<string, string>;
  /** Only `subscribed` columns appear; `declined` and `unknown` never create a subscription. */
  audiences: { list: { existingId: string } | { createNamed: string }; consentBasis: ConsentBasis }[];
  /** Columns that read as an explicit decline — recorded so an import can honour it rather than ignore it. */
  declined: { list: { existingId: string } | { createNamed: string } }[];
  /** False when a row-level signal says do not mail: opted out, inactive, or not an email endpoint. */
  mailable: boolean;
  /** Why the row is not mailable, or why it cannot be imported at all. */
  reasons: string[];
  discardedColumns: number;
}

/**
 * Apply a validated mapping to one row. Pure — no writes, no clock, no store —
 * so the console preview and the real import cannot diverge.
 */
export function applyMapping(plan: MappingPlan, row: Record<string, string>): MappedRow {
  const out: MappedRow = {
    email: "",
    attributes: {},
    audiences: [],
    declined: [],
    mailable: true,
    reasons: [],
    discardedColumns: 0,
  };

  for (const [header, m] of Object.entries(plan.columns)) {
    const raw = row[header] ?? "";
    switch (m.kind) {
      case "email":
        out.email = raw.trim().toLowerCase();
        break;
      case "attribute": {
        const v = raw.trim();
        if (v !== "") out.attributes[m.key] = v;
        break;
      }
      case "audience": {
        switch (readTriState(raw, m.rule ?? DEFAULT_TRISTATE)) {
          case "subscribed":
            out.audiences.push({ list: m.list, consentBasis: m.consentBasis });
            break;
          case "declined":
            out.declined.push({ list: m.list });
            break;
          case "unknown":
            // Never asked. Not a subscription and NOT a decline — recording it
            // as either would invent consent history the subscriber never gave.
            break;
        }
        break;
      }
      case "optOut":
        if (m.optedOutValues.some((v) => norm(v) === norm(raw))) {
          out.mailable = false;
          out.reasons.push(`opted out (${header}=${raw})`);
        }
        break;
      case "endpointStatus":
        if (raw.trim() !== "" && !m.activeValues.some((v) => norm(v) === norm(raw))) {
          out.mailable = false;
          out.reasons.push(`not active (${header}=${raw})`);
        }
        break;
      case "channel":
        if (raw.trim() !== "" && !m.emailValues.some((v) => norm(v) === norm(raw))) {
          out.mailable = false;
          out.reasons.push(`not an email endpoint (${header}=${raw})`);
        }
        break;
      case "discard":
        out.discardedColumns++;
        break;
    }
  }

  if (!out.email.includes("@")) out.reasons.push("missing or invalid email address");
  return out;
}
