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
import type { ScheduleKind, ScheduleStatus, SendScheduleState } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";

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
): Promise<SendScheduleState> {
  const existing = await stores.schedules.get(input.orgId, input.scheduleId);
  if (!existing) throw new Error(`unknown schedule ${input.scheduleId}`);
  const status: ScheduleStatus =
    input.action === "start" ? "active" : input.action === "pause" ? "paused" : "archived";
  const state: SendScheduleState = { ...existing, status, updatedAt: clock.now().toISOString() };
  await stores.schedules.put(state);
  return state;
}
