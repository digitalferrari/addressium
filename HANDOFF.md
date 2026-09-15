# Handoff — admin console defects found by the response-shape audit

Written 2026-09-15 against commit `2de05c5`. Anchors below were verified against
that commit; if you are on a later one, re-grep by symbol name rather than
trusting a line number.

**Division of labour.** Everything under "Frontend" is yours. Everything under
"Backend (not yours)" is being handled separately — do not attempt those, and do
not work around them in the UI, because the fix will land underneath you.

---

## Baseline (measured, not assumed)

```
npm test       1028 tests, 1024 pass, 0 fail, exit 0   (~103s)
npm run test:web   189 pass / 189, 24 files
npx tsc -b     exit 0
```

`npm test` does **not** run admin-web's vitest — it runs `node --test` over
`packages/domain`, `packages/integration-tests` and `infra/cdk` dist output.
Frontend tests are `npm run test:web`. Run both.

The earlier handoff's "root test run did not terminate cleanly / 723 passing"
was an environment artifact, not a code defect. The suite exits 0. There are no
lingering-handle tests to fix; that item is closed.

---

## Running the test suite — you do not need Docker

**Short answer: nothing in the test suite requires a Docker container, and
there is nothing for you to `docker exec` into.** There are no Dockerfiles and
no compose files in this repo. Verified empirically on 2026-09-15 with
`docker ps` reporting **zero containers running**:

```
node --test infra/cdk/dist/test/*.test.js    77 pass / 77, 0 fail
npm test                                     1024 pass / 1028, 0 fail, exit 0
npm run test:web                             189 pass / 189
```

Just run the npm scripts directly. Two things make that work, and both are
worth knowing because they are easy to break:

### 1. Integration tests use dynalite, in-process

`packages/integration-tests` runs DynamoDB **in the same Node process** via
`dynalite` (`dynalite({ createTableMs: 0 })`), not a container. Same for
`scripts/dev-server.mjs`, which serves every route handler verbatim against
dynalite plus an on-disk mail outbox — no AWS, no daemon. So `npm run dev`
needs nothing running either.

If you see `ETIMEDOUT 127.0.0.1` from these tests, it is not Docker — it is a
port or a leaked server handle from a previous run.

### 2. CDK template tests bundle locally — do not undo this

This one has a sharp edge you should understand before touching
`infra/cdk/test/template.test.ts`.

`esbuild` is installed **only** in the CDK workspace
(`infra/cdk/node_modules/.bin/esbuild`); there is **no** esbuild at the repo
root. CDK discovers local bundling by looking on `PATH`. The root `npm test`
launches Node from the repository root, so without help CDK cannot see that
binary and **silently falls back to Docker for every Lambda asset** — which is
why the suite used to need a daemon and took ~15 minutes or timed out.

`infra/cdk/test/template.test.ts` fixes this at the top of the file:

```js
const cdkBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/.bin");
process.env.PATH = `${cdkBin}:${process.env.PATH ?? ""}`;
```

Keep those lines. Deleting them does not fail the test — it makes it slow, or
makes it demand a daemon you do not have. The failure mode is a timeout, not a
clear error, so it is easy to misdiagnose.

The asset that forces bundling work at all is
`nodeModules: ["@cedar-policy/cedar-wasm"]`
(`infra/cdk/lib/control-plane-stack.ts:788`) — a wasm-pack build whose binary
sidecar esbuild cannot inline, so it gets a real npm install during bundling.
Note that `aws:cdk:bundling-stacks: []` does **not** skip that install.

### When Docker *is* actually needed

Only for a real `cdk deploy` / `cdk synth` of the Lambda assets on a machine
without the local esbuild — i.e. the deployment path, which is not yours (see
Deployment at the end). For everything in the Frontend section below, you can
ignore Docker entirely.

### If you do need to inspect a container

There are none to inspect, so there is no `docker exec` workflow here. If you
find yourself reaching for one, something has gone wrong with the PATH fix
above — check that before starting a daemon.

---

## Why these bugs exist, and why the tests are green

`apps/admin-web/src/api.ts` is ~1100 lines, of which the first ~890 are
**locally declared** response interfaces. It imports **zero** types from
`@addressium/core` or `@addressium/domain`.

Two consequences, and they are the reason this audit was necessary:

1. `npx tsc -b` passing proves the screens use *the client's claims about the
   server* consistently. It proves nothing about what a handler returns.
