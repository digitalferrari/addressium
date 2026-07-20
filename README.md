# addressium

An open-source, self-hostable replacement for the email capabilities of
**Amazon Pinpoint**. Deploy it into your own AWS account, verify a sending
domain, and run email lists, signup forms, broadcasts, and drip automations —
all serverless, at near-zero idle cost.

Pinpoint is being retired. addressium gives teams a path to keep running email
lists on their own infrastructure: **you own the subscriber data** (DynamoDB in
your account) and **you own the sending reputation** (your own Amazon SES
identity). It is not a hosted SaaS — each deployment is a single organization's
system, running entirely in that organization's AWS account.

## Highlights

- **Serverless-first** — DynamoDB on-demand, Lambda, SES, S3/CloudFront. ~$0 at
  idle; you pay AWS directly (~$0.10 per 1,000 emails via SES).
- **Email done well** — signup forms, double opt-in, preference center,
  broadcasts (send-now / scheduled / recurring), and drip automations.
- **Deliverability built in** — DKIM/SPF/DMARC setup, RFC 8058 one-click
  unsubscribe, suppression handling, and complaint-rate protection.
- **Migration-friendly** — first-class importer for Amazon Pinpoint exports and
  CSV (endpoints, segments, suppression lists).
- **One-command deploy** — AWS CDK (TypeScript) plus a guided setup wizard.

## Documentation

- [Architecture & Design](docs/ARCHITECTURE.md) — the canonical system design.

> **Status:** Design phase (pre-implementation). The architecture document is
> the source of truth; implementation follows it.
