/**
 * SigV4-signed OpenSearch Serverless client (§5, #28, #246).
 *
 * Two halves of the mirror. `OpenSearchBulkWriter` is the WRITE side: the segment
 * indexer projects DynamoDB Streams changes into IndexOps and writes them via
 * `_bulk`. `OpenSearchQueryClient` is the READ side, which #246 was about — the
 * mirror was provisioned, fed and never queried, because the sender constructed
 * `GsiSegmentEngine` unconditionally and nothing anywhere read the index it was
 * paying to keep current.
 *
 * OpenSearch Serverless requires SigV4 with service name "aoss"; both sign the
 * request and send it with fetch.
 */
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { IndexOp, OpenSearchClient } from "@addressium/segment";

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

/**
 * The read half of the mirror: `search` and `count` over an org's index (#246).
 *
 * Satisfies `OpenSearchClient` structurally, which is all `OpenSearchSegmentEngine`
 * asks for — the engine takes the client rather than an endpoint precisely so the
 * signing and transport stay in the adapter layer and the query building stays
 * unit-testable without a network.
 */
export class OpenSearchQueryClient implements OpenSearchClient {
  private readonly signer: SignatureV4;
  constructor(
    private readonly endpoint: string,
    region = process.env.AWS_REGION ?? "us-east-1",
  ) {
    this.signer = new SignatureV4({
      service: "aoss",
      region,
      credentials: defaultProvider(),
      sha256: Sha256,
    });
  }

  async search(index: string, body: unknown): Promise<{ hits: { hits: Array<{ _id: string }> } }> {
    return this.post(`/${index}/_search`, body) as Promise<{
      hits: { hits: Array<{ _id: string }> };
    }>;
  }

  async count(index: string, body: unknown): Promise<{ count: number }> {
    return this.post(`/${index}/_count`, body) as Promise<{ count: number }>;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const url = new URL(`${this.endpoint}${path}`);
    const payload = JSON.stringify(body);
    const request = new HttpRequest({
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      headers: { host: url.hostname, "content-type": "application/json" },
      body: payload,
    });
    const signed = await this.signer.sign(request);
    const res = await fetch(url, {
      method: "POST",
      headers: signed.headers as Record<string, string>,
      body: payload,
    });
    // Loud rather than empty. A 403 from a missing data-access policy would
    // otherwise read as "this segment matches nobody" — a campaign that claims
    // itself and sends to no one, which is the #201 failure shape and the one
    // thing a segment resolver must never do quietly.
    if (!res.ok) {
      throw new Error(`OpenSearch ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as unknown;
  }
}
