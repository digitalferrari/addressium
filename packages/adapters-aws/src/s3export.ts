/**
 * Streaming bulk export to S3 with a presigned, expiring download (#224, #182).
 *
 * The export used to be returned in the HTTP response body. That works right up
 * until it doesn't: API Gateway caps a response at 6MB, so an org large enough
 * to care about portability was exactly the org whose export failed — and it
 * failed by returning a truncated or errored response rather than saying so.
 * The whole file also had to exist in Lambda memory at once, which is the OOM
 * #182 is about.
 *
 * So the response is now a pointer, not a payload. Bytes go to S3 as they are
 * produced and the caller gets a short-lived presigned URL.
 *
 * Two properties the URL has to have, both security-relevant:
 *
 *  - **It expires.** A presigned URL is a bearer credential for the entire
 *    subscriber base of an org. It is not revocable, so its lifetime is the only
 *    control — minutes, not days, and the bucket expires the object behind it
 *    regardless.
 *  - **The key is unguessable.** Object keys embed a random id, so possession of
 *    one org's URL reveals nothing about another's.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

/** S3's floor for every multipart part except the last. Not ours to choose. */
const PART_SIZE = 5 * 1024 * 1024;

export interface ExportUpload {
  key: string;
  bytes: number;
  /** Presigned GET. Treat as a credential: it grants the whole file to anyone holding it. */
  url: string;
  expiresAt: string;
}

export class S3ExportWriter {
  constructor(
    private readonly bucket: string,
    private readonly s3 = new S3Client({}),
    /**
     * Deliberately short. Long enough to click through from the console, short
     * enough that a URL pasted into a ticket or a chat log is dead by the time
     * anyone else reads it.
     */
    private readonly urlTtlSeconds = 300,
  ) {}

  /**
   * Consume `chunks` and upload them. Under one part's worth the whole thing is
   * a single PutObject — starting a multipart upload for a 40KB export would
   * leave incomplete-upload garbage to clean up for no benefit.
   */
  async write(
    orgId: string,
    format: "csv" | "jsonl",
    chunks: AsyncIterable<string>,
    now: Date,
  ): Promise<ExportUpload> {
    const stamp = now.toISOString().slice(0, 10);
    // The random segment is what makes the key unguessable; the org prefix is
    // what lets a bucket policy or lifecycle rule reason about it.
    const key = `exports/${orgId}/${stamp}/${randomUUID()}.${format}`;
    const contentType = format === "jsonl" ? "application/x-ndjson" : "text/csv";

    let uploadId: string | undefined;
    const parts: { ETag: string; PartNumber: number }[] = [];
    let buffer: Buffer[] = [];
    let buffered = 0;
    let bytes = 0;

    const flushPart = async (): Promise<void> => {
      const body = Buffer.concat(buffer);
      buffer = [];
      buffered = 0;
      const res = await this.s3.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: parts.length + 1,
          Body: body,
        }),
      );
      parts.push({ ETag: res.ETag ?? "", PartNumber: parts.length + 1 });
    };

    try {
      for await (const chunk of chunks) {
        const buf = Buffer.from(chunk, "utf8");
        bytes += buf.byteLength;
        buffer.push(buf);
        buffered += buf.byteLength;
        if (buffered < PART_SIZE) continue;
        if (!uploadId) {
          const created = await this.s3.send(
            new CreateMultipartUploadCommand({
              Bucket: this.bucket,
              Key: key,
              ContentType: contentType,
            }),
          );
          uploadId = created.UploadId;
        }
        await flushPart();
      }

      if (uploadId) {
        // The tail is allowed to be under the 5MB floor; an empty one is not a
        // valid part, so only flush if something is left.
        if (buffered > 0) await flushPart();
        await this.s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        );
      } else {
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: Buffer.concat(buffer),
            ContentType: contentType,
          }),
        );
      }
    } catch (e) {
      // An abandoned multipart upload is billed storage nobody can see. Abort on
      // the way out rather than relying solely on the bucket's lifecycle rule.
      if (uploadId) {
        await this.s3
          .send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }))
          .catch(() => undefined);
      }
      throw e;
    }

    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: this.urlTtlSeconds },
    );
    return {
      key,
      bytes,
      url,
      expiresAt: new Date(now.getTime() + this.urlTtlSeconds * 1000).toISOString(),
    };
  }
}
