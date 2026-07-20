/**
 * addressium service: sender
 * SQS consumers -> SES SendBulkEmail (token-bucket throttled), archive/link-map, ad-tag injection
 *
 * See docs/ARCHITECTURE.md. This is a scaffold stub — the handler shape is in
 * place so infra can wire it; business logic is TODO.
 */

export interface HandlerEvent {
  [key: string]: unknown;
}

export async function handler(event: HandlerEvent): Promise<unknown> {
  // TODO: implement — SQS consumers -> SES SendBulkEmail (token-bucket throttled), archive/link-map, ad-tag injection
  return { ok: true, service: "sender", received: event };
}
