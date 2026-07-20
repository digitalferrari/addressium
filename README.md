# addressium

An open-source, self-hostable replacement for the email capabilities of
**Amazon Pinpoint**. Deploy it into your own AWS account, verify a sending
domain, and run email lists, signup forms, broadcasts, and drip automations —
all serverless, at near-zero idle cost.

Pinpoint is being retired. addressium gives teams a path to keep running email
lists on their own infrastructure: **you own the subscriber data** (DynamoDB in
your account) and **you own the sending reputation** (your own Amazon SES
identity). It is not a hosted SaaS — a single deployment runs one or many
**organizations (silos)**, all operated by the same owner, entirely in that
owner's AWS account.

## Highlights

- **Serverless-first** — DynamoDB on-demand, Lambda, SES, S3/CloudFront. ~$0 at
  idle; you pay AWS directly (~$0.10 per 1,000 emails via SES).
- **Multi-organization** — run several publications as isolated silos (per-org
  subscriber pool, signing key and sending identity) from one deployment.
- **Email done well** — signup forms, double opt-in, preference center,
  broadcasts + ongoing series, and drip automations.
- **Deliverability built in** — DKIM/SPF/DMARC setup, RFC 8058 one-click
  unsubscribe, suppression handling, complaint-rate protection, SNS alerts.
- **Role-based access** — Developer Admin / Editor / Analyst (Sales) / Support,
  scoped per organization and enforced server-side.
- **Migration-friendly** — first-class importer for Amazon Pinpoint exports and
  CSV (endpoints, segments, suppression lists).
- **One-command deploy** — AWS CDK (TypeScript) plus a guided setup wizard.

## Documentation

- [Architecture & Design](docs/ARCHITECTURE.md) — the canonical system design.
- [Security Design & Threat Model](docs/SECURITY.md) — STRIDE model, standards
  mapping, and the hardened magic-link reference verifier.
- [Security Policy](SECURITY.md) — how to report a vulnerability.
- [Clickable UI prototype](docs/prototype/addressium-prototype.html) — the
  admin console + subscriber site design reference (open in a browser).

## Security

addressium is built to public standards — OWASP ASVS (L2) & API Top 10, NIST
SP 800-63B, RFC 8725 (JWT), CIS AWS Foundations, and SLSA/OpenSSF for the supply
chain. The most security-sensitive integration point, the magic-link verifier,
ships as a hardened, copy-paste module: `packages/magiclink-verify`. See
[docs/SECURITY.md](docs/SECURITY.md).

## Repository layout

```
apps/        admin-web · subscriber-web · public-web   (React SPAs)
packages/    core (domain types + zod) · rbac · segment
services/    api · sender · events · automations · reporting · tokens ·
             provisioning · feeds · privacy · importer   (Lambda handlers)
infra/cdk/   CDK app — shared control-plane stack + per-org provisioning
docs/        ARCHITECTURE.md · prototype/
```

## Development

Requires Node 20+. This is an npm-workspaces monorepo.

```bash
npm install       # install all workspaces
npm run build     # tsc --build across packages/services
npm run deploy    # cdk deploy (from infra/cdk) — needs AWS creds
```

> **Status:** Early scaffold. The architecture document is the source of truth;
> package/service stubs are in place and being filled in.