2. The 189 frontend tests **mock the `api` module wholesale**
   (`expect(api.search).toHaveBeenCalledWith(...)`). Response-shape drift is
   invisible to them by construction.

The node suite exercises handlers in isolation. **No test crosses the seam.**

The sharpest illustration: `Campaigns.test.tsx:133` asserts `getByText("sent")`
against a hand-built fixture whose `status` is `"sent"` — a value no production
writer can ever produce (see F1). A passing mocked test can validate a screen
against a state the system cannot reach.

**When you fix these, do not add another mocked-api test as the only
regression guard.** Where a defect is about what the server really returns,
assert against the real handler shape, or at minimum build fixtures from the
handler's actual return statement rather than from `api.ts`'s interface.

### Already verified clean — do not re-audit

- **Route existence.** Every `api.*` call maps to a registered API Gateway
  routeKey (77 client methods vs 86 router keys vs 93 CDK registrations). Zero
  dead controls. Note routes live in three places — `services/api` (routeKey
  dispatch), `services/reporting` / `services/provisioning`, and 71
  `adminRoute()` calls in `infra/cdk/lib/control-plane-stack.ts`. Checking only
  one produces false positives.
- **JWKS URL** is correctly fixed: the handler writes `jwksPath`
  (`services/api/src/index.ts:1195`), `Identity.tsx:275` renders it through
  `absoluteApiUrl`.
- **Ad-tag render path works.** `packages/domain/src/send.ts:621` calls
  `applySeriesAdFills(input.template, series.adSlotFills)`. A prior agent
  reported this as a dead write after grepping `services/sender/src/index.ts` —
  the send logic lives in the domain package, not the sender service.

---

# Frontend — yours

## F1. Campaign status never advances, and a Dashboard feature is dead

**This is the highest-value item. Read it fully before touching either screen.**

`Campaign.status` declares five states (`packages/core/src/entities.ts:446`:
`draft | scheduled | sending | sent | halted`). Production code writes only
`draft`, `scheduled`, `halted`. `"sent"` and `"sending"` appear **only in test
fixtures**.

This is exhaustive for structural reasons, not just grep: `CampaignStore`
(`packages/domain/src/ports.ts:427`) exposes only `get`/`put`/`list` — there is
no partial-update method — and `CAMPAIGNREC#` is written in non-test source only
in `packages/adapters-aws/src/dynamo.ts`, whose one non-`put` mutation targets
`data.counters.<field>` and never `data.status`.

Four consequences:

- **`Dashboard.tsx:64-65` — an entire feature never renders.**
  ```js
  const latestSent = [...campaigns].filter((c) => c.status === "sent").sort(byMostRecentSend)[0];
  if (!latestSent) return { campaigns };
  ```
  `latestSent` is permanently `undefined`, so `loadDashboard` always takes the
  early return. The Dashboard's latest-send report block has never rendered for
  any org, and `api.report` is never called from that screen. The unreachable
  `"sent"` branches at `Dashboard.tsx:163` and `:173` are the same root cause.
- **`Campaigns.tsx:168` — the "Scheduled" filter chip is useless.**
  `case "Scheduled": return r.campaign.status === "scheduled";` matches every
  non-draft, non-halted campaign in the org forever, including everything that
  shipped months ago. It is the one control an operator reaches for to answer
  "what is still pending", and it returns the entire send history.
- **`Campaigns.tsx:41-42`** — `CAMPAIGN_STATUS_COLOR.sent` / `.sending` are
  unreachable dead code.
- **Two adjacent columns contradict each other.** A fully delivered one-off
  renders an orange `scheduled` pill next to a *correct* COMPLETED lifecycle
  pill. The lifecycle machine does advance
  (`packages/domain/src/schedule-state.ts:197` writes `completed`); the campaign
  machine is frozen. `Campaigns.tsx`'s own header comment justifies showing both
  columns by citing "a `sent` one-off can sit on an `archived` lifecycle row" —
  a state no writer can produce.

**Do not "fix" this by writing `status: "sent"` from the frontend.** Advancing
the campaign state machine is a backend change (B3) and is not yours.

Your job is to make the console stop asserting things that are false **given the
data model as it is today**:

- Derive "has this sent?" from the lifecycle row and/or `counters.sent`, which
  *are* maintained, rather than from `campaign.status`.
