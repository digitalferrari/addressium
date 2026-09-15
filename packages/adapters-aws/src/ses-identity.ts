/**
 * Amazon SES v2 implementation of the `SesIdentityReader` port (#285,
 * GitHub #285) — the live read that answers "can this org actually send?".
 *
 * Strictly read-only, by construction and not by convention: the only two
 * commands this file imports are `GetEmailIdentity` and `GetAccount`, so the
 * grant the admin router needs is exactly `ses:GetEmailIdentity` +
 * `ses:GetAccount` and nothing wider. Creating and mutating identities stays
 * where it already is — `AwsProvisioningProviders`, held by the provisioning
 * function alone. Keeping the two classes apart is what keeps an
 * internet-facing router from holding `CreateEmailIdentity`.
 *
 * SESv2 throughout, like the rest of the repo. The classic `GetSendQuota` is
 * SESv1 and appears nowhere here: `GetAccount` returns the same quota numbers
 * plus the field that matters most — `ProductionAccessEnabled`, which is the
 * sandbox.
 *
 * Nothing in this file decides what a status MEANS. Mapping SES's strings to a
 * verdict an operator can act on is a domain decision and lives in one
 * reviewable place (`readSendingIdentity`); the adapter translates shapes.
 */
import {
  SESv2Client,
  GetEmailIdentityCommand,
  GetAccountCommand,
  NotFoundException,
} from "@aws-sdk/client-sesv2";
import type {
  AccountSendingStatus,
  DomainIdentityStatus,
  DomainVerificationState,
  SesIdentityReader,
} from "@addressium/domain";

/**
 * Map SES's DKIM status to our state.
 *
 * `VerifiedForSendingStatus` is the authority on whether SES will sign and send
 * for this identity, so a true there is `verified` regardless of what the DKIM
 * sub-status says. When it is false the DKIM status is what distinguishes "DNS
 * not published yet" from "SES tried and gave up", and those are different
 * jobs for the operator: wait, versus go look at the records.
 *
 * An unrecognized DKIM status becomes `pending`, not `unknown`: `unknown` in
 * this codebase means "we could not ask", and we did ask — SES answered with a
 * word we have no mapping for. Mapping a future SES status to "could not ask"
 * would report an IAM-shaped problem that does not exist.
 */
function stateFrom(verifiedForSending: boolean | undefined, dkimStatus: string | undefined): DomainVerificationState {
  if (verifiedForSending === true) return "verified";
  switch (dkimStatus) {
    case "FAILED":
      return "failed";
    case "SUCCESS":
    case "PENDING":
    case "NOT_STARTED":
    case "TEMPORARY_FAILURE":
    default:
      return "pending";
  }
}

export class SesIdentityStatusReader implements SesIdentityReader {
  private readonly client: SESv2Client;

  constructor(client?: SESv2Client) {
    // No config object and no env var: the SDK resolves credentials and region
    // itself, and there is nothing per-deployment to tune here.
    this.client = client ?? new SESv2Client({});
  }

  /**
   * SES's current view of one domain identity, or `undefined` when SES says no
   * such identity exists.
   *
   * `NotFoundException` is the ONLY error swallowed, and it is swallowed into a
   * value rather than a throw because it is a real answer: the org record names
   * a domain SES has never been told about. Everything else — throttling, an
   * AccessDenied from a missing grant, SES being unreachable — propagates, so
   * the domain layer can report it as `unknown` with the message attached
   * instead of as a verification failure the operator would go edit DNS over.
   */
  async getDomain(domain: string): Promise<DomainIdentityStatus | undefined> {
    try {
      const res = await this.client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      const dkimStatus = res.DkimAttributes?.Status;
      return {
        domain,
        state: stateFrom(res.VerifiedForSendingStatus, dkimStatus),
        // Passed through in SES's own spelling so an operator comparing this
        // screen to the AWS console reads the same word on both.
        ...(dkimStatus ? { dkimStatus } : {}),
        // The custom MAIL FROM (#200) — the SPF-alignment leg. Absent on an org
        // provisioned before it existed, which is a fact, not a default.
        ...(res.MailFromAttributes?.MailFromDomain
          ? { mailFromDomain: res.MailFromAttributes.MailFromDomain }
          : {}),
        ...(res.MailFromAttributes?.MailFromDomainStatus
          ? { mailFromStatus: res.MailFromAttributes.MailFromDomainStatus }
          : {}),
      };
    } catch (e) {
      if (e instanceof NotFoundException || (e as Error)?.name === "NotFoundException") {
        return undefined;
      }
      throw e;
    }
  }

  /**
   * Account-level sending state for the region this deployment runs in.
   *
   * `ProductionAccessEnabled === false` IS the SES sandbox — the account may
   * only mail addresses it has itself verified — and it is the fact that
   * explains a valid subscriber address being refused on a public signup page.
   *
   * Every field is copied only when SES actually supplied it. A quota SES did
   * not report must stay absent rather than become 0: zero is a number an
   * operator would act on, and it would be a number we invented.
   */
  async getAccount(): Promise<AccountSendingStatus> {
    const res = await this.client.send(new GetAccountCommand({}));
    const quota = res.SendQuota;
    return {
      ...(res.ProductionAccessEnabled !== undefined
        ? { productionAccess: res.ProductionAccessEnabled }
        : {}),
      ...(res.SendingEnabled !== undefined ? { sendingEnabled: res.SendingEnabled } : {}),
      ...(res.EnforcementStatus ? { enforcementStatus: res.EnforcementStatus } : {}),
      ...(quota?.Max24HourSend !== undefined ? { max24HourSend: quota.Max24HourSend } : {}),
      ...(quota?.MaxSendRate !== undefined ? { maxSendRate: quota.MaxSendRate } : {}),
      ...(quota?.SentLast24Hours !== undefined ? { sentLast24Hours: quota.SentLast24Hours } : {}),
    };
  }
}
