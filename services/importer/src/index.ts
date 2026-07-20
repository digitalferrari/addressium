/**
 * addressium service: importer
 * Pinpoint / CSV migration importer
 *
 * See docs/ARCHITECTURE.md. This is a scaffold stub — the handler shape is in
 * place so infra can wire it; business logic is TODO.
 */

export interface HandlerEvent {
  [key: string]: unknown;
}

export async function handler(event: HandlerEvent): Promise<unknown> {
  // TODO: implement — Pinpoint / CSV migration importer
  return { ok: true, service: "importer", received: event };
}
