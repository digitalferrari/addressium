/**
 * addressium service: reporting
 * Reporting queries: click-overlay data, series aggregation, A/B results
 *
 * See docs/ARCHITECTURE.md. This is a scaffold stub — the handler shape is in
 * place so infra can wire it; business logic is TODO.
 */

export interface HandlerEvent {
  [key: string]: unknown;
}

export async function handler(event: HandlerEvent): Promise<unknown> {
  // TODO: implement — Reporting queries: click-overlay data, series aggregation, A/B results
  return { ok: true, service: "reporting", received: event };
}
