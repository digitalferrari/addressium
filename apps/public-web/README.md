# @addressium/public-web

Public signup: a hosted signup page **and** an embeddable widget (`embed.js`)
operators drop into their own site with a copy-paste snippet. Both post double
opt-in signups to the API. Builds to the public S3 + CloudFront distribution.

## Dev
```
npm run dev -w apps/public-web
```
Config: `VITE_API_BASE`, `VITE_ORG_ID`. The embed snippet is shown in the app's
"Embed" tab; `public/embed.js` is the self-contained widget.
