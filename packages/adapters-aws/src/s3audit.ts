/**
 * S3 (Object Lock / WORM) implementation of the AuditLog port (§4.19, #29).
 *
 * Writes one immutable JSON object per audit entry. The bucket's default Object
 * Lock retention (set in infra) makes every object write-once — even an admin
 * can't overwrite or delete within the retention window. Keys are time-ordered
 * per org so history reads chronologically.
 */
import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { AuditEntry } from "@addressium/core";
import type { AuditLog } from "@addressium/domain";

export class S3AuditLog implements AuditLog {
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
}
