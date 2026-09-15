import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Generic rendered campaign copy used by the authenticated click-map view. */
export class S3ArchiveWriter {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({});
  }

  async put(key: string, html: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: html,
      ContentType: "text/html; charset=utf-8",
    }));
  }

  async get(key: string): Promise<string | undefined> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return response.Body?.transformToString();
  }
}
