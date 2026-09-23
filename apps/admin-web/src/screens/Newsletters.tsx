import { useState } from "react";
import { useAsync } from "../useAsync.js";
import { idProblem, suggestId } from "../ids.js";
import { api } from "../api.js";
import { SkeletonTable } from "../Skeleton.js";
import { RefreshButton } from "../RefreshButton.js";

/**
 * Newsletters — create a list, open or close it (#130/#131).
 *
 * `api.saveList` and `api.setVisibility` existed and were called by NOTHING, so
 * there was no way to create a newsletter from the console at all. For a product
 * whose entire subject is newsletters, that is not a missing convenience — the
 * console could show you a count of lists and give you no way to add one.
 *
 * The compliance fields are required rather than defaulted. A list with no
 * physical address or footer is a CAN-SPAM violation on every message it ever
 * sends, and inventing a plausible-looking default is how that ships silently.
 */
export function Newsletters({ org }: { org: string }) {
  const lists = useAsync(() => api.lists(org), [org]);
  const [refresh, setRefresh] = useState(0);
  const rows = useAsync(() => api.lists(org), [org, refresh]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({
    listId: "",
    name: "",
    description: "",
    fromAddress: "",
    complianceFooter: "",
    physicalAddress: "",
    optInPolicy: "double" as "single" | "double",
    access: "free" as "free" | "paid",
    visibility: "open" as "open" | "closed",
  });

  const listIdProblem = idProblem(form.listId.trim());
  const ready =
    form.listId.trim() && !listIdProblem && form.name.trim() && form.fromAddress.trim() &&
    form.complianceFooter.trim() && form.physicalAddress.trim();

  const create = async () => {
    setBusy(true); setMsg("");
    try {
      await api.saveList({
        orgId: org,
        ...form,
        listId: form.listId.trim(),
        name: form.name.trim(),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
      });
      setMsg(`Created “${form.name}”.`);
      setForm({ ...form, listId: "", name: "", description: "" });
      setRefresh((n) => n + 1);
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };

  const toggle = async (listId: string, current: "open" | "closed" | undefined) => {
    setMsg("");
    try {
      await api.setVisibility(org, listId, current === "closed" ? "open" : "closed");
      setRefresh((n) => n + 1);
    } catch (e) { setMsg(String(e)); }
  };

  const field = (key: keyof typeof form, label: string, placeholder = "") => (
    <label style={{ display: "block", marginBottom: 8 }}>
      <span style={{ display: "block", fontSize: 13 }}>{label}</span>
      <input
        value={String(form[key])}
        placeholder={placeholder}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        style={{ width: "100%" }}
      />
    </label>
  );

  return (
    <div>
      <div className="pagehead">
        <div>
          <h1>Newsletters</h1>
          <p>Each newsletter is a list with its own opt-in policy, from-address and compliance footer.</p>
        </div>
        {/* `rows` is the read the table renders. `lists` is a second, identical
            read of `api.lists` that feeds only the error line below — see the
            note there; refreshing both keeps the two from disagreeing. */}
        <RefreshButton
          refreshing={rows.refreshing || lists.refreshing}
          disabled={rows.loading}
          onClick={() => { void rows.refetch(); void lists.refetch(); }}
        />
      </div>
      <p className="muted">A <strong>closed</strong> newsletter keeps its subscribers and stops accepting new ones — it also disappears from the public directory.</p>

      <div className="card">
        <strong>Create a newsletter</strong>
        {field("listId", "List id", "ledger — used in URLs, cannot change later")}
        {/* The server rejects anything outside the id charset with a 400 (#196),
            and this value is permanent — so say so before the operator commits,
            and offer the slug of the name they already typed. */}
        {listIdProblem && <p className="err" style={{ margin: "-4px 0 8px" }}>List id {listIdProblem}</p>}
        {!form.listId.trim() && suggestId(form.name) && (
          <p className="muted" style={{ margin: "-4px 0 8px" }}>
            Suggested:{" "}
            <button
              className="btn ghost"
              style={{ padding: "0 6px" }}
              onClick={() => setForm({ ...form, listId: suggestId(form.name) })}
            >
              <code>{suggestId(form.name)}</code>
            </button>
          </p>
        )}
        {field("name", "Name", "The Ledger")}
        {field("description", "Description (optional)", "Daily business briefing")}
        {field("fromAddress", "From address", "ledger@yourdomain.example")}
        {field("complianceFooter", "Compliance footer", "You subscribed at yourdomain.example")}
        {field("physicalAddress", "Physical mailing address", "1 Main St, Springfield")}
        <div className="muted" style={{ marginBottom: 8 }}>
          The footer and physical address are CAN-SPAM requirements on every message this list
          sends, so they are required here rather than defaulted.
        </div>
        <div className="row">
          <label>
            Opt-in
            <select
              value={form.optInPolicy}
              onChange={(e) => setForm({ ...form, optInPolicy: e.target.value as "single" | "double" })}
            >
              <option value="double">Double — confirm by email</option>
              <option value="single">Single</option>
            </select>
          </label>
          <label>
            Access
            <select
              value={form.access}
              onChange={(e) => setForm({ ...form, access: e.target.value as "free" | "paid" })}
            >
              <option value="free">Free</option>
              <option value="paid">Paid</option>
            </select>
          </label>
        </div>
        <button className="btn" disabled={!ready || busy} onClick={() => void create()}>
          {busy ? "Creating…" : "Create newsletter"}
        </button>
        {msg && <div style={{ marginTop: 8 }}>{msg}</div>}
      </div>

      {rows.loading && <SkeletonTable rows={5} />}
      {rows.error && <div className="error">{rows.error}</div>}
      {rows.data && rows.data.length === 0 && (
        <div className="muted">No newsletters yet — create the first one above.</div>
      )}
      {rows.data && rows.data.length > 0 && (
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Id</th><th>From</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {rows.data.map((l) => (
              <tr key={l.listId}>
                <td>{l.name}</td>
                <td><code>{l.listId}</code></td>
                <td className="muted">{l.fromAddress ?? "—"}</td>
                <td>{l.visibility === "closed" ? "Closed" : "Open"}</td>
                <td>
                  <button className="btn ghost" onClick={() => void toggle(l.listId, l.visibility)}>
                    {l.visibility === "closed" ? "Reopen" : "Close"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {lists.error && <div className="error">{lists.error}</div>}
    </div>
  );
}
