/**
 * SigV4-signed OpenSearch Serverless bulk writer (§5, #28).
 *
 * The segment indexer projects DynamoDB Streams changes into IndexOps and writes
 * them to the org's index via the `_bulk` API. OpenSearch Serverless requires
 * SigV4 with service name "aoss"; we sign the request and send it with fetch.
 */
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { IndexOp } from "@addressium/segment";

export class OpenSearchBulkWriter {
  private readonly signer: SignatureV4;
  constructor(
    private readonly endpoint: string, // https://<id>.<region>.aoss.amazonaws.com
    region = process.env.AWS_REGION ?? "us-east-1",
  ) {
    this.signer = new SignatureV4({
      service: "aoss",
      region,
      credentials: defaultProvider(),
      sha256: Sha256,
    });
  }

  /** Build the NDJSON `_bulk` body for a batch of ops. */
  static bulkBody(ops: IndexOp[]): string {
    const lines: string[] = [];
    for (const op of ops) {
      if (op.type === "delete") {
        lines.push(JSON.stringify({ delete: { _index: op.index, _id: op.id } }));
      } else {
        lines.push(JSON.stringify({ index: { _index: op.index, _id: op.id } }));
        lines.push(JSON.stringify(op.doc));
      }
    }
    return lines.join("\n") + "\n";
  }

  async bulk(ops: IndexOp[]): Promise<void> {
    if (ops.length === 0) return;
    const url = new URL(`${this.endpoint}/_bulk`);
    const body = OpenSearchBulkWriter.bulkBody(ops);
    const request = new HttpRequest({
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      headers: { host: url.hostname, "content-type": "application/x-ndjson" },
      body,
    });
    const signed = await this.signer.sign(request);
    const res = await fetch(url, {
      method: "POST",
      headers: signed.headers as Record<string, string>,
      body,
    });
    if (!res.ok) throw new Error(`OpenSearch bulk failed: ${res.status} ${await res.text()}`);
  }
}
