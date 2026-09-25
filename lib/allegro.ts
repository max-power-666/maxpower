// Klient API Allegro (https://developer.allegro.pl, definicja: /swagger.yaml). Autoryzacja to OAuth2 (Authorization Code):
// aplikacja ma Client_ID/Client_Secret, a administrator raz łączy swoje konto sprzedawcy. Access token żyje 12 godzin,
// refresh token 3 miesiące i jest JEDNORAZOWY — każde odświeżenie zwraca nową parę, którą trzeba zapisać (tabela oauth_tokens).
// Zamówienia to "checkout forms": GET /order/checkout-forms (scope allegro:api:orders:read).

import { scanOrders } from "./scanOrders";

export const ALLEGRO_API_URL = "https://api.allegro.pl";
export const ALLEGRO_AUTH_URL = "https://allegro.pl/auth/oauth";
export const ALLEGRO_SCOPE = "allegro:api:orders:read"; // tylko odczyt zamówień
const ACCEPT = "application/vnd.allegro.public.v1+json";
const PAGE_LIMIT = 100; // maksimum dla listy zamówień
const REFRESH_MARGIN_MS = 120_000; // odświeżamy token, gdy zostało mniej niż 2 minuty

export class AllegroReauthError extends Error {}

// userAgent: Allegro BLOKUJE klucz API przy zapytaniach bez prawidłowego User-Agenta wygenerowanego w panelu aplikacji
// (apps.developer.allegro.pl -> generator User-Agent), dlatego jest wymagany także przy zapytaniach o tokeny.
export type AllegroApp = { clientId: string; clientSecret: string; userAgent: string; fetchImpl?: typeof fetch };
export type AllegroTokens = { refresh_token: string; access_token: string | null; access_expires_at: string | null };
export type TokenStore = {
  load(): Promise<AllegroTokens | null>;
  // Zapisuje nową parę tylko jeśli w bazie nadal jest `expectedRefresh` (porównanie i zamiana) — chroni przed
  // nadpisaniem przez równoległe odświeżenie. Zwraca, czy zapis się udał.
  save(next: AllegroTokens, expectedRefresh: string): Promise<boolean>;
};

const basic = (a: AllegroApp) => "Basic " + Buffer.from(`${a.clientId}:${a.clientSecret}`).toString("base64");

async function tokenRequest(a: AllegroApp, body: Record<string, string>) {
  const res = await (a.fetchImpl ?? fetch)(`${ALLEGRO_AUTH_URL}/token`, {
    method: "POST",
    headers: { Authorization: basic(a), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": a.userAgent },
    body: new URLSearchParams(body).toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 400 || res.status === 401) throw new AllegroReauthError(`Allegro odrzuciło token (${res.status}): ${text.slice(0, 160)}`);
    throw new Error(`Allegro (autoryzacja) zwróciło błąd (${res.status}): ${text.slice(0, 160)}`);
  }
  const j = await res.json();
  return { access_token: String(j.access_token), refresh_token: String(j.refresh_token), expires_in: Number(j.expires_in) || 43200 };
}

// Krok 5 Authorization Code flow: kod z przekierowania -> para tokenów.
export function exchangeCode(a: AllegroApp, code: string, redirectUri: string) {
  return tokenRequest(a, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, scope: ALLEGRO_SCOPE });
  return `${ALLEGRO_AUTH_URL}/authorize?${q.toString()}`;
}

const stillValid = (t: AllegroTokens | null, now: number) =>
  !!t?.access_token && !!t.access_expires_at && Date.parse(t.access_expires_at) - now > REFRESH_MARGIN_MS;

// Zwraca ważny access token, w razie potrzeby odświeżając go i zapisując nową parę tokenów.
export async function getAccessToken(a: AllegroApp, store: TokenStore, now: () => number = Date.now): Promise<string> {
  const t = await store.load();
  if (!t?.refresh_token) throw new AllegroReauthError("Allegro nie jest połączone — kliknij „Połącz z Allegro”.");
  if (stillValid(t, now())) return t.access_token!;

  try {
    const r = await tokenRequest(a, { grant_type: "refresh_token", refresh_token: t.refresh_token });
    const next: AllegroTokens = {
      refresh_token: r.refresh_token,
      access_token: r.access_token,
      access_expires_at: new Date(now() + r.expires_in * 1000).toISOString(),
    };
    await store.save(next, t.refresh_token);
    return r.access_token;
  } catch (e) {
    // Równoległy przebieg mógł właśnie odświeżyć token (refresh jest jednorazowy) — wtedy bierzemy jego wynik.
    const again = await store.load();
    if (again && again.refresh_token !== t.refresh_token && stillValid(again, now())) return again.access_token!;
    throw e;
  }
}

