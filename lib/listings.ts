// Magazyn -> Listingi (13.10.2026): oferty wystawione na Back Market i refurbed. Tu: mappery odpowiedzi API na wiersz tabeli marketplace_listings, etykiety stanów i klienci
// stron (Back Market GET /ws/listings, refurbed OfferService/ListOffers). Specyfikacje: api.backmarket.dev/bundled_openapi.yaml (ListingPublic) i
// gitlab.com/refurbed-community/public-apis (refb.merchant.v1.OfferService). Synchronizacja migawki: lib/listingsSync.ts, route: app/api/listings/sync.

import { REFURBED_BASE_URL, type RefurbedClient } from "./refurbed";

export type ListingMarketplace = "backmarket" | "refurbed";
export const LISTING_MARKETPLACES: { key: ListingMarketplace; label: string }[] = [
  { key: "backmarket", label: "Back Market" },
  { key: "refurbed", label: "refurbed" },
];

export type ListingRow = {
  marketplace: ListingMarketplace;
  external_id: string;
  sku: string | null;
  title: string | null;
  quantity: number | null;
  price: number | null;
  currency: string | null;
  min_price: number | null;
  max_price: number | null;
  state: string | null;
  grade: string | null;
  warranty_months: number | null;
  product_id: string | null;
  listing_ref: string | null;
  details: Record<string, unknown>;
  listed_at: string | null;
  snapshot_at: string;
};

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
};
const unspecified = (v: unknown): string | null => {
  const s = str(v);
  return s === null || s === "UNSPECIFIED" ? null : s;
};

// ---- Back Market (ListingPublic) ----
export function mapBmListing(l: any, snapshotAt: string): ListingRow | null {
  const id = str(l?.id) ?? str(l?.listing_id);
  if (!id) return null;
  const shippings = Array.isArray(l.shippings)
    ? l.shippings.slice(0, 12).map((s: any) => ({ c: str(s?.country_code), s: str(s?.shipper_display) ?? str(s?.shipper), d: int(s?.shipping_delay), p: num(s?.shipping_price) }))
    : [];
  const details: Record<string, unknown> = {};
  if (str(l.comment)) details.comment = String(l.comment).slice(0, 500);
  if (l.new_battery === true) details.new_battery = true;
  if (l.outlet === true) details.outlet = true;
  if (shippings.length) details.shippings = shippings;
  const bmId = int(l.backmarket_id);
  if (bmId !== null) details.backmarket_id = bmId;
  return {
    marketplace: "backmarket",
    external_id: id,
    sku: str(l.sku),
    title: str(l.title),
    quantity: int(l.quantity),
    price: num(l.price),
    currency: str(l.currency),
    min_price: num(l.min_price),
    max_price: num(l.max_price),
    state: l.publication_state === null || l.publication_state === undefined ? null : String(l.publication_state),
    grade: str(l.grade),
    warranty_months: int(l.warranty_delay),
    product_id: str(l.product_id),
    listing_ref: l.listing_id === null || l.listing_id === undefined ? null : String(l.listing_id),
    details,
    listed_at: null,
    snapshot_at: snapshotAt,
  };
}

// ---- refurbed (Offer) ----
export type MarketPriceBrief = { m: string; p: number | null; c: string | null; v: string | null; b: string | null; calc: boolean };

export function mapRefurbedOffer(o: any, snapshotAt: string): ListingRow | null {
  const id = str(o?.id);
  if (!id) return null;
  if (o.is_current === false) return null; // starsza wersja oferty — interesuje nas aktualna
  // Ceny na rynkach: ustawione ręcznie mają pierwszeństwo przed wyliczonymi (unikalne po market_code).
  const byMarket = new Map<string, MarketPriceBrief>();
  for (const [list, calc] of [[o.calculated_market_prices, true], [o.set_market_prices, false]] as const) {
    for (const mp of Array.isArray(list) ? list : []) {
      const code = str(mp?.market_code);
      if (!code) continue;
      byMarket.set(code, { m: code, p: num(mp.price), c: unspecified(mp.currency_code), v: unspecified(mp.visibility), b: unspecified(mp.instance_buybox_state), calc });
    }
  }
  const details: Record<string, unknown> = {};
  if (byMarket.size) details.markets = [...byMarket.values()].sort((a, b) => a.m.localeCompare(b.m));
  const profile = str(o.shipping_profile_name);
  if (profile) details.shipping_profile = profile;
  const second = str(o.secondary_shipping_profile_name);
  if (second) details.secondary_shipping_profile = second;
  const tax = unspecified(o.real_taxation) ?? unspecified(o.taxation);
  if (tax) details.taxation = tax;
  const battery = unspecified(o.battery_condition);
  if (battery) details.battery = battery;
  const w = unspecified(o.warranty);
  return {
    marketplace: "refurbed",
    external_id: id,
    sku: str(o.sku),
    title: str(o.instance_name),
    quantity: int(o.stock),
    price: num(o.reference_price),
    currency: unspecified(o.reference_currency_code),
    min_price: num(o.reference_min_price),
    max_price: null,
    state: unspecified(o.state),
    grade: unspecified(o.grading),
    warranty_months: w && /^M(\d+)$/.test(w) ? Number(w.slice(1)) : null,
    product_id: str(o.instance_id),
    listing_ref: null,
    details,
    listed_at: str(o.created_at),
    snapshot_at: snapshotAt,
  };
}

