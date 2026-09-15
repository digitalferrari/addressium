/**
 * Can this org actually send? (GitHub #285)
 *
 * Everything else in the console reads from our own table, so it can only ever
 * answer "a domain is on the org record". Whether SES will accept a message to
 * an arbitrary recipient turns on two facts that live in SES alone:
 *
 *  1. the DOMAIN identity has finished verifying (DKIM published and accepted),
 *     and
 *  2. the ACCOUNT has production access — outside the SES sandbox, an account
 *     may only mail addresses it has itself verified.
 *
 * The second is the one that produced a public-facing failure: a subscriber
 * typed a valid address, SES refused it because the account was still in the
 * sandbox, and the refusal surfaced on the signup page. From the console there
 * was no way to see the cause. This module is the read that makes it visible.
 *
 * ## Four states per domain, not two
 *
 * The temptation is `verified: boolean`. That is the defect, not the feature. A
 * missing IAM grant, a throttle, or SES being unreachable would all collapse
 * into `false`, and the console would assert "not verified" about a domain it
 * never managed to ask about — a fabricated negative, which is the same class
 * of lie as a fabricated positive. So a domain is `verified`, `pending`,
 * `not_found` (no SES identity exists for it at all — provisioning did not run,
 * or the identity was deleted underneath us), or `unknown` WITH a reason. The
 * precedents are `CloudWatchHealth`'s `{status: "unknown", reason}` and
 * `checkSuppression`'s `liveError`; this follows both.
 *
 * Account state degrades independently of domain state, and each domain
 * independently of the others: one failed call must not blank the rest of the
 * readout. An operator whose account read failed but whose domains came back
 * still learns something true.
 *
 * ## What is NOT here, and why
 *
 * **DMARC.** `GetEmailIdentity` reports DKIM status and tokens, and the custom
 * MAIL FROM (the SPF-alignment leg). It does not report DMARC: `_dmarc` is a
 * DNS TXT record on the operator's own zone that SES neither owns nor reads
 * back. Answering "what is this domain's DMARC policy" means resolving DNS from
 * a Lambda, which is a different capability with a different failure mode
 * (resolver timeouts, split-horizon answers, SSRF surface) and is deliberately
 * not built. A console column for DMARC would have nothing behind it.
 *
 * **Anything written at provisioning time.** `SesIdentity.verificationStatus`
 * is stamped once, when the org was created, and is stale by construction — a
 * domain that verified an hour later still reads `pending`, and one whose DKIM
 * records were removed still reads `verified`. Nothing in this module reads it.
 * Every value here comes from a live call, or is reported as unknown.
 *
 * This is a pure function over an injected port, so it is testable without AWS.
 * The port lives in this module rather than `ports.ts` for the same reason
 * `ProvisioningProviders` does: it is one feature's provider boundary, not part
 * of the store surface every handler touches.
 */

/** Live verification state of one sending domain, as SES reports it now. */
export type DomainVerificationState = "verified" | "pending" | "failed" | "not_found" | "unknown";

/**
 * What SES says about one domain identity.
 *
 * Every field beyond `domain` and `state` is optional because every one of them
 * can be genuinely absent: an identity SES has not finished examining has no
 * DKIM status, and an org provisioned before #200 has no custom MAIL FROM. An
 * absent field renders as "not reported", never as a default.
 */
export interface DomainIdentityStatus {
  domain: string;
  state: DomainVerificationState;
  /**
   * Why the state is `unknown`. Present only in that case — a check that could
   * not run is NOT the same as a domain that failed to verify, and conflating
   * them sends an operator to edit DNS when the real problem is an IAM policy.
   */
  reason?: string;
  /**
   * DKIM signing status in SES's own spelling (`SUCCESS`, `PENDING`,
   * `FAILED`, `NOT_STARTED`, `TEMPORARY_FAILURE`). Passed through rather than
   * mapped: this is the string the AWS console and the SES docs use, so an
   * operator comparing the two screens sees the same word.
   */
  dkimStatus?: string;
  /** The custom MAIL FROM subdomain (#200), if one is configured. */
  mailFromDomain?: string;
  /** Its status in SES's spelling — `PENDING` here means SPF is not aligned yet. */
  mailFromStatus?: string;
}

/**
 * Account-level sending state for the deployment's region.
 *
 * `productionAccess: false` IS the sandbox — the single fact that explains a
 * valid address being refused. `sendingEnabled: false` is the other way an
 * account stops sending (SES paused it), and the two are separate questions.
 */
