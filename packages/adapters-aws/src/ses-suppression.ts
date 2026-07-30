/**
 * Amazon SES v2 implementation of the SuppressionListReader and
 * SuppressionChecker ports (docs/ARCHITECTURE.md §4.7, §4.13, #240, #247).
 *
 * Two capabilities, deliberately kept apart by risk shape though they share one
 * client:
 *
 *  - `list()` reads the ACCOUNT-level suppression list wholesale — the one SES
 *    maintains itself from hard bounces and complaints, and the one a Pinpoint
 *    account will have accumulated for as long as it has been sending. It is
 *    the half of a migration nothing else can reconstruct: subscriber records
 *    can be re-exported, but "we already learned this address bounces" exists
 *    only here.
 *  - `get`/`put` are a single-address point lookup and a single deliberate
 *    write — the console equivalent of `aws sesv2 get-suppressed-destination`
 *    / `put-suppressed-destination`, for an operator looking at one subscriber.
 *
 * The class stayed "read-only by construction" through #240 on purpose: pushing
 * OUR WHOLE LIST into an operator's account suppression list would change how
 * their account behaves for every sender using it, including whatever they have
 * not migrated yet — so BULK writing back to SES is still never automated, and
 * `list()` still writes nothing. `put()` is a different shape of risk entirely:
 * one operator, one address, one audited action, mirroring a change they could
 * already make by hand in the SES console or the CLI. Automating the bulk case
 * would be reckless; refusing the single case would just be inconvenient.
 */
import {
  SESv2Client,
  ListSuppressedDestinationsCommand,
  GetSuppressedDestinationCommand,
  PutSuppressedDestinationCommand,
  NotFoundException,
  type SuppressionListReason,
} from "@aws-sdk/client-sesv2";
import type {
  SuppressedDestination,
  SuppressionChecker,
  SuppressionListReader,
} from "@addressium/domain";

export interface SesSuppressionListReaderConfig {
  /**
   * Restrict to these reasons. Omit for everything SES has.
   *
   * Present because SES will grow reasons we have no mapping for, and an
   * operator mid-migration may want to take only the bounces. Absent, we read
   * all of them and let `importSuppressionList` decide what it understands —
   * which is where that decision is reviewable.
   */
  reasons?: SuppressionListReason[];
  /** Page size. SES caps this at 1000; left unset, SES picks. */
  pageSize?: number;
}

export class SesSuppressionListReader implements SuppressionListReader, SuppressionChecker {
  private readonly client: SESv2Client;

  constructor(
    private readonly cfg: SesSuppressionListReaderConfig = {},
    client?: SESv2Client,
  ) {
    this.client = client ?? new SESv2Client({});
  }

  /**
   * Every suppressed destination, following `NextToken` to the end.
   *
   * A generator rather than an array: this list is however large the operator's
   * sending history made it, and the caller (`importSuppressionList`) batches its
   * writes as entries arrive, so one page is resident at a time. Materializing it
   * would put an unpredictable memory ceiling in a Lambda at the one moment an
   * operator has the least patience for a failure.
   *
   * The token loop is `do/while` on a truthy token rather than a page count:
   * SES may return an empty page WITH a token (a page whose entries were all
   * filtered by `Reasons`), and stopping on the empty page would silently
   * truncate the list — a partial suppression import that reports success.
   */
  async *list(): AsyncGenerator<SuppressedDestination> {
    let NextToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListSuppressedDestinationsCommand({
          ...(this.cfg.reasons ? { Reasons: this.cfg.reasons } : {}),
          ...(this.cfg.pageSize ? { PageSize: this.cfg.pageSize } : {}),
          ...(NextToken ? { NextToken } : {}),
        }),
      );
      for (const d of res.SuppressedDestinationSummaries ?? []) {
        // An entry with no address is not something to guess at — SES always
        // supplies one, so a missing value means the shape changed under us and
        // inventing a key would write a suppression for "".
        if (!d.EmailAddress) continue;
        yield {
          email: d.EmailAddress,
          // Passed through in SES's spelling. The mapping to a domain
          // source/scope is a compliance decision and lives in one place.
          reason: d.Reason ?? "",
          ...(d.LastUpdateTime ? { at: d.LastUpdateTime.toISOString() } : {}),
        };
      }
      NextToken = res.NextToken;
    } while (NextToken);
  }

  /**
   * The live account-list entry for one address, or `undefined` if SES says it
   * is not suppressed (#247).
   *
   * `NotFoundException` is SES's answer for "not on the list" — the expected,
   * common case — and is the only error swallowed. Anything else (throttling,
   * a permissions gap, SES being unreachable) propagates, because `undefined`
   * here means "confirmed clear," and confusing "SES said no" with "SES could
   * not be asked" is precisely the gap `checkSuppression`'s `liveError` field
   * exists to keep visible instead.
   */
  async get(email: string): Promise<SuppressedDestination | undefined> {
    try {
      const res = await this.client.send(
        new GetSuppressedDestinationCommand({ EmailAddress: email }),
      );
      const d = res.SuppressedDestination;
      if (!d?.EmailAddress) return undefined;
      return {
        email: d.EmailAddress,
        reason: d.Reason ?? "",
        ...(d.LastUpdateTime ? { at: d.LastUpdateTime.toISOString() } : {}),
      };
    } catch (e) {
      if (e instanceof NotFoundException || (e as Error)?.name === "NotFoundException") {
        return undefined;
      }
      throw e;
    }
  }

  /**
   * Add one address to the account suppression list (#247) — one operator, one
   * address, one audited action; see the class comment for why this is not the
   * bulk-write `list()` was deliberately never given.
   *
   * `reason` is typed to exactly what SES's `SuppressionListReason` accepts —
   * there is no third value to pass, so there is nothing here to validate.
   */
  async put(email: string, reason: "BOUNCE" | "COMPLAINT"): Promise<void> {
    await this.client.send(
      new PutSuppressedDestinationCommand({ EmailAddress: email, Reason: reason }),
    );
  }
}
