/**
 * Send-schedule lifecycle (docs/ARCHITECTURE.md §4.6).
 *
 * A scheduled send has three operator-facing states — **active** (scheduled /
 * started), **paused**, and **archived** — and is **never deleted**. The
 * lifecycle record (`SendScheduleState`) is the source of truth: the recurring
 * launch handler and the one-off campaign sender both gate on it, so pausing a
 * daily series stops the next edition even though its EventBridge schedule keeps
 * ticking, and a paused series can be resumed later. Archiving is a terminal
 * "put it away" state that likewise keeps the record and its history.
 */
import { createHash } from "node:crypto";
import type { ScheduleKind, ScheduleStatus, SendScheduleState } from "@addressium/core";
import type { Clock, SendDescriptor, Stores } from "./ports.js";

/** EventBridge Scheduler caps a schedule name at 64 characters. */
const SCHEDULE_NAME_MAX = 64;

/**
 * The EventBridge Scheduler name for a campaign's schedule (#196).
 *
 * Scheduler names are a FLAT, account-wide namespace — nothing about them is
 * per-tenant — and `CreateSchedule` is not an upsert. The old
 * `camp-${orgId}-${campaignId}` was ambiguous because `-` is legal inside both
 * ids: org `acme` + campaign `x-1` and org `acme-x` + campaign `1` both produced
 * `camp-acme-x-1`, so whichever tenant scheduled second got a
 * `ConflictException`. One org could deny scheduling to another by guessing a
 * name — and would also hit it by accident.
 *
 * `.` is the separator because `idSchema` forbids it, which is what makes the
 * join unambiguous. Constraining the ids alone would NOT have fixed this: the
 * charset still allows `-`.
 *
 * Over 64 characters the readable form is replaced wholesale by a digest of the
 * exact pair. Truncating the readable form instead would put the collision back
 * at the cut point, which is the failure this function exists to prevent.
 */
export function scheduleName(kind: "camp" | "series", orgId: string, campaignId: string): string {
  const readable = `${kind}.${orgId}.${campaignId}`;
  if (readable.length <= SCHEDULE_NAME_MAX) return readable;
  // NUL separates the two ids inside the digest so `("ab","c")` and `("a","bc")`
  // hash differently — the same ambiguity, one layer down.
  const digest = createHash("sha256").update(`${orgId}\u0000${campaignId}`).digest("hex");
  return `${kind}.${digest.slice(0, SCHEDULE_NAME_MAX - kind.length - 1)}`;
}

/**
 * May a send under this schedule fire? Only when active. A missing record
 * (a send scheduled before lifecycle tracking existed) is treated as active so
 * legacy schedules keep working.
 */
export function scheduleActive(state: SendScheduleState | undefined): boolean {
  return !state || state.status === "active";
}

/**
 * Record (or refresh) a schedule as active — called when a send is scheduled or
 * a paused one is resumed. Preserves `createdAt` across updates.
 */
export async function markScheduleActive(
  stores: Stores,
  clock: Clock,
  input: { orgId: string; scheduleId: string; kind: ScheduleKind; cron?: string; timezone?: string },
): Promise<SendScheduleState> {
  const now = clock.now().toISOString();
  const existing = await stores.schedules.get(input.orgId, input.scheduleId);
  const state: SendScheduleState = {
    orgId: input.orgId,
    scheduleId: input.scheduleId,
    kind: input.kind,
    status: "active",
    cron: input.cron ?? existing?.cron,
    timezone: input.timezone ?? existing?.timezone,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await stores.schedules.put(state);
  return state;
}

/** Apply a lifecycle transition (start | pause | archive) to an existing schedule. */
export async function transitionSchedule(
  stores: Stores,
  clock: Clock,
  input: { orgId: string; scheduleId: string; action: "start" | "pause" | "archive" },
): Promise<SendScheduleState & { resumed?: SendDescriptor }> {
  const existing = await stores.schedules.get(input.orgId, input.scheduleId);
  if (!existing) throw new Error(`unknown schedule ${input.scheduleId}`);
  const status: ScheduleStatus =
    input.action === "start" ? "active" : input.action === "pause" ? "paused" : "archived";

  // A one-off that fired while paused was parked rather than dropped (#179).
  // Resuming hands it back so the caller can re-enqueue it; archiving discards
  // it, because a terminal state that leaves a send waiting to fire is not
  // terminal.
  const parked = existing.deferred as SendDescriptor | undefined;
  const resumed = input.action === "start" ? parked : undefined;

  const state: SendScheduleState = {
    ...existing,
    status,
    updatedAt: clock.now().toISOString(),
  };
  // `pause` keeps whatever is parked; start and archive both clear it.
  if (input.action !== "pause") delete state.deferred;

  await stores.schedules.put(state);
  return resumed ? { ...state, resumed } : state;
}

/**
 * Park a one-off whose delivery arrived while the schedule was paused (#179).
 *
 * Called by the sender instead of silently dropping the message. Idempotent: a
 * redelivery overwrites the same parked descriptor rather than stacking.
 */
export async function deferSend(
  stores: Stores,
  clock: Clock,
  descriptor: SendDescriptor,
): Promise<void> {
  const existing = await stores.schedules.get(descriptor.orgId, descriptor.campaignId);
  // Nothing to park against — a legacy send with no lifecycle record is treated
  // as active by `scheduleActive`, so it never reaches here.
  if (!existing) return;
  await stores.schedules.put({
    ...existing,
    // The slice is deliberately dropped: on resume the campaign fans out afresh
    // against the recipient set as it stands THEN, which is both correct and
    // simpler than parking N slices and hoping they still tile the list.
    deferred: { ...descriptor, slice: undefined },
    updatedAt: clock.now().toISOString(),
  });
}
