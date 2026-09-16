# Owen Bradlaw — 2026-09-15

**Build:** HEAD 75d8b5a; stack addressium-dev deployed 2026-09-15T21:14:35Z  **Surface:** public-web (subscriber-web unreachable — no URL in stack outputs)
**Org:** identithing-newsletter (live)

## Journey walked

**Owen's entire journey starts in an email client, and is therefore untestable in
this session. Say that first and plainly: none of his four steps could be
performed.**

The walk for this persona is: (1) RFC 8058 one-click unsubscribe from the mail
client, (2) confirm it took effect with no further clicks, (3) request a data
export, (4) request an erasure.

- **Steps 1 and 2 — not performed.** They begin in a received message. No mail
  was sent, received or opened in this session, and no message headers were
  inspected. **Nothing is claimed here about the actual List-Unsubscribe or
  List-Unsubscribe-Post headers — whether they are present, well-formed, or
  honoured is entirely unexamined.** The landing page a one-click unsubscribe
  would reach lives on subscriber-web, which **has no public URL in the stack
  outputs**, so there is no address to visit even independently of the mail.
- **Steps 3 and 4 (export, erasure) — not performed, and not self-servable.**
  There is no export or erasure control anywhere on the public site. Both live in
  the admin console, on the Data & exports screen — "Handle DSAR export and
  erasure requests" — behind `subscribers:manage`, with Erase additionally
  requiring `subscribers:delete`. Those are staff capabilities. Owen holds no
  credential of any kind and cannot reach that screen.

What *could* be reviewed: the three public-web pages at
https://d3n0nygr388rl7.cloudfront.net — `/`, `/all` and `/preferences` — were
loaded and read for any route out. The findings below rest only on that.

**CRITICAL LIMITATION.** Nothing past a Subscribe / Email-me-a-link button could
be exercised in this session. No confirmation mail, no magic link, no RFC 8058
one-click unsubscribe header and no subscriber-web screen was observed.
subscriber-web has no public URL in the stack outputs. Persona 10 could only
review the public-web entry points, not the journey.

## What worked

Nothing I'd call working. The one thing I'll give it is that the promise is at
least *printed* — every page I looked at has "You can unsubscribe at any time"
sitting at the bottom. Fine. Someone thought about it for long enough to type it.
Whether it's true is a different question and I couldn't find out.

## What confused me

I want out. That's the whole of it. So I go to the site to get out, and there is
**no way out on it.** Three pages — Browse, Subscribe to all, Manage
subscriptions — and every single button on all three is a *Subscribe* button. The
word "unsubscribe" appears exactly once anywhere, in small grey text in the
footer, as a promise, not as a way to do it. There is no unsubscribe link, no
"leave," no "stop emailing me." I read the footer promise, I go looking for the
thing it promises, and it isn't there.

So my only route is "Manage subscriptions," and look what that asks me to do:
**give them my email address, and then wait for them to send me another email.**
Read that back. I came here because I don't want mail from these people, and the
first thing they do is take my address and mail me. I have to go and hunt through
my inbox — the inbox I'm trying to clear — for a message from the sender I'm
trying to be rid of, and click a link inside it, before I'm even allowed to
*begin* the process of leaving. If it lands in spam, or the link expires, or it
just never turns up, I'm stuck and there is no one to ask: no support address, no
resend, nothing on the page.

That is not one click. It isn't two. It's: type address, wait, go to inbox, find
mail, open mail, click link, then presumably find the right toggle and save it.
Every one of those is an extra step. The footer says "at any time" — it does not say
"at any time, subject to us successfully emailing you first." For someone who has
stopped trusting the sender, handing that sender your address and waiting on
their goodwill is precisely backwards. This is the finding I'd put at the top, and
it stands on the screenshots alone without needing a single email opened.

And if I want the rest of it — everything they hold on me gone, or just a copy of
it so I can see what they took — there is no button for that either. Not on any
public page. There's apparently a way to do it, but it lives inside their staff console, which
means it isn't mine to use: I have to write in and ask a member of staff to do it
for me, and then trust that they did, and then trust their answer about what
"erased" covered. I can't see the export, I can't verify the erasure, and I have
no timer running on either. For the one part of this with actual legal weight,
the person the data is about is the only person in the building who can't touch
it.

## Blocked where I should not have been

Not applicable — no credential of any kind, and no form was submitted (this stack sends real mail).

## Reached something I should not have

Not applicable — no credential of any kind, and no form was submitted (this stack sends real mail).

## Verdict

Baseline, first review: the whole journey is untestable from here, but from the
captures alone the public site promises "unsubscribe at any time" on every page
while offering no unsubscribe entry point at all — only an emailed-link detour —
and neither export nor erasure is self-servable.
