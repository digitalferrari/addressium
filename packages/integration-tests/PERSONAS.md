# Personas

A standing panel of test users. Each one walks the web apps the way a real
person with that job would, then logs what they found. The point is usability
feedback from a consistent cast — the same people returning to the same
journeys, so a regression in the experience shows up as a changed report rather
than a changed reviewer.

Personas are also test fixtures. The machine-readable definitions live in
[`test/personas.ts`](./test/personas.ts)
and are asserted against the real Cedar authorizer by `personas.test.ts`. **That
module is the source of truth for claims and capabilities** — this document
describes the people; the fixtures decide what they can do.

## Persona is not role

Ten personas share five grants. A sales rep and a marketing analyst are both
`analyst`: Cedar cannot tell them apart, and it should not — they differ in what
they come to the console *to do*, and that is exactly what usability feedback is
about. Adding a role per job would mean a new `RoleName` threaded through Cedar
policy generation, the `ROLES` matrix, the console's mirror and Cognito claim
validation, to express a distinction the permission system does not have.

So: **persona = person + duties**, **grant = role × org scope**. The grant axis
matters because `permit` is conditioned on
`principal.allOrgs || principal.orgs.contains(resource.orgId)` — a persona set
that varies role but never scope leaves half that condition untested.

### Org type

Each staff persona is pinned to a **dev** org (fail-closed to an allowlist) or a
**live** org. Same person, same grant, different expected send behavior.

`orgType` is **enforced**, not decorative: `personas.test.ts` drives each
persona's org record through `recipientAllowedForDev` (§4.11,
`packages/domain/src/send.ts`) and asserts that a dev-org persona reaches nobody
off the allowlist, that an empty allowlist reaches nobody at all (fail-closed),
and that a live-org persona is not gated.

