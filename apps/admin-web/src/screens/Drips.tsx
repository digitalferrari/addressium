import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { isValidId } from "../ids.js";
import { can, type Grant } from "../rbac.js";
import {
  api,
  type DripEnrollment,
  type DripSequence,
  type DripStepDef,
  type ReengagementPolicy,
  type SubscriberDetail,
  type SubscriberRow,
} from "../api.js";
import { SkeletonTable } from "../Skeleton.js";
import { RefreshButton } from "../RefreshButton.js";

interface DraftStep { stepId: string; waitSeconds: string; listId: string; templateId: string; subject: string }

/**
 * The one readable sentence out of an API error (#265).
 *
 * `call` throws `Error("POST /drip-sequences/enroll → 400: {\"error\":\"…\"}")`.
 * Under the error contract the 400 body IS the sentence an operator has to read
 * — an unknown sequence, a signup-triggered one, a subscriber who never
 * confirmed — so showing the raw envelope buries the only useful part. Local to
 * this screen deliberately: every other screen still prints `String(e)`, and a
 * shared unwrapper is a separate change across a file other agents are editing.
 *
 * A 500 is left as the server's own generic text (never the underlying error,
 * which #265 keeps in CloudWatch), and a 403 is named for what it is: the role
 * lacks `campaigns:manage`, and re-trying will not fix it.
 */
export function enrollErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const envelope = /→ (\d{3}): ([\s\S]*)$/.exec(raw);
  // No envelope at all — a network failure, or `UnauthorizedError`'s own text.
  // Whatever it is, it is the whole message: slicing at the first ": " would
  // cut "TypeError: Failed to fetch" down to "Failed to fetch".
  if (!envelope) return raw;
  const status = envelope[1];
  const body = envelope[2] ?? "";
  let sentence = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      sentence = (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON — a gateway or network failure. Keep whatever we were given.
  }
  if (status === "403") {
    return `Refused: your role does not hold campaigns:manage in this organization. (${sentence})`;
  }
  if (status === "500") return `The server could not enroll them: ${sentence}`;
  return sentence || raw;
}

