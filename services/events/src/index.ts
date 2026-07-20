/**
 * addressium service: events
 * SES event processor (SNS->SQS): counters, link-id aggregation, token redaction, Firehose, alerts
 *
 * See docs/ARCHITECTURE.md. This is a scaffold stub — the handler shape is in
 * place so infra can wire it; business logic is TODO.
 */

export interface HandlerEvent {
  [key: string]: unknown;
}

export async function handler(event: HandlerEvent): Promise<unknown> {
  // TODO: implement — SES event processor (SNS->SQS): counters, link-id aggregation, token redaction, Firehose, alerts
  return { ok: true, service: "events", received: event };
}
