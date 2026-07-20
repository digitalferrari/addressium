# @addressium/admin-web

Operator console (React + Vite SPA). Cognito Hosted-UI login (Auth Code + PKCE),
org switcher, dashboard, campaign click-map report with **Analyze with AI**
(#32), subscriber-site **branding** editor (#31), per-list **presentation
toggles** (#33), subscribers (manual suppress), and AI-provider settings. RBAC-
aware controls mirror the server capabilities (the API is the boundary). Builds
to static assets served from S3 + CloudFront (docs/ARCHITECTURE.md §4.1).

## Dev
```
npm run dev -w apps/admin-web
```
Config via env: `VITE_API_BASE`, `VITE_COGNITO_DOMAIN`, `VITE_COGNITO_CLIENT_ID`,
`VITE_REDIRECT_URI`. Build: `npm run build -w apps/admin-web`.
