# Wen Li — 2026-09-15

**Build:** HEAD 75d8b5a; stack addressium-dev deployed 2026-09-15T21:14:35Z  **Surface:** admin-web
**Org:** identithing-newsletter (live) — NOTE: single-org deployment; cross-org comparison, the first step of Wen's walk, could not be run

## Journey walked

Walked from captured artifacts of a live session, not a live `analyst` login. Only the
nine screens an `analyst` sees were reviewed: Dashboard, Analytics, Setup, Campaigns,
Campaign report, API & webhooks, Usage & cost, Cost estimator, Settings.

1. **Compare performance across orgs** — *could not be started.* Looked for a cross-org
   or all-orgs surface across all nine screens. There is none. Every screen that carries
   a number is pinned to one organization: the breadcrumb reads "Identithing Newsletter /
   Dashboard", Setup is titled "Setup · identithing-newsletter", Usage & cost is titled
   "Usage & cost · identithing-newsletter". Separately, this deployment has exactly one
   organization, so even a `developer_admin` could not have exercised the comparison.
2. **Dashboard** — read the 30-day trends block: 2 subscribers, 2 emails sent, 50.0%
   average open rate, 0.0% average click rate; one daily row, 2026-09-15.
3. **Analytics** — the campaign picker offers two campaigns (When check, Report check)
   and a Load button. Below it, the same 30-day trends block as the Dashboard, with the
   same four numbers.
4. **Campaigns** — read the two-row table and the "What this table does not show" panel.
5. **Campaign report** — the picker is the whole screen; the main pane below it is empty
   until a campaign is loaded. Nothing was loaded.
6. **Usage & cost** — first visit rendered only the heading and "Loading…" for over two
   seconds. A second visit with a six-second wait resolved: latest period 2026-09,
   0 total $, 2 emails sent, 0 GB scanned, 0 dedicated IPs; one cost row, all $0.00.
7. **Cost estimator** — read the per-send breakdown ($5.29), the fixed monthly ($5.80)
   and the annual ($346.00).
8. **Setup** and **Settings** — the two ungated screens I am asked to probe. Read the
   checklist and the "Sending identity · live from SES" block on both.

## What worked

The measurement definitions are the best thing in this console, and I do not say that
about many tools. Analytics states up front that "Every percentage on this screen is a
share of sent" and that "Campaign opens and clicks are counted once per subscriber;
per-link clicks count all recorded click events." That is the exact ambiguity that makes
two vendors' open rates un-comparable, and it is answered before I ask. The 30-day trends
block does the same: "Opens and clicks are unique subscribers per day." I know what I am
holding.

The Dashboard's deliverability card is similarly careful — it tells me its rates are "this
edition's own counters, not the 30-day aggregate shown on the dashboard," which is the
kind of scope note I normally have to reverse-engineer from a discrepancy. It even names
what it is *not* showing: audience totals, DKIM/SPF/DMARC state and the send quota.

The Cost estimator is the one screen that behaves like a model rather than a report. Every
line shows its arithmetic — "$4.00 (40,000 × $0.10/1,000)", "$0.60 (40,000 asymmetric Sign
calls × $0.15/10,000)", "52 sends × $5.29 + $5.80/mo × 12" — so I can check it, change an
input, and defend the output. And it is honest about its boundary: list prices captured
2026-07, excluding WAF, data transfer and free tiers, "so treat this as an upper bound."
That is a caveat I can paste into a deck.

Campaigns' "What this table does not show" panel is the same instinct, and I would rather
have it than not. A tool that names its own gaps is a tool I can work around.

## What confused me

**My whole job has no screen.** I am the analyst with scope over every organization, and
there is not one view anywhere in my nine screens that puts two organizations side by side
— or even totals them. Analytics is one org. Campaign report is one campaign in one org.
Usage & cost has the org id in its *title*. The Dashboard is one org's recent campaigns. I
was given the keys to every building and a floor plan for one. I understand this deployment
only has a single org, so I could not have compared anything today regardless — but that is
a data problem, and what I hit is a product problem: the aggregate screen does not exist to
be empty.

**I cannot rank campaigns, which is the first thing anyone asks me for.** Campaigns tells
me plainly: "Open and click rates are per campaign and live on the report screen — there is
no bulk rates route, so they are not columns here." So to answer "which of our sends
performed best," I have to open Campaign report once per campaign and transcribe numbers by
hand. Two campaigns, fine. Fifty, and I am building a spreadsheet the product should have
been. The same panel says "A recurring series aggregates no counters across its editions;
each edition reports on its own" — so I cannot even tell whether a weekly is trending up.
Aggregation is not a nice-to-have for my role; it is the role.

