# Neve Carrington — 2026-09-15

**Build:** HEAD 75d8b5a; stack addressium-dev deployed 2026-09-15T21:14:35Z  **Surface:** public-web (subscriber-web unreachable — no URL in stack outputs)
**Org:** identithing-newsletter (live)

## Journey walked

The walk for this persona is: (1) request a link, (2) open it, (3) change which
lists she is on, (4) update attributes, (5) save, (6) confirm the change stuck.

**Only step 1 was reached, and only as far as reading the form.** The
`/preferences` page at https://d3n0nygr388rl7.cloudfront.net was loaded and read:
a card headed "Manage your subscriptions", the copy "Enter your email and we'll
send a private link to update every newsletter subscription", one email field and
an [Email me a link] button. Nothing was typed and the button was not pressed —
this stack sends real mail.

- **Step 1 (request a link) — form observed, not submitted.** No post-submit
  state is evidenced in the capture, because nothing was submitted. Whether the
  page shows a "check your inbox" confirmation, an error, or nothing at all is
  simply not observable here.
- **Steps 2–6 (open the link, change lists, update attributes, save, confirm) —
  not performed and not reachable.** They all live on subscriber-web, and
  **subscriber-web has no public URL in the stack outputs.** There is no address
  to visit. The magic-link mail that would carry Neve there was also never sent
  or inspected.

**The single highest-value thing to verify for this persona.** The admin console's
Identity & pools screen reports, for this same organization, that magic-link
signing is **off**: "Magic links are off for this organization, which is a complete
and valid configuration — not a missing step. It has no signing key, no linked
pool, no token. Its public JWKS endpoint returns an empty key set," and, for the
subscriber user pool, "Linked user pool ID: not configured — No pool linked —
magic links are off for this organization."

So the public site offers an "Email me a link" button for an organization where
magic links are disabled. **What that button actually does — error visibly, fail
silently, or fall back to some other mechanism — is NOT observable from this
capture.** Nothing was submitted, so no behaviour was seen. This is the one thing
worth verifying before anything else in this persona's journey is reviewed again,
because every remaining step (2 through 6) is downstream of it.

**CRITICAL LIMITATION.** Nothing past a Subscribe / Email-me-a-link button could
be exercised in this session. No confirmation mail, no magic link, no RFC 8058
one-click unsubscribe header and no subscriber-web screen was observed.
subscriber-web has no public URL in the stack outputs. Persona 9 could only
review the public-web entry point to her journey, not the journey itself.

## What worked

It took me about four seconds to find. The nav says "Manage subscriptions," I
clicked it, and there's the box — no password, no "log in to continue," no
account I'd have to remember creating. For something I do maybe twice a year
that's exactly right; I genuinely could not tell you a password for a newsletter
and I resent being asked for one. One field, one button, and the sentence tells
me in plain words that it covers *every* newsletter subscription rather than
making me do this once per list. Fine. That's the correct shape.

## What confused me

"We'll send a **private link**." Private how? I've got about ninety seconds for
this and that phrase makes me stop and think, which is the opposite of what I
want. Is it private because it's secret, or private because it expires? If it's a
link that gets me straight into my settings with no password, then anyone holding
it is me — so what happens if my mail client previews it, or I forward the mail
to my husband because he's the one who actually reads this newsletter? Does it
last ten minutes or ten days? Can I use it twice, or is one accidental double-tap
enough to burn it? None of that is on the page, and "private" is doing the work
of explaining it while explaining nothing.

Then I press the button and — I don't know. I don't know what I'm supposed to
see, because I couldn't press it. But looking at the page as it sits there, I
can't see anywhere for a confirmation to appear, nothing that says "check your
inbox," and no hint of what the email will be called or who it comes from so I
know what to look for. If it lands in spam under a sender name I don't recognise,
I'll never find it.

And what if it never comes? There's no "resend," no "didn't get it?", no support
address, nothing. My only option is to type the same address in again and hope,
and by then I've spent ten minutes on a task that should have taken two. At that
point I'd give up on changing my settings and just unsubscribe out of the next
email I got, which I don't think is what anyone wants.

Small thing, but: the page tells me it will email *every* subscription. I'd like
to know how many that is before I commit — one list or twelve — so I know whether
this trip is worth it.

## Blocked where I should not have been

Not applicable — no credential of any kind, and no form was submitted (this stack sends real mail).

## Reached something I should not have

Not applicable — no credential of any kind, and no form was submitted (this stack sends real mail).

## Verdict

Baseline, first review: the request form is fast and password-free, but "private
link" explains nothing about lifetime, reuse or forwarding, no post-submit state
or resend path is evidenced, and the button is offered for an organization whose
admin console reports magic links are switched off — verify that first.
