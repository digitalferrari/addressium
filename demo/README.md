# addressium demo

`index.html` is a **self-contained, static** click-through of the addressium
admin console and subscriber site. It has no backend and stores nothing — every
number and row is illustrative sample data for a fictional publisher
(*Northwind Times* on the reserved `northwindtimes.example` domain).

## Viewing it

Open `demo/index.html` in any browser, or host it. It is a single file with all
CSS/JS inlined, so it can be dropped onto any static host as-is.

It is published straight from this repo via **GitHub Pages** at
**<https://addressium.com/>** by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml), which uploads
this folder (including the `CNAME` for the custom domain) as the Pages site on
every push to `main`.

One-time repo setup: **Settings → Pages → Source: "GitHub Actions"**, then set
the custom domain to `addressium.com`.

## Honesty convention

The demo holds the same line the docs do: it shows what the code **does**, not
what is planned. Where a screen shows something aspirational it is labelled, and
there is exactly **one** marker — reuse it, don't invent a second vocabulary:

- `<span class="pill p-warn">Not yet built</span>` on the screen header, card
  header or control, and
- a `.note.warn` next to it saying what *is* real and what isn't.

The phrase matches `docs/ARCHITECTURE.md`'s own **not yet built**. Do not
introduce "roadmap", "coming soon", "planned" or "beta".

Decisions that were made *against* a feature (no Pinpoint segment import, no
`SendBulkEmail` batching, no subscriber login, no sandbox mode) are stated with
their reasoning rather than hidden — they are not gaps.

> It is a **design reference / prototype**, not the running application. The real
> app is the React SPAs under `apps/` talking to the Lambda API in `services/`.
> addressium is pre-1.0 and has never been deployed to a real AWS account; the
> banner under the console topbar says so.
