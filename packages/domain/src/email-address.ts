/**
 * Is this string an address SES will accept as a destination? (#293)
 *
 * The import paths used to accept anything containing an `@`, so `a@@b`, `a@`
 * and `@b` reached the send path from real uploaded lists. SES then refuses
 * them per recipient — which the sender now survives (it records a `reject` and
 * carries on) rather than stranding the rest of the slice.
 *
 * But surviving is not the same as being fine. A permanently-unsendable address
 * left on a list rejects on EVERY edition: one SES call and one `reject` event
 * every morning, for ever. Enough of them and `RecipientRejectAlarm` fires on
 * every send and gets muted — which its own threshold comment warns against.
 * Rejecting at import is where this costs nothing.
 *
 * Deliberately NOT a full RFC 5322 parser. That grammar admits quoted strings,
 * comments and domain literals that no newsletter list has ever legitimately
 * contained, and a stricter-than-RFC check would silently drop real
 * subscribers. This rejects only what SES itself rejects, verified against live
 * SES (us-east-1, 2026-09-23):
 *
 *   nobody@@invalid.example -> "Domain contains illegal character"
 *   trailing@               -> "Missing domain"
 *
 * Anything it admits, SES will attempt.
 */
export function isSendableEmail(raw: string): boolean {
  const email = raw.trim();
  if (!email || email.length > 254) return false;
  // Exactly one `@`, with a non-empty local part and domain on either side.
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64) return false;
  // No whitespace or the characters SES calls "illegal" in a domain.
  if (/[\s,;<>()[\]\\"]/.test(email)) return false;
  // A domain needs at least one dot, no leading/trailing dot or hyphen, and no
  // empty label — `a@b`, `a@.b`, `a@b.` and `a@b..c` are all undeliverable.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) return false;
  return true;
}
