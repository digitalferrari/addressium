/**
 * Compose & schedule. Exported for `Compose.test.tsx` (#249) — which body mode
 * the submit path actually reads is a property of this component.
 */
import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { isValidId } from "../ids.js";
import { api, type EmailBlock, type ScheduleWhen } from "../api.js";

interface DraftBlock { kind: "text" | "editorial" | "ad"; html: string; label: string; url: string; slot: string }

const MODE_LABELS: Record<"blocks" | "html" | "mjml", string> = {
  blocks: "Blocks",
  html: "Raw HTML",
  mjml: "MJML",
};

export function Compose({ org, onScheduled }: { org: string; onScheduled: () => void }) {
  const lists = useAsync(() => api.lists(org), [org]);
  const templates = useAsync(() => api.templates(org), [org]);
  const segments = useAsync(() => api.segments(org), [org]);
  const feeds = useAsync(() => api.feeds(org), [org]);
  const [listId, setListId] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyMode, setBodyMode] = useState<"blocks" | "html" | "mjml">("blocks");
  const [html, setHtml] = useState("");
  const [mjml, setMjml] = useState("");
  const [blocks, setBlocks] = useState<DraftBlock[]>([{ kind: "text", html: "", label: "", url: "", slot: "" }]);
  const [when, setWhen] = useState<"now" | "at" | "recurring">("now");
  const [at, setAt] = useState("");
  const [cron, setCron] = useState("cron(0 13 * * ? *)");
  const [timezone, setTimezone] = useState("");
  const [feedId, setFeedId] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (lists.data && lists.data.length > 0 && !listId) setListId(lists.data[0]!.listId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists.data]);

  const setBlock = (i: number, patch: Partial<DraftBlock>) =>
    setBlocks((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const addBlock = (kind: "text" | "editorial" | "ad") =>
    setBlocks((bs) => [...bs, { kind, html: "", label: "", url: "", slot: "" }]);
  const removeBlock = (i: number) => setBlocks((bs) => bs.filter((_, j) => j !== i));

  const blocksValid = blocks.length > 0 && blocks.every((b) =>
    b.kind === "text" || b.kind === "ad" ? b.html.trim() !== "" && (b.kind === "text" || b.slot.trim() !== "") : b.label.trim() !== "" && /^https?:\/\//.test(b.url.trim()),
  );
  const bodyValid = bodyMode === "blocks" ? blocksValid : bodyMode === "html" ? html.trim() !== "" : mjml.trim() !== "";
  // "Holds something the operator typed", which is not the same as "is valid":
  // a half-finished editorial block is exactly the draft worth warning about.
  const filledBodyModes = ([
    ["blocks", blocks.some((b) => b.html.trim() !== "" || b.label.trim() !== "" || b.url.trim() !== "" || b.slot.trim() !== "")],
    ["html", html.trim() !== ""],
    ["mjml", mjml.trim() !== ""],
  ] as const).filter(([, filled]) => filled).map(([m]) => m);
  const otherFilledModes = filledBodyModes.filter((m) => m !== bodyMode);
  const valid =
    !!listId && isValidId(campaignId.trim()) && subject.trim() !== "" && bodyValid &&
    (when !== "at" || at !== "") && (when !== "recurring" || cron.trim() !== "");

  const htmlTemplates = (templates.data ?? []).filter((t) => t.mode === "raw_html");
  const mjmlTemplates = (templates.data ?? []).filter((t) => t.mode === "mjml" || t.mode === "visual");

  const submit = async () => {
    setMsg(""); setBusy(true);
    try {
      const whenPayload: ScheduleWhen =
        when === "now" ? { type: "now" }
        : when === "at" ? { type: "at", at: new Date(at).toISOString() }
        : { type: "recurring", cron: cron.trim(), ...(timezone.trim() ? { timezone: timezone.trim() } : {}) };
      let template;
      if (bodyMode === "html") {
        template = { html };
      } else if (bodyMode === "mjml") {
        const { default: mjml2html } = await import("mjml-browser");
        const compiled = mjml2html(mjml);
        if (compiled.errors.length > 0) {
          setMsg(`MJML has ${compiled.errors.length} issue(s): ${compiled.errors[0]?.formattedMessage ?? compiled.errors[0]?.message}`);
          setBusy(false);
          return;
        }
        template = { mjmlHtml: compiled.html };
      } else {
        template = {
          blocks: blocks.map((b): EmailBlock =>
            b.kind === "text" ? { kind: "text", html: b.html } : b.kind === "ad" ? { kind: "ad", slot: b.slot.trim(), html: b.html } : { kind: "editorial", label: b.label, url: b.url.trim() },
          ),
        };
      }
      const res = await api.scheduleCampaign({ orgId: org, campaignId: campaignId.trim(), listId, subject, template, when: whenPayload, ...(segmentId ? { segmentId } : {}), ...(when === "recurring" && feedId ? { feedId } : {}) });
      setMsg(`Scheduled "${res.scheduleId}" (${res.status}${res.at ? ` · ${new Date(res.at).toLocaleString()}` : ""}${res.timezone ? ` · ${res.timezone}` : ""}).`);
      onScheduled();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="h1">Compose &amp; schedule · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Build a send and schedule it now, at a time, or on a recurring cron. It appears under
        Schedules where you can pause or archive it.
      </p>
      {lists.data && lists.data.length === 0 && (
        <div className="card muted">No newsletters yet — create a list first.</div>
      )}
      <div className="card">
        <label>Newsletter</label>
        <select value={listId} onChange={(e) => setListId(e.target.value)} style={{ width: "100%" }}>
          {(lists.data ?? []).map((l) => (
            <option key={l.listId} value={l.listId}>{l.name} ({l.listId})</option>
          ))}
        </select>
        <label style={{ marginTop: 12 }}>Segment (optional — targets within the list)</label>
        <select value={segmentId} onChange={(e) => setSegmentId(e.target.value)} style={{ width: "100%" }}>
          <option value="">Whole list (no segment)</option>
          {(segments.data ?? []).map((s) => (
            <option key={s.segmentId} value={s.segmentId}>{s.name} ({s.segmentId})</option>
          ))}
        </select>
        {segmentId && (
          <p className="muted" style={{ margin: "6px 0 0" }}>
            Only members of this segment who are <strong>confirmed on {listId || "the list"}</strong> will
            be sent to — segment membership is not consent.
          </p>
        )}
        <label style={{ marginTop: 12 }}>Campaign id</label>
        <input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="e.g. daily-2026-07-21" style={{ width: "100%" }} />
        <label style={{ marginTop: 12 }}>Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line" style={{ width: "100%" }} />
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span className="muted">Body</span>
          <span style={{ display: "flex", gap: 12 }}>
            {(["blocks", "html", "mjml"] as const).map((m) => (
              <label key={m} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="radio" name="bodyMode" checked={bodyMode === m} onChange={() => setBodyMode(m)} />
                {m === "blocks" ? "Blocks" : m === "html" ? "Raw HTML" : "MJML"}
                {/* The three modes are independent state, so switching keeps
                    what was typed — but the submit path reads ONLY the selected
                    one, and nothing said so (#249). A mode holding text that
                    will not be sent is the whole failure: the operator's model
                    is "my draft is here", and the send disagrees. */}
                {bodyMode !== m && filledBodyModes.includes(m) && (
                  <span className="muted" title="This mode holds a draft that will not be sent.">
                    · has a draft
                  </span>
                )}
              </label>
            ))}
          </span>
        </div>
        {otherFilledModes.length > 0 && (
          <p className="muted" style={{ margin: "0 0 8px" }}>
            Sending the <strong>{MODE_LABELS[bodyMode]}</strong> body.{" "}
            {otherFilledModes.map((m) => MODE_LABELS[m]).join(" and ")}{" "}
            {otherFilledModes.length > 1 ? "hold drafts that are" : "holds a draft that is"} kept
            here but not sent — switch back to send {otherFilledModes.length > 1 ? "one" : "it"}.
          </p>
        )}
        {bodyMode === "mjml" ? (
          <div>
            {mjmlTemplates.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <label>Load a saved MJML template (copy)</label>
                <select defaultValue="" onChange={(e) => {
                  const t = mjmlTemplates.find((x) => x.templateId === e.target.value);
                  if (t) setMjml(t.source);
                }} style={{ width: "100%" }}>
                  <option value="" disabled>Choose a template…</option>
                  {mjmlTemplates.map((t) => (<option key={t.templateId} value={t.templateId}>{t.name} ({t.templateId})</option>))}
                </select>
              </div>
            )}
            <textarea value={mjml} onChange={(e) => setMjml(e.target.value)} rows={12}
              placeholder={"<mjml><mj-body><mj-section><mj-column>\n  <mj-text>Hi {{first_name}} <a href=\"https://…\">read</a></mj-text>\n</mj-column></mj-section></mj-body></mjml>"}
              style={{ width: "100%", fontFamily: "monospace" }} />
            <p className="muted" style={{ margin: "6px 0 0" }}>
              Compiled to responsive HTML in your browser on schedule; merge tags escaped and links tokenized server-side.
            </p>
          </div>
        ) : bodyMode === "html" ? (
          <div>
            {htmlTemplates.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <label>Load a saved HTML template (copy)</label>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    const t = htmlTemplates.find((x) => x.templateId === e.target.value);
                    if (t) setHtml(t.source);
                  }}
                  style={{ width: "100%" }}
                >
                  <option value="" disabled>Choose a template…</option>
                  {htmlTemplates.map((t) => (
                    <option key={t.templateId} value={t.templateId}>{t.name} ({t.templateId})</option>
                  ))}
                </select>
              </div>
            )}
            <textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={12}
              placeholder={"<h1>Hello {{first_name}}</h1>\n<a href=\"https://…\">Read more</a>"}
              style={{ width: "100%", fontFamily: "monospace" }} />
            <p className="muted" style={{ margin: "6px 0 0" }}>
              Sanitized on schedule. Merge tags are escaped; every {"<a>"} is tokenized per recipient and tracked.
            </p>
          </div>
        ) : (
          <>
        {blocks.map((b, i) => (
          <div key={i} style={{ borderTop: i ? "1px solid #eee" : "none", paddingTop: i ? 10 : 0, marginTop: i ? 10 : 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="muted">{b.kind === "text" ? "Text block" : b.kind === "ad" ? "Ad block" : "Editorial link"}</span>
              {blocks.length > 1 && (
                <button className="btn ghost" onClick={() => removeBlock(i)}>Remove</button>
              )}
            </div>
            {b.kind === "text" ? (
              <textarea value={b.html} onChange={(e) => setBlock(i, { html: e.target.value })}
                placeholder="HTML — {{first_name}} merge tags allowed" rows={3} style={{ width: "100%" }} />
            ) : b.kind === "ad" ? (
              <div style={{ display: "flex", gap: 8 }}><input value={b.slot} onChange={(e) => setBlock(i, { slot: e.target.value })} placeholder="Slot, e.g. ad_top" style={{ flex: 1 }} /><textarea value={b.html} onChange={(e) => setBlock(i, { html: e.target.value })} placeholder="LiveIntent HTML — inserted verbatim" rows={3} style={{ flex: 3, fontFamily: "monospace" }} /></div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <input value={b.label} onChange={(e) => setBlock(i, { label: e.target.value })} placeholder="Link label" style={{ flex: 1 }} />
                <input value={b.url} onChange={(e) => setBlock(i, { url: e.target.value })} placeholder="https://…" style={{ flex: 2 }} />
              </div>
            )}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="btn ghost" onClick={() => addBlock("text")}>+ Text</button>
          <button className="btn ghost" onClick={() => addBlock("editorial")}>+ Editorial link</button>
          <button className="btn ghost" onClick={() => addBlock("ad")}>+ Ad block</button>
        </div>
          </>
        )}
      </div>

      {bodyMode !== "blocks" && (
        <p className="muted">
          Loading a template copies its saved body into this draft. Edits here do not change the
          saved template, and later template changes do not update this draft. Scheduling stores
          the current body, including for recurring sends.
        </p>
      )}

      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>When</div>
        <div style={{ display: "flex", gap: 16 }}>
          {(["now", "at", "recurring"] as const).map((w) => (
            <label key={w} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="radio" name="when" checked={when === w} onChange={() => setWhen(w)} />
              {w === "now" ? "Send now" : w === "at" ? "At a time" : "Recurring"}
            </label>
          ))}
        </div>
        {when === "at" && (
          <div style={{ marginTop: 10 }}>
            <label>Send at (your local time; a 5-minute floor always applies)</label>
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} style={{ width: "100%" }} />
          </div>
        )}
        {when === "recurring" && (
          <div style={{ marginTop: 10 }}>
            <label>Cron expression</label>
            <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="cron(0 13 * * ? *)" style={{ width: "100%" }} />
            <label style={{ marginTop: 8 }}>Timezone (blank → org default)</label>
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Denver" style={{ width: "100%" }} />
            <label style={{ marginTop: 8 }}>Article feed (optional)</label>
            <select value={feedId} onChange={(e) => setFeedId(e.target.value)} style={{ width: "100%" }}>
              <option value="">Use the composed body</option>
              {(feeds.data ?? []).filter((feed) => feed.targetListId === listId).map((feed) => <option key={feed.feedId} value={feed.feedId}>{feed.feedId} ({feed.format})</option>)}
            </select>
            <p className="muted">Each firing fetches the selected feed and builds an edition from its latest items.</p>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn" disabled={!valid || busy} onClick={submit}>
          {busy ? "Scheduling…" : "Schedule"}
        </button>
        {msg && <span className={msg.startsWith("Scheduled") ? "muted" : "err"}>{msg}</span>}
      </div>
    </div>
  );
}