- Make the "Scheduled" chip mean what an operator reads it to mean.
- Either render the Dashboard latest-send block off a real signal, or remove it
  — but do not leave code that reads as a working feature when it cannot run.
- Drop the unreachable colour entries, or keep them with a comment that says
  plainly they are unreachable until B3 lands.

Coordinate with B3: if the state machine is fixed first, some of this becomes
unnecessary. Check `git log` before starting.

## F2. Dashboard reports a 403 as "no halt threshold configured"

`Dashboard.tsx:100` calls `api.alertConfig(org)` with **no capability gate** —
the file imports neither `can` nor `grant`. The handler requires
`alerts:manage` (`services/api/src/index.ts:2860`), which
`apps/admin-web/src/rbac.ts:14-19` grants **only to developer_admin**. The
other reads on that screen are `reports:view`, held by all four roles — so for
an editor, analyst or support user the screen renders normally and only this one
call 403s.

`api.ts` throws on non-2xx, so `alerts.data` stays undefined, `rule(...)`
(`:218`) returns undefined, `halt` (`:320`) is undefined, and `:333` prints:

```js
{!thresholdApplies ? "—" : halt === undefined ? "none set" : ratePct(halt)}
```

**"none set" is a positive claim that nobody configured a halt threshold** —
rendered on the default landing view, to three of four roles, for an org whose
auto-halt may in fact be armed. The threshold bar is suppressed at `:328`. The
adjacent Auto-halt line simultaneously leaks raw API error text
(`Unknown — Error: GET /orgs/<org>/alerts → 403: …`).

The screen's own comments at `:250-253` and `:315` reason carefully about "none
set" being a claim an operator will act on. The 403 path simply was not
considered.

Note the collision that makes this subtle: `alertConfig` legitimately returns
`null` for an org with no record, which *should* render "none set". Denied and
genuinely-empty are currently indistinguishable in that column. Distinguish
them — gate the call on the capability, and render denied as unknown, not as a
fact.

Never caught because `Dashboard.test.tsx:77` mocks `api.alertConfig` with
`mockResolvedValue` only; the rejection path is never exercised. Add that case.

## F3. AdTags presents load failures as facts about org state

Two separate spots in `apps/admin-web/src/screens/AdTags.tsx`:

- **`:117`** has no `series.error` branch, so a failed `GET /orgs/{org}/series`
  (5xx, network, expired session) renders the affirmative empty state
  **"No recurring series yet. Create one here…"**. `useAsync` leaves `data`
  undefined on rejection, so `rows` is `[]` and `!series.loading` is true.
- **`:96`** gates the per-series report panel on `seriesReport.data` alone, with
  no `loading` or `error` branch anywhere in the file. On failure the screen
  shows nothing at all, and there is no ErrorBoundary in `App.tsx` to surface it.

AdTags is the outlier among its siblings — `Feeds.tsx:78-79`, `Segments.tsx:97`
and `Drips.tsx:194` all render their `useAsync` error, and Feeds additionally
guards its empty state with `!feeds.error`. Follow the sibling pattern.

Scope note: the originally-reported RBAC path for this was **disproved**. Every
role with `campaigns:manage` also has `reports:view`, and `Sidebar.tsx:80` gates
the whole screen on `campaigns:manage`, so no operator can reach this screen,
fail the load on RBAC, and still POST. The claimed destructive
seriesId-collision consequence is therefore not reachable. The confirmed harm is
the misreported load failure alone — fix that, don't chase the rest.

## F4. Customer-sync Save latches off after the first save

`Settings.tsx:143`:
```js
disabled={busy || !endpoint.trim() || !tableName.trim() || (!configured && !secret)}
```
`configured` (`:124`) is `loaded.data?.configured ?? false`, from a `useAsync`
keyed on `[org]` alone, and `Settings.tsx` has no refetch or revision counter.
`save()` (`:130`) does `setSecret("")` and **discards `result.configured`** —
a value the handler does return (`services/api/src/index.ts:2800`) and the
client type does declare (`api.ts:970`).

So after a first-time save the guard's `(!configured && !secret)` term flips
true and Save greys out.

**Correction to the original report, and it matters:** the latch is *not*
permanent, and tab-switching is not the only escape — typing anything into the
secret field re-enables Save. But that workaround is **destructive**: the
handler accepts a blank secret once `secretRef` exists
(`services/api/src/index.ts:2791-2794`), so re-entering a secret merely to
unstick the button force-rotates the secret in Secrets Manager and can silently
break delivery. The stale `configured: false` also suppresses the "(leave blank
only to keep the existing secret)" hint at `:142`, hiding the safe path.

