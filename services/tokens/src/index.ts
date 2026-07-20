/**
 * addressium service: tokens
 * Magic-link JWT minting, KMS signing, JWKS endpoint
 *
 * See docs/ARCHITECTURE.md. This is a scaffold stub — the handler shape is in
 * place so infra can wire it; business logic is TODO.
 */

export interface HandlerEvent {
  [key: string]: unknown;
}

export async function handler(event: HandlerEvent): Promise<unknown> {
  // TODO: implement — Magic-link JWT minting, KMS signing, JWKS endpoint
  return { ok: true, service: "tokens", received: event };
}
