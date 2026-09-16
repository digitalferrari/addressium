# Tom Whitfield — 2026-09-15

**Build:** HEAD 75d8b5a; stack addressium-dev deployed 2026-09-15T21:14:35Z  **Surface:** admin-web, public-web
**Org:** identithing-newsletter (live) — NOTE: single-org deployment; the cross-org switch at the heart of Tom's walk could not be run

## Journey walked

1. Opened **Branding** (Subscriber-site branding) — presets, Light/Dark, Logo URL, Primary,
   Secondary, Background, and the two-line preview. Read from captured screen text:
   `branding.jpg` was captured scrolled past the form and shows only the sidebar.
2. Opened **Presentation** (Subscriber-site presentation) — list picker, five toggles, two
   label fields. Also read from captured text; `presentation.jpg` is the same scroll artifact.
3. **COULD NOT RUN — the defining step of this persona's walk.** Switch from one org to a
   second org and confirm the first org's logo, palette and background did not follow.
   This deployment has exactly one organization (`identithing-newsletter`). There is no org
   switcher to exercise and no second tenant to bleed into. Cross-org branding isolation —
   the single thing this persona exists to test — is **untested on this build**, not passing.
   Worth saying plainly: a one-org deployment cannot produce evidence either way, so nothing
   in this review should be read as assurance that branding is org-scoped. One further
   mismatch: Tom's fixture scope is `summit,vail`, and this deployment's only org is
   `identithing-newsletter` — so his grant does not cover the org whose branding I reviewed
   at all. Every screen below was read through a `developer_admin` session on a tenant this
   persona has no claim to. The walk was not merely truncated; it was performed elsewhere.
4. Viewed the subscriber-facing site with no credential: `/` (Browse), `/all` (Subscribe to
   all), `/preferences` (Manage subscriptions). Compared what renders against the admin
   controls in steps 1–2.
5. Skimmed Templates, Compose & schedule, Campaigns and Dashboard for anything that shapes
   the reader-facing look.

Nothing was saved and nothing was submitted. No branding value was written, no toggle was
changed, no email address was entered on any public form.

## What worked

The three presets are a genuinely good idea and they are *named for people* — Broadsheet ·
Editor, Marquee · Ad Director, Contrast · A11y. That last one is the one I care about: an
accessibility preset offered as a first-class starting point, not buried in a checkbox at the
bottom. Somebody thought about who is sitting in this chair.

The public pages themselves are well-made. The type on "Ideas worth opening." is confident,
the hierarchy from eyebrow to headline to body reads cleanly, and the card has real restraint —
title, description, one field, one button. The footer line is quiet. Nobody has crowded it.

Presentation's helper copy is the best-written thing in this console: *"A list you have not
configured yet shows exactly what subscribers already see, so saving it unchanged changes
nothing."* That sentence anticipated exactly the question I was about to ask. More screens
should talk to me like that.

And the compliance plumbing is handled somewhere other than my screen. Footer, physical
address and unsubscribe are list-level and system-supplied — I am not being asked to art-direct
a CAN-SPAM block. Correct division of labour.

## What confused me

**The masthead says SUMMIT DAILY. The only newsletter on the site says "Notes from
Identithing."** I stared at this for a while because a brand editor's whole job is that these
two agree, and they do not. This is a live org called `identithing-newsletter` and its public
front door is wearing a different publisher's wordmark — a serif newspaper lockup, styled and
deliberate, not a placeholder box. Searching the repo, "Summit Daily" / `summitdaily` is the
example publisher used throughout the fixtures (`packages/core/src/entities.ts`,
`packages/domain/test/`, the integration tests, the magic-link paywall example). So my reading
is that this is **left-over fixture branding sitting on a live org**, not a default the product
falls back to. That distinction matters: a default is a design decision, this is a demo
artifact that shipped. If a real Identithing reader landed here they would think they were on
the wrong site, and if I had never seen the fixtures I would have no way to tell whether I was
looking at a bug or at a setting somebody set.

