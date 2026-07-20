# addressium demo

`index.html` is a **self-contained, static** click-through of the addressium
admin console and subscriber site. It has no backend and stores nothing — every
number and row is illustrative sample data for a fictional publisher
(*Northwind Times* on the reserved `northwindtimes.example` domain).

## Viewing it

Open `demo/index.html` in any browser, or host it. It is a single file with all
CSS/JS inlined, so it can be dropped onto any static host as-is:

```
addressium.com/demo  →  demo/index.html
```

This is the copy intended to be published at **<https://addressium.com/demo>**
and linked from the project README.

> It is a **design reference / prototype**, not the running application. The real
> app is the React SPAs under `apps/` talking to the Lambda API in `services/`.
