# @addressium/subscriber-web

Subscriber-facing site (React + Vite SPA): newsletter directory (themed by the
org's **branding** #31, honoring per-list **presentation toggles** #33), double
opt-in confirm landing, and one-click unsubscribe. Branding is applied as CSS
variables at load. Builds to the public S3 + CloudFront distribution.

## Dev
```
npm run dev -w apps/subscriber-web
```
Config: `VITE_API_BASE`, `VITE_ORG_ID`. Subscribers do not log in; the email
address is the identity and confirmation/unsubscribe links carry signed tokens.

For local development, run the API with `npm run dev`, then start this app with
`VITE_API_BASE=http://localhost:4000 VITE_ORG_ID=<org> npm run dev -w apps/subscriber-web`.
