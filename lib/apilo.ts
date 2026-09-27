// Klient Apilo (developer.apilo.com) — TYMCZASOWY most do Amazon (i innych kanałów spiętych w Apilo), dopóki nie zbudujemy
// bezpośredniej integracji z Amazon SP-API. Apilo jest white-label: każdy klient ma własną subdomenę (tu: recoo.apilo.com).
//
// Autoryzacja: token dostępowy ważny 21 dni, token odświeżający 2 miesiące; odświeżanie zwraca ZA KAŻDYM RAZEM nową parę
// (jak w Allegro) i wymaga Basic Auth (client_id:client_secret) na endpoincie tokenu. Pierwszą parę tokenów daje jednorazowa
// wymiana "kodu autoryzacyjnego" pokazanego w panelu Apilo (Administracja / API Apilo) po utworzeniu aplikacji.
// Limit zapytań: 150/min.


export const APILO_API_PATH = "/rest/api";
export const APILO_AUTH_PATH = "/rest/auth/token/";
const PAGE_LIMIT = 200; // dopuszczalne do 2000, ale mniejsze porcje = mniej ryzyka przekroczenia limitu 150 req/min
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class ApiloError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export type ApiloApp = { clientId: string; clientSecret: string; baseUrl: string; fetchImpl?: typeof fetch };
export type ApiloTokens = { refresh_token: string; access_token: string | null; access_expires_at: string | null };
export type TokenStore = {
  load(): Promise<ApiloTokens | null>;
  save(next: ApiloTokens, expectedRefresh: string): Promise<boolean>;
};

const basic = (a: ApiloApp) => "Basic " + Buffer.from(`${a.clientId}:${a.clientSecret}`).toString("base64");

async function tokenRequest(a: ApiloApp, body: { grantType: "authorization_code" | "refresh_token"; token: string }) {
  const res = await (a.fetchImpl ?? fetch)(`${a.baseUrl}${APILO_AUTH_PATH}`, {
    method: "POST",
    headers: { Authorization: basic(a), Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new ApiloError(`Apilo (autoryzacja) zwróciło błąd (${res.status}): ${text.slice(0, 200)}`, res.status);
  const j = JSON.parse(text);
  return { access_token: String(j.accessToken), refresh_token: String(j.refreshToken), access_expires_at: String(j.accessTokenExpireAt) };
}

// Krok jednorazowy: kod autoryzacyjny z panelu Apilo (Administracja / API Apilo) -> pierwsza para tokenów.
export function exchangeCode(a: ApiloApp, code: string) {
  return tokenRequest(a, { grantType: "authorization_code", token: code });
}

const stillValid = (t: ApiloTokens | null, now: number) => !!t?.access_token && !!t.access_expires_at && Date.parse(t.access_expires_at) - now > REFRESH_MARGIN_MS;

// Zwraca ważny access token, w razie potrzeby odświeżając go (refresh_token jest jednorazowy — zapisujemy nową parę).
export async function getAccessToken(a: ApiloApp, store: TokenStore, now: () => number = Date.now): Promise<string> {
  const t = await store.load();
  if (!t?.refresh_token) throw new ApiloError("Apilo nie jest połączone — wymień kod autoryzacyjny z panelu Apilo (Administracja / API Apilo).");
  if (stillValid(t, now())) return t.access_token!;

  try {
    const r = await tokenRequest(a, { grantType: "refresh_token", token: t.refresh_token });
    await store.save(r, t.refresh_token);
    return r.access_token;
  } catch (e) {
    // Równoległy przebieg mógł właśnie odświeżyć token (refresh jest jednorazowy) — wtedy bierzemy jego wynik.
    const again = await store.load();
    if (again && again.refresh_token !== t.refresh_token && stillValid(again, now())) return again.access_token!;
    throw e;
  }
}

/* ---------------- zamówienia ---------------- */

export type ApiloClient = { accessToken: string; baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number };

async function apiloGet(c: ApiloClient, path: string): Promise<any> {
  const res = await (c.fetchImpl ?? fetch)(`${c.baseUrl}${APILO_API_PATH}${path}`, {
    headers: { Authorization: `Bearer ${c.accessToken}`, Accept: "application/json", "Content-Type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(c.timeoutMs ?? 30_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new ApiloError(`Apilo zwróciło błąd (${res.status}): ${text.slice(0, 200)}`, res.status);
  return JSON.parse(text);
}

// /rest/api/orders/platform/map/ — lista połączonych kont sprzedażowych; szukamy Amazon po prefiksie klucza.
export async function apiloFindPlatformAccountId(c: ApiloClient, keyPrefix = "PLATFORM_AMAZON_"): Promise<number | null> {
  const list = (await apiloGet(c, "/orders/platform/map/")) as { id: number; key: string }[];
  return list.find((x) => x.key?.startsWith(keyPrefix))?.id ?? null;
}

// /rest/api/orders/status/map/ — nazwy statusów są własne dla konta Apilo (skonfigurowane przez sprzedawcę), nie ma stałego słownika.
export async function apiloStatusMap(c: ApiloClient): Promise<Record<number, string>> {
  const list = (await apiloGet(c, "/orders/status/map/")) as { id: number; name: string }[];
  return Object.fromEntries(list.map((x) => [x.id, x.name]));
}

// GET /orders/ — jedna strona, posortowana po dacie aktualizacji rosnąco, opcjonalnie tylko jedno konto (platformAccountId).
export async function apiloListOrders(c: ApiloClient, opts: { platformAccountId: number; updatedAfter?: string; offset: number }): Promise<any[]> {
  const params = new URLSearchParams({ platformAccountId: String(opts.platformAccountId), sort: "updatedAtAsc", limit: String(PAGE_LIMIT), offset: String(opts.offset) });
  if (opts.updatedAfter) params.set("updatedAfter", opts.updatedAfter);
  const data = await apiloGet(c, `/orders/?${params.toString()}`);
  return (data.orders as any[]) || [];
}
