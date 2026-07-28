/**
 * Client mirror of `idSchema` in `@addressium/core` (#196).
 *
 * The server is the boundary and rejects anything outside this charset with a
 * 400. Without a mirror the console lets an operator type "The Ledger" into a
 * list id, submit, and get a raw zod issue array back — for a value the form
 * itself described as "used in URLs, cannot change later".
 *
 * Kept deliberately dumb and identical: if the server charset changes, this
 * changes with it. It never *permits* anything — a divergence here can only
 * annoy the operator, never widen what the API accepts.
 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const ID_MAX = 64;

export function isValidId(value: string): boolean {
  return value.length > 0 && value.length <= ID_MAX && ID_PATTERN.test(value);
}

/** Why `value` is not a valid id, or `null` if it is (empty reads as "not yet typed"). */
export function idProblem(value: string): string | null {
  if (!value) return null;
  if (value.length > ID_MAX) return `must be ${ID_MAX} characters or fewer`;
  if (!ID_PATTERN.test(value)) {
    return "lowercase letters, digits, - and _ only, starting with a letter or digit";
  }
  return null;
}

/**
 * Turn a display name into a legal id — the same derivation the server uses for
 * an org slug, offered here as a suggestion the operator can overwrite.
 */
export function suggestId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|(?<!-)-+$/g, "")
    .slice(0, ID_MAX)
    .replace(/-+$/, "");
}
