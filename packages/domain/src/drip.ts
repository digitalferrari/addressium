/**
 * Drip / journey automations (docs/ARCHITECTURE.md §4.6, #23).
 *
 * A drip sequence is a list of steps, each with a wait and a send. The wait +
 * branching are orchestrated by a Step Functions state machine (Wait/Choice);
 * this module owns the pure per-step decision the machine calls at each Task
 * state: given the subscriber's current state, should this step SEND, be SKIPped
 * (gate not met, keep going), or EXIT the whole sequence (unsubscribed / bounced
 * / suppressed). Keeping the choice logic here makes it unit-testable and keeps
 * the state machine a thin orchestrator.
 */
import type { DripSequence, DripStep, Subscriber, Subscription } from "@addressium/core";

export type DripAction =
  | { type: "send"; step: DripStep }
  | { type: "skip"; reason: string }
  | { type: "exit"; reason: string };

/** Decide what a step should do for one enrolled subscriber. */
export function evaluateDripStep(
  step: DripStep,
  subscriber: Subscriber | undefined,
  subscription: Subscription | undefined,
): DripAction {
  if (!subscriber) return { type: "exit", reason: "subscriber not found" };
  if (subscriber.status === "suppressed") return { type: "exit", reason: "suppressed" };
  if (
    subscription &&
    (subscription.status === "unsubscribed" ||
      subscription.status === "bounced" ||
      subscription.status === "complained")
  ) {
    return { type: "exit", reason: `subscription ${subscription.status}` };
  }
  if (step.requireEntitlement && subscriber.entitlement !== step.requireEntitlement) {
    return { type: "skip", reason: `entitlement ${subscriber.entitlement} != ${step.requireEntitlement}` };
  }
  return { type: "send", step };
}

/** The index of the next step, or undefined when the sequence is complete. */
export function nextStepIndex(sequence: DripSequence, currentIndex: number): number | undefined {
  const next = currentIndex + 1;
  return next < sequence.steps.length ? next : undefined;
}

/** Whether a signup on `listId` should enroll the subscriber in this sequence. */
export function isEnrolledBySignup(sequence: DripSequence, listId: string): boolean {
  return sequence.trigger.kind === "signup" && sequence.trigger.listId === listId;
}
