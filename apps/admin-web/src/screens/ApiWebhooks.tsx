/**
 * API & webhooks — the integration boundary between this organization and
 * everything outside it.
 *
 * Three things, in the order an operator cares about them: the inbound webhooks
 * that already ship, the API keys they can now issue (#280), and the outbound
 * customer-record delivery boundary. The latter is configured in Settings so
 * this page explains the contract without creating a second configuration writer.
 */
import { ApiKeys } from "./ApiKeys.js";
import type { Grant } from "../rbac.js";

export function ApiWebhooks({ org, grant }: { org: string; grant: Grant | null }) {
  return (
    <div>
      <div className="pagehead">
        <div>
          <h1>API &amp; webhooks</h1>
          <p>Integration boundaries for this organization and the addressium control plane.</p>
        </div>
      </div>

      <div className="card">
        <div className="cardhead" style={{ margin: "-18px -18px 16px" }}><h2>Inbound webhooks</h2><span className="pill p-good">Built</span></div>
        <p className="muted">The API accepts signed events from the billing system and the organization’s identity source.</p>
        <div className="kpis">
          <div className="kpi"><div className="n">POST</div><div className="l">/webhooks/entitlement</div></div>
          <div className="kpi"><div className="n">POST</div><div className="l">/webhooks/identity</div></div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Signatures are verified server-side before either event can change subscriber state. These
          are authenticated by their HMAC signature, not by an API key — issuing or revoking a key
          below does not affect them.
        </p>
      </div>

      <ApiKeys org={org} grant={grant} />

      <div className="card">
        <div className="cardhead" style={{ margin: "-18px -18px 16px" }}><h2>Outbound customer updates</h2><span className="pill p-good">Built</span></div>
        <p className="muted">
          Addressium can notify your external customer-record system when a subscriber confirms or
          ends a newsletter subscription. Configure the HTTPS endpoint, external table name, and
          delivery secret in <b>Settings → Customer sync</b>.
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          Delivery is asynchronous through a FIFO queue with retries and a dead-letter queue, so a
          customer-system outage does not block signup or unsubscribe. The current contract uses the
          configured secret as a basic credential; HMAC signing, rotation, and replay protection
          remain intentionally deferred under #267.
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          {/* This said keys were "management only: no route in this build is
              authenticated by one" — true until #291 shipped the /v1 machine
              API. Left accurate rather than aspirational: the console is where
              an operator decides what a credential can do, so it has to state
              what the scopes actually gate. */}
          Keys authenticate the <b>/v1 machine API</b>, and their scopes gate it: a key reaches
          only the routes its scopes name. They do <b>not</b> grant console access — a key cannot
          issue credentials, manage the team, or change its own scopes.
        </p>
      </div>
    </div>
  );
}
