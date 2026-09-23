import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { api, type AlertRule } from "../api.js";
import { SkeletonScreen } from "../Skeleton.js";

const METRIC_LABEL: Record<string, string> = {
  complaint_rate: "Complaint rate",
  bounce_rate: "Bounce rate",
  send_failures: "Send failures (count)",
  reputation: "Reputation",
};

/**
 * Deliverability thresholds (#217) — the numbers that stop a campaign mid-flight.
 *
 * A missing config reads back as `null`, and that is rendered as UNPROTECTED
 * rather than as zeroed thresholds: zeros look like a deliberate setting, and an
 * org that silently has no halt is exactly what this issue was about.
 */
export function Deliverability({ org }: { org: string }) {
  const loaded = useAsync(() => api.alertConfig(org), [org]);
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [topic, setTopic] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (loaded.data) {
      setRules(loaded.data.rules);
      setTopic(loaded.data.snsTopicArn ?? "");
    } else if (!loaded.loading && !loaded.error) {
      setRules([]);
    }
  }, [loaded.data, loaded.loading, loaded.error]);

  const update = (i: number, patch: Partial<AlertRule>) =>
    setRules((rs) => (rs ? rs.map((r, j) => (j === i ? { ...r, ...patch } : r)) : rs));

  const save = async () => {
    if (!rules) return;
    setSaving(true);
    setMsg("");
    try {
      // haltAt below warnAt is rejected server-side; catch it here too so the
      // operator is told which row is wrong rather than getting one message.
      const bad = rules.findIndex((r) => r.haltAt < r.warnAt);
      if (bad >= 0) throw new Error(`${METRIC_LABEL[rules[bad]!.metric]}: halt must not be below warn`);
      await api.saveAlertConfig({ orgId: org, snsTopicArn: topic.trim() || undefined, rules, notifyTargets: [] });
      setMsg("Saved.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loaded.loading) return <SkeletonScreen />;
  if (loaded.error) return <div className="error">{loaded.error}</div>;

  return (
    <div>
      <h2>Deliverability</h2>
      <p className="muted">
        When a campaign crosses a halt threshold it stops mid-flight. Rates are fractions of
        messages sent — 0.005 is 0.5%.
      </p>

      {!loaded.data && (
        <div className="card" style={{ borderColor: "#b45309" }}>
          <strong>This organization has no thresholds.</strong>
          <div className="muted">
            Nothing will stop a campaign that starts generating complaints. Set thresholds below.
          </div>
        </div>
      )}

      <div className="card">
        <label>
          Alert topic ARN <span className="muted">(optional)</span>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="arn:aws:sns:…" />
        </label>
        <div className="muted">
          Without a topic a breach still halts the campaign — you just are not notified.
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Warn at</th>
            <th>Halt at</th>
            <th>Enabled</th>
          </tr>
        </thead>
        <tbody>
          {(rules ?? []).map((r, i) => (
            <tr key={r.metric}>
              <td>
                {METRIC_LABEL[r.metric] ?? r.metric}
                {r.metric === "reputation" && (
                  <div className="muted">No live signal yet — leave disabled.</div>
                )}
              </td>
              <td>
                <input
                  type="number"
                  step="0.001"
                  value={r.warnAt}
                  onChange={(e) => update(i, { warnAt: Number(e.target.value) })}
                />
              </td>
              <td>
                <input
                  type="number"
                  step="0.001"
                  value={r.haltAt}
                  onChange={(e) => update(i, { haltAt: Number(e.target.value) })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => update(i, { enabled: e.target.checked })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button className="btn" onClick={save} disabled={saving || !rules}>
        {saving ? "Saving…" : "Save thresholds"}
      </button>
      {msg && <span style={{ marginLeft: 12 }}>{msg}</span>}
    </div>
  );
}
