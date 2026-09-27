// Klient Amazon Selling Partner API (SP-API) — https://developer-docs.amazon.com/sp-api. Bezpośrednia integracja
// (nie most przez Apilo). Amazon dzieli sprzedawców na REGIONY, nie kraje: konto zarejestrowane w Europie obsługuje
// wszystkie europejskie rynki (PL, DE, FR, ES, IT, BE, NL, IE, SE...) jednym zestawem danych — nie trzeba osobnej
// integracji na każdy kraj, wystarczy lista `marketplaceId` w jednym zapytaniu.
//
// Autoryzacja: aplikacja prywatna (self-authorization w Seller Central: Apps and Services -> Develop Apps -> Authorize).
// To daje JEDEN, DŁUGOTRWAŁY refresh token (w odróżnieniu od Allegro/Apilo NIE rotuje się przy odświeżaniu) — leży
// tylko w zmiennych środowiskowych, nie w bazie. Dostęp: LWA access token (ważny 1h, wymieniany z refresh tokena,
// https://api.amazon.com/auth/o2/token). Od 2023 zapytania do samego SP-API NIE wymagają już podpisu AWS SigV4 —
// wystarczy nagłówek x-amz-access-token.
//
// WAŻNE — limity szybkości są bardzo restrykcyjne i inne dla obu operacji:
//  - GET /orders/v0/orders: 0,0167 req/s (czyli JEDNO zapytanie na ok. 60 s), zapas (burst) 20 zapytań.
//  - GET /orders/v0/orders/{id}/orderItems: 0,5 req/s, zapas 30.
// Dlatego lista zamówień i pozycje zamówień to DWIE oddzielne, samodzielnie tempowane fazy (patrz orders/amazon-sync).

export const AMAZON_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
export const AMAZON_EU_ENDPOINT = "https://sellingpartnerapi-eu.amazon.com";

// Rynki UE, na których działamy (kod kraju -> marketplaceId, https://developer-docs.amazon.com/sp-api/docs/marketplace-ids).
export const AMAZON_EU_MARKETPLACE_IDS: Record<string, string> = {
  PL: "A1C3SOZRARQ6R3",
  DE: "A1PA6795UKMFR9",
  FR: "A13V1IB3VIYZZH",
  ES: "A1RKKUPIHCS9HS",
  IT: "APJ6JRA9NG5V4",
  BE: "AMEN7PMS3EDWL",
  NL: "A1805IZSGTT6HS",
  IE: "A28R8C7NBKEWEA",
  SE: "A2NODRKZP88ZB9",
};

export type AmazonConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  marketplaceIds: string[];
  endpoint?: string;
  fetchImpl?: typeof fetch;
};

export function amazonConfigFromEnv(env: Record<string, string | undefined> = process.env): AmazonConfig | null {
  const clientId = env.AMAZON_CLIENT_ID?.trim();
  const clientSecret = env.AMAZON_CLIENT_SECRET?.trim();
  const refreshToken = env.AMAZON_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  // Domyślnie wszystkie skonfigurowane rynki UE; AMAZON_MARKETPLACE_IDS pozwala zawęzić (lista kodów krajów po przecinku).
  const codes = env.AMAZON_MARKETPLACE_IDS?.trim();
  const marketplaceIds = codes
    ? codes.split(",").map((c) => AMAZON_EU_MARKETPLACE_IDS[c.trim().toUpperCase()]).filter((x): x is string => !!x)
    : Object.values(AMAZON_EU_MARKETPLACE_IDS);
  if (marketplaceIds.length === 0) return null;
  return { clientId, clientSecret, refreshToken, marketplaceIds, endpoint: env.AMAZON_ENDPOINT?.trim() || undefined };
}

export class AmazonError extends Error {
  constructor(message: string, public status?: number, public retryAfterMs?: number) {
    super(message);
  }
}

// Access token żyje tylko godzinę i zapytań o niego nie brakuje (limit osobny od danych) — pobieramy nowy na każdy
// przebieg synchronizacji zamiast trzymać go w bazie; to prostsze niż Allegro/Apilo i nie wymaga tabeli tokenów.
export async function amazonGetAccessToken(cfg: AmazonConfig): Promise<string> {
  const res = await (cfg.fetchImpl ?? fetch)(AMAZON_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cfg.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret }).toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new AmazonError(`Amazon (autoryzacja) zwróciło błąd (${res.status}): ${text.slice(0, 200)}`, res.status);
  return String(JSON.parse(text).access_token);
}

function userAgent() {
  return process.env.AMAZON_USER_AGENT?.trim() || "RecooERP/1.0 (Language=TypeScript; Platform=Vercel)";
}

// Odczytuje sugerowany czas oczekiwania z odpowiedzi 429 (Retry-After w sekundach), z bezpiecznym zapasem.
function retryDelayMs(res: Response, fallbackMs: number): number {
  const retryAfter = Number(res.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 + 1000 : fallbackMs;
}

async function amazonGet(cfg: AmazonConfig, accessToken: string, path: string, params: URLSearchParams, fallbackRetryMs: number): Promise<any> {
  const doFetch = cfg.fetchImpl ?? fetch;
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(`${cfg.endpoint ?? AMAZON_EU_ENDPOINT}${path}?${params.toString()}`, {
      headers: { "x-amz-access-token": accessToken, "x-amz-date": new Date().toISOString().replace(/[-:]|\.\d+/g, ""), "user-agent": userAgent(), accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && attempt <= 3) {
      const wait = retryDelayMs(res, fallbackRetryMs);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      if (res.status === 429) throw new AmazonError(`Amazon: limit zapytań przekroczony (429) mimo ponowień.`, 429, retryDelayMs(res, fallbackRetryMs));
      throw new AmazonError(`Amazon zwróciło błąd (${res.status}): ${text.slice(0, 300)}`, res.status);
    }
    return JSON.parse(text);
  }
}

// GET /orders/v0/orders — jedna strona (maks. 100). `nextToken` (z poprzedniej odpowiedzi) ma pierwszeństwo nad
// filtrami dat, tak jak wymaga tego API.
export async function amazonGetOrders(cfg: AmazonConfig, accessToken: string, opts: { lastUpdatedAfter?: string; nextToken?: string }): Promise<{ orders: any[]; nextToken: string | null }> {
  const params = new URLSearchParams();
  if (opts.nextToken) params.set("NextToken", opts.nextToken);
  else {
    params.set("MarketplaceIds", cfg.marketplaceIds.join(","));
    params.set("MaxResultsPerPage", "100");
    if (opts.lastUpdatedAfter) params.set("LastUpdatedAfter", opts.lastUpdatedAfter);
  }
  const data = await amazonGet(cfg, accessToken, "/orders/v0/orders", params, 65_000);
  return { orders: (data.payload?.Orders as any[]) || [], nextToken: data.payload?.NextToken || null };
}

// GET /orders/v0/orders/{id}/orderItems — pozycje jednego zamówienia (SKU nie jest zwracany w liście zamówień).
export async function amazonGetOrderItems(cfg: AmazonConfig, accessToken: string, orderId: string): Promise<any[]> {
  const data = await amazonGet(cfg, accessToken, `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`, new URLSearchParams(), 3_000);
  return (data.payload?.OrderItems as any[]) || [];
}
