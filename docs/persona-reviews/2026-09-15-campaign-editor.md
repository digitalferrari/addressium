# Priya Raman — 2026-09-15

**Build:** HEAD 75d8b5a; stack addressium-dev deployed 2026-09-15T21:14:35Z  **Surface:** admin-web
**Org:** identithing-newsletter (live) — NOTE: Priya is defined against a dev org; this deployment's only org is live, so allowlist-bound send behavior was not observable

## Journey walked

Screens traced against Priya's defined walk (compose → merge tags → MJML template → preview → schedule → pause/resume). Captures are from a single `developer_admin` session and **nothing past a submit button was exercised** — no template was saved, no sequence saved, no send scheduled, nothing paused or resumed.

1. Dashboard, Analytics, Setup — the landing and health surfaces.
2. Subscribers, Segments, Import (mapper), Import (simple) — the audience side.
3. **Compose & schedule** — newsletter, segment, campaign id, subject, Body mode (Blocks / Raw HTML / MJML), When (Send now / At a time / Recurring), Schedule.
4. **Merge tags** — the four reserved system tags and the add/update form.
5. **Templates** — the three smoke-test templates (raw_html, mjml, visual) and the new-template form.
6. **Automations** — the enroll block, New sequence with Step 1 (step id, wait, List, Template, Subject), and re-engagement.
7. **Schedules** and **Campaigns** — lifecycle rows with Start / Pause / Archive.
8. Campaign report, Feeds, Ad tags, Data & exports, API & webhooks, Branding, Presentation, Usage & cost, Cost estimator, Settings.

The preview step in her walk has no corresponding control — see below.

## What worked

The explanations are written for me, not at me. On **Templates** the intro actually says what the three modes *are* — "Raw HTML is sanitized on save and rendered per recipient (merge tags escaped, links tokenized for click tracking). MJML and the visual builder compile to responsive HTML in your browser" — so I can pick a mode without asking an engineer which one is safe. That's rare.

**Merge tags** is the best page in here. "Reserved names win" and the line about an imported CSV column called `unsubscribe_url` not being able to replace the real unsubscribe link told me, in one sentence, that I cannot accidentally break the thing that keeps us legal. Seeing the four system tags listed with an example value and the words "System per-recipient" / "System per-campaign" means I know which ones change per reader and which are the same for everyone. I would not have thought to ask that.

**Compose & schedule** is laid out the way I actually work: pick the newsletter, name the send, write the subject, then the body, then when. The When row being three plain radios — Send now / At a time / Recurring — is exactly the decision I'm making, with no calendar widget in the way until I need one. And the block editor offering "+ Text / + Editorial link / + Ad block" as named things rather than generic boxes fits how I think about a newsletter.

**Schedules** and **Campaigns** both say up front that "Nothing is ever deleted" — a paused series stops its next edition and archive keeps history. That is genuinely reassuring on the one screen where I'm most afraid of clicking the wrong button.

The **Templates** note that "Compose loads a COPY of a saved template" is the right warning to have given me, and it's given before I do anything.

## What confused me

**Where is preview?** I was told to build the template, preview it, then schedule. On Compose I picked MJML for the body and then ran out of screen — there's Body, there's When, there's a blue Schedule button, and that's it. Nothing says "see what this looks like." MJML is the mode I was told compiles in my browser, which sounds like the one where I most need to *look* at the result, and it's the one where I get the least reassurance. I'm being asked to press Schedule on a newsletter I have never seen rendered. I would not press it.

**I typed a merge tag that doesn't exist.** The Compose body box literally prompts me with "HTML — `{{first_name}}` merge tags allowed", so I used `{{first_name}}`. Then on Merge tags the only tags registered for us are the four system ones — `unsubscribe_url`, `list_name`, `compliance_footer`, `physical_address`. There is no `first_name`. So the hint in the box named a tag that isn't set up, and nothing on Compose would have told me; I'd have found out from a subscriber named "Hi ,". If Compose is going to name a tag, it should name one I actually have, or warn me when I use one I don't.

**The MJML warning is nowhere near the MJML decision.** Automations opens with "Drip steps render the selected template; use raw_html templates (server-side MJML compile isn't available)." I read it. Then I scrolled past the enroll block, past its three paragraphs about real sends, past the sequence id and trigger and signup list — and by the time I reached Step 1 and the Template dropdown, that sentence was long off my screen. The row where I actually choose is just `step id / wait / List… / Template… / Subject`, with no note attached to it at all. The one place the warning matters is the one place it isn't. (Whether choosing an MJML template there fails loudly was not observable — nothing was submitted.)

**"Saving changes here does not update a body already loaded in Compose or any scheduled campaign, including recurring sends."** I had to read that three times. It means if I fix a typo in our template, every recurring edition already scheduled keeps sending the typo. That is the single most consequential thing on the Templates screen and it's set as a note under the intro, in the same grey as everything else. It deserves to be the loudest thing on the page.

**The sample merge-tag values are someone else's newsletter.** `list_name` shows "The Ledger" and `compliance_footer` shows "Example Times · 123 …", but our only newsletter is The Dispatch. For a second I thought I was looking at another publisher's settings.

**I can pause, but I can't see how to un-pause.** My job includes resuming a send. On Schedules and Campaigns every row has Start / Pause / Archive, and **Start is greyed out on all four rows** while Pause is bright and clickable. So the undo for the scary button is the one that looks unavailable. I'd be afraid to pause anything.

**Campaigns says two things at once.** The rows for When check and Report check read Status `sent` and Schedule `ACTIVE` at the same time, and Pause and Archive are both live on a send that already went out. Sent and active are opposites to me. And on Schedules, three of the four rows say ACTIVE with a dash where the send time should be — active, but never sending, apparently.

**Campaign report is a blank page.** I opened it and got a dropdown and then nothing — no placeholder, no "pick a campaign to see opens and clicks." I assumed it was broken before I thought to use the picker.

**Segments** told me to "Finish every condition above" while the condition row was sitting there with a value field reading "choose a value" and no obvious list to choose from, and Save looked greyed. I couldn't tell whether I'd done something wrong or the screen wasn't ready.

## Blocked where I should not have been

Not exercised — screens were captured in a single `developer_admin` session, not as `editor`. RBAC is asserted in `personas.test.ts`.

## Reached something I should not have

Not exercised — screens were captured in a single `developer_admin` session, not as `editor`. RBAC is asserted in `personas.test.ts`.

## Verdict

First review — baseline: the writing surfaces explain themselves unusually well, but the authoring loop is broken at preview, and the two warnings that matter most (MJML in drip steps, template edits not reaching scheduled sends) are placed where the writer has already scrolled past them.