/** How long until the first mail — `nextWaitSeconds` is step 0's OWN wait (#201). */
export function waitLabel(seconds: number): string {
  if (seconds <= 0) return "immediately";
  if (seconds < 60) return `in ${seconds}s`;
  // Singularized, because 86_400 — one day, the most common first wait there is
  // — otherwise reads "in 1 days" on the one line the operator is meant to read
  // before starting real mail.
  const unit = (n: number, word: string) => `in ${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds < 3600) return unit(Math.round(seconds / 60), "minute");
  if (seconds < 86_400) return unit(+(seconds / 3600).toFixed(1), "hour");
  return unit(+(seconds / 86_400).toFixed(1), "day");
}

/**
 * What enrolling this person into this sequence will actually do, stated from
 * the sequence the API returned — never a guess.
 */
export function enrollConsequence(sequence: DripSequence, email: string): string {
  const first = sequence.steps[0];
  if (!first) return `“${sequence.name}” has no steps, so there is nothing to send.`;
  const n = sequence.steps.length;
  return `Sends ${n} email${n === 1 ? "" : "s"} to ${email}, starting with “${first.subject}” ${waitLabel(first.waitSeconds)}.`;
}

/**
 * Whether this subscriber's standing on step 0's list lets the enrolment
 * through — the exact check `enrollManually` makes at the door.
 *
 * `undefined` means "not asked yet": the answer comes from
 * `GET /orgs/{org}/subscribers/{sub}`, and until it lands the console says so
 * rather than guessing a status.
 */
export function consentGate(
  sequence: DripSequence,
  detail: SubscriberDetail | undefined,
): { ok: boolean; message: string } | undefined {
  const listId = sequence.steps[0]?.listId;
  if (!listId) return { ok: false, message: "This sequence has no steps to send." };
  if (!detail) return undefined;
  const state = detail.lists.find((l) => l.listId === listId);
  if (state?.status === "confirmed") {
    return { ok: true, message: `Confirmed on ${state.name} (${listId}) — step 1 may send.` };
  }
  return {
    ok: false,
    message: state?.status
      ? `Not enrollable: ${detail.email} is ${state.status}, not confirmed, on ${listId} — the list step 1 mails.`
      : `Not enrollable: ${detail.email} has no subscription to ${listId} — the list step 1 mails.`,
  };
}

export function Drips({ org, grant }: { org: string; grant: Grant | null }) {
  const [rev, setRev] = useState(0);
  const sequences = useAsync(() => api.dripSequences(org), [org, rev]);
  const lists = useAsync(() => api.lists(org), [org]);
  const templates = useAsync(() => api.templates(org), [org]);
  const reengagement = useAsync(() => api.reengagement(org), [org, rev]);
  const [sequenceId, setSequenceId] = useState("");
  const [name, setName] = useState("");
  const [triggerKind, setTriggerKind] = useState<"signup" | "manual">("signup");
  const [triggerListId, setTriggerListId] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>([{ stepId: "", waitSeconds: "0", listId: "", templateId: "", subject: "" }]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [reBusy, setReBusy] = useState(false);
  const [reMsg, setReMsg] = useState("");
  const [rePolicy, setRePolicy] = useState<ReengagementPolicy>({
    enabled: false,
    coldAfterDays: 180,
    steps: 3,
    stepIntervalDays: 7,
    suppressScope: "org",
    listId: "",
  });

  useEffect(() => {
    const loaded = reengagement.data?.policy;
    if (loaded && reengagement.data?.configured) {
      // The API is the source of truth; hydrate only when the response changes.
      setRePolicy({ ...loaded, listId: loaded.listId ?? "" });
    }
  }, [reengagement.data]);

  const setStep = (i: number, patch: Partial<DraftStep>) =>
    setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addStep = () => setSteps((ss) => [...ss, { stepId: "", waitSeconds: "0", listId: "", templateId: "", subject: "" }]);
  const removeStep = (i: number) => setSteps((ss) => ss.filter((_, j) => j !== i));

  const save = async () => {
    setMsg(""); setBusy(true);
    try {
      const stepDefs: DripStepDef[] = steps.map((s) => ({
        stepId: s.stepId.trim(),
        waitSeconds: Number(s.waitSeconds) || 0,
        listId: s.listId,
        templateId: s.templateId,
        subject: s.subject,
      }));
      const trigger = triggerKind === "signup"
        ? { kind: "signup" as const, listId: triggerListId }
        : { kind: "manual" as const };
      const saved = await api.saveDripSequence({ orgId: org, sequenceId: sequenceId.trim(), name: name.trim(), trigger, steps: stepDefs });
      setMsg(`Saved "${saved.sequenceId}".`);
      setRev((n) => n + 1);
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  const saveReengagement = async () => {
    setReMsg(""); setReBusy(true);
    try {
      const saved = await api.saveReengagement({ orgId: org, ...rePolicy, listId: rePolicy.listId || undefined });
      setRePolicy({ ...saved.policy, listId: saved.policy.listId ?? "" });
      setReMsg(saved.policy.enabled ? "Re-engagement enabled." : "Re-engagement disabled.");
    } catch (e) {
      setReMsg(String(e));
    } finally {
      setReBusy(false);
    }
  };

  const stepsValid = steps.length > 0 && steps.every((s) => isValidId(s.stepId.trim()) && s.listId && s.templateId && s.subject.trim());
  const valid = isValidId(sequenceId.trim()) && name.trim() && stepsValid && (triggerKind === "manual" || !!triggerListId);

  return (
    <div>
      <div className="pagehead">
        <div>
          <h1>Automations</h1>
          <p>Linear drip sequences on Step Functions — waits and sends, in order.</p>
        </div>
        <div className="row">
          {/* The sequence LIST only — deliberately not `reengagement`. An
              effect keyed on `reengagement.data` re-seeds the policy form from
              every new response, so refreshing it would overwrite whatever the
              operator has typed into the re-engagement card. Same reason the
              list and template pickers are left alone: they feed the editor
              below, and a refresh must not cost anyone a half-filled form. */}
          <RefreshButton
            refreshing={sequences.refreshing}
            disabled={sequences.loading}
            onClick={() => void sequences.refetch()}
          />
          <button className="btn" onClick={() => document.getElementById("new-sequence")?.scrollIntoView({ behavior: "smooth" })}>＋ New sequence</button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>
        Automated multi-step sends triggered on signup or manually. Drip steps render the selected
        template; use raw_html templates (server-side MJML compile isn't available).
      </p>
      {sequences.loading && <SkeletonTable rows={4} />}
      {sequences.error && <p className="err">{sequences.error}</p>}
      {sequences.data && sequences.data.length > 0 && (
        <div className="card">
          <table>
            <thead><tr><th>Sequence</th><th>Trigger</th><th>Steps</th></tr></thead>
            <tbody>
              {sequences.data.map((s) => (
                <tr key={s.sequenceId}>
                  <td className="t-strong">{s.name} <span className="muted">({s.sequenceId})</span></td>
                  <td>{s.trigger.kind === "signup" ? `signup → ${s.trigger.listId}` : "manual"}</td>
                  <td>{s.steps.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <EnrollCard org={org} grant={grant} sequences={sequences.data} />

      <div className="card" id="new-sequence">
        <div className="muted" style={{ marginBottom: 8 }}>New sequence</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={sequenceId} onChange={(e) => setSequenceId(e.target.value)} placeholder="sequence id" style={{ flex: 1 }} disabled={busy} />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" style={{ flex: 2 }} disabled={busy} />
        </div>
        <label style={{ marginTop: 12 }}>Trigger</label>
        <div style={{ display: "flex", gap: 16 }}>
          {(["signup", "manual"] as const).map((k) => (
            <label key={k} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="radio" name="triggerKind" checked={triggerKind === k} onChange={() => setTriggerKind(k)} /> {k}
            </label>
          ))}
        </div>
        {triggerKind === "signup" && (
          <div style={{ marginTop: 8 }}>
            <label>Signup list</label>
            <select value={triggerListId} onChange={(e) => setTriggerListId(e.target.value)} style={{ width: "100%" }}>
              <option value="">Choose a list…</option>
              {(lists.data ?? []).map((l) => (<option key={l.listId} value={l.listId}>{l.name} ({l.listId})</option>))}
            </select>
          </div>
        )}
        <div style={{ marginTop: 16 }}>
          <div className="muted" style={{ marginBottom: 8 }}>Steps</div>
          {steps.map((s, i) => (
            <div key={i} style={{ borderTop: i ? "1px solid #eee" : "none", paddingTop: i ? 10 : 0, marginTop: i ? 10 : 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="muted">Step {i + 1}</span>
                {steps.length > 1 && <button className="btn ghost" onClick={() => removeStep(i)}>Remove</button>}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input value={s.stepId} onChange={(e) => setStep(i, { stepId: e.target.value })} placeholder="step id" style={{ flex: 1 }} />
                <input type="number" value={s.waitSeconds} onChange={(e) => setStep(i, { waitSeconds: e.target.value })} placeholder="wait seconds" style={{ flex: 1 }} />
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <select value={s.listId} onChange={(e) => setStep(i, { listId: e.target.value })} style={{ flex: 1 }}>
                  <option value="">List…</option>
                  {(lists.data ?? []).map((l) => (<option key={l.listId} value={l.listId}>{l.name} ({l.listId})</option>))}
                </select>
                <select value={s.templateId} onChange={(e) => setStep(i, { templateId: e.target.value })} style={{ flex: 1 }}>
                  <option value="">Template…</option>
                  {(templates.data ?? []).map((t) => (<option key={t.templateId} value={t.templateId}>{t.name} ({t.templateId})</option>))}
                </select>
              </div>
              <input value={s.subject} onChange={(e) => setStep(i, { subject: e.target.value })} placeholder="Subject" style={{ width: "100%", marginTop: 6 }} />
            </div>
          ))}
          <button className="btn ghost" style={{ marginTop: 10 }} onClick={addStep}>+ Step</button>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
          <button className="btn" disabled={!valid || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save sequence"}</button>
          {msg && <span className={msg.startsWith("Saved") ? "muted" : "err"}>{msg}</span>}
        </div>
      </div>
      <div className="card">
        <strong>Re-engagement → sunset</strong>
        <p className="muted">Win back people who have not clicked recently. If they still do not engage after the final step, they are unsubscribed and marked inactive.</p>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <label><input type="checkbox" checked={rePolicy.enabled} onChange={(e) => setRePolicy({ ...rePolicy, enabled: e.target.checked })} /> Enable weekly sweep</label>
          {reengagement.data?.configured && <span className="pill">Configured</span>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
          <label>Cold after (days)<input type="number" min={1} max={3650} value={rePolicy.coldAfterDays} onChange={(e) => setRePolicy({ ...rePolicy, coldAfterDays: Number(e.target.value) })} /></label>
          <label>Win-back emails<input type="number" min={1} max={10} value={rePolicy.steps} onChange={(e) => setRePolicy({ ...rePolicy, steps: Number(e.target.value) })} /></label>
          <label>Days between steps<input type="number" min={1} max={365} value={rePolicy.stepIntervalDays} onChange={(e) => setRePolicy({ ...rePolicy, stepIntervalDays: Number(e.target.value) })} /></label>
          <label>Send from list<select value={rePolicy.listId ?? ""} onChange={(e) => setRePolicy({ ...rePolicy, listId: e.target.value })}><option value="">Choose a list…</option>{(lists.data ?? []).map((l) => <option key={l.listId} value={l.listId}>{l.name} ({l.listId})</option>)}</select></label>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
          <button className="btn" disabled={!can(grant, "campaigns:manage", org) || reBusy} onClick={() => void saveReengagement()}>{reBusy ? "Saving…" : "Save re-engagement"}</button>
          {reMsg && <span className={reMsg.includes("enabled") || reMsg.includes("disabled") ? "muted" : "err"}>{reMsg}</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * Hand-enrolment — `POST /drip-sequences/enroll` (#255/#283).
 *
 * The route has been wired and IAM-granted since #245 with nothing in the
 * console calling it. This is the one enrollment path with no double opt-in in
 * front of it: an operator names a subscriber and real marketing mail starts
 * going out, so the card is built to make that legible BEFORE the button fires
 * rather than to report it afterwards.
 *
 * Three things follow from that:
 *
 * - Only `manual` sequences are offered. Signup-triggered ones are a 400 from
 *   the domain (hand-starting one would deliver every step twice), so putting
 *   them in the picker would only be a way to earn that error. This is UX, not
 *   a client-side check — the server still refuses either way.
 * - The subscriber is RESOLVED, never typed. The API takes a `subscriberId`,
 *   not an email; free text would either 400 as "no confirmed subscription" for
 *   an id that does not exist, or trip the 64-char cap. `api.subscribers(org,
 *   q)` searches by email PREFIX (an index key condition, not a substring
 *   match), and the operator picks a row.
 * - Consent is shown before the click. `api.subscriber` returns per-list
 *   status, so the console can say "not confirmed on the list step 1 mails" —
 *   the refusal `enrollManually` would issue — rather than letting the operator
 *   discover it from a red error.
 *
 * What is NOT shown, because nothing can answer it: how many people are
 * enrolled, or where in a sequence anyone is. No enrollment is persisted; a run
 * exists only as a Step Functions execution name, and no role holds
 * `ListExecutions`.
 */
function EnrollCard({
  org,
  grant,
  sequences,
}: {
  org: string;
  grant: Grant | null;
  sequences: DripSequence[] | undefined;
}) {
  const [sequenceId, setSequenceId] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<SubscriberRow | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<DripEnrollment | null>(null);

  const allowed = can(grant, "campaigns:manage", org);
  const manual = (sequences ?? []).filter((s) => s.trigger.kind === "manual");
  const sequence = manual.find((s) => s.sequenceId === sequenceId);

  // Both reads are conditional, and `useAsync` cannot skip — they resolve to a
  // sentinel instead, exactly as its doc comment prescribes.
  const matches = useAsync(
    async () => (query ? (await api.subscribers(org, query, undefined, 10)).rows : null),
    [org, query],
  );
  const detail = useAsync(
    async () => (picked ? await api.subscriber(org, picked.sub) : null),
    [org, picked?.sub],
  );

  const gate = sequence ? consentGate(sequence, detail.data ?? undefined) : undefined;
  const ready = allowed && !!sequence && !!picked && gate?.ok === true && !busy;

  const reset = () => {
    setConfirming(false);
    setPicked(null);
    setQ("");
    setQuery("");
  };

  const enroll = async () => {
    if (!sequence || !picked) return;
    setErr(""); setDone(null); setBusy(true);
    try {
      setDone(await api.enrollInDrip(org, sequence.sequenceId, picked.sub));
      reset();
    } catch (e) {
      setErr(enrollErrorText(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="muted" style={{ marginBottom: 8 }}>Enroll a subscriber</div>
      <p className="muted" style={{ marginTop: 0 }}>
        Starts a <strong>real</strong> sequence of sends to one person, with no opt-in step in
        front of it — the sequence begins the moment this is clicked, and when the first mail
        goes out is whatever step 1&rsquo;s wait says. Only <code>manual</code> sequences can be
        hand-enrolled: a signup-triggered one enrolls on double opt-in, and starting it by hand
        would deliver every step twice.
      </p>

      {!allowed && (
        <p className="err" style={{ marginTop: 0 }}>
          Your role cannot enroll subscribers — this needs <code>campaigns:manage</code>{" "}
          in {org || "this organization"}.
        </p>
      )}
      {sequences && manual.length === 0 && (
        <p className="muted" style={{ marginTop: 0 }}>
          This organization has no manual sequences. Set a sequence&rsquo;s trigger to{" "}
          <code>manual</code> below to make it hand-enrollable.
        </p>
      )}

      <label>Sequence</label>
      <select
        value={sequenceId}
        onChange={(e) => { setSequenceId(e.target.value); setConfirming(false); setDone(null); setErr(""); }}
        style={{ width: "100%" }}
        disabled={!allowed || manual.length === 0 || busy}
      >
        <option value="">Choose a manual sequence…</option>
        {manual.map((s) => (
          <option key={s.sequenceId} value={s.sequenceId}>
            {s.name} ({s.sequenceId}) — {s.steps.length} step{s.steps.length === 1 ? "" : "s"}
          </option>
        ))}
      </select>

      <label style={{ marginTop: 12 }}>Subscriber</label>
      <div style={{ display: "flex", gap: 8 }}>
        {/* Enter resets exactly as Find does, `setConfirming(false)` included: a
            new search drops the pick, and an armed confirmation whose subscriber
            has gone renders NEITHER button — `!confirming` hides "Enroll →", and
            `confirming && picked` hides the confirm pair. */}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { setPicked(null); setConfirming(false); setQuery(q.trim()); } }}
          placeholder="Email starts with…"
          style={{ flex: 1 }}
          disabled={!allowed || busy}
        />
        <button
          className="btn ghost"
          disabled={!allowed || !q.trim() || busy}
          onClick={() => { setPicked(null); setConfirming(false); setQuery(q.trim()); }}
        >
          Find
        </button>
      </div>
      {/* Prefix, not substring: the server serves `q` as a key condition on the
          email index, so "ledger" will not find "reader@ledger.example.com". */}
      <p className="muted" style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }}>
        Matches the <strong>start</strong> of an address. Enrollment is by subscriber id, so one has
        to be picked from the results — an address typed here is not sent to the API.
      </p>

      {matches.loading && query && <p className="muted">Searching…</p>}
      {matches.error && <p className="err">{matches.error}</p>}
      {matches.data && matches.data.length === 0 && (
        <p className="muted">No subscriber in {org} whose address starts with “{query}”.</p>
      )}
      {matches.data && matches.data.length > 0 && (
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Email</th><th>Subscriber</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {matches.data.map((r) => (
              <tr key={r.sub}>
                <td className="t-strong">{r.email}</td>
                <td className="muted"><code>{r.sub}</code></td>
                <td className={r.status === "suppressed" ? "err" : "muted"}>{r.status}</td>
                <td>
                  {picked?.sub === r.sub
                    ? <span className="muted">Chosen</span>
                    : <button className="btn ghost" disabled={busy} onClick={() => { setPicked(r); setConfirming(false); setDone(null); setErr(""); }}>Choose</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {sequence && picked && (
        <div style={{ marginTop: 12 }}>
          {detail.loading && <p className="muted">Checking {picked.email}&rsquo;s consent…</p>}
          {detail.error && (
            <p className="err">
              Could not read {picked.email}&rsquo;s subscriptions, so whether this enrolment is
              allowed is unknown: {detail.error}
            </p>
          )}
          {gate && <p className={gate.ok ? "muted" : "err"}>{gate.message}</p>}
          {gate?.ok && (
            <p className="t-strong" style={{ marginBottom: 6 }}>{enrollConsequence(sequence, picked.email)}</p>
          )}
          {/* `enrollManually` makes no suppression check, so this enrolment
              would succeed — and then `evaluateDripStep` EXITS on a suppressed
              subscriber at step 1, before any send. Stated, not used to
              disable: the server is the boundary and it does allow this. */}
          {gate?.ok && picked.status === "suppressed" && (
            <p className="err" style={{ marginTop: 0 }}>
              {picked.email} is suppressed org-wide. The enrolment will be accepted, and then the
              sequence exits at step 1 without sending anything.
            </p>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
        {!confirming && (
          <button className="btn" disabled={!ready} onClick={() => setConfirming(true)}>Enroll →</button>
        )}
        {confirming && sequence && picked && (
          <>
            <button className="btn" disabled={!ready} onClick={() => void enroll()}>
              {busy ? "Enrolling…" : `Yes — start sending to ${picked.email}`}
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            <span className="muted">
              Enrolling again later starts another run: each click is its own enrollment.
            </span>
          </>
        )}
        {err && <span className="err">{err}</span>}
      </div>

      {done && (
        <p className="muted" style={{ marginTop: 10 }}>
          Enrolled {done.subscriberId} in “{done.sequenceId}”. Step {done.nextStepIndex + 1} sends{" "}
          {waitLabel(done.nextWaitSeconds)}. Enrollment id{" "}
          <code>{done.enrollmentId}</code> — the only handle this run has; no
          progress through the sequence is recorded anywhere to read back.
        </p>
      )}
    </div>
  );
}
