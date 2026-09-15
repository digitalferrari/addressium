/**
 * S3-backed import file store (docs/ARCHITECTURE.md §4.7, #242).
 *
 * The read half of the async import: the console PUTs the file straight to S3
 * with a presigned URL, and the job Lambda reads it back here. Direct-to-storage
 * on purpose — routing the bytes through the API would reintroduce the 10 MB
 * payload ceiling the async path exists to remove.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ImportFileStore } from "@addressium/domain";

/**
 * A client that will not poison a presigned PUT with a checksum (#252).
 *
 * Since v3.729 the SDK computes a CRC32 for every `PutObject` by default and,
 * when presigning, hoists it into the QUERY STRING as `x-amz-checksum-crc32`.
 * There is no body at signing time, so the value is the CRC32 of ZERO BYTES
 * (`AAAAAA==`). The browser then PUTs the real file, S3 checksums what it
 * actually received, the two disagree, and every upload of a non-empty file
 * fails with `XAmzContentChecksumMismatch` — a 400 that looks exactly like a
 * CORS or signature problem and is neither.
 *
 * `WHEN_REQUIRED` keeps the checksum for the operations that mandate one and
 * drops it here, which is the only configuration under which a browser can
 * complete a presigned PUT: a browser `fetch` cannot be made to send a matching
 * `x-amz-checksum-*`, because the value depends on bytes it is streaming.
 *
 * Integrity is not lost — the presigned URL is still SigV4 over the key, the
 * bucket and an expiry, the transfer is TLS, and the import job validates what
 * it parses row by row.
 */
const presignSafeClient = (): S3Client =>
  new S3Client({ requestChecksumCalculation: "WHEN_REQUIRED" });

export class S3ImportFileStore implements ImportFileStore {
  constructor(
    private readonly bucket: string,
    private readonly s3 = presignSafeClient(),
    /**
     * Short. A presigned PUT is a bearer credential to write one object in our
     * bucket, so it should outlive the upload and nothing more — long enough for
     * a large file on a poor connection, short enough that one pasted into a
     * ticket is dead before anyone reads it.
     */
    private readonly urlTtlSeconds = 900,
  ) {}

  async read(key: string): Promise<Uint8Array> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`import object ${key} is empty`);
    // `transformToByteArray` rather than a string: the object may be gzip, and
    // decoding it as text would corrupt it before `decodeImportFile` ever sees
    // the magic bytes (#239).
    return await res.Body.transformToByteArray();
  }

  async presignUpload(key: string, contentType?: string): Promise<{ url: string; key: string }> {
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
      { expiresIn: this.urlTtlSeconds },
    );
    return { url, key };
  }
}
