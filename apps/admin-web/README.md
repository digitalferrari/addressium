# @addressium/admin-web

Operator console (React + Vite SPA). Cognito Hosted-UI login (Auth Code + PKCE),
org switcher, dashboard, campaign click-map report, subscriber-site **branding**
editor (#31), per-list **presentation toggles** (#33), subscribers (manual
suppress), import mapper, bulk export, team & access, and the audit-log viewer.
RBAC-aware controls mirror the server capabilities (the API is the boundary).
Builds to static assets served from S3 + CloudFront (docs/ARCHITECTURE.md §4.1).

## Dev
```
npm run dev -w apps/admin-web
```
Config via env: `VITE_API_BASE`, `VITE_COGNITO_DOMAIN`, `VITE_COGNITO_CLIENT_ID`,
`VITE_REDIRECT_URI`. Optional `VITE_COGNITO_POOL_ID` displays the staff user pool ID
on Identity & pools; it is not used for sign-in and is separate from an
organization's linked subscriber pool. These values are read at build time.

For local end-to-end development, start the API with `npm run dev`, then start
the SPA with `VITE_API_BASE=http://localhost:4000 npm run dev -w apps/admin-web`.
The console shows an `Enter local development console` button and uses the
development server's seeded `developer_admin` identity; Cognito is not needed.
Build: `npm run build -w apps/admin-web`.
