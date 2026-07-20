# Security Policy

Thank you for helping keep addressium and its users safe. addressium is
self-hosted software that handles subscriber data and email-sending
reputation, so we take security reports seriously.

## Reporting a vulnerability

**Please report privately — do not open a public issue for security bugs.**

- Preferred: open a **private GitHub Security Advisory** on this repository
  (`Security` tab → `Report a vulnerability`).
- Alternatively, email the maintainers at **security@** the project domain with
  details and, if possible, a proof-of-concept.

Please include: affected component/version, reproduction steps, impact, and any
suggested remediation.

## Our commitment

- **Acknowledge** your report within **3 business days**.
- Provide an initial **assessment within 7 business days**.
- Work toward a fix and coordinated release, keeping you updated.
- **Credit** you in the advisory and release notes (unless you prefer to remain
  anonymous).

## Coordinated disclosure

We follow coordinated disclosure. Please give us a reasonable window
(typically **90 days**, or sooner once a fix ships) before public disclosure, so
self-hosting operators can upgrade first. We publish fixes as **GitHub Security
Advisories** with CVEs where applicable.

## Safe harbor

We will not pursue or support legal action against researchers who:

- Act in good faith and avoid privacy violations, data destruction, and service
  disruption;
- Only test against **their own deployment** (never another operator's data);
- Give us a reasonable time to remediate before public disclosure.

## Scope

- **In scope:** this codebase (services, packages, infra) and its documented
  deployment.
- **Out of scope:** an operator's own AWS misconfiguration, third-party services
  (Cognito, SES, LiveIntent), and the operator's **main-website** integration
  (the magic-link verifier they run — though we ship a hardened reference so this
  is hard to get wrong; see `docs/SECURITY.md` §4.1).

## Supported versions

Until a 1.0 release, only the latest `main` receives security fixes. A support
matrix will accompany the first tagged release.

For the security **design** and threat model, see
[`docs/SECURITY.md`](./docs/SECURITY.md).
