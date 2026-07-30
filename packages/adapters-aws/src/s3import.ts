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

export class S3ImportFileStore implements ImportFileStore {
  constructor(
    private readonly bucket: string,
    private readonly s3 = new S3Client({}),
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