**Analytics and the Dashboard show me the identical block and I do not know why.** Both
render the same 30-day trends: 2 subscribers, 2 emails sent, 50.0% open, 0.0% click. If I
navigate to Analytics expecting the deeper cut, what I actually get is the Dashboard's
block plus a campaign picker I have not used yet. Before I press Load, Analytics adds
nothing over Dashboard. I spent a minute convinced I had mis-clicked the nav.

**The denominators are not on screen and the numbers are tiny.** "50.0% average open rate"
is one open out of two sends. I can only work that out because the daily row happens to
spell it out — "Sent 2, Delivered 2, Opens 1 (50.0%), Clicks 0 (0.0%)". The headline tile
shows me the percentage at the same visual weight it would show a percentage computed over
four hundred thousand sends. Nothing on the tile warns me the sample is two. If I pulled
that 50.0% into a client deck — and a tile that reads "50.0% average open rate" is *asking*
to be pulled into a deck — I would be presenting a coin flip as a performance benchmark.
There is no minimum-sample suppression, no "n=2", no greying. That is the single change I
would most want made.

**Every metric has a trend indicator that never says anything.** "2 emails sent · —",
"50.0% average open rate · —", "0.0% average click rate · —", and "Delivered 100.0% —" on
the deliverability card. That em dash is a comparison slot: it is where a period-over-period
delta goes. It renders empty on every metric on both screens. Either there is no prior
period and the UI should say so, or the comparison is not wired up. As it stands the layout
promises me a trend on four tiles and delivers one on none of them.

**Estimated and actual are on two screens with no bridge between them.** Cost estimator
tells me $346.00 a year, off a per-send breakdown that implies 40,000 recipients. Usage &
cost tells me $0.00 and 2 emails sent. Both are correct; neither acknowledges the other.
Nothing on the estimator says "your actual usage is on Usage & cost," and nothing on Usage
& cost says "here is what this would cost at your target volume." Variance against forecast
is the most ordinary question a cost report answers, and I would have to answer it in my
head, on two tabs.

**Usage & cost made me think it was broken.** A heading and the word "Loading…" for more
than two seconds, with nothing else on the page and no spinner or skeleton. On the first
visit I assumed the screen had failed. It took a second visit and a six-second wait to
resolve. For a cost screen I open specifically to check on a number, that is the worst
possible first impression.

**Campaign report shows me nothing and explains nothing.** A picker, a Load button, and an
empty main pane below — no placeholder, no list of what the report will contain, no "choose
a campaign to see opens, clicks and the per-link map." I do not know whether I am looking at
an unloaded screen or a broken one until I commit to a campaign.

**As a read-only analyst I see the whole deployment's mail plumbing, on two screens.** Setup
and Settings both render "Sending identity · live from SES" and both tell me the account is
in the SES sandbox, that the 24-hour send quota is 200 with 6 used, the max rate is
1/second, and that `www.identithing.com` has no SES identity at all — "SES has no identity
for it. Publishing DNS will not help; the identity itself is missing." Settings is candid
that this is deployment-wide, not org-scoped: "the account sandbox and quota describe the
whole deployment rather than this organization." None of that is my business and none of it
is anything I could act on. It is operational state on a screen aimed at every role,
including the two roles that can change nothing. And it is duplicated verbatim across Setup
and Settings, so I saw it twice before I understood it was one fact.

There is one thing here I *would* want flagged to me and is not: that sandbox limit caps
any volume comparison I could make. The estimator happily models 40,000 recipients a send
on an account that may only mail addresses it has itself verified, against a 200/day quota.
Those two facts live on different screens and never meet.

**API & webhooks hands me a Create key form.** I am read-only, and this screen presents
name, key id and five scope checkboxes with a Create key button. The screen's own note says
"no route in this build is authenticated by one, and their scopes do not gate the operator
console," and SCREENS.md records that the `apikeys:manage` gate is server-side only. So the
form is presumably refused on submit — but from where I sit it reads as an invitation. Same
shape on Campaigns: Pause and Archive render enabled next to a campaign whose status column
already reads `sent`. I did not press anything, so I do not know what would happen; I only
know the UI is not telling me these are not mine.

**A campaign that is `sent` is also `ACTIVE`.** On Campaigns, the status column reads
`sent` while the schedule column reads `ACTIVE`, on both rows. Two words, two columns, one
campaign, and no key explaining that they describe different things. If I am counting
active campaigns for a client, I do not know which column to count.

## Blocked where I should not have been

Not exercised — screens were captured in a single `developer_admin` session, not as `analyst`. RBAC is asserted in `personas.test.ts`.

## Reached something I should not have

Not exercised — screens were captured in a single `developer_admin` session, not as `analyst`. RBAC is asserted in `personas.test.ts`.

## Verdict

First review — no prior baseline: the measurement copy is unusually honest, but the persona defined by `*` org scope has no screen that aggregates anything, across orgs or within one.
