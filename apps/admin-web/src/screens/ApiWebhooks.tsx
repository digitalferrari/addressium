export function ApiWebhooks() {
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
        <p className="muted" style={{ marginBottom: 0 }}>Signatures are verified server-side before either event can change subscriber state.</p>
      </div>

      <div className="card" style={{ borderColor: "var(--warn)", background: "var(--warn-soft)" }}>
        <strong>Outbound webhooks are not in v1</strong>
        <p className="muted">There is no delivery queue, retry policy, dead-letter queue or signing configuration to expose yet. API-key management is also planned for a later wave and is not represented by a non-functional control.</p>
      </div>
    </div>
  );
}
