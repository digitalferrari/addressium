/**
 * Amazon SES v2 implementation of the SuppressionListReader port
 * (docs/ARCHITECTURE.md §4.7, §4.13, #240).
 *
 * Reads the ACCOUNT-level suppression list — the one SES maintains itself from
 * hard bounces and complaints, and the one a Pinpoint account will have been
 * accumulating for as long as it has been sending. It is the half of a migration
 * that nothing else can reconstruct: subscriber records can be re-exported, but
 * "we already learned this address bounces" exists only here.
 *
 * Read-only by construction. Nothing in this file writes to SES, because the
 * import direction is the only one that is safe to automate: pushing OUR list
 * into an operator's account suppression list would change how their account
 * behaves for every sender using it, including whatever they have not migrated
 * yet.
 */
import {
  SESv2Client,
  ListSuppressedDestinationsCommand,
  type SuppressionListReason,
} from "@aws-sdk/client-sesv2";
import type { SuppressedDestination, SuppressionListReader } from "@addressium/domain";

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

export class SesSuppressionListReader implements SuppressionListReader {
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
}
