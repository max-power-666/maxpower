// Ceny na marketplace'ach (16.10.2026, "Do wystawienia"): odczyt ceny BuyBox/Backbox i ustawianie ceny oferty. Tylko serwer (klucze API).
//  - Back Market: GET /ws/backbox/v1/competitors/{listingId} (cena do wygrania Backbox, cena zwycięzcy, czy wygrywamy — osobno dla każdego rynku) oraz POST /ws/listings/{listingId}
//    z samą ceną ("You just need to specify field(s) you would like to change") — cena dotyczy rynku z nagłówka Accept-Language (u nas BACKMARKET_LANG, domyślnie fr-fr).
//  - refurbed: OfferService/GetOffer (ceny rynkowe z polami instance_buybox_state i instance_buybox_info.suggested_offer_price) oraz OfferService/UpdateOffer z reference_price
//    (cena referencyjna, z której refurbed liczy ceny rynków, które nie mają ręcznie ustawionej ceny).
// Specyfikacje: api.backmarket.dev/bundled_openapi.yaml i gitlab.com/refurbed-community/public-apis. NIE testowane na żywych API (z komputera asystenta Back Market zwraca 401, tokena refurbed
// nie ma lokalnie) — kształty żądań i odpowiedzi sprawdzone na atrapie fetch wg specyfikacji; pierwsze użycie zrób na jednej ofercie.
import type { BmListingsConfig } from "./listings";
import { REFURBED_BASE_URL, type RefurbedClient } from "./refurbed";

