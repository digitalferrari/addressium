import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { api, type TeamMemberRow } from "../api.js";

const ROLE_HELP: Record<string, string> = {
  developer_admin: "Everything, including managing this team",
  editor: "Create and send campaigns, manage templates, segments and subscribers",
  analyst: "Read reports only",
  support: "Read reports and manage individual subscribers",
};

/**
 * Team & access (#226).
 *
 * Before this, the only member any deployment had was the deploy-time seed —
 * developer_admin scoped to every org — so the four-role matrix was enforced
 * server-side while exactly one role was reachable, and offboarding meant an
 * AWS console operation.
 */
export function Team({ org }: { org: string }) {
  const loaded = useAsync(() => api.team(org), [org]);
  const [members, setMembers] = useState<TeamMemberRow[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [orgs, setOrgs] = useState(org);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (loaded.data) setMembers(loaded.data); }, [loaded.data]);

  const refresh = async () => setMembers(await api.team(org));
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMsg("");
    try { await fn(); await refresh(); }
    // The server's reason is the useful part — "this is the last enabled
    // developer admin" has to reach the operator, not become "request failed".
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  if (loaded.loading) return <div className="muted">Loading…</div>;
  if (loaded.error) return <div className="error">{loaded.error}</div>;

  return (
    <div>
      <h2>Team &amp; access</h2>
      <p className="muted">
        Members of this deployment&rsquo;s admin console. Roles are enforced server-side; the
        organizations listed here scope what each member can act on.
      </p>

      <div className="card">
        <h3>Invite a member</h3>
        <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.keys(ROLE_HELP).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <div className="muted">{ROLE_HELP[role]}</div>
        </label>
        <label>
          Organizations <span className="muted">(comma separated)</span>
          <input value={orgs} onChange={(e) => setOrgs(e.target.value)} />
          <div className="muted">
            <code>*</code> is reserved for the bootstrap administrator and cannot be granted here.
          </div>
        </label>
        <button
          className="btn"
          disabled={busy || !email}
          onClick={() => run(() => api.inviteMember(org, email, role, orgs.split(",").map((o) => o.trim()).filter(Boolean)))}
        >
          Send invite
        </button>
        <div className="muted">Cognito emails them a temporary password.</div>
      </div>

      {msg && <div className="error" style={{ margin: "8px 0" }}>{msg}</div>}

      <table className="table">
        <thead>
          <tr><th>Member</th><th>Role</th><th>Organizations</th><th>State</th><th /></tr>
        </thead>
        <tbody>
          {(members ?? []).map((m) => (
            <tr key={m.username} style={{ opacity: m.enabled ? 1 : 0.55 }}>
              <td>
                {m.email}
                {m.status && <div className="muted">{m.status}</div>}
              </td>
              <td>
                <select
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => run(() => api.setMemberAccess(org, m.username, e.target.value, m.orgs))}
                >
                  {Object.keys(ROLE_HELP).map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <div className="muted">{m.capabilities.length} capabilities</div>
              </td>
              <td>
                {m.orgs.includes("*")
                  ? <span title="bootstrap administrator">all organizations</span>
                  : m.orgs.join(", ")}
              </td>
              <td>{m.enabled ? "active" : "disabled"}</td>
              <td>
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => run(() => api.setMemberEnabled(org, m.username, !m.enabled))}
                >
                  {m.enabled ? "Disable" : "Enable"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