One documented gap is pinned rather than papered over: a **missing** org record
currently returns `true` — fail-*open* — because "no org record" is a normal
condition across the send path, so denying there would change the contract for
every send (#201). The test asserts today's behavior, so closing #201 will fail
it and force these expectations to be revisited deliberately.

### API-key scopes are a separate axis

`ApiKeys.tsx` offers `subscribers:write`, `campaigns:read`, `suppression:write`
and friends. Those are **API key scopes for machine credentials**, not staff
capabilities — they are not in the `Capability` union and no persona holds them.
Issuing a key is gated by `apikeys:manage`; what the key may then do is a
separate permission system. Don't conflate the two when reviewing.

---

## The staff panel (admin-web)

All seven authenticate with an admin-pool Cognito **ID token**. Claims are
`custom:role`, `custom:orgs`, `token_use: "id"`.

| # | Persona | Role | Org scope | Org type |
|---|---|---|---|---|
| 1 | **Dana Okafor** — owner / operator | `developer_admin` | `*` | live |
| 2 | **Rafael Nunes** — org admin | `developer_admin` | `summit` | live |
| 3 | **Priya Raman** — campaign editor | `editor` | `summit` | dev |
| 4 | **Tom Whitfield** — content & brand editor | `editor` | `summit,vail` | live |
| 5 | **Marcus Ellery** — sales rep | `analyst` | `summit` | live |
| 6 | **Wen Li** — marketing analyst | `analyst` | `*` | live |
| 7 | **Aisha Bello** — support agent | `support` | `summit` | live |

### 1. Dana Okafor — owner / operator

Runs the deployment. The only persona holding `identity:manage`, `team:manage`,
`apikeys:manage`, `subscribers:delete`, `newsletters:close`, `suppression:manage`
and `alerts:manage`.

- **Walks:** provision a new organization → verify a sending identity → invite a
  teammate and assign a role → issue and revoke an API key → read the audit log.
- **Should be blocked from:** nothing. If Dana cannot do it, no one can — which
  makes her the persona who finds missing functionality rather than missing
  permission.

### 2. Rafael Nunes — org admin

Identical capabilities to Dana, scoped to one tenant. **He exists to prove that
`allOrgs` gates.** A full-capability role must still fail cross-tenant.

- **Walks:** everything Dana does, inside `summit` only.
- **Should be blocked from:** every action against `vail`. Not merely hidden —
  the API must refuse. Try the org switcher; try a `vail` id in a URL.

### 3. Priya Raman — campaign editor

The newsletter writer. Creates and edits newsletter content, builds templates,
schedules sends. Pinned to a **dev org**, so her sends are allowlist-bound.

- **Walks:** compose a newsletter → insert merge tags → build an MJML template →
  preview → schedule (now / at / recurring) → pause and resume a send.
- **Should be blocked from:** deleting subscribers, closing newsletters, editing
  suppression, managing the team, touching identity or API keys.
- **Watch for:** MJML compiles browser-side, so a drip step on an MJML template
  is expected to fail *loudly*. Report the wording if it doesn't.

### 4. Tom Whitfield — content & brand editor

Same `editor` grant as Priya, different day job: the subscriber-facing look. Two
orgs on purpose — **the org switcher and any cross-org bleed only appear at ≥2.**

- **Walks:** set logo, theme and background for `summit` → switch to `vail` →
  confirm `summit`'s branding did not follow him → toggle per-list presentation →
  view the result on the subscriber site.
- **Should be blocked from:** any org that is not `summit` or `vail`.

### 5. Marcus Ellery — sales rep

Pulls numbers for clients. Read-only: `reports:view` and nothing else.

- **Walks:** open a campaign report → read opens, clicks, bounces, complaints,
  delivery rate → drill into the per-link click map → export → check usage & cost.
- **Should be blocked from:** every mutation. **This is the highest-value
  persona for finding false negatives** — a control the nav hides but whose
  endpoint still answers. Note that `Campaigns` is gated on `reports:view`, not
  `campaigns:schedule`, so Marcus can *see* the campaign list by design; its
  lifecycle buttons gate separately inside. Verify they actually do.

### 6. Wen Li — marketing analyst

`analyst` across every org. Same read-only ceiling as Marcus, wider reach.

- **Walks:** compare performance across orgs → aggregate usage and cost → run
  the cost estimator.
- **Should be blocked from:** every mutation, in *every* org — breadth of scope
  must not become depth of capability.

### 7. Aisha Bello — support agent

Fixes subscriber records for people who write in. Holds `subscribers:manage`
**without** `subscribers:delete` — the subtlest line in the matrix.

- **Walks:** find a subscriber → correct an attribute → manually unsubscribe
  them → look up why a message bounced → handle a data request.
- **Should be blocked from:** **deleting a subscriber** (the whole reason this
  role is distinct from `editor`), and from suppression, campaigns, segments,
  templates and branding.

### What each role actually sees

Generated from `Sidebar.tsx` and the `ROLES` matrix — regenerate with
`node scripts/persona-nav.mjs` rather than editing by hand.

| Role | Nav items visible |
|---|---|
| `developer_admin` | 30 / 30 — all |
| `editor` | 23 / 30 — no Newsletters, Suppression, Deliverability, Identity & pools, Organizations, Roles & access, Audit log |
| `analyst` | 9 / 30 — Dashboard, Analytics, Setup, Campaigns, Campaign report, API & webhooks, Usage & cost, Cost estimator, Settings |
| `support` | 13 / 30 — the analyst nine plus Subscribers, both Imports, and Data & exports |

Three capabilities gate **no nav item at all** — `templates:manage`,
`subscribers:delete` and `apikeys:manage`. Templates sits behind
`campaigns:manage` and the other two are enforced inside screens or on the API
only. No persona can exercise them by walking the nav, so they need direct API
coverage; `personas.test.ts` asserts them at the boundary.

Four items are **deliberately ungated**: Dashboard, Setup, API & webhooks, and
Settings (which spans four capabilities and gates each tab itself). Every role
sees them, so they need review attention from the *lowest*-privileged personas —
Marcus and Wen are the ones who should probe what those screens expose.

---

## The end-user panel

No admin credential of any kind. These are not "roles with fewer capabilities";
they authenticate on a different pool or not at all.

### 8. Jordan Alvarez — prospect (public-web)

Has never heard of the product. No credential.

- **Walks:** land on the signup form → enter an address → read the confirmation
  copy → receive the double opt-in mail → confirm → land wherever that leads.
- **Reviewing for:** is it obvious what they signed up for? Does the
  confirmation step explain itself, or look like a dead end? Does the branding
  read as the *publisher's*, or as a generic tool's?

### 9. Neve Carrington — subscriber (subscriber-web)

An existing subscriber managing preferences. Authenticates by **magic link** —
the preference centre is reachable without a password.

- **Walks:** request a link → open it → change which lists she is on → update
  attributes → save → confirm the change stuck.
- **Reviewing for:** does the link flow feel safe or sketchy? Is it clear what
  changed? What happens on an expired or reused link?

### 10. Owen Bradlaw — departing subscriber (subscriber-web)

Wants out. The hardest journey to get right, and the one with legal weight.

- **Walks:** RFC 8058 one-click unsubscribe from the mail client → confirm it
  took effect with no further clicks → separately, request a data export and an
  erasure.
- **Reviewing for:** one click must mean one click. Any extra step is a finding.
  Is the export intelligible to a human? Is erasure honest about what it removes?

---

## Credential mutations

Not an eleventh person — **a test axis applied to personas 1–7**: the same
staff member presenting a broken or forged credential. Enumerated in
`MUTATIONS` in the fixtures module and asserted for every staff persona.

| Mutation | Must be rejected because |
|---|---|
| `token_use: "access"` | Access tokens carry no `custom:*` claims; only the ID token is trusted |
| `custom:orgs: "summit,*"` | `*` is a wildcard only as the *entire* claim — a list containing it must never widen scope |
| missing `custom:role` | Deny by default |
| `custom:role: "wizard"` | An unknown role must not fall through to a default |
| `custom:role: "toString"` | A prototype-chain name must be rejected, not resolved |

One case is deliberately *not* a rejection: an **empty** `custom:orgs` parses
into an empty scope and is refused at `authorize` time rather than at parse
time. Deny by default, enforced at the boundary — even for `developer_admin`.

---

## Logging a review

Keep this file stable; it defines who the personas are. Each *review* is a
snapshot of one build, so it belongs outside the repo — a GitHub issue, or a
local run log. A committed review goes stale the moment the next commit lands and
nothing will ever update it.

Name it `YYYY-MM-DD-<persona-id>` so a series stays sortable. (`PERSONAS.md` and
[`PERSONA-ACCOUNTS.md`](./PERSONA-ACCOUNTS.md) stay here because they describe
who the personas *are* rather than what one run found.)

Persona ids are the `id` field in the fixtures module: `owner`, `org-admin`,
`campaign-editor`, `brand-editor`, `sales-rep`, `marketing-analyst`,
`support-agent`, `prospect`, `subscriber`, `departing-subscriber`.

Template:

```markdown
# <Persona name> — <date>

**Build:** <commit sha>  **Surface:** admin-web | subscriber-web | public-web
**Org:** <org id> (dev|live)

## Journey walked
<the numbered steps actually taken>

## What worked
## What confused me
<in the persona's voice — the value is the reaction, not the diagnosis>

## Blocked where I should not have been
## Reached something I should not have
<anything here is a security finding, not a usability one — escalate it>

## Verdict
<one line: better, worse, or unchanged since the last review>
```

The two "blocked / reached" sections are why the panel is worth running. A
usability complaint is a judgement call; a persona reaching a control its role
does not hold is a bug with a test already waiting to be written for it.

## Keeping this honest

- Fixture addresses are all `@example.com` (RFC 2606). **This stack sends real
  mail** — a persona must never name a deliverable address. Asserted in
  `personas.test.ts`.
- Capability claims in this document are prose; the assertions are in
  `personas.test.ts`. If the two disagree, the test is right.
- The nav tables are generated. Re-run `node scripts/persona-nav.mjs` after any
  change to `Sidebar.tsx` or the `ROLES` matrix.
- The console keeps its own copy of the `ROLES` matrix in
  `apps/admin-web/src/rbac.ts` (it cannot import the server package — cedar-wasm
  has no place in a browser bundle). `rbac-client-drift.test.ts` fails if the two
  diverge.