export type MarketInfo = {
  market: string; // kod rynku (FR, DE, …)
  ours: number | null; // nasza cena w tym rynku
  currency: string | null;
  won: boolean | null; // czy mamy Backbox/BuyBox (null = nieznane)
  priceToWin: number | null; // cena, którą trzeba ustawić, żeby wygrać
  winnerPrice: number | null; // cena aktualnego zwycięzcy
  state: string | null; // surowy stan (refurbed: WON/ELIGIBLE/…)
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(typeof v === "string" ? v.replace(",", ".") : v);
  return Number.isFinite(n) ? n : null;
};
const money = (m: any): { v: number | null; c: string | null } => ({ v: num(m?.amount), c: typeof m?.currency === "string" ? m.currency : null });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function withRetry(doFetch: typeof fetch, url: string, init: RequestInit, what: string, timeoutMs = 30_000): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if ([429, 502, 503, 504].includes(res.status) && attempt < 3) {
      await sleep(1200 * attempt);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${what} — błąd ${res.status}: ${text.slice(0, 250)}`);
    }
    return res;
  }
}

export const bmHeaders = (cfg: BmListingsConfig, json = false) => ({
  Accept: "application/json",
  "Accept-Language": cfg.lang,
  Authorization: cfg.auth,
  "User-Agent": cfg.userAgent,
  ...(json ? { "Content-Type": "application/json" } : {}),
});

// ---- Back Market ----
export async function bmMarketInfo(cfg: BmListingsConfig, listingId: string): Promise<MarketInfo[]> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await withRetry(doFetch, `${cfg.baseUrl}/ws/backbox/v1/competitors/${encodeURIComponent(listingId)}`, { headers: bmHeaders(cfg) }, "Back Market (Backbox)", cfg.timeoutMs);
  const data = await res.json();
  const items: any[] = Array.isArray(data) ? data : [];
  const own = items.filter((c) => String(c?.listing_id || "").toLowerCase() === listingId.toLowerCase());
  return (own.length ? own : items).map((c) => {
    const price = money(c.price);
    const ptw = money(c.price_to_win);
    const win = money(c.winner_price);
    return { market: String(c.market || ""), ours: price.v, currency: price.c ?? ptw.c ?? win.c, won: typeof c.is_winning === "boolean" ? c.is_winning : null, priceToWin: ptw.v, winnerPrice: win.v, state: null };
  });
}

export async function bmSetListingPrice(cfg: BmListingsConfig, listingId: string, price: number, currency: string, minPrice?: number | null): Promise<{ price: number | null; minPrice: number | null }> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await withRetry(
    doFetch,
    `${cfg.baseUrl}/ws/listings/${encodeURIComponent(listingId)}`,
    { method: "POST", headers: bmHeaders(cfg, true), body: JSON.stringify({ price: price.toFixed(2), currency, ...(minPrice ? { min_price: minPrice.toFixed(2) } : {}) }) },
    "Back Market (zmiana ceny)",
    cfg.timeoutMs
  );
  const data = await res.json().catch(() => null);
  return { price: num(data?.price), minPrice: num(data?.min_price) };
}

// ---- refurbed ----
export const rfHeaders = (c: RefurbedClient) => ({
  Authorization: `Plain ${c.token.trim().replace(/^Plain\s+/i, "")}`,
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": c.userAgent,
});
export const rfUrl = (c: RefurbedClient, method: string) => `${c.baseUrl ?? REFURBED_BASE_URL}/refb.merchant.v1.OfferService/${method}`;

// Ceny rynków z oferty: ręcznie ustawione mają pierwszeństwo przed wyliczonymi. Stan BuyBox: WON / SHOULD_WIN = mamy (SHOULD_WIN: wygramy przy najbliższym odświeżeniu), ELIGIBLE / WON_ELSEWHERE = nie mamy,
// INELIGIBLE / UNSPECIFIED = nie wiadomo.
export function mapRefurbedMarkets(offer: any): MarketInfo[] {
  const by = new Map<string, MarketInfo>();
  for (const list of [offer?.calculated_market_prices, offer?.set_market_prices]) {
    for (const mp of Array.isArray(list) ? list : []) {
      const code = String(mp?.market_code || "");
      if (!code) continue;
      const state = typeof mp.instance_buybox_state === "string" && mp.instance_buybox_state !== "UNSPECIFIED" ? mp.instance_buybox_state : null;
      const info = mp.instance_buybox_info || {};
      by.set(code, {
        market: code,
        ours: num(mp.price),
        currency: typeof mp.currency_code === "string" && mp.currency_code !== "UNSPECIFIED" ? mp.currency_code : null,
        won: state === "WON" || state === "SHOULD_WIN" ? true : state === "ELIGIBLE" || state === "WON_ELSEWHERE" ? false : null,
        priceToWin: num(info.suggested_offer_price),
        winnerPrice: num(info.site_market_competitor_price),
        state,
      });
    }
  }
  return [...by.values()].sort((a, b) => a.market.localeCompare(b.market));
}

export async function refurbedMarketInfo(c: RefurbedClient, offerId: string): Promise<MarketInfo[]> {
  const doFetch = c.fetchImpl ?? fetch;
  const res = await withRetry(doFetch, rfUrl(c, "GetOffer"), { method: "POST", headers: rfHeaders(c), body: JSON.stringify({ identifier: { id: offerId } }) }, "refurbed (GetOffer)", c.timeoutMs);
  const data = await res.json();
  return mapRefurbedMarkets(data?.offer);
}

export async function refurbedSetReferencePrice(c: RefurbedClient, offerId: string, price: number, currency: string, minPrice?: number | null): Promise<{ price: number | null; minPrice: number | null }> {
  const doFetch = c.fetchImpl ?? fetch;
  const res = await withRetry(
    doFetch,
    rfUrl(c, "UpdateOffer"),
    { method: "POST", headers: rfHeaders(c), body: JSON.stringify({ identifier: { id: offerId }, reference_price: price.toFixed(2), reference_currency_code: currency, ...(minPrice ? { reference_min_price: minPrice.toFixed(2) } : {}) }) },
    "refurbed (UpdateOffer)",
    c.timeoutMs
  );
  const data = await res.json().catch(() => null);
  return { price: num(data?.offer?.reference_price), minPrice: num(data?.offer?.reference_min_price) };
}