Scope: only bites within the session that performs first-time configuration.

**Fix:** hold `configured` in state seeded from `loaded.data`, and update it
from `result.configured` in `save()`. No frontend test references
`saveCustomerSync` — add one.

## F5. Subscribers / Suppression — the unreachable `global` arm

`Subscribers.tsx:198` branches `s.scope === "org" ? <Lift/> : <span>global</span>`.
The `global` arm is currently unreachable, because the route only ever returns
org-scoped rows. **The root cause is backend (B2) and is not yours** — but once
B2 lands this arm starts rendering, so leave it in place and make sure the
Scope column and the "Lift" affordance behave sensibly for a global row (a
global entry generally should not offer a per-org lift).

Do not paper over B2 by hiding the column.

---

# Backend (not yours) — listed so you understand the UI symptoms

Do not fix these, and do not work around them.

## B1. Every recurring campaign dead-letters — ship blocker

`services/api/src/index.ts:778` stamps `seriesId: body.campaignId` on the
recurring branch. **No code path ever creates the matching `CampaignSeries`.**
`packages/domain/src/send.ts:617` hard-throws `unknown campaign series ${id}`.

UI symptom you may observe: Compose returns 202 and shows a green
`Scheduled "…" (recurring · …)`; the campaign reads ACTIVE on Schedules and
Campaigns; every firing throws before a single message goes out, retries, then
dead-letters. No mail is ever sent and the console never says so.

It is invisible because `recordSeriesEdition`
(`packages/domain/src/admin.ts:241`) stamps `seriesId` onto the edition's
*Campaign* row and the series report filters editions by `campaign.seriesId` —
so `seriesId` looks populated and self-consistent across screens while the
`SERIES#<id>` record the sender actually reads was never written.

## B2. Suppression list hides every global-scope entry

`suppressionsListHandler` (`services/api/src/index.ts:1938`) returns
`stores().suppression.list(orgId)` verbatim, and that store is *intentionally*
org-only (documented `packages/domain/src/ports.ts:344-345`, and unit-tested at
`packages/domain/test/suppression-admin.test.ts:73-77`). But the two write paths
those screens drive — the SES account-list import and manual bounce/complaint
suppression — write exclusively **global**-scope entries.

UI symptom: the operator runs the SES import that `Subscribers.tsx:130` tells
them to run first, sees "Read 12000, wrote 12000", the screen refetches, and the
card below reads "No suppressed addresses." The suppressions are real and do
block sending. The per-address "Check an address" panel *does* see globals (it
uses `entriesFor`), so the same console gives two contradicting answers about
one address.

## B3. Campaign state machine is frozen

The root cause of F1. Nothing advances a campaign to `sending`/`sent`. See F1
for how to keep the console honest until this lands.

---

# Refuted — do not act on these

Both were plausible and both were checked against the files. Recorded so nobody
re-files them.

- **Settings JWKS row** (`Settings.tsx:305`) is *not* a broken control. It
  renders the literal `{org}` when no org is selected, which makes it
  route-template notation in a self-described documentation table ("there is
  nothing to configure"), with no copy affordance. The real vending surface is
  `Identity.tsx`, which is correct.
- **Feed `pullIntervalMins`** is validated, written, echoed back and re-seeded
  into the edit form, and read by nothing. The "no reader" fact is true, but the
  UI already tells the operator it is not wired — a documented limitation, not a
  silent fabrication.

---

# Stale context to ignore

A prior 16-agent run's edits **did not survive** — later commits overwrote that
tree, and `git status` is clean. Its reports are history, not deliverables, and
its test counts (155 with 1 failure, 167/167) describe a tree that no longer
exists and were measured under concurrent-agent contention.

# Deployment

`cdk diff` against the live stack is **additive**: 56 added, 34 modified, 0
removed, 0 replacements, 0 destructive. The additions are the CustomerSync
queue/DLQ/Lambda/alarms plus ~30 API Gateway routes that exist in the router but
were never registered.

**Nothing is deployed, and deploying is not yours.** The public site still runs
the old code. B1 should land before any deploy — shipping now would deliver a
feature that green-lights in the UI and then silently dead-letters.
