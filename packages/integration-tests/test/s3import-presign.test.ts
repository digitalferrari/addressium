/**
 * The presigned import PUT has to be usable by a BROWSER (#252, #287).
 *
 * This is the last link in the large-file import chain and the one that was
 * broken in a way nothing upstream could show. The bucket has CORS, the route
 * mints a URL, the console PUTs to it — and every upload of a non-empty file
 * failed with a 400 that reads like a CORS or credentials problem.
 *
 * The cause is in the SDK, not in our code: since v3.729 `PutObjectCommand`
 * computes a CRC32 by default, and the presigner hoists it into the query
 * string. At signing time there is no body, so the signed value is the CRC32 of
 * ZERO BYTES. S3 then checksums the real file the browser uploaded, the two
 * disagree, and the PUT is rejected. A browser cannot fix this from its side:
 * `fetch` cannot compute and send a matching `x-amz-checksum-*` for a body it is
 * streaming.
 *
 * So this test asserts the negative — the signed URL carries NO checksum
 * parameter, and every header it requires the browser to send is one a browser
 * actually sends. An SDK upgrade that re-enables the default flips this red
 * before it reaches an operator with a migration file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { S3ImportFileStore } from "@addressium/adapters-aws";

/**
 * Nothing here reaches the network: presigning is pure computation over static
 * credentials. They are fake and the bucket name is an example.
 */
const store = () => {
  process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE";
  process.env.AWS_SECRET_ACCESS_KEY = "example-secret";
  process.env.AWS_REGION = "us-east-1";
  delete process.env.AWS_SESSION_TOKEN;
  return new S3ImportFileStore("example-import-bucket");
};

test("the presigned import upload carries no checksum the browser cannot satisfy", async () => {
  const { url, key } = await store().presignUpload("orgs/org_1/imports/imp_1");
  assert.equal(key, "orgs/org_1/imports/imp_1");
  const params = new URL(url).searchParams;

  // The whole bug, in one assertion. `x-amz-checksum-crc32=AAAAAA==` is the
  // CRC32 of an empty body; S3 compares it against the real file and 400s.
  for (const [name] of params) {
    assert.ok(
      !name.toLowerCase().startsWith("x-amz-checksum-"),
      `presigned import PUT carries ${name} — the browser's file will not match it`,
    );
  }
  assert.equal(
    params.get("x-amz-sdk-checksum-algorithm"),
    null,
    "the SDK is still asking S3 to enforce a checksum on this upload",
  );

  // Only `host` may be signed. Anything else is a header the browser would have
  // to reproduce byte-for-byte, and `fetch` controls almost none of them.
  assert.equal(params.get("X-Amz-SignedHeaders"), "host");
  assert.equal(params.get("X-Amz-Content-Sha256"), "UNSIGNED-PAYLOAD");
});

test("the presigned import upload expires", async () => {
  const { url } = await store().presignUpload("orgs/org_1/imports/imp_2");
  const expires = Number(new URL(url).searchParams.get("X-Amz-Expires"));
  // A presigned PUT is a bearer credential to write one object in our bucket.
  assert.ok(expires > 0 && expires <= 3600, `import upload URL lives ${expires}s`);
});
