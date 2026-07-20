/**
 * addressium service: api
 * API Gateway HTTP API handlers: RBAC enforcement, entitlement-sync, merge/ad tags, alerts, org CRUD
 *
 * See docs/ARCHITECTURE.md. This is a scaffold stub — the handler shape is in
 * place so infra can wire it; business logic is TODO.
 */

export interface HandlerEvent {
  [key: string]: unknown;
}

export async function handler(event: HandlerEvent): Promise<unknown> {
  // TODO: implement — API Gateway HTTP API handlers: RBAC enforcement, entitlement-sync, merge/ad tags, alerts, org CRUD
  return { ok: true, service: "api", received: event };
}
