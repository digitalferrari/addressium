/**
 * Streaming export upload (#224).
 *
 * The S3 calls are faked — what is being asserted is the writer's own decision
 * logic, which is where the bugs live: when to open a multipart upload at all,
 * that no part except the last is under S3's 5MB floor, that a failure does not
 * leave a billed-but-invisible upload behind, and that the byte count reported
 * to the operator is the file's real size.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import { S3ExportWriter } from "@addressium/adapters-aws";

const NOW = new Date("2026-07-28T12:00:00.000Z");

interface Call {
  name: string;
  input: Record<string, unknown>;
}

/** Records what would have reached S3, and reassembles the object from it. */
function fakeS3(opts: { failOnPart?: number } = {}) {
  const calls: Call[] = [];
  const parts: Buffer[] = [];
  let single: Buffer | undefined;
  // A REAL client with `send` replaced, not a plain object: `getSignedUrl`
  // clones the client's config and middleware stack to sign, so a stub would
  // fail inside the presigner rather than test anything. Credentials are static
  // and fake — nothing here reaches the network.
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "AKIAFAKE", secretAccessKey: "fake" },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = cmd.constructor.name;
    calls.push({ name, input: cmd.input });
    if (name === "CreateMultipartUploadCommand") return { UploadId: "up-1" };
    if (name === "UploadPartCommand") {
      const n = cmd.input.PartNumber as number;
      if (opts.failOnPart === n) throw new Error("part upload failed");
      parts.push(cmd.input.Body as Buffer);
      return { ETag: `etag-${n}` };
    }
    if (name === "PutObjectCommand") {
      single = cmd.input.Body as Buffer;
      return {};
    }
    return {};
  };
  const of = (n: string) => calls.filter((c) => c.name === n);
  const body = () => (single ? single.toString() : Buffer.concat(parts).toString());
  return { client, calls, of, body };
}

/**
 * `getSignedUrl` needs a real S3 client to sign against, so the writer is given
 * one whose `send` is replaced. Everything else about the client is genuine.
 */
function writerOver(fake: ReturnType<typeof fakeS3>, ttl = 300): S3ExportWriter {
  return new S3ExportWriter("export-bucket", fake.client, ttl);
}

async function* chunksOf(...lines: string[]): AsyncGenerator<string> {
  for (const l of lines) yield l;
}

test("a small export is a single PutObject, not a multipart upload", async () => {
  // Opening a multipart upload for a 40-byte file leaves incomplete-upload
  // garbage to sweep and buys nothing.
  const fake = fakeS3();
  const out = await writerOver(fake).write("summit", "csv", chunksOf("email\n", "a@x.com\n"), NOW);

  assert.equal(fake.of("CreateMultipartUploadCommand").length, 0);
  assert.equal(fake.of("UploadPartCommand").length, 0);
  assert.equal(fake.of("PutObjectCommand").length, 1);
  assert.equal(fake.body(), "email\na@x.com\n");
  assert.equal(out.bytes, "email\na@x.com\n".length);
  assert.equal(fake.of("PutObjectCommand")[0]?.input.ContentType, "text/csv");
});

test("an export past the part floor becomes a multipart upload, reassembled intact", async () => {
  const fake = fakeS3();
  // 3 × 4MB = 12MB: two full parts and a remainder, so both the flush path and
  // the tail path are exercised.
  const big = "x".repeat(4 * 1024 * 1024);
  const out = await writerOver(fake).write("summit", "jsonl", chunksOf(big, big, big), NOW);

  assert.equal(fake.of("CreateMultipartUploadCommand").length, 1);
  assert.equal(fake.of("CompleteMultipartUploadCommand").length, 1);
  assert.equal(out.bytes, 12 * 1024 * 1024);
  assert.equal(fake.body().length, 12 * 1024 * 1024);

  // Every part but the last must clear S3's 5MB minimum, or CompleteMultipart
  // fails with EntityTooSmall — which is the kind of bug that only shows up on
  // a real customer's export.
  const sizes = fake.of("UploadPartCommand").map((c) => (c.input.Body as Buffer).byteLength);
  assert.ok(sizes.length >= 2);
  for (const s of sizes.slice(0, -1)) assert.ok(s >= 5 * 1024 * 1024, `part too small: ${s}`);

  // Parts are completed in order with the etags S3 handed back.
  const completed = fake.of("CompleteMultipartUploadCommand")[0]?.input.MultipartUpload as {
    Parts: { ETag: string; PartNumber: number }[];
  };
  assert.deepEqual(
    completed.Parts.map((p) => p.PartNumber),
    sizes.map((_, i) => i + 1),
  );
});

test("a failed multipart upload is aborted rather than left billing", async () => {
  // An abandoned multipart upload is storage nobody can see in the console but
  // everybody pays for. The bucket lifecycle sweeps it eventually; the writer
  // should not wait for that.
  const fake = fakeS3({ failOnPart: 2 });
  const big = "x".repeat(4 * 1024 * 1024);
  await assert.rejects(
    () => writerOver(fake).write("summit", "csv", chunksOf(big, big, big, big), NOW),
    /part upload failed/,
  );
  assert.equal(fake.of("AbortMultipartUploadCommand").length, 1);
});

test("the object key is unguessable and org-scoped", async () => {
  // The key is what a bucket policy or lifecycle rule reasons about, and its
  // random segment is what stops one org's URL revealing another's.
  const a = await writerOver(fakeS3()).write("summit", "csv", chunksOf("x"), NOW);
  const b = await writerOver(fakeS3()).write("summit", "csv", chunksOf("x"), NOW);
  assert.match(a.key, /^exports\/summit\/2026-07-28\/[0-9a-f-]{36}\.csv$/);
  assert.notEqual(a.key, b.key, "two exports never collide");
});

test("the download link expires, and says when", async () => {
  // A presigned URL is a bearer credential for an entire subscriber base and
  // cannot be revoked, so its lifetime is the only control there is.
  const out = await writerOver(fakeS3(), 300).write("summit", "csv", chunksOf("x"), NOW);
  assert.equal(out.expiresAt, "2026-07-28T12:05:00.000Z");
  assert.match(out.url, /X-Amz-Expires=300/);
  assert.match(out.url, /X-Amz-Signature=/);
});

test("an empty export still produces an object", async () => {
  // A zero-row export that produced no object would 404 the download and read
  // as a broken export rather than an empty one.
  const fake = fakeS3();
  const out = await writerOver(fake).write("summit", "jsonl", chunksOf(), NOW);
  assert.equal(fake.of("PutObjectCommand").length, 1);
  assert.equal(out.bytes, 0);
});