/* ---------------- zamówienia ---------------- */

export type AllegroClient = { accessToken: string; userAgent: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number };

async function allegroGet(c: AllegroClient, path: string) {
  const doFetch = c.fetchImpl ?? fetch;
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(`${c.baseUrl ?? ALLEGRO_API_URL}${path}`, {
      headers: { Authorization: `Bearer ${c.accessToken}`, Accept: ACCEPT, "User-Agent": c.userAgent },
      cache: "no-store",
      signal: AbortSignal.timeout(c.timeoutMs ?? 30_000),
    });
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    if (res.status === 401) throw new AllegroReauthError("Allegro odrzuciło token dostępu (401) — połącz konto ponownie.");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Allegro zwróciło błąd (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.json();
  }
}

// GET /order/checkout-forms posortowane po updatedAt rosnąco, od `updatedGte` (włącznie).
export async function allegroListOrders(c: AllegroClient, opts: { updatedGte: string; offset: number }): Promise<any[]> {
  const q = new URLSearchParams({ limit: String(PAGE_LIMIT), offset: String(opts.offset), sort: "updatedAt", "updatedAt.gte": opts.updatedGte });
  const data = await allegroGet(c, `/order/checkout-forms?${q.toString()}`);
  return (data.checkoutForms || []) as any[];
}

// Numery przesyłek (waybill) nie są na liście zamówień — pobieramy je osobno, tylko dla zamówień, w których cokolwiek wysłano.
// Błąd pojedynczego zapytania nie psuje synchronizacji (zamówienie zostaje bez numeru do następnej zmiany).
export async function attachShipments(c: AllegroClient, orders: any[], concurrency = 5) {
  const todo = orders.filter((o) => ["SOME", "ALL"].includes(o?.fulfillment?.shipmentSummary?.lineItemsSent));
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
      while (i < todo.length) {
        const o = todo[i++];
        try {
          const data = await allegroGet(c, `/order/checkout-forms/${encodeURIComponent(o.id)}/shipments`);
          o._shipments = data.shipments || [];
        } catch (e) {
          if (e instanceof AllegroReauthError) throw e;
        }
      }
    })
  );
}

// Przechodzi zamówienia zmienione od `since`. Paginacja idzie kursorem po updatedAt (updatedAt.gte = updatedAt ostatniego
// zamówienia, offset 0), a nie samym offsetem — zamówienie zmienione w trakcie skanu przeskakuje na koniec listy i przy
// paginacji offsetem przesunęłoby resztę, gubiąc jedno zamówienie. Gdy cała strona ma ten sam updatedAt co kursor (brak
// postępu), przechodzimy offsetem w obrębie tego kursora. Zwraca kursor do wznowienia.
export async function allegroSweep(
  c: AllegroClient,
  opts: { since: string; budgetMs: number; save: (orders: any[]) => Promise<void>; now?: () => number }
) {
  let cursor = opts.since;
  let offset = 0;
  const result = await scanOrders({
    startPage: 1,
    budgetMs: opts.budgetMs,
    maxPages: 100_000,
    now: opts.now,
    fetchPage: async () => {
      const orders = await allegroListOrders(c, { updatedGte: cursor, offset });
      const last = orders[orders.length - 1];
      if (orders.length < PAGE_LIMIT || !last?.updatedAt) return { results: orders, hasNext: false };
      if (last.updatedAt === cursor) offset += PAGE_LIMIT;
      else {
        cursor = String(last.updatedAt);
        offset = 0;
      }
      return { results: orders, hasNext: true };
    },
    save: opts.save,
  });
  return { finished: result.finished, processed: result.processed, cursor };
}