**The preview is two words and it cannot tell me anything.** Branding shows me "Primary
heading" and "Secondary accent" in a little swatch. But look at what I am actually theming: a
masthead wordmark, a nav bar, an eyebrow, a display headline, body copy, a card with a border
and a shadow, a sparkle glyph, a text input, and a button. Ten or more surfaces, and the
preview shows two of them. I cannot judge whether my primary is legible on the card, whether
the background gradient fights the card's white, or whether the button's fill has enough
contrast against its own label. I would have to save to a **live** publisher site to find out —
which is exactly the thing you never want a brand tool to make you do. Put the actual card
in the preview, or at minimum the masthead and one card.

**Presentation's five toggles are all unchecked, and the description shows anyway.** "Show
description" is off in the form, yet "Notes from Identithing" is plainly visible on the browse
card and again on `/all`. There is a switch for this and the page ignores it — or the switch is
lying to me about the current state. I could not tell which from the screen, and I do not
think a user should have to. My guess, and it is only a guess from the copy: the picker reads
"Choose a list…" and the form is probably showing empty defaults rather than the Dispatch's
saved config. If that is right, then a form that describes itself as *"exactly what subscribers
already see"* is showing me five falsehoods before I pick a list. It should either preselect the
only list in the org or refuse to render toggles until one is chosen. (Server-side,
`packages/domain/src/admin.ts` defaults `showDescription` to `true` and strips the description
when it is false — so all-unchecked is very likely form state, not truth. I could not confirm
the deployed bundle matches this source.)

**"Powered by addressium" is on every public page and I have no control over it.** Branding
lets me set a logo, three colors and a background, and gives me nothing to remove or replace
the vendor line in the footer. On a live publisher's site that is a conversation I have to have
with my editor-in-chief, and I have no answer for her. Even a note saying "not configurable on
this plan" would be better than a field that simply is not there.

**The same primary renders two different ways.** The Subscribe buttons on `/` and `/all` are a
washed-out periwinkle; "Email me a link" on `/preferences` is a saturated blue. Same brand,
same primary, two treatments. Either those subscribe buttons are in a disabled state that
happens to look like a brand color — which is its own problem, since I read them as the brand —
or two components are deriving the fill differently. A designer cannot ship a palette they
cannot predict.

**One image field for a page made of cards.** The only image control is Logo URL, which is the
masthead. Every list card gets the same generic ✦ sparkle, and so does the `/preferences` card.
With one newsletter that reads as minimalism. With eight it will read as a page of identical
placeholders, and I will have no way to give The Dispatch its own mark.

**The layout is off-balance on the hero pages.** `/` puts everything hard left and leaves the
entire right half of the screen empty — not airy, just unfinished, like a column whose partner
never loaded. `/all` then centers its card under a hero that is still left-aligned, so the eye
tracks left, then jumps to center for no reason. `/preferences` centers everything and is the
only page that looks resolved. Three pages, three alignment schemes.

**`/preferences` ends the conversation without telling me anything.** "Email me a link" and
then nothing — no word on how long the link lives, what to do if it does not arrive, or whether
a wrong address gets told so. It is the page a frustrated reader arrives at, and it is the page
with the least copy on it.

**"Subscribe to all" is not what that screen does.** The nav promises one action; the page is a
checklist titled "Choose your inbox" with nothing pre-ticked. If the label is a promise, tick
the boxes. If the page is right, the nav should say "Choose newsletters."

**Dark mode is unjudgeable from here.** Branding offers Light and Dark; every capture is light.
Not exercised.

## Blocked where I should not have been
Not exercised — screens were captured in a single `developer_admin` session in a one-org deployment. RBAC is asserted in `personas.test.ts`.

## Reached something I should not have
Not exercised — screens were captured in a single `developer_admin` session in a one-org deployment. RBAC is asserted in `personas.test.ts`.

## Verdict
First review, so this is the baseline: the public site is genuinely well-designed, but a live org is wearing a fixture publisher's wordmark, the branding preview is too small to judge anything by, and the persona's one defining test — cross-org isolation — cannot be run on a single-org deployment.
