/**
 * Transactional emails (docs/ARCHITECTURE.md §4.2).
 *
 * These are 1:1 system emails (double opt-in confirmation), distinct from
 * campaigns — no magic-link token, no click tracking, not subject to the
 * campaign send floor. Rendered as a SentMessage the EmailSender can dispatch.
 */
import type { List } from "@addressium/core";
import type { SentMessage } from "./ports.js";
import { escapeHtml } from "./render.js";

export function buildConfirmationEmail(
  list: List,
  toEmail: string,
  confirmUrl: string,
): SentMessage {
  const name = escapeHtml(list.name);
  const html = [
    `<p>Please confirm your subscription to <b>${name}</b>.</p>`,
    `<p><a href="${escapeHtml(confirmUrl)}">Confirm subscription</a></p>`,
    `<p style="font-size:12px;color:#777">${escapeHtml(list.complianceFooter)}<br>${escapeHtml(list.physicalAddress)}</p>`,
  ].join("\n");
  const text = [
    `Please confirm your subscription to ${list.name}.`,
    `Confirm: ${confirmUrl}`,
    ``,
    list.complianceFooter,
    list.physicalAddress,
  ].join("\n");
  return {
    from: list.fromAddress,
    to: toEmail,
    subject: `Confirm your subscription to ${list.name}`,
    html,
    text,
    // Transactional opt-in confirmation: mailto-only List-Unsubscribe (no
    // one-click POST — the SES adapter omits the One-Click header for mailto).
    listUnsubscribe: `<mailto:${list.fromAddress}>`,
  };
}

/** One confirmation email covering several lists (the "All newsletters" page, #61). */
export function buildBatchConfirmationEmail(
  lists: List[],
  toEmail: string,
  confirmUrl: string,
): SentMessage {
  const first = lists[0];
  if (!first) throw new Error("no lists to confirm");
  const items = lists.map((l) => `<li>${escapeHtml(l.name)}</li>`).join("");
  const html = [
    `<p>Please confirm your subscription to:</p>`,
    `<ul>${items}</ul>`,
    `<p><a href="${escapeHtml(confirmUrl)}">Confirm all subscriptions</a></p>`,
    `<p style="font-size:12px;color:#777">${escapeHtml(first.complianceFooter)}<br>${escapeHtml(first.physicalAddress)}</p>`,
  ].join("\n");
  const text = [
    `Please confirm your subscription to:`,
    ...lists.map((l) => `- ${l.name}`),
    ``,
    `Confirm all: ${confirmUrl}`,
    ``,
    first.complianceFooter,
    first.physicalAddress,
  ].join("\n");
  return {
    from: first.fromAddress,
    to: toEmail,
    subject: `Confirm your subscriptions (${lists.length})`,
    html,
    text,
    listUnsubscribe: `<mailto:${first.fromAddress}>`,
  };
}
