import { useEffect, useState } from "react";
import { api, type Feed, type SaveFeedBody } from "../api.js";
import { useAsync } from "../useAsync.js";

const FIELDS = ["title", "link", "description", "date", "author", "content"];

function parseFieldMap(value: string): Record<string, string> {
  return Object.fromEntries(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [field, tag] = line.split("=").map((part) => part?.trim() ?? "");
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

  useEffect(() => { setForm((current) => ({ ...current, orgId: org })); }, [org]);

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
    {feeds.loading && <p className="muted">Loading feeds…</p>}
    {!feeds.loading && (localFeeds ?? feeds.data ?? []).length === 0 && !showForm && <div className="card muted">No feeds configured yet.</div>}
    {(localFeeds ?? feeds.data ?? []).map((feed) => <div className="card" key={feed.feedId}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><div><h2 style={{ marginTop: 0 }}>{feed.feedId}</h2><p className="muted">{feed.url}</p></div><button className="btn ghost" onClick={() => begin(feed)}>Edit</button></div>
      <p>{feed.format.toUpperCase()} · suggested pull every {feed.pullIntervalMins} minutes · newsletter <code>{feed.targetListId}</code></p>
      <p className="muted">{Object.entries(feed.fieldMap).map(([field, tag]) => `${field} → {{${tag}}}`).join(" · ") || "No field mappings"}</p>
    </div>)}
  </div>;
}
