/**
 * Subscriber-site API client (public + preference centre + confirm/unsubscribe). Branding + list
 * presentation are read from the public endpoints; signup posts to the API.
 */
import { apiBase } from "./api-base.js";

export const ORG = import.meta.env.VITE_ORG_ID ?? "";

async function j<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${await apiBase()}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(await errorMessage(res));
  return (await res.json()) as T;
}

/**
 * An error whose message the API wrote FOR a reader (#265).
 *
 * Tagged so the render path can tell it apart from every other exception a
 * fetch can produce — a network failure's "Failed to fetch", a JSON parse
 * error, a TypeError from a bad field — none of which were written to be shown
 * to a subscriber, and all of which `String(e)` used to put on the page.
 */
export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** Shown when the response carries nothing we can show a reader. */
const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * The message to show for a failed response (#265).
 *
 * This used to be `throw new Error(await res.text())`, which put the RAW BODY
 * into the message — so a validation failure rendered the whole serialized
 * ZodError, regex included, on the public signup page. The API answers with
 * `{error}` and that field is now the only thing read. The body is taken as
 * text and then parsed, not via `res.json()`, because the body can only be
 * consumed once and a non-JSON error page (a gateway 502, say) must not throw
 * a second time inside the error path.
 */
async function errorMessage(res: Response): Promise<string> {
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    return GENERIC_ERROR;
  }
  try {
    const body = JSON.parse(raw) as { error?: unknown };
    return typeof body.error === "string" && body.error ? body.error : GENERIC_ERROR;
  } catch {
    // Not JSON — whatever it is, it was not written to be read by a subscriber.
    return GENERIC_ERROR;
  }
}

export interface Branding {
  logoUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  background: { type: "solid"; color: string } | { type: "gradient"; from: string; to: string; angle: number };
}

export interface PublicList {
  listId: string;
  name: string;
  description?: string;
  presentation: { showFrequency: boolean; showSendTime: boolean; showReaderCount: boolean; showFreePaidCount: boolean };
  frequencyLabel?: string;
  sendTimeLabel?: string;
  readerCount?: number;
  freePaidCount?: { free: number; paid: number };
}

export interface PreferenceRow {
  listId: string;
  name: string;
  description?: string;
  status?: "pending" | "confirmed" | "unsubscribed" | "bounced" | "complained";
  subscribed: boolean;
}

export interface PreferenceView {
  orgId: string;
  email: string;
  rows: PreferenceRow[];
}

export const api = {
  branding: () => j<Branding | null>("GET", `/orgs/${ORG}/branding`),
  /**
   * The public directory (#124). Returns the FULL public view of every open
   * list in one call, so a browse page needs no follow-up request per list —
   * and `closed` lists never appear, because a directory that advertises a list
   * nobody can join is worse than one that omits it.
   */
  directory: () => j<PublicList[]>("GET", `/orgs/${ORG}/directory`),
  publicList: (listId: string) => j<PublicList>("GET", `/orgs/${ORG}/lists/${listId}/public`),
  signup: (email: string, listId: string) => j<{ status: string }>("POST", `/signup`, { orgId: ORG, email, listId }),
  signupMany: (email: string, listIds: string[]) =>
    j<{ status: string; lists: string[] }>("POST", `/signup/batch`, { orgId: ORG, email, listIds }),
  requestPreferences: (email: string) =>
    j<{ status: string; message: string }>("POST", "/preferences/request", { orgId: ORG, email }),
  preferences: (token: string) =>
    j<PreferenceView>("GET", `/preferences?token=${encodeURIComponent(token)}`),
  updatePreferences: (token: string, changes: { listId: string; subscribed: boolean }[]) =>
    j<{ unsubscribed: string[]; resubscribed: string[]; rejected: string[]; view: PreferenceView }>("POST", "/preferences", { token, changes }),
  confirm: (token: string) => j<{ status: string; confirmed?: number }>("GET", `/confirm?token=${encodeURIComponent(token)}`),
  unsubscribe: (token: string) => j<{ status: string }>("POST", `/unsubscribe`, { token }),
};

/**
 * The sentence to render for a caught error (#265).
 *
 * Every catch on this site went through `String(e)`, which prefixes `Error: `
 * and, before the fix above, pasted the raw response body after it. Only an
 * `ApiError` — a message the API deliberately addressed to a reader — is
 * trusted; anything else is a failure whose text was written for us, so it
 * falls back rather than being rendered.
 */
export function displayError(e: unknown): string {
  return e instanceof ApiError && e.message ? e.message : GENERIC_ERROR;
}

/** Apply branding as CSS variables on :root (§4.10). */
export function applyBranding(b: Branding | null): void {
  if (!b) return;
  const r = document.documentElement.style;
  r.setProperty("--brand-primary", b.primaryColor);
  r.setProperty("--brand-secondary", b.secondaryColor);
  r.setProperty(
    "--brand-bg",
    b.background.type === "solid"
      ? b.background.color
      : `linear-gradient(${b.background.angle}deg, ${b.background.from}, ${b.background.to})`,
  );
}
