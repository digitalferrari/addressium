# @addressium/subscriber-web

Subscriber-facing site (React + Vite SPA): newsletter directory (themed by the
org's **branding** #31, honoring per-list **presentation toggles** #33), double
opt-in confirm landing, and one-click unsubscribe. Branding is applied as CSS
variables at load. Builds to the public S3 + CloudFront distribution.

## Dev
```
npm run dev -w apps/subscriber-web
```
Config: `VITE_API_BASE`, `VITE_ORG_ID` (and `VITE_COGNITO_*` for subscriber login).
