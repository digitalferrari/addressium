# addressium — Security Design & Threat Model

> How addressium protects subscriber data, sending reputation, and its
> multi-tenant boundaries. Every control here maps to a **public, named
> standard** so it can be independently reviewed — nothing bespoke.

- **Status:** Design-level (tracks the scaffold in this repo).
- **Companion docs:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) (system design),
  [`../SECURITY.md`](../SECURITY.md) (how to report a vulnerability).
- **Audience:** contributors, security reviewers, and operators self-hosting
  addressium.

---

## 1. Principles & standards

Secure-by-default, defense-in-depth, least privilege, and **no home-grown
crypto** (KMS + a vetted JOSE library, never our own). We hold ourselves to:

| Area | Standard |
|---|---|
| Application requirements | OWASP **ASVS** (target **Level 2**), OWASP **Top 10 (2021)**, **Proactive Controls** |
| APIs | OWASP **API Security Top 10 (2023)** |
| Tokens & identity | NIST **SP 800-63B**; **RFC 8725** (JWT BCP); RFC **7519/7515/7517/7518**; **RFC 7636** (PKCE); RFC **6749/6819** (OAuth 2.0) |
| Email authentication | **SPF** (7208), **DKIM** (6376), **DMARC** (7489), **ARC** (8617), **BIMI**, **RFC 8058** (one-click unsubscribe) |
| Cloud | AWS **Well-Architected Security Pillar**; **CIS AWS Foundations Benchmark** |
| Governance | NIST **CSF 2.0** / **SP 800-53**; **STRIDE** threat modeling |
| Frontend | OWASP **Secure Headers**; **CSP Level 3** |
| Supply chain | **SLSA**, **OpenSSF Scorecard** + **Best Practices Badge**, **Sigstore/cosign**, **SBOM** (CycloneDX/SPDX) |

---

## 2. Assets & trust boundaries

**Crown-jewel assets:** subscriber PII · SES **sending reputation** · magic-link
**signing keys** · admin access · entitlement data · **cross-org isolation**.

**Trust boundaries** (each crossing is an authorization decision):

```
Internet ─▶ Public plane (unauth)  ─▶ Subscriber plane (Cognito, per-org pool)
                                    ─▶ Admin plane (admin pool + RBAC + org scope)
Main website ◀── JWKS / magic-link token boundary (client-side verify)
AWS account boundary ─▶ per-org silos (orgId partition + per-org KMS key + SES identity)
Build/release ─▶ self-hosted deployment (supply chain)
```

**Adversaries:** external abuser (signup/list-bombing, token forgery,
denial-of-wallet), compromised/malicious admin, cross-tenant attacker, a
forwarded-email recipient, and a poisoned dependency in the supply chain.

---

## 3. Threat model (STRIDE per boundary)

| Boundary | Top threats (STRIDE) | Primary controls |
|---|---|---|
| Public plane | Spoofing, DoS/denial-of-wallet, injection | Double opt-in, WAF + rate limits + CAPTCHA, signed action tokens, input validation |
| Magic-link / main site | **Tampering** (alg confusion, forged token), **EoP** (paywall→account) | RFC 8725 alg-pinning, per-org keys, lite scope, step-up on the main site |
| Subscriber plane | Spoofing, info disclosure | Cognito auth, per-org pool, object-level authz on the subscriber's own `sub` |
| Admin plane | **EoP**, repudiation | Server-side RBAC + org scope, TOTP MFA, immutable audit log |
| Cross-org (tenancy) | **Info disclosure** (BOLA/BFLA) | Server-derived `orgId`, central authz, per-org keys, cross-tenant tests |
| Feeds/webhooks | **SSRF**, spoofed callbacks | Egress allowlist + private-range blocking, signature verification |
| Supply chain | Tampering (build), poisoned deps | SLSA provenance, signed releases, SBOM, pinned CI, OIDC-to-AWS |

---

## 4. Crown-jewel controls

### 4.1 Magic-link token security — the highest-risk surface (RFC 8725)

