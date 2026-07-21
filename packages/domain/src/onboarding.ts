/**
 * New-install / new-org onboarding (docs/ARCHITECTURE.md §9).
 *
 * A fresh deployment (or a freshly-added org) needs a guided path to a working
 * state: a sending domain, at least one list, compliant footers, and branding.
 * This module computes that setup checklist PURELY from observable config
 * (org + its lists) — cheap, no subscriber scan — so the admin console can show
 * progress and flip `Organization.setupComplete` once the essentials are in
 * place. SES domain verification and sandbox-exit are AWS-side steps the wizard
 * surfaces as guidance; everything here is derived from data we own.
 */
import type { List, Organization } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";

export type SetupStepId = "sending_domain" | "first_list" | "compliance" | "branding";

export interface SetupStep {
  id: SetupStepId;
  label: string;
  done: boolean;
  /** Required steps gate `setupComplete`; recommended ones are guidance only. */
  required: boolean;
  /** One-line hint on how to satisfy the step. */
  hint: string;
}

export interface SetupState {
  steps: SetupStep[];
  requiredDone: number;
  requiredTotal: number;
  /** True once every REQUIRED step is done. */
  complete: boolean;
}

/** Compute the setup checklist from an org and its lists. Pure. */
export function computeSetupState(org: Organization, lists: List[]): SetupState {
  const hasDomain = org.domains.length > 0;
  const hasList = lists.length > 0;
  // Compliance: CAN-SPAM needs a physical address + footer on every list.
  const compliant = hasList && lists.every((l) => l.physicalAddress.trim() !== "" && l.complianceFooter.trim() !== "");
  const hasBranding = org.branding !== undefined;

  const steps: SetupStep[] = [
    { id: "sending_domain", label: "Sending domain", done: hasDomain, required: true, hint: "Add and verify a sending domain (SES DKIM/SPF/DMARC)." },
    { id: "first_list", label: "First newsletter", done: hasList, required: true, hint: "Create at least one list for subscribers to opt into." },
    { id: "compliance", label: "Compliance footer & address", done: compliant, required: true, hint: "Every list needs a physical mailing address and footer (CAN-SPAM)." },
    { id: "branding", label: "Subscriber-site branding", done: hasBranding, required: false, hint: "Set colors/logo so the opt-in and preference pages match your brand." },
  ];

  const required = steps.filter((s) => s.required);
  const requiredDone = required.filter((s) => s.done).length;
  return { steps, requiredDone, requiredTotal: required.length, complete: requiredDone === required.length };
}

/** Load the org + its lists and compute the current setup state. */
export async function evaluateSetup(stores: Stores, orgId: string): Promise<SetupState> {
  const org = await stores.organizations.get(orgId);
  if (!org) throw new Error("unknown org");
  const lists = await stores.lists.list(orgId);
  return computeSetupState(org, lists);
}

/**
 * Recompute setup state and, when the required steps are all satisfied, flip
 * `setupComplete` to true (idempotent — never flips it back). Returns the state
 * plus whether the flag changed, so a caller can react (e.g. dismiss the wizard).
 */
export async function refreshSetupComplete(
  stores: Stores,
  orgId: string,
  _clock?: Clock,
): Promise<{ state: SetupState; setupComplete: boolean; changed: boolean }> {
  const org = await stores.organizations.get(orgId);
  if (!org) throw new Error("unknown org");
  const state = computeSetupState(org, await stores.lists.list(orgId));
  if (state.complete && !org.setupComplete) {
    await stores.organizations.put({ ...org, setupComplete: true });
    return { state, setupComplete: true, changed: true };
  }
  return { state, setupComplete: org.setupComplete, changed: false };
}