// ---- etykiety do UI (surowa wartość zostaje w bazie, więc poprawka etykiety nie wymaga ponownej synchronizacji) ----
// Back Market publication_state: opisu nie ma w OpenAPI (przykład w dokumentacji: 2 = online); znaczenia wg starszej dokumentacji BM — do potwierdzenia na pierwszej synchronizacji.
export const BM_PUBLICATION_LABEL: Record<string, string> = {
  "0": "Brak ceny lub opisu",
  "1": "Oczekuje na weryfikację",
  "2": "Online",
  "3": "Offline",
  "4": "Dezaktywowana",
};
export const REFURBED_STATE_LABEL: Record<string, string> = {
  OK: "Aktywna",
  UNVERIFIED: "Niezweryfikowana",
  SUBMITTED: "Zgłoszona",
  PENDING_REVIEW: "W weryfikacji",
  REJECTED: "Odrzucona",
};
export const BM_GRADE_LABEL: Record<string, string> = {
  PREMIUM: "Premium",
  EXCELLENT: "Doskonały",
  VERY_GOOD: "Bardzo dobry",
  GOOD: "Dobry",
  FAIR: "Przyzwoity",
  STALLONE: "Stallone",
};
export function listingStateLabel(marketplace: string, state: string | null): string {
  if (state === null || state === "") return "—";
  const map = marketplace === "backmarket" ? BM_PUBLICATION_LABEL : REFURBED_STATE_LABEL;
  return map[state] ?? state;
}
// Czy oferta jest "żywa" (ma towar do sprzedaży) — BM: quantity > 0 i publikacja Online (2); refurbed: stock > 0 i stan OK.
export function isListingLive(l: { marketplace: string; quantity: number | null; state: string | null }): boolean {
  if ((l.quantity ?? 0) <= 0) return false;
  return l.marketplace === "backmarket" ? l.state === "2" : l.state === "OK";
}

// ---- klienci stron ----
export type BmListingsConfig = { baseUrl: string; auth: string; lang: string; userAgent: string; fetchImpl?: typeof fetch; timeoutMs?: number };
export const BM_LISTINGS_PAGE_SIZE = 50; // maksimum wg dokumentacji

export function bmListingsConfigFromEnv(): BmListingsConfig | null {
  if (!process.env.BACKMARKET_AUTH) return null;
  return {
    baseUrl: process.env.BACKMARKET_BASE_URL || "https://www.backmarket.fr",
    auth: process.env.BACKMARKET_AUTH,
    lang: process.env.BACKMARKET_LANG || "fr-fr",
    userAgent: process.env.BACKMARKET_UA || "backmarket@recoo.io",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

// GET /ws/listings?page=N&page-size=50 — BEZ filtra publication_state, więc dostajemy też oferty offline (quantity 0) i dezaktywowane.
export async function bmFetchListingsPage(cfg: BmListingsConfig, page: number): Promise<{ results: any[]; hasNext: boolean; count: number | null }> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const url = `${cfg.baseUrl}/ws/listings?page=${page}&page-size=${BM_LISTINGS_PAGE_SIZE}`;
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(url, {
      headers: { Accept: "application/json", "Accept-Language": cfg.lang, Authorization: cfg.auth, "User-Agent": cfg.userAgent },
      cache: "no-store",
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
    });
    if (RETRY_STATUSES.has(res.status) && attempt < 4) {
      await sleep(1500 * attempt);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Back Market zwrócił błąd (${res.status}) na stronie ${page} listingów: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return { results: (data.results || []) as any[], hasNext: !!data.next, count: typeof data.count === "number" ? data.count : null };
  }
}

// OfferService/ListOffers — kursor: starting_after = id ostatniej oferty, sortowanie po ID rosnąco (jak zamówienia); limit 100 to maksimum.
export async function refurbedFetchOffersPage(c: RefurbedClient, startAfter: string | null): Promise<{ offers: any[]; hasMore: boolean }> {
  const doFetch = c.fetchImpl ?? fetch;
  const body = { pagination: { limit: 100, ...(startAfter ? { starting_after: startAfter } : {}) }, sort: { order: "ASC", by: "ID" } };
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(`${c.baseUrl ?? REFURBED_BASE_URL}/refb.merchant.v1.OfferService/ListOffers`, {
      method: "POST",
      headers: {
        Authorization: `Plain ${c.token.trim().replace(/^Plain\s+/i, "")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": c.userAgent,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(c.timeoutMs ?? 30_000),
    });
    if (RETRY_STATUSES.has(res.status) && attempt < 4) {
      await sleep(1100 * attempt);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Refurbed zwrócił błąd (${res.status}) przy pobieraniu ofert: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return { offers: (data.offers || []) as any[], hasMore: !!data.has_more };
  }
}