Verification happens **client-side with a public key** (the page is
CloudFront-cached; see `ARCHITECTURE.md` §8.1), so the classic attack is
**algorithm confusion**: forging an `HS256` token that uses the *public* key
bytes as the HMAC secret, or sending `alg:none`. Requirements for **any**
verifier (ours and every integrator's):

1. **Pin the algorithm to `ES256`.** Reject anything the JWT header selects —
   never let the token choose its own algorithm or key type (RFC 8725 §2.1, §3.1).
2. **Reject `alg:none`** and all symmetric algorithms.
3. Validate `iss`, `aud`, `exp`, `nbf`, `iat`; honor `kid` against the JWKS.
4. **Per-org signing keys** so a token minted for one silo cannot verify against
   another (`ARCHITECTURE.md` §4.11).
5. **Verify, don't decode** — an unverified base64 decode is trivially forged.
6. Enforce the **lite scope** (`scope: "content:read"`, `amr: ["magic_link"]`);
   never elevate a magic-link session — gate profile/account behind step-up.

Because integrators write the client-side half, addressium ships a **hardened
reference verifier** so nobody rolls their own: see
[`packages/magiclink-verify`](../packages/magiclink-verify/src/index.ts). Use it
verbatim in Node (custom-auth Lambda) and the browser.

### 4.2 Multi-tenant isolation — OWASP API #1 (BOLA) / #5 (BFLA)

- `orgId` is **derived from the authenticated grant, server-side** — never
  trusted from a request body/param. The DynamoDB `orgId` partition prefix is
  **defense-in-depth, not the authorization**.
- Authorization is centralized (see [`packages/rbac`](../packages/rbac)) rather
  than ad-hoc per handler; a policy engine (**Cedar**) is the intended path as
  rules grow.
- CI carries **cross-tenant tests** ("can a grant for org A read/write org B?")
  as a required gate.

### 4.3 Admin authorization & audit

- **Server-side RBAC** (capability + org scope) on every mutating handler; the
  console UI mirror is convenience only. Destructive actions
  (delete contacts, close newsletters) are Developer-Admin-only.
- **TOTP MFA required** on the admin pool (enforced in the CDK stack).
- **Append-only audit log**; production uses S3 **Object Lock (WORM)** so history
  cannot be rewritten even by an admin.
- Only Developer Admin can change roles — no privilege-escalation path.

### 4.4 Send-path abuse & denial-of-wallet

The system's purpose is sending mail, so a compromised account is a spam/phishing
cannon aimed at your own reputation, and unauth endpoints are a cost-explosion
vector.

- **Double opt-in** means confirmation goes to the address itself — addressium
  cannot be weaponized to spam third parties.
- **Per-org sending quotas + anomaly alerts** (complaint/bounce spikes → SNS,
  auto-halt thresholds).
- **AWS Budgets** alarms + WAF **rate-based rules** + CAPTCHA cap Lambda/SES
  spend from abuse (denial-of-wallet).

### 4.5 SSRF (feeds) & stored-HTML / XSS

- **Feeds** fetch operator-supplied URLs server-side — textbook **SSRF**. Guard:
  HTTPS-only, **egress allowlist**, block link-local/private ranges
  (`169.254/16`, `10/8`, `172.16/12`, `192.168/16`, `127/8`, `0/8`), reject
  DNS-rebinding by pinning the resolved IP, and set tight timeouts. Reference
  guard: [`services/feeds/src/guard.ts`](../services/feeds/src/guard.ts).
  (Fetchers run in **Lambda, which has no IMDS endpoint** — removing the
  `169.254.169.254` credential-theft path — but internal/VPC SSRF still matters.)
- **Ad tags / raw-HTML templates** are attacker/advertiser-controlled markup.
  Admin previews render only inside a **sandboxed iframe with a strict CSP**;
  merge-tag values are **contextually escaped** so a malicious subscriber
  attribute cannot inject markup.

#### Pre-launch review outcomes (#94)

- **Every send body is sanitized or trusted-by-provenance, uniformly.** `raw_html`
  bodies and **`text`/`ad` blocks** are hard-sanitized (`sanitizeEmailHtml`) at the
  API edge, so blocks mode is no weaker than raw HTML. **`mjmlHtml` is the one
  intentional bypass**: it is HTML our own SPA compiled from operator MJML and is
  trusted as-is so Outlook `<!--[if mso]>` conditional comments survive. Its trust
  boundary is **authenticated admin holding `campaigns:schedule`** — the same
  actor could paste `raw_html` — so it grants no capability that role lacks. Stored
  email HTML is never rendered in a privileged same-origin context (previews use a
  sandboxed iframe), so the bypass cannot become console XSS.
- **Link schemes are restricted in depth.** Editorial/ad link URLs are validated to
  `http(s)`/`mailto` at the schema boundary (`z.string().url()` alone accepts
  `javascript:`), and `renderForRecipient`/`renderHtmlForRecipient` re-check every
  href at send time — so even the trusted `mjmlHtml` path cannot emit a
  `javascript:`/`data:` link (neutralized to `#`).
- **`style` is allowed without a CSS-property allowlist** (accepted risk): inline
  styles are load-bearing for email layout, mail clients strip active CSS
  (`expression()`, `url(javascript:…)`), and merge values are escaped. Revisit with
  `allowedStyles` if a concrete client-side CSS-exfil vector is identified.
- **RBAC:** every route added since the last review (`campaigns` list, `subscribers`
  list, `suppressions` list, `unsuppress`, `import`, `privacy`, `drip-sequences`)
  enforces an explicit capability + org scope; `privacy:erase` requires the stronger
  `subscribers:delete`. **Magic-link verifier** re-audited: pins `ES256`, rejects
  `alg:none`/symmetric (RFC 8725), checks `iss`/`aud`/`exp`/`scope`/`amr`, fails
  closed.

### 4.6 Secrets, keys & webhooks

- Signing keys **never leave KMS** (asymmetric). Application secrets live in
  **Secrets Manager / SSM**, never in the repo (`addressium.config.json` is
  gitignored).
- **Verify inbound webhook signatures** (e.g. billing entitlement sync) and
  **HMAC-sign outbound** webhooks; always **timing-safe** comparison.
- Scheduled key/secret rotation with a JWKS overlap window.

### 4.7 Data protection & privacy

- **Encryption** at rest (KMS on DynamoDB/S3) and in transit (TLS 1.2+).
- **Claim minimization** in tokens; **token redaction** from the event pipeline
  and logs (no bearer tokens at rest).
- **Consent provenance**, configurable retention, and **GDPR/CCPA** export +
  erase-to-tombstone (`ARCHITECTURE.md` §4.19).

---

## 5. Cloud hardening (CIS / Well-Architected)

| Control | Requirement |
|---|---|
| IAM | Least-privilege per Lambda; scoped resource ARNs; **no wildcards**; no long-lived keys |
| Detection | CloudTrail (all regions), GuardDuty, AWS Config, Security Hub |
| Edge | WAF managed rule sets + rate rules on CloudFront/API Gateway |
| Storage | S3 Block Public Access on; SSE-KMS; TLS-only bucket policies |
| Compute | IMDSv2 only (any EC2/containers); minimal Lambda perms; DLQs |
| Budget | AWS Budgets + anomaly alarms (denial-of-wallet backstop) |

## 6. Frontend hardening

Strict **Content-Security-Policy** (no inline where avoidable, `frame-ancestors`
locked), **HSTS**, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
`Permissions-Policy`; Cognito **Authorization Code + PKCE** (no implicit flow);
short-lived tokens with refresh, avoiding long-lived token storage in
`localStorage`. Public one-click unsubscribe is a **signed POST** (RFC 8058) — the
token authorizes the cross-origin request, so no ambient-authority CSRF exists.

## 7. Supply chain & release integrity

Because addressium is **self-hosted OSS**, build/release integrity is a
first-class control:

- **SLSA** build provenance; **Sigstore/cosign**-signed release artifacts.
- Published **SBOM** (CycloneDX) per release.
- GitHub Actions **pinned by commit SHA** (every `uses:` in `.github/workflows/`
  carries a full-SHA pin + a version comment); workflow `permissions`
  least-privilege; **OIDC to AWS** (no static deploy keys). The `deploy` job runs
  only on `refs/tags/v*`, requests `id-token: write`, and assumes the
  `DEPLOY_ROLE_ARN` repo variable's role via `configure-aws-credentials`.
  Create that role once with a GitHub OIDC provider
  (`token.actions.githubusercontent.com`) and a trust policy that restricts
  `sub` to `repo:<owner>/<repo>:ref:refs/tags/v*`; grant it only the CDK
  deploy permissions. No branch/PR run can assume it.
- **Dependabot/Renovate**, **CodeQL**, and **secret scanning** enabled.
- Branch protection + required review; maintainer **2FA**.
- Public trust signals: **OpenSSF Scorecard** + **Best Practices Badge**.
- Coordinated disclosure per [`../SECURITY.md`](../SECURITY.md).

## 8. Secure defaults (a fresh `cdk deploy`)

Out of the box, with no tuning: admin **MFA required**, encryption at rest on all
stores, S3 public access blocked, least-privilege IAM, WAF + rate limiting on
public endpoints, double opt-in default, DKIM/SPF/DMARC guided in the setup
wizard, and secrets sourced from Secrets Manager/SSM. Hardening beyond the
defaults is documented, not assumed.

## 9. ASVS Level 2 — condensed verification checklist

A living checklist mapped to our controls (full ASVS tracked separately):

- **V1 Architecture** — documented threat model (this doc); trust boundaries defined.
- **V2 Authentication** — Cognito + TOTP MFA (admin); NIST 800-63B alignment.
- **V3 Session** — Cognito-managed sessions; magic-link is a **lite, scoped**
  session, never elevated.
- **V4 Access Control** — server-side RBAC + org scope; deny-by-default; BOLA/BFLA tests.
- **V5 Validation/Encoding** — zod validation at the edge; contextual output
  encoding; SSRF egress guard.
- **V6 Cryptography** — KMS-managed keys; ES256; no home-grown crypto.
- **V7 Errors/Logging** — structured logs, PII/token redaction, immutable audit.
- **V9 Communications** — TLS 1.2+ everywhere; HSTS.
- **V10 Malicious Code** — pinned deps, CodeQL, SBOM, signed releases.
- **V12 Files/Resources** — SSRF controls on feeds; sanitized/sandboxed HTML.
- **V13 API** — authz on every object/function; rate limiting.
- **V14 Config** — secure defaults; secrets never in repo; least-privilege IAM.

## 10. Open items (tracked)

- ~~Central policy engine (Cedar) for authorization as rules grow.~~ **Done** —
  enforcement runs through the Cedar engine; the policy set is generated from the
  ROLES matrix and evaluated server-side in `authorize()` (#30).
- ~~WORM/Object-Lock wiring for the audit log.~~ **Done** — audit log backed by
  S3 Object Lock (COMPLIANCE mode) in the CDK stack (#29).
- ~~CI: pin all actions to SHAs, wire OIDC-to-AWS deploy role.~~ **Done** —
  every `uses:` pinned by SHA; OIDC `deploy` job assumes a scoped role on tags (#27).
- Formal, full ASVS L2 line-by-line review before a 1.0 release.
