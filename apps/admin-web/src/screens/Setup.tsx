import { useAsync } from "../useAsync.js";
import { api } from "../api.js";

export function Setup({ org }: { org: string }) {
  const { data, error, loading } = useAsync(() => api.setup(org), [org]);
  return (
    <div>
      <h1 className="h1">Setup · {org || "—"}</h1>
      {loading && <div className="card muted">Loading…</div>}
      {error && <p className="err">{error}</p>}
      {data && (
        <>
          <div className="card">
            <div className="muted">
              {data.complete
                ? "All required steps complete — this organization is ready to send."
                : `${data.requiredDone} of ${data.requiredTotal} required steps complete.`}
            </div>
          </div>
          <div className="card">
            <table>
              <thead><tr><th></th><th>Step</th><th></th><th>How</th></tr></thead>
              <tbody>
                {data.steps.map((s) => (
                  <tr key={s.id}>
                    <td style={{ width: 24 }}>{s.done ? "✓" : "○"}</td>
                    <td className="t-strong">{s.label}</td>
                    <td className="muted">{s.required ? "required" : "recommended"}</td>
                    <td className="muted">{s.done ? "—" : s.hint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
