# Open issues — shipped console vs. design prototype

A local tracker. This repo has no GitHub issues wired up for these findings, and
the `#NNN` references scattered through the code comments and `docs/` are cited
rather than linked — so this file is where the next batch lives until something
better exists. Numbering continues from the highest existing citation (#247), so
a reference here does not collide with one already in a comment.

Each entry compares two artefacts:

- **`demo/index.html`** — the click-through prototype published at addressium.com.
  Static, no backend, fabricated data. It is the design reference, not a spec of
  what shipped. It flags its own known gaps with a `Not yet built` pill; those
  are declared intent, **not** defects, and are not filed individually below.
- **`apps/admin-web/src/App.tsx`** + **`apps/admin-web/src/api.ts`** — the real
  console, talking to the live API.

What is filed: shipped behaviour that contradicts something the prototype marks
**Built**; a working backend route with no way to reach it from the console; and
anything that loses data, traps an operator, or shows a number that is wrong or
absent. Cosmetic divergence is collapsed into a single entry (#260) rather than
itemised.

**A correction to the working assumption.** The prototype sidebar is often
described as 12 items in four groups. It is 21 items in five —
`demo/index.html:470-497` also carries a DEVELOPER tail (Identity & pools, Data &
exports, API & webhooks) and a whole CONFIGURE group (Organizations, Roles &
access, Branding, Usage & cost, Settings, Audit log), plus three screens reached
without nav (`compose`, `builder`, `subscriber-detail`). So the shipped Branding,
Usage & cost, Audit log, Team and Add organization screens *do* have design
counterparts, and several entries below are field-by-field comparisons against
them rather than "the prototype has a screen we don't".

---

## High

### #248 — A one-off schedule never records when it sends
**Screen:** Schedules · **Kind:** bug · **Severity:** high

The prototype's Campaigns table gives every row a `When` — `Sat 8:00 ET`, `2h
ago`, `Held 2d` (`demo/index.html:656-662`). The shipped Schedules table renders
`{r.cron ? … : "—"}`, so every one-off reads `Cadence: —`. The value is not
missing from the UI, it is missing from the record: `SendScheduleState` has
`cron`/`timezone` for a recurring series and no field at all for a one-off's
send time. It exists at creation as `campaign.schedule.sendAt`, is passed to
`atExpression`, and is then dropped. An operator looking at a paused one-off
cannot tell whether it was due five minutes ago or next Tuesday — which is
exactly the decision the pause window exists to support. Fixing it spans the
entity type, the write path, the API projection and the UI.
**Where:** `packages/core/src/entities.ts:442-452` · `apps/admin-web/src/api.ts:195-204` · `apps/admin-web/src/App.tsx:832`
**Status:** fixed — `SendScheduleState.sendAt` is written by `markScheduleActive`
from the same instant `recordScheduledCampaign` stamps, and the column (now
headed `When`) renders it as local time plus "in 4 minutes"; cleared on
conversion to recurring, preserved across pause/resume.

### #249 — Switching body mode in Compose silently discards the body
**Screen:** Compose & schedule · **Kind:** bug · **Severity:** high

`bodyMode` selects between three independent state slots — `blocks`, `html`,
`mjml` — and the radio's `onChange` is a bare `setBodyMode(m)`. Clicking a mode
to see what it looks like therefore abandons whatever was typed, with no
confirmation and no way back: the previous slot still holds the text, but the
submit path reads only the current one, and the operator has no signal that
their draft survived or that it did not. There is no draft persistence anywhere
in `Compose`, so a mis-click loses the whole message.
**Where:** `apps/admin-web/src/App.tsx:539-542,648-654,580-597`
**Status:** fixed — with a correction to the premise: the three slots are
separate `useState`, so switching keeps the text; what was missing was any
signal that the unselected slots hold a draft the submit path will not send.
Each mode now marks a held draft, and a banner names both the body that will be
sent and the ones that will not. No draft persistence was added — the text was
never being discarded.

### #250 — A dev org created in the console can never send to anyone
**Screen:** Add organization · **Kind:** bug · **Severity:** high

`CreateOrgInput` carries `devAllowlist`, and `recipientAllowedForDev` is
deliberately fail-closed: a dev org with an empty allowlist sends to nobody.
The Add organization form offers the `prod`/`dev` selector — labelled "dev —
fail-closed to an allowlist" — and then never collects the allowlist. There is
also no org-update route (`GET /orgs/{org}` is the only per-org verb), so the
field cannot be set afterwards either. Choosing `dev` in the console therefore
produces an organization that can never deliver a message, and the failure mode
is silence: campaigns schedule, run, and reach no one. The prototype presents
the allowlist as the answer to "how do I test safely" (`demo/index.html:1303`).
**Where:** `apps/admin-web/src/App.tsx:2255-2261` · `apps/admin-web/src/api.ts:463-473` · `packages/domain/src/send.ts:226-248` · `services/api/src/index.ts:2199`
**Status:** fixed — Add organization collects the allowlist when `dev` is
selected, refuses to submit a dev org with an empty one (creation is the only
chance to set it), and rejects entries `recipientAllowedForDev` cannot match —
`*@example.com` and a bare domain both deny every address they appear to allow.
The fail-closed guard is untouched.

### #251 — The SES suppression import has no console surface
**Screen:** Subscribers (prototype: Suppression) · **Kind:** missing-feature · **Severity:** high

`POST /orgs/{org}/import/suppression` is built, routed and granted
`ListSuppressedDestinations`. Nothing in the console calls it. The prototype
gives it a screen of its own with a dry run, and says plainly why it has to run
*before* the subscriber import: a subscriber base can be re-exported from the
old provider at any time, but "this address hard-bounced two years ago" exists
only on the SES account list. Skipping it means the first campaign after a
migration mails every one of those addresses, straight into the bounce rate the
deliverability halt exists to catch. Today that step is reachable only by
calling the API by hand.
**Where:** `services/api/src/index.ts:1677,2241` · `infra/cdk/lib/control-plane-stack.ts:1447` · `apps/admin-web/src/api.ts` (no client method)
**Status:** fixed — `api.importSuppression` plus a card on Subscribers with a
dry run, gated on `suppression:manage` to match the server rather than offering
a button that 403s. Unmapped reasons are listed with their addresses, not
counted: "4 skipped" reads as housekeeping, and what it means is "4 addresses we
will now mail".

### #252 — Large imports are refused by the only import screens that exist
**Screen:** Import (mapper), Import (simple) · **Kind:** missing-feature · **Severity:** high

The inline import path caps at `INLINE_IMPORT_MAX_BYTES` and returns a 413
naming the route that can do better: `POST /orgs/{org}/import/upload-url` then
`POST /orgs/{org}/import/async`. Both are built (#242). Neither is in `api.ts`,
and both console import screens post inline only — the mapper reads the file
with `FileReader.readAsText` into a string, and the simple importer is a
textarea. Moving a real subscriber base in, on migration day, therefore hits a
413 whose named remedy no screen can perform. The mapper is also CSV-only
(`accept=".csv,text/csv"`, read as text) where the prototype and the async path
both take the gzipped JSON Lines a Pinpoint export job produces.
**Where:** `services/api/src/index.ts:1596-1606,1701,1728,2243-2244` · `apps/admin-web/src/App.tsx:1443-1448,1493,1780-1783`
**Status:** deferred — larger than it reads. The console cannot PUT to the
presigned URL at all until `ImportBucket` carries a CORS rule allowing PUT from
the console origin, and it has none (`infra/cdk/lib/control-plane-stack.ts:379`
sets `blockPublicAccess`, `enforceSSL` and lifecycle rules only). That makes
this an infra + console change whose central step cannot be verified locally,
on top of presign → PUT → async → poll and the gzipped-JSONL accept change.

### #253 — The report drops four counters the API already returns
**Screen:** Campaign report · **Kind:** bug · **Severity:** high

`campaignReport` computes and returns `delivered`, `unsubscribes`, `rejects`,
`renderingFailures` and `deliveryDelays` alongside the five the UI shows. The
report screen renders sent / opens / clicks / bounces / complaints and discards
the rest — including `delivered`, the denominator an operator actually reasons
about, and `renderingFailures`, which means a merge tag did not resolve and is
the only counter here pointing at our bug rather than a recipient's mailbox. The
prototype gives all of them a panel (`demo/index.html:866-876`); the data is
already on the wire and nothing renders it.
**Where:** `packages/domain/src/reporting.ts:20-33` · `apps/admin-web/src/api.ts:80-85` · `apps/admin-web/src/App.tsx:320-327`
**Status:** fixed — the report renders all ten counters, zeros included, so a
rendering failure is readable as a fact rather than inferred from a missing
tile. `rejects`/`renderingFailures`/`deliveryDelays` were also typed as the
literal `0` in `api.ts`, asserting the API never returns a nonzero one; widened
to `number`.

---

## Medium

### #264 — "Loading newsletters…" is also what "no newsletters" looks like
**Screen:** Subscriber site (public) · **Kind:** bug · **Severity:** medium

`AllNewsletters` and `Directory` both gated the spinner on `lists.length === 0`
with no pending flag, and both start from `useState([])`. A request that has
finished and returned an empty array is therefore indistinguishable from one
still in flight, so the public page sits on "Loading newsletters…" forever.

This is not only the empty-org case. `GET /orgs/{org}/directory` answers `200 []`
for an org id that does not exist at all, so a subscriber site built against a
stale or mistyped `VITE_ORG_ID` shows a permanent false spinner rather than
anything an operator could diagnose from. Observed on the deployed public site,
which was still carrying a deleted org's id from an earlier build.

Fixed: an explicit `loaded` flag set in `.finally()` on both call sites, so
pending shows the spinner and loaded-and-empty says no newsletters are published
yet. **Status:** fixed

**Where:** `apps/subscriber-web/src/App.tsx` (`AllNewsletters`, `Directory`)

### #261 — The Dashboard is a count of lists
**Screen:** Dashboard · **Kind:** ux-gap · **Severity:** medium

The shipped Dashboard shows the health badge, the setup nag, and one number:
how many newsletters the org has. The prototype's dashboard is four metric
cards with deltas, a deliverability panel for the latest edition, and a recent
campaigns list — and it marks the trend chart, and only the chart, `Not yet
built`. The deliverability panel and the recent-campaign rows are not charts:
they are the counters and rates that `campaignReport` already returns per
campaign, and the alert thresholds `GET /orgs/{org}/alerts` already returns.
Filed low because nothing is wrong on this screen; it is just that the landing
page of a sending tool tells an operator nothing about sending.
**Where:** `apps/admin-web/src/App.tsx:226-249` · `demo/index.html:517-572`
**Status:** fixed — the Dashboard now shows a recent-campaigns list and a
deliverability panel for the latest sent edition, its rates drawn against the
org's own halt thresholds (`null` alert config renders "no thresholds", not 0%).
The rolling-30-day KPI strip is NOT built: the prototype flags it `Not yet
built` itself (`demo/index.html:525`, a second pill this entry missed), and
nothing on the API aggregates across campaigns or returns a subscriber total, so
every card in it and every "vs last month" delta would have been invented.

### #263 — A one-off that has already sent still reads ACTIVE
**Screen:** Schedules · **Kind:** bug · **Severity:** medium

`ScheduleStatus` is `"active" | "paused" | "archived"` — there is no terminal
state for a one-off that has done its single job, and nothing writes one. The
sender does not transition the lifecycle record after a successful send, so a
fired one-off sits at `active` forever. Observed with four one-offs that had all
sent: every EventBridge schedule was gone (`ActionAfterCompletion: DELETE`) and
all four records still read `active`.

The screen therefore offers Pause and Archive on a send that already went out,
and shows a green ACTIVE badge next to a `When` in the past. Both read as "this
is still going to happen". Pause on a fired one-off is not merely useless — the
#179 deferral path it drives exists to park a delivery that arrives while paused,
which cannot occur once the schedule is deleted, so the control implies a
cancellation it cannot perform.

Two things make this worse than cosmetic rather than merely untidy. `scheduleActive`
treats `active` as the permission to send, so the record cannot distinguish "not
yet fired" from "already fired" for any future redelivery or replay reasoning.
And the list grows without bound: every one-off ever sent stays in the operator's
Schedules view at the same visual weight as a send that has not happened, which
is precisely the screen they are meant to scan when deciding whether to stop
something.

Adding a terminal status touches the type, the sender's post-send path, the
`scheduleActive` predicate (which must keep treating a missing record as active
for legacy rows) and the console's badge and action gating. Note `transitionSchedule`
already models start/pause/archive; the gap is that nothing calls it on success.

**Where:** `packages/core/src/entities.ts` (`ScheduleStatus`),
`packages/domain/src/schedule-state.ts` (`scheduleActive`, `transitionSchedule`),
`packages/domain/src/send.ts` (post-send path), `apps/admin-web/src/App.tsx`
(`Schedules` badge + Start/Pause/Archive gating)

### #254 — There is no campaign list, only a dropdown
**Screen:** Campaign report (prototype: Campaigns) · **Kind:** missing-feature · **Severity:** medium

`GET /orgs/{org}/campaigns` returns `status`, `type`, `listId`, `segmentId`,
`sent` and `sendAt` per campaign. The console's only consumer is the report
screen's `<select>`, which reads `subject` and `campaignId` and throws the rest
away. There is no screen that answers "what has this organization sent, and how
did it do" without picking campaigns one at a time from a dropdown and pressing
Load — which is the first question anyone opens a campaign tool to ask. The
prototype's Campaigns table is exactly these fields.
**Where:** `services/api/src/index.ts:857-874` · `apps/admin-web/src/api.ts:206-215` · `apps/admin-web/src/App.tsx:308-315`

### #255 — Manual drip enrolment has a route and no screen
**Screen:** Drip sequences · **Kind:** missing-feature · **Severity:** medium

`POST /drip-sequences/enroll` is built and routed (#245). It refuses
hand-enrolling into a `signup`-triggered sequence rather than duplicating, and
refuses a subscriber who has not confirmed the list step 0 mails — so the hard
part is done. The console can author a sequence with `trigger: manual` and then
has no way to enrol anybody into it, which makes a manual sequence unusable
from the console entirely. The prototype marks this specific screen `Not yet
built` and says the route works (`demo/index.html:754-756`); it is filed here
because the gap strands a feature the console itself lets you create.
**Where:** `services/api/src/index.ts:990,2224` · `apps/admin-web/src/App.tsx:1988-2004` (trigger selector) · `apps/admin-web/src/api.ts` (no client method)

### #256 — The segment editor is a raw JSON textarea
**Screen:** Segments · **Kind:** ux-gap · **Severity:** medium

The prototype designs a condition builder — field, operator, value, "match ALL"
— that surfaces the API's own 400 and hint in place when a predicate the v1
engine cannot resolve is saved (`demo/index.html:630-642`). The shipped editor
is a `<textarea>` holding hand-written predicate JSON, validated only by
`JSON.parse`, with a placeholder as the sole documentation of the schema. An
operator with no access to the source cannot discover which fields and operators
exist, and a predicate that parses but names a field the engine does not support
fails at the server with a message the screen shows as a raw error string. This
is the screen that decides who receives mail; a typo here is a mis-targeted
campaign.
**Where:** `apps/admin-web/src/App.tsx:1305-1314`

### #257 — Ad blocks can be sent but not authored
**Screen:** Compose & schedule, Templates · **Kind:** missing-feature · **Severity:** medium

`EmailBlock` includes `{ kind: "ad"; slot; html }`, the renderer handles it, and
the schedule boundary hard-sanitizes it — the mechanism the prototype describes
as the part that ships (`demo/index.html:1056`). The Compose block editor offers
only `text` and `editorial`, and `Template.adSlots` is declared in the client
type and populated by nothing. So the ad path exists end to end in the backend
and is unreachable from the console, which for a publisher-facing product means
the revenue-carrying block is the one you cannot place.
**Where:** `apps/admin-web/src/api.ts:166-169,128` · `packages/domain/src/render.ts:17` · `apps/admin-web/src/App.tsx:529,557-558,726-727`

### #258 — Templates and Compose hold separate copies of the same body
**Screen:** Compose & schedule · **Kind:** ux-gap · **Severity:** medium

Compose loads a saved template by copying `t.source` into local `html`/`mjml`
state; the scheduled campaign then carries that snapshot, not a reference. A
template edited after a recurring series is scheduled does not change what the
series sends, and nothing on either screen says so. The prototype treats the
template as the live binding — "Template: Editorial — Daily (MJML)" is a
selection on the campaign (`demo/index.html:682`). Either behaviour is
defensible; the silent divergence between them is not, because the operator's
model is "I fixed the template" and the sends disagree.
**Where:** `apps/admin-web/src/App.tsx:661-668,682-695,580-597`

### #259 — Nothing on the console reads the SES sending identity
**Screen:** Setup (prototype: Settings → Domains) · **Kind:** missing-feature · **Severity:** medium

The prototype is explicit that DKIM/SPF/DMARC state and the SES send quota are
not readable, and that its verification table is a design rather than a reading
(`demo/index.html:903-910`). The shipped Setup screen matches that limit: its
"sending domain" step is `org.domains.length > 0`, and Add organization prints
the DNS records once, at creation, and never again. The consequence is worth
tracking separately from the design gap: after provisioning there is no way from
the console to answer "is this domain verified yet" or "are we still in the SES
sandbox" — the two things that decide whether the org can send at all — and a
new org that cannot send because nobody published the DKIM records is named in
the code as the common failure.
**Where:** `apps/admin-web/src/App.tsx:2291-2318,251-286` · `apps/admin-web/src/api.ts:611`

---

## Low

### #260 — The console has no shell: no orientation, no context, no explanation
**Screen:** all · **Kind:** ux-gap · **Severity:** low

Collapsed into one entry deliberately. The prototype wraps every screen in an
org card (name, domain, environment, switcher), breadcrumbs, a global search
box, a region badge, notifications, an avatar, and one or two lines under each
heading explaining what the screen is for and where its numbers come from. The
shipped console is a flat dark list of 21 undifferentiated links with a bare
`<select>` for the org, no grouping, no search, and headings that read
`Dashboard · —` when no org is selected. Filed as low because none of it changes
what the console can do — but 21 flat links is past the point where an operator
can find a screen they have not used before, and the prototype's five-group
structure exists for that reason.
**Where:** `apps/admin-web/src/App.tsx:117-208` · `demo/index.html:464-512`

### #262 — Presentation saves defaults over unset fields
**Screen:** Presentation · **Kind:** bug · **Severity:** low

`PresentationEditor` prefills from the list's current toggles and falls back to
`DEFAULT_PRESENTATION` for anything unset (#143 fixed the worse version of
this). The two free-text labels still round-trip differently: a list with no
`frequencyLabel` prefills the literal string `"Daily"` from the defaults
constant, and Save writes it as though the operator had typed it. A publisher
whose cadence is weekly gets "Daily" published on their public list page
because they opened the screen to change a checkbox. The screen's own warning —
"Saving overwrites this list's current toggles with the values shown" — is
accurate but does not distinguish a shown value the operator chose from one the
constant supplied.
**Where:** `apps/admin-web/src/App.tsx:2128-2148,2179-2180`

---

## Not filed, and why

These are the largest prototype/console differences that are **not** defects.

**Compared and clean.** Eight shipped screens were read against their design
counterpart and produced no entry: Newsletters, Usage & cost, Cost estimator,
Data requests, Branding, Team & access, Audit log and Deliverability. Branding
is the clearest match — the prototype marks it **Built** with exactly a logo
url, two colours and a background that is `solid` or `gradient`
(`demo/index.html:1433-1448`), and `Branding` in `api.ts:56-61` is that shape
exactly, plus five presets the design does not ask for.

Two near-misses that were considered and passed over. `saveAlertConfig`
hardwires `notifyTargets: []` while the field is real and the prototype designs
an "Also notify" control — the same field-on-the-wire shape as #253, but the
prototype's own argument is that halting is the control and notification is
secondary, so an unwired notify list costs nothing. And the prototype's Usage
screen is a cross-org chargeback table where the shipped one is per-period for a
single org; `api.usage(org)` cannot produce the cross-org view, which makes it a
backend gap rather than a console one.

- Every surface the prototype tags `Not yet built` — Analytics trends, the click
  map overlay, Feeds, Merge tags, Ad tags (the management screen, as opposed to
  #257's authoring gap), API keys, series-level reporting, the re-engagement
  policy editor, engagement-recency segments, per-subscriber timelines. These
  are declared design intent that the code has deliberately not implemented, and
  the prototype says so in place.
- **Identity & pools** — the prototype's own copy says every field on it is
  read-only and that no org-update route exists. A screen that can only display
  provisioning output is a fair thing to defer.
- **No "send test"** — absent in both, and argued for in the prototype
  (`demo/index.html:700`): the five-minute lead window and the dev-org allowlist
  are the answer instead. See #250 for the half of that answer the console
  breaks.
- **Subscriber detail as a separate page** — the prototype routes to its own
  screen; the console expands a panel in place. Same information, and the
  shipped panel carries more (live SES suppression check, per-list consent
  provenance, attribute editing).
- **Suppression scope selector** — the prototype offers global / per-org /
  hybrid as a deployment choice. The code implements hybrid and only hybrid,
  which is the recommended option; a selector with one reachable value would be
  worse than none.