export interface AccountSendingStatus {
  /** False means the account is in the SES sandbox and may only mail verified addresses. */
  productionAccess?: boolean;
  /** False means SES has paused sending for this account entirely. */
  sendingEnabled?: boolean;
  /** `HEALTHY` / `PROBATION` / `SHUTDOWN`, in SES's spelling. */
  enforcementStatus?: string;
  /** Max messages per 24h. SES reports -1 for an unlimited quota. */
  max24HourSend?: number;
  /** Max messages per second. */
  maxSendRate?: number;
  /** Messages sent in the trailing 24h, as SES counts them. */
  sentLast24Hours?: number;
  /**
   * Why nothing above could be read. Present only when the call failed —
   * every other field is then absent rather than zero, because a quota of 0
   * and an unreadable quota are different facts and only one of them is true.
   */
  reason?: string;
}

/**
 * The live SES read this feature needs. One port, two calls, both read-only.
 *
 * Deliberately NOT folded into `ProvisioningProviders`: that port is held by the
 * provisioning function, which creates identities and keys. This one is held by
 * the admin router, which must never create anything — keeping them apart is
 * what keeps the admin router's IAM policy to two read actions.
 */
export interface SesIdentityReader {
  /**
   * SES's current view of one domain identity. Resolves to `undefined` when SES
   * says the identity does not exist (`NotFoundException`) — which is a real
   * answer about the world, not a failure. Anything else throws, so the caller
   * can tell "SES says no identity" from "SES could not be asked".
   */
  getDomain(domain: string): Promise<DomainIdentityStatus | undefined>;
  /** Account-level production access and quota for the deployment's region. */
  getAccount(): Promise<AccountSendingStatus>;
}

/** The whole readout for one org: the account it sends from, and its domains. */
export interface SendingIdentityReport {
  orgId: string;
  account: AccountSendingStatus;
  domains: DomainIdentityStatus[];
  /**
   * True only when SES would accept a message to an ARBITRARY recipient right
   * now: the account has production access AND at least one domain is verified.
   *
   * Deliberately tri-state rather than boolean. `undefined` means the checks
   * did not complete — an unreadable account or no readable domain — and a
   * console that renders that as "cannot send" would be reporting an IAM gap as
   * a deliverability problem. It is the same distinction `HealthReport` draws
   * between `degraded` and `unknown`.
   */
  canSend?: boolean;
}

/**
 * Read live SES state for an org's sending domains and the account behind them.
 *
 * Pure orchestration over the port: no store reads, no AWS types, no throwing.
 * Every failure becomes an `unknown` with a reason, because the whole point of
 * the screen is that an operator sees WHY they cannot send, and "the console
 * 500ed" is not a why.
 *
 * `domains` is the org's full list, not just `domains[0]`: provisioning creates
 * one SES identity per entry, and a readout that covers one of two makes the
 * second look unprovisioned.
 */
export async function readSendingIdentity(
  reader: SesIdentityReader,
  orgId: string,
  domains: string[],
): Promise<SendingIdentityReport> {
  const account = await readAccount(reader);
  // Sequential rather than Promise.all: SES read APIs are throttled per account,
  // and an org with several domains firing concurrently is exactly how a read
  // that works for one operator starts returning TooManyRequestsException for
  // another. A handful of domains costs a handful of round trips.
  const results: DomainIdentityStatus[] = [];
  for (const domain of domains) {
    results.push(await readDomain(reader, domain));
  }
  return { orgId, account, domains: results, canSend: computeCanSend(account, results) };
}

async function readAccount(reader: SesIdentityReader): Promise<AccountSendingStatus> {
  try {
    return await reader.getAccount();
  } catch (e) {
    return { reason: (e as Error).message };
  }
}

async function readDomain(reader: SesIdentityReader, domain: string): Promise<DomainIdentityStatus> {
  try {
    const found = await reader.getDomain(domain);
    // `undefined` is SES answering "there is no identity for this name" — the
    // org record claims a domain SES has never been told about. That is a
    // finding, not an error, and it is the shape of "provisioning half-ran".
    return found ?? { domain, state: "not_found" };
  } catch (e) {
    return { domain, state: "unknown", reason: (e as Error).message };
  }
}

/**
 * Whether mail to an arbitrary address would be accepted right now.
 *
 * Undefined unless BOTH halves are actually known. A verified domain on an
 * unreadable account cannot answer the question — the sandbox is precisely the
 * half that was missing — so it returns `undefined` rather than guessing in
 * either direction.
 */
function computeCanSend(
  account: AccountSendingStatus,
  domains: DomainIdentityStatus[],
): boolean | undefined {
  if (account.productionAccess === undefined) return undefined;
  const anyUnknown = domains.some((d) => d.state === "unknown");
  const anyVerified = domains.some((d) => d.state === "verified");
  // A known-false is safe to report either way: no verified domain and no
  // production access both mean "no" regardless of what the unknown ones say.
  if (!account.productionAccess) return false;
  if (anyVerified) return account.sendingEnabled !== false;
  // No verified domain, but a domain we could not read might be the verified
  // one — so this is unknown rather than false.
  return anyUnknown ? undefined : false;
}
