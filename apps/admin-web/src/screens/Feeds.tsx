import { useEffect, useState } from "react";
import { api, type Feed, type SaveFeedBody } from "../api.js";
import { useAsync } from "../useAsync.js";
import { SkeletonTable } from "../Skeleton.js";

const FIELDS = ["title", "link", "description", "date", "author", "content"];

function parseFieldMap(value: string): Record<string, string> {
  return Object.fromEntries(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line): [string, string] => {
    const [field = "", tag = ""] = line.split("=").map((part) => part.trim());
    return [field, tag];
  }).filter(([field, tag]) => FIELDS.includes(field) && /^[a-z0-9][a-z0-9_-]*$/.test(tag)));
}

function formatFieldMap(map: Record<string, string>): string {
  return Object.entries(map).map(([field, tag]) => `${field}=${tag}`).join("\n");
}

export function Feeds({ org }: { org: string }) {
  const feeds = useAsync(() => api.feeds(org), [org]);
  const lists = useAsync(() => api.lists(org), [org]);
  const [editing, setEditing] = useState<Feed | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<SaveFeedBody>({
    orgId: org, feedId: "", url: "", format: "rss", targetListId: "", fieldMap: {}, pullIntervalMins: 60,
  });
  const [mappingText, setMappingText] = useState("");
  const [message, setMessage] = useState("");
  const [localFeeds, setLocalFeeds] = useState<Feed[] | undefined>();

  // Clearing localFeeds is load-bearing, not tidiness: it holds the PREVIOUS
  // org's list after a save, and it wins over feeds.data — so without this the
  // table renders org A's feeds under org B's header after an org switch.
  useEffect(() => { setLocalFeeds(undefined); setForm((current) => ({ ...current, orgId: org })); }, [org]);

  const rows = localFeeds ?? feeds.data ?? [];
  const listName = (listId: string) =>
    (lists.data ?? []).find((list) => list.listId === listId)?.name ?? listId;

  const begin = (feed?: Feed) => {
    const next = feed ?? { ...form, orgId: org, targetListId: lists.data?.[0]?.listId ?? "" };
    setEditing(feed ?? null);
    setForm({ ...next, fieldMap: { ...next.fieldMap } });
    setMappingText(formatFieldMap(next.fieldMap));
    setMessage("");
    setShowForm(true);
  };

  const save = async () => {
    setMessage("");
    const body = { ...form, feedId: form.feedId.trim(), url: form.url.trim(), fieldMap: parseFieldMap(mappingText) };
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(body.feedId)) return setMessage("Feed id must use lowercase letters, numbers, _ or -.");
    if (!body.url.startsWith("https://")) return setMessage("Feed URL must use https.");
    try {
      const saved = await api.saveFeed(body);
      setMessage("Feed saved.");
      setShowForm(false);
      setLocalFeeds([...(localFeeds ?? feeds.data ?? []).filter((feed) => feed.feedId !== saved.feedId), saved]);
    } catch (e) { setMessage((e as Error).message); }
  };

  return <div>
    <div className="pagehead"><div><h1>Feeds</h1><p>Pull RSS, Atom or JSON articles into recurring newsletter editions.</p></div><button className="btn" onClick={() => begin()}>＋ Add feed</button></div>
    {message && <p className="muted">{message}</p>}
    {showForm && <div className="card">
      <div className="cardhead" style={{ margin: "-18px -18px 16px" }}><h2>{editing ? "Edit feed" : "Add feed"}</h2></div>
      <label>Feed id<input value={form.feedId} disabled={!!editing} onChange={(e) => setForm({ ...form, feedId: e.target.value })} placeholder="news-feed" /></label>
      <label>Source URL<input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/rss.xml" /></label>
      <div style={{ display: "flex", gap: 12 }}>
        <label style={{ flex: 1 }}>Format<select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value as SaveFeedBody["format"] })}><option value="rss">RSS</option><option value="atom">Atom</option><option value="json">JSON Feed</option></select></label>
        <label style={{ flex: 1 }}>Newsletter<select value={form.targetListId} onChange={(e) => setForm({ ...form, targetListId: e.target.value })}>{(lists.data ?? []).map((list) => <option key={list.listId} value={list.listId}>{list.name}</option>)}</select></label>
        <label style={{ flex: 1 }}>Suggested pull interval (minutes)<input type="number" min={5} max={10080} value={form.pullIntervalMins} onChange={(e) => setForm({ ...form, pullIntervalMins: Number(e.target.value) })} /><small className="muted">The recurring campaign schedule controls when the feed is fetched.</small></label>
      </div>
      <label>Field mapping <span className="muted">(one field=merge_tag per line)</span><textarea rows={5} value={mappingText} onChange={(e) => setMappingText(e.target.value)} placeholder={'title=article_title\nlink=article_url\ndescription=article_summary'} style={{ width: "100%", fontFamily: "monospace" }} /></label>
      <p className="muted">Supported feed fields: {FIELDS.join(", ")}. The URL is fetched server-side with SSRF protection when a recurring edition runs.</p>
      <div style={{ display: "flex", gap: 8 }}><button className="btn" onClick={() => void save()}>Save feed</button><button className="btn ghost" onClick={() => setShowForm(false)}>Cancel</button></div>
    </div>}
    {feeds.loading && <SkeletonTable rows={3} label="Loading feeds…" />}
    {feeds.error && <p className="err">{feeds.error}</p>}
    {!feeds.loading && !feeds.error && rows.length === 0 && !showForm && <div className="card muted">No feeds configured yet.</div>}
    {rows.length > 0 && <div className="card" style={{ padding: 0, overflowX: "auto" }}>
      <table className="table">
        <thead><tr><th>Feed</th><th>Maps to</th><th>Last pulled</th><th>Items</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((feed) => <tr key={feed.feedId}>
          <td>
            <b>{feed.feedId}</b>
            <div className="muted" style={{ wordBreak: "break-all" }}>{feed.format.toUpperCase()} · {feed.url}</div>
          </td>
          <td>
            {listName(feed.targetListId)}
            <div className="muted">{Object.entries(feed.fieldMap ?? {}).map(([field, tag]) => `${field} → {{${tag}}}`).join(" · ") || "No field mappings"}</div>
          </td>
          <td className="muted">{feed.lastPulledAt ? new Date(feed.lastPulledAt).toLocaleString() : "Not pulled yet"}</td>
          <td className="muted">{feed.lastItemCount ?? "—"}</td>
          <td>
            {!feed.lastStatus && <span className="muted">Not pulled yet</span>}
            {feed.lastStatus === "ok" && <span className="pill">OK</span>}
            {feed.lastStatus === "error" && <span className="pill" style={{ color: "#b42318", background: "#fee4e2" }} title={feed.lastError}>Error</span>}
          </td>
          <td><button className="btn ghost" onClick={() => begin(feed)}>Edit</button></td>
        </tr>)}</tbody>
      </table>
    </div>}
    {rows.length > 0 && <p className="muted">
      These values come from the most recent recurring campaign launch that referenced the
      feed. A feed is not pulled merely by saving it; attach it to a recurring campaign to
      start recording runs.
    </p>}
  </div>;
}
