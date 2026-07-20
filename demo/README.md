# addressium demo

`index.html` is a **self-contained, static** click-through of the addressium
admin console and subscriber site. It has no backend and stores nothing — every
number and row is illustrative sample data for a fictional publisher
(*Northwind Times* on the reserved `northwindtimes.example` domain).

## Viewing it

Open `demo/index.html` in any browser, or host it. It is a single file with all
CSS/JS inlined, so it can be dropped onto any static host as-is.

It is published straight from this repo via **GitHub Pages** at
**<https://digitalferrari.github.io/addressium/>** by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml), which uploads
this folder as the Pages site on every push to `main`.

One-time repo setup: **Settings → Pages → Source: "GitHub Actions"**.

> It is a **design reference / prototype**, not the running application. The real
> app is the React SPAs under `apps/` talking to the Lambda API in `services/`.
