/**
 * Subscriber-site API client (public + confirm/unsubscribe). Branding + list
 * presentation are read from the public endpoints; signup posts to the API.
 */
const BASE = import.meta.env.VITE_API_BASE ?? "";
export const ORG = import.meta.env.VITE_ORG_ID ?? "";

async function j<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
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

export const api = {
  branding: () => j<Branding | null>("GET", `/orgs/${ORG}/branding`),
  lists: () => j<Array<{ listId: string }>>("GET", `/orgs/${ORG}/lists`),
  publicList: (listId: string) => j<PublicList>("GET", `/orgs/${ORG}/lists/${listId}/public`),
  signup: (email: string, listId: string) => j<{ status: string }>("POST", `/signup`, { orgId: ORG, email, listId }),
  signupMany: (email: string, listIds: string[]) =>
    j<{ status: string; lists: string[] }>("POST", `/signup/batch`, { orgId: ORG, email, listIds }),
  confirm: (token: string) => j<{ status: string; confirmed?: number }>("GET", `/confirm?token=${encodeURIComponent(token)}`),
  unsubscribe: (token: string) => j<{ status: string }>("POST", `/unsubscribe`, { token }),
};

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
