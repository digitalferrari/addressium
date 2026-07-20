/**
 * addressium service: provisioning
 * Add-organization: create per-org Cognito pool, KMS key, SES identity, config set, JWKS
 *
 * See docs/ARCHITECTURE.md. This is a scaffold stub — the handler shape is in
 * place so infra can wire it; business logic is TODO.
 */

export interface HandlerEvent {
  [key: string]: unknown;
}

export async function handler(event: HandlerEvent): Promise<unknown> {
  // TODO: implement — Add-organization: create per-org Cognito pool, KMS key, SES identity, config set, JWKS
  return { ok: true, service: "provisioning", received: event };
}
