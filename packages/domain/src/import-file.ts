/**
 * Reading whatever file the operator actually has (docs/ARCHITECTURE.md §4.7,
 * #239).
 *
 * A Pinpoint migration arrives in one of two shapes, and the repo only understood
 * one of them. The console/manual route gives a CSV with dotted column paths
 * (`Address`, `Attributes.SD_Skiing`, `User.UserAttributes.*`) — that is what
 * `import-mapping.ts` was built against. But a Pinpoint **export job** writes
 * **gzipped JSON Lines of endpoint objects** to S3, and that is what an operator
 * gets when they export programmatically, which is what anyone with a real-sized
 * audience does.
 *
 * Fed the second shape, the old importer read line 1 as a header, found no
 * recognisable column, errored every row, and returned `200 {created: 0}` — a
 * silent zero that reads as success (#209's failure, still live for this format).
 *
 * The fix is deliberately NOT a second import pipeline. Each endpoint object is
 * FLATTENED to the same dotted-path row the CSV export already produces, so the
 * mapper, the three-state audience logic, the `OptOut`/`EndpointStatus` safety
 * columns, the consent-basis declaration and the import-batch record all apply
 * unchanged. One shape in the middle means the JSONL path cannot drift away from
 * the CSV path's compliance rules — which are the rules that matter most in
 * exactly the file this reads.
 */
import { gunzipSync } from "node:zlib";

/** Gzip's magic bytes. A Pinpoint export job's objects are always gzipped. */
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * How much decompressed text we will accept from one upload.
 *
 * gzip is a DECOMPRESSION BOMB primitive: measured on ordinary input, a stream
 * of one repeated byte compresses at better than 1000:1, so a 200KB body becomes
 * 200MB and API Gateway's own 10MB ceiling permits roughly 10GB. Without a bound
 * here the first caller to notice can OOM the Lambda at will, and the size caps
 * upstream do not help — they measure the COMPRESSED bytes, which is the number
 * the attacker chooses.
 *
 * 256MB of text is far beyond any real subscriber export (the largest plausible
 * migration is tens of MB of JSON) while staying inside a Lambda's memory, so a
 * legitimate file is never refused and a bomb never gets to allocate.
 */
export const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

export type ImportFormat = "csv" | "jsonl";

export interface ParsedImportFile {
  format: ImportFormat;
  rows: Record<string, string>[];
  /** Lines that could not be parsed, with 1-based line numbers. Never silent. */
  errors: string[];
}

/**
 * Decode an uploaded file to text, decompressing if it is gzipped (#239).
 *
 * Sniffed by magic bytes rather than trusting a filename or a content-type: an
 * S3 object written by an export job carries neither reliably, and a `.gz`
 * suffix on a plaintext file (or its absence on a compressed one) is a support
 * ticket rather than an error anybody can act on.
 *
 * Decompression is BOUNDED (`MAX_DECOMPRESSED_BYTES`). Node stops and throws at
 * the limit rather than allocating first and checking after, so the bomb never
 * gets the memory. The error is deliberately explicit: an operator whose genuine
 * export is somehow this large needs to know the limit exists, not to see an
 * opaque OOM.
 */
export function decodeImportFile(input: Uint8Array | string): string {
  if (typeof input === "string") return input;
  const gzipped = input.length >= 2 && input[0] === GZIP_MAGIC[0] && input[1] === GZIP_MAGIC[1];
  if (!gzipped) return Buffer.from(input).toString("utf8");
  try {
    return gunzipSync(Buffer.from(input), { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString("utf8");
  } catch (e) {
    // `ERR_BUFFER_TOO_LARGE` is what the cap raises; anything else is a corrupt
    // archive. Both are the caller's problem and neither should look like an
    // infrastructure failure.
    const why = (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
      ? `decompresses to more than ${MAX_DECOMPRESSED_BYTES / 1024 / 1024}MB`
      : "is not a readable gzip archive";
    throw new Error(`import file ${why}`);
  }
}

/**
 * Which of the two shapes this text is (#239).
 *
 * JSON Lines is identified by the first non-blank line parsing as a JSON OBJECT.
 * A CSV header row does not — and a CSV whose first cell happens to be `{...}`
 * is not a thing Pinpoint produces. An array is rejected rather than accepted as
 * a convenience: a whole-file JSON array is a THIRD format, and quietly
 * accepting one would mean a file we half-understand.
 */
export function detectImportFormat(text: string): ImportFormat {
  const first = text.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
  if (!first || !first.startsWith("{")) return "csv";
  try {
    const v: unknown = JSON.parse(first);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? "jsonl" : "csv";
  } catch {
    return "csv";
  }
}

/**
 * Flatten one endpoint object into the dotted-path columns the CSV export uses.
 *
 * `{Address: "a@b", User: {UserId: "u1"}, Attributes: {SD_Ski: ["true"]}}`
 * becomes `{Address: "a@b", "User.UserId": "u1", "Attributes.SD_Ski": "true"}` —
 * byte-for-byte the column names `import-mapping.ts` already detects, which is
 * the whole point.
 *
 * Three value rules, each load-bearing:
 *
 *  - **A single-element array becomes its element.** Pinpoint models every
 *    attribute as a list, so `["true"]` is how a boolean audience flag arrives.
 *    Left as `["true"]` the mapper's three-state logic — `true` / `false` /
 *    empty, where empty means NEVER ASKED — would see a string it does not
 *    recognise and read it as empty. That silently converts "declined" into
 *    "never asked", which is the one direction consent must never move.
 *  - **A multi-element array joins on `,`.** Matching how the CSV export writes
 *    the same value, so a multi-valued attribute means the same thing in both.
 *  - **`null` becomes empty string**, which the mapper already reads as absent.
 */
export function flattenEndpoint(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) {
      out[path] = "";
    } else if (Array.isArray(value)) {
      out[path] = value.length === 1 ? String(value[0] ?? "") : value.map((v) => String(v)).join(",");
    } else if (typeof value === "object") {
      Object.assign(out, flattenEndpoint(value as Record<string, unknown>, path));
    } else {
      out[path] = String(value);
    }
  }
  return out;
}

/** Parse JSON Lines of endpoint objects into flattened rows (#239). */
export function parseEndpointJsonl(text: string): { rows: Record<string, string>[]; errors: string[] } {
  const rows: Record<string, string>[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Reported with its line number, never skipped. A dropped line in a
      // suppression-adjacent file is an address that silently becomes mailable.
      errors.push(`line ${i + 1}: not valid JSON`);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push(`line ${i + 1}: expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
      continue;
    }
    rows.push(flattenEndpoint(parsed as Record<string, unknown>));
  }
  return { rows, errors };
}

/**
 * Parse an uploaded import file of either shape into mapper-ready rows (#239).
 *
 * The single entry point the import paths call, so neither has to know which
 * format it was handed — and so a format we do NOT understand fails loudly here
 * rather than becoming an empty row set three layers down.
 */
export function parseImportFile(
  input: Uint8Array | string,
  parseCsv: (text: string) => Record<string, string>[],
): ParsedImportFile {
  const text = decodeImportFile(input);
  const format = detectImportFormat(text);
  if (format === "jsonl") {
    const { rows, errors } = parseEndpointJsonl(text);
    return { format, rows, errors };
  }
  return { format, rows: parseCsv(text), errors: [] };
}
