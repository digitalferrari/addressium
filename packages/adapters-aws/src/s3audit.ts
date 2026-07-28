/**
 * S3 (Object Lock / WORM) implementation of the AuditLog port (§4.19, #29).
 *
 * Writes one immutable JSON object per audit entry. The bucket's default Object
 * Lock retention (set in infra) makes every object write-once — even an admin
 * can't overwrite or delete within the retention window. Keys are time-ordered
 * per org so history reads chronologically.
 */
import { randomUUID } from "node:crypto";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { AuditEntry } from "@addressium/core";
import type { AuditLog, AuditReader } from "@addressium/domain";

/** One UTC day, for walking key prefixes backwards. */
const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (iso: string): string => iso.slice(0, 10);

export class S3AuditLog implements AuditLog, AuditReader {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({});
  }

  async append(entry: AuditEntry): Promise<void> {
    const scope = entry.orgId ?? "GLOBAL";
    const key = `audit/${scope}/${entry.at}-${randomUUID()}.json`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(entry),
        ContentType: "application/json",
      }),
    );
  }

  /**
   * Newest first (#191).
   *
   * Keys are `audit/<scope>/<ISO timestamp>-<uuid>.json`, so they sort
   * chronologically — but S3 only ever lists ASCENDING. Asking for "the last 50
   * actions" by listing from the beginning of time and taking the tail means
   * paging the entire history of the deployment to answer a question about
   * yesterday, and it gets slower every day the product runs.
   *
   * So this walks DAY prefixes backwards from `to` and stops as soon as it has
   * enough. A console showing the most recent page costs one or two ListObjects
   * calls regardless of how much history exists behind it.
   */
  async read(
    orgId: string | null,
    opts: { from?: string; to?: string; limit?: number } = {},
  ): Promise<AuditEntry[]> {
    const scope = orgId ?? "GLOBAL";
    const limit = Math.min(opts.limit ?? 100, 500);
    const to = opts.to ?? new Date().toISOString();
    // Default window is 90 days. Unbounded would mean an empty log walks back to
    // 1970 one day at a time — a request that never returns.
    const from = opts.from ?? new Date(Date.parse(to) - 90 * DAY_MS).toISOString();

    const keys: string[] = [];
    for (let t = Date.parse(to); t >= Date.parse(from) && keys.length < limit; t -= DAY_MS) {
      const prefix = `audit/${scope}/${dayOf(new Date(t).toISOString())}`;
      let token: string | undefined;
      const dayKeys: string[] = [];
      do {
        const res = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const o of res.Contents ?? []) if (o.Key) dayKeys.push(o.Key);
        token = res.NextContinuationToken;
      } while (token);
      // Within a day the keys are ascending; the caller wants newest first.
      dayKeys.sort().reverse();
      keys.push(...dayKeys);
    }

    const wanted = keys.slice(0, limit);
    const entries = await Promise.all(
      wanted.map(async (Key) => {
        const res = await this.client.send(
          new GetObjectCommand({ Bucket: this.bucket, Key }),
        );
        const body = await res.Body?.transformToString();
        // A single unreadable object must not blank the whole view — the point
        // of the log is that the rest of it is still evidence.
        try {
          return body ? (JSON.parse(body) as AuditEntry) : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return entries
      .filter((e): e is AuditEntry => e !== undefined)
      .filter((e) => e.at >= from && e.at <= to);
  }
}
