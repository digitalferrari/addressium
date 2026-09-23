# Persona accounts — admin pool

Created 2026-09-16 against the live admin pool `us-east-1_khM5Bgpo2`
(stack `addressium-dev`, us-east-1). App client `dp2k200l2ebsrc9tlj2u7soij`.
Console: <https://d2xoqzbsflph68.cloudfront.net>

These back the staff personas in [`PERSONAS.md`](./PERSONAS.md). Addresses are all
`@example.com` (RFC 2606) and undeliverable by design; `--message-action SUPPRESS` was
used, so **no mail was sent** by creating them.

> **Credentials are not in this repo.** The shared password lives in a local file
> outside the working tree, mode 600. `.gitignore` carries a `persona-logins.txt` guard
> so it cannot be committed by accident. Ask the deployment owner if you need it.

## State

All seven are `CONFIRMED` and can sign in.

| Persona | Email | `custom:role` | `custom:orgs` |
|---|---|---|---|
| Dana Okafor — owner | `dana.okafor@example.com` | `developer_admin` | `*` |
| Rafael Nunes — org admin | `rafael.nunes@example.com` | `developer_admin` | `identithing-newsletter` |
| Priya Raman — campaign editor | `priya.raman@example.com` | `editor` | `identithing-newsletter` |
| Tom Whitfield — brand editor | `tom.whitfield@example.com` | `editor` | `identithing-newsletter,vail` |
| Marcus Ellery — sales rep | `marcus.ellery@example.com` | `analyst` | `identithing-newsletter` |
| Wen Li — marketing analyst | `wen.li@example.com` | `analyst` | `*` |
| Aisha Bello — support agent | `aisha.bello@example.com` | `support` | `identithing-newsletter` |

Every grant was read back with `admin-get-user`.

### Scopes deliberately differ from the fixtures

`packages/integration-tests/test/personas.ts` scopes these personas to `summit` and
`vail`. **Neither org exists on this deployment** — the only org is
`identithing-newsletter` — so five accounts were re-pointed at it, or they would reach
an empty console and test nothing but scope refusal.

Tom keeps a second, nonexistent org (`vail`) on purpose: the org switcher only renders
at ≥2 orgs, so that is what makes cross-org isolation observable at all. Expect `vail`
to be empty or refuse — that *is* the check.

**Do not edit the fixtures to match these accounts.** The fixtures describe the
personas; these accounts are a deployment-specific accommodation.

### MFA

Pool MFA was changed **`ON` → `OPTIONAL`** (software-token factor left enabled), so
these accounts are not challenged for a TOTP code. Existing enrollments — including
`mike@digitalferrari.com` — are unaffected.

## The two questions this was set up to answer

Both were first flagged by a `developer_admin` render and never confirmed by a
real login. A real login settles each in about a minute. Sign out fully between
personas — the console caches the Cognito session.

1. **`marcus.ellery` (`analyst`, holds only `reports:view`) → Campaigns.**
   Do `Pause` and `Archive` render, and do they *act* when clicked? The nav reaches
   this screen by design; the lifecycle buttons are meant to gate separately inside. If
   they act, that is a false negative — a visible control whose endpoint still answers.

2. **`aisha.bello` (`support`, holds `subscribers:manage` but **not**
   `subscribers:delete`) → Data & exports.**
   Does `Erase` render, and is it enabled? The screen's own copy says erase "will 403
   otherwise". If the button is live, the exact capability line separating a support
   agent from an editor is enforced at the API only.

Cheap to check in the same pass: **API & webhooks gates on no capability at all** yet
holds a Create-key form — confirm what `analyst` sees there.

## Cleanup

```sh
# restore pool MFA
aws cognito-idp set-user-pool-mfa-config --region us-east-1 \
  --user-pool-id us-east-1_khM5Bgpo2 \
  --software-token-mfa-configuration Enabled=true --mfa-configuration ON

# delete the fixture accounts
for u in dana.okafor rafael.nunes priya.raman tom.whitfield \
         marcus.ellery wen.li aisha.bello; do
  aws cognito-idp admin-delete-user --region us-east-1 \
    --user-pool-id us-east-1_khM5Bgpo2 --username "$u@example.com"
done
```
