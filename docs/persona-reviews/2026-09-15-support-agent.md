# Aisha Bello — 2026-09-15

**Build:** HEAD 75d8b5a; stack addressium-dev deployed 2026-09-15T21:14:35Z  **Surface:** admin-web
**Org:** identithing-newsletter (live)

## Journey walked

1. Landed on Dashboard; read sending health and the recent-campaign list.
2. Checked Analytics and the 30-day trends block for context on recent sends.
3. Opened Setup to see whether the org was in a state that would explain delivery complaints.
4. Opened Subscribers and searched by address prefix.
5. Looked for a way to correct an attribute on a subscriber record.
6. Looked for the manual unsubscribe path (`[Unsubscribe all]`, and the "Manually suppress an address" box below the results).
7. Went looking for why a message bounced — checked Subscribers' "Last engaged" column, then looked through the nav for a bounce or suppression view.
8. Opened Import (mapper) and Import (simple).
9. Opened Campaigns and Campaign report to see whether a delivery complaint could be traced to a specific send.
10. Opened Data & exports for the data request.
11. Glanced at API & webhooks, Usage & cost, Cost estimator and Settings.

Nothing was submitted. No address was suppressed, imported, exported, unsubscribed or erased.

## What worked

Search on Subscribers does exactly what it says. The hint under the box tells me it matches the *start* of the address before I waste a search wondering why "gmail" returns nothing — that is the single most useful sentence on the screen for someone working a queue, and it saved me a support-ticket round trip on my very first lookup.

The DSAR half of Data & exports is the best-fitting thing in this console for my job. A subject email field and an Export button, and that is the whole interaction. When someone writes in asking what you hold on them, I can answer it in one step without asking anyone else for help. That part is right.

Data & exports is also honest about the export that matters: "an opt-out you fail to carry across is one you will mail again" is the kind of sentence that stops me doing something stupid on a Friday.

I like that Subscribers has no delete button. I do not want one. The screen says "does not delete" right in the suppress heading, and that lines up with what I was told my job is.

Campaigns being visible is genuinely useful — when someone writes in about a specific email, I can at least see which sends went out and when, and that there were only two.

## What confused me

**The suppress dropdown terrifies me.** It sits one input below my search results, and two of its three options read "Bounce (account-wide, mirrored to SES)" and "Complaint (account-wide, mirrored to SES)". Account-wide. Mirrored into the actual mail provider. I am the person who fixes typos in subscriber records all day, and the control that pushes an address into a provider-level suppression list is the same size, the same shape and the same two clicks as everything else on the page. There is no confirmation step shown between picking "Complaint" and the address being suppressed at the account level. I can see myself misreading which row I was on, picking the wrong option from a three-item dropdown, and permanently breaking mail delivery to a real person at another company — while doing routine ticket work. The default is "Manual (this org only)", which is the right default, and that is the only thing standing between me and the other two.

**Data & exports has an Erase button on it and I do not think I am allowed to press it.** The screen's own copy says "Erase requires the `subscribers:delete` role and will 403 otherwise." I do not hold `subscribers:delete` — that is, I am told, the whole reason my role exists separately. But this screen is gated on a capability I *do* hold, and the Erase control renders on it, styled exactly like every other action button on the page. Whether it is hidden or disabled for `support` is not something this capture can show, and it is the first thing to verify. What I can say is that the only warning I get is a sentence of prose sitting above a checkbox reading "I understand this is irreversible". If I tick that box and press Erase and get a raw 403, I have had a terrible day and a confusing one — I did the thing the screen offered me and the screen told me off in a language I do not speak. And if it ever *doesn't* 403, a subscriber has had a much worse day than I have, permanently. Please decide whether I can do this and then show me that decision in the button, not in a paragraph.

**I was asked to correct an attribute and I could not find where.** The list gives me Email, Status, Entitlement and Last engaged, then `[Open]` and `[Unsubscribe all]`. I assume the editing lives behind Open, but I could not confirm that from the list screen, and nothing on it tells me. For the single most common thing in my queue — "you've spelled my name wrong" — I should not have to guess which button leads to the form.

**I cannot find out why a message bounced.** This is the part of my job with no tool in it. "Last engaged" reads "—" for every subscriber in the list, so it tells me nothing. There is no bounce reason anywhere I can reach. When I went looking, the nav had no Suppression view and no Deliverability view for me. So when someone writes in saying "I stopped getting your newsletter", I can see that they exist, that they are active, and nothing else at all. I have to escalate a question that should take me thirty seconds, every single time.

**The first row of the subscriber list is a real person's address.** It is a live, deliverable personal Gmail account — not an `@example.com` placeholder — sitting in the subscriber base on a screen I am expected to have open all day, on a stack that sends real mail. A `privacy.export` was run against that address. Whatever this record is for, it is real customer data on a routine support screen and it should be treated that way.

**Why can I bulk-import subscribers?** Both Import (mapper) and Import (simple) are open to me, and I cannot think of a ticket where the right answer is for support to paste in a CSV. The consent basis dropdown defaults to "Implicit — an existing relationship", which is the permissive option chosen for me. The copy does reassure me that implicit can only create pending subscriptions — but that reassurance is doing a lot of work for a screen I should probably not be standing in front of.

**Campaign report is an empty room.** I picked it expecting to trace a delivery complaint, and got a campaign picker above an entirely blank pane — no placeholder, no sentence saying what will appear once I load one. I assumed it was broken and moved on.

## Blocked where I should not have been

Not exercised — screens were captured in a single `developer_admin` session, not as `support`. RBAC is asserted in `personas.test.ts`. The Erase-control concern raised above is a UI observation from an admin render, not a confirmed privilege finding.

## Reached something I should not have

Not exercised — screens were captured in a single `developer_admin` session, not as `support`. RBAC is asserted in `personas.test.ts`. The Erase-control concern raised above is a UI observation from an admin render, not a confirmed privilege finding.

## Verdict

First review — no prior to compare against; the support surface can find and unsubscribe a subscriber but gives her no bounce diagnosis at all, and puts account-wide SES suppression and an Erase button within routine reach.
