/**
 * ES256 compact-JWS assembly for signers whose private key never leaves a
 * remote HSM/KMS (docs/SECURITY.md §4.1, §4.6).
 *
 * KMS returns an ECDSA signature in ASN.1/DER form; JOSE (RFC 7515) requires the
 * fixed-length `r || s` concatenation. `derToJose` does that conversion, and
 * `buildEs256CompactJws` assembles the token given a `sign` function that returns
 * a DER signature over the signing input. The same helper is used by the KMS
 * signer (adapters) and is unit-tested against a local EC key.
 */

export function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Convert an ASN.1/DER ECDSA signature to JOSE r||s of `2 * partLen` bytes. */
export function derToJose(der: Buffer, partLen = 32): Buffer {
  let i = 0;
  const read = (): number => {
    const v = der[i];
    if (v === undefined) throw new Error("DER: unexpected end");
    i += 1;
    return v;
  };

  if (read() !== 0x30) throw new Error("DER: expected SEQUENCE");
  let seqLen = read();
  if ((seqLen & 0x80) !== 0) {
    const n = seqLen & 0x7f;
    seqLen = 0;
    for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | read();
  }

  const readInt = (): Buffer => {
    if (read() !== 0x02) throw new Error("DER: expected INTEGER");
    const len = read();
    const start = i;
    i += len;
    if (i > der.length) throw new Error("DER: INTEGER overruns buffer");
    let bytes = der.subarray(start, i);
    // strip leading zero padding used to keep the integer positive
    while (bytes.length > 1 && bytes[0] === 0x00) bytes = bytes.subarray(1);
    if (bytes.length > partLen) throw new Error("DER: INTEGER longer than expected");
    const out = Buffer.alloc(partLen);
    bytes.copy(out, partLen - bytes.length);
    return out;
  };

  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

/**
 * Assemble a compact ES256 JWS. `sign` receives the signing input
 * (`base64url(header) . base64url(payload)`) and returns a DER ECDSA signature.
 */
export async function buildEs256CompactJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  sign: (signingInput: Buffer) => Promise<Buffer>,
): Promise<string> {
  const h = base64url(Buffer.from(JSON.stringify({ ...header, alg: "ES256" })));
  const p = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = Buffer.from(`${h}.${p}`);
  const der = await sign(signingInput);
  const jose = derToJose(der, 32);
  return `${h}.${p}.${base64url(jose)}`;
}
