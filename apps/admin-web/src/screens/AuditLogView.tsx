import { useState } from "react";
import { useAsync } from "../useAsync.js";
import { api } from "../api.js";

/**
 * Audit log viewer (#191).
 *
 * The WORM bucket was provisioned, then the writes were wired — and the only way
 * to read an entry was still an AWS console login, which is precisely the
 * dependency §4.19 exists to remove. "Who exported subscriber data on the 14th?"
 * is the question the bucket was built to answer.
 *
 * Gated on `team:manage` like Team & access: the log names members and their
 * actions, so it is the same administrative surface, not a report.
 */
export function AuditLogView({ org }: { org: string }) {
  // "GLOBAL" is a scope, not an org. Org creation and pool linking belong to no
  // single org, so they would otherwise be invisible from every view.
  const [scope, setScope] = useState(org);
  const [limit, setLimit] = useState(100);
  const entries = useAsync(() => api.auditLog(scope, limit), [scope, limit]);

  return (
    <div>
      <h2>Audit log</h2>
      <p className="muted">
        Every privileged action, written once to an Object-Locked bucket. Entries cannot be
        edited or deleted — including by whoever wrote them.
      </p>
      <div className="card">
        <label>
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value={org}>{org}</option>
            <option value="GLOBAL">Cross-org (org creation, pool linking)</option>
          </select>
        </label>
        <label>
          Show
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            <option value={50}>50 most recent</option>
            <option value={100}>100 most recent</option>
            <option value={500}>500 most recent</option>
          </select>
        </label>
      </div>

      {entries.loading && <div className="muted">Reading the log…</div>}
      {entries.error && <div className="error">{entries.error}</div>}
      {entries.data?.length === 0 && (
        <div className="muted">
          Nothing recorded in this scope in the last 90 days.
        </div>
      )}
      {entries.data && entries.data.length > 0 && (
        <table className="table">
          <thead>
            <tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr>
          </thead>
          <tbody>
            {entries.data.map((e) => (
              <tr key={`${e.at}-${e.action}-${e.memberSub}`}>
                <td>{new Date(e.at).toLocaleString()}</td>
                <td><code>{e.memberSub}</code></td>
                <td>{e.action}</td>
                <td className="muted">{e.target ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
