// Magazyn -> Listingi (13.10.2026): oferty wystawione na Back Market i refurbed. Tu: mappery odpowiedzi API na wiersz tabeli marketplace_listings, etykiety stanów i klienci
// stron (Back Market GET /ws/listings, refurbed OfferService/ListOffers). Specyfikacje: api.backmarket.dev/bundled_openapi.yaml (ListingPublic) i
// gitlab.com/refurbed-community/public-apis (refb.merchant.v1.OfferService). Synchronizacja migawki: lib/listingsSync.ts, route: app/api/listings/sync.

import { REFURBED_BASE_URL, type RefurbedClient } from "./refurbed";

export type ListingMarketplace = "backmarket" | "refurbed" | "octopia";
export const LISTING_MARKETPLACES: { key: ListingMarketplace; label: string }[] = [
  { key: "backmarket", label: "Back Market" },
  { key: "refurbed", label: "refurbed" },
  { key: "octopia", label: "Cdiscount" }, // Octopia, kanał CDISFR (16.10.2026)
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

// ---- Octopia / Cdiscount (GET /offers z expand=salesChannelFeedback, 16.10.2026) ----
// Specyfikacja: developer.octopia-io.net (Octopia-SellerAPI-2026-10-15.yml). offerId = SellerId_ProductId_ConditionId_SalesChannelId; SKU = sellerExternalReference; ilość = suma ilości ofert dostawy
// (deliveryOffers[].quantity — stan jest wspólny dla kanałów); cena = cena wyświetlana na kanale (facialPrice), a gdy brak — cena integracji. Cena minimalna to offerCompetition.minimumPrice (wbudowany
// automat Cdiscount obniża cenę do 0,01 € poniżej najtańszego konkurenta, ale nie poniżej minimum — API tylko to ODCZYTUJE). BuyBox: salesChannelFeedback.bestOfferDetails (Cdiscount), a dla innych kanałów isBestOffer.
export type OctopiaBrief = {
  bb: boolean | null; // czy mamy BuyBox
  bbAt: string | null;
  bestPrice: number | null; // cena oferty z BuyBox
  bestDelivery: number | null;
  comp: boolean | null; // offerCompetition.isActivated
  compMin: number | null; // offerCompetition.minimumPrice
  online: boolean | null;
  offersCount: number | null;
  score: string | null; // Qualiscore
  offlineReason: string | null;
  competing: { n: string | null; p: number | null; d: number | null; b: boolean | null }[];
  ext: { name: string | null; total: number | null; idx: number | null } | null;
};
export function mapOctopiaOffer(o: any, snapshotAt: string): ListingRow | null {
  const id = str(o?.offerId);
  if (!id) return null;
  const fb = o.salesChannelFeedback ?? {};
  const best = fb.bestOfferDetails ?? null;
  const bb = typeof best?.isBestOffer === "boolean" ? best.isBestOffer : typeof o.isBestOffer === "boolean" ? o.isBestOffer : null;
  const bestOffer = best?.bestOffer ?? o.bestOffer ?? null;
  const deliveries: any[] = Array.isArray(o.deliveryOffers) ? o.deliveryOffers : [];
  const qty = deliveries.reduce((s, d) => s + (int(d?.quantity) ?? 0), 0);
  const price = num(o.facialPrice?.price) ?? num(o.integrationPrice?.price);
  const brief: OctopiaBrief = {
    bb,
    bbAt: str(best?.isBestOfferUpdatedAt),
    bestPrice: num(bestOffer?.price),
    bestDelivery: num(bestOffer?.deliveryCost),
    comp: typeof o.offerCompetition?.isActivated === "boolean" ? o.offerCompetition.isActivated : null,
    compMin: num(o.offerCompetition?.minimumPrice),
    online: typeof fb.isOnline === "boolean" ? fb.isOnline : null,
    offersCount: int(fb.productInformation?.offersCount),
    score: str(fb.offerQuality?.offerScore),
    offlineReason: str(fb.offlineReason?.reason),
    competing: (Array.isArray(fb.competingOffers) ? fb.competingOffers : []).slice(0, 8).map((c: any) => ({ n: str(c?.sellerName), p: num(c?.displayedOfferPrice), d: num(c?.deliveryCost), b: typeof c?.isBestOffer === "boolean" ? c.isBestOffer : null })),
    ext: fb.externalCompetingOffer ? { name: str(fb.externalCompetingOffer.marketplaceName), total: num(fb.externalCompetingOffer.totalPrice), idx: num(fb.externalCompetingOffer.priceIndex) } : null,
  };
  const details: Record<string, unknown> = { octopia: brief };
  if (str(o.comments)) details.comment = String(o.comments).slice(0, 500);
  const url = str(fb.productInformation?.productPageUrl);
  if (url && /^https?:\/\//.test(url)) details.product_page_url = url;
  const prep = deliveries.map((d) => int(d?.preparationTime)).find((x) => x !== null);
  if (prep !== undefined && prep !== null) details.preparation_days = prep;
  const modes = deliveries.flatMap((d) => (Array.isArray(d?.deliveryModes) ? d.deliveryModes : [])).slice(0, 6).map((m: any) => ({ c: str(m?.legacyDeliveryModeId) ?? str(m?.code), d: int(m?.maxDeliveryTime), p: num(m?.cost) }));
  if (modes.length) details.delivery_modes = modes;
  return {
    marketplace: "octopia",
    external_id: id,
    sku: str(o.sellerExternalReference),
    title: str(o.product?.title) ?? str(o.product?.reference) ?? str(o.product?.gtin),
    quantity: qty,
    price,
    currency: str(o.facialPrice?.currencyCode) ?? str(o.integrationPrice?.currencyCode),
    min_price: brief.compMin,
    max_price: null,
    state: str(o.offerState),
    grade: str(o.condition),
    warranty_months: null,
    product_id: str(o.product?.reference),
    listing_ref: str(o.product?.gtin),
    details,
    listed_at: str(o.createdAt),
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
export const OCTOPIA_STATE_LABEL: Record<string, string> = { Active: "Aktywna", Inactive: "Nieaktywna" };
export const OCTOPIA_CONDITION_LABEL: Record<string, string> = { New: "Nowy", LikeNew: "Jak nowy", VeryGoodState: "Bardzo dobry", GoodState: "Dobry", AverageState: "Średni", Refurbished: "Odnowiony", RefurbishedLikeNew: "Odnowiony — jak nowy", RefurbishedVeryGoodState: "Odnowiony — bardzo dobry", RefurbishedCorrectState: "Odnowiony — zadowalający" };
export function listingStateLabel(marketplace: string, state: string | null): string {
  if (state === null || state === "") return "—";
  const map = marketplace === "backmarket" ? BM_PUBLICATION_LABEL : marketplace === "octopia" ? OCTOPIA_STATE_LABEL : REFURBED_STATE_LABEL;
  return map[state] ?? state;
}
// Czy oferta jest "żywa" (ma towar do sprzedaży) — BM: quantity > 0 i publikacja Online (2); refurbed: stock > 0 i stan OK.
export function isListingLive(l: { marketplace: string; quantity: number | null; state: string | null }): boolean {
  if ((l.quantity ?? 0) <= 0) return false;
  return l.marketplace === "backmarket" ? l.state === "2" : l.marketplace === "octopia" ? l.state === "Active" : l.state === "OK";
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

// ---- linki do oferty (13.10.2026) ----
// Sprawdzone 13.10.2026: backmarket.fr/p/{slug}/{product_id} przekierowuje na /fr-fr/p/{slug}/{product_id} (strona produktu otwiera się po UUID produktu), a /bo-seller/listings(/active) to istniejąca
// trasa panelu sprzedawcy (po zalogowaniu). Publiczna strona refurbed wymaga właściwego sluga rodziny produktu (np. "iphone-13"), którego nie da się wyprowadzić z naszych danych — dla refurbed
// jest więc tylko panel sprzedawcy (szczegóły oferty po jej ID).
export function slugify(title: string | null | undefined): string {
  const s = (title ?? "")
    .replace(/ł/g, "l") // "ł" nie rozkłada się w NFKD
    .replace(/Ł/g, "L")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return s || "produit";
}

export type ListingLink = { label: string; url: string; hint: string };
export function listingLinks(l: { marketplace: string; product_id: string | null; title: string | null; sku?: string | null; external_id?: string | null; details?: Record<string, any> | null }): ListingLink[] {
  if (l.marketplace === "octopia") {
    // Publiczna strona produktu na Cdiscount (z informacji kanału); panel sprzedawcy adresuje oferty wewnętrznymi identyfikatorami, których API nie zwraca.
    const url = typeof l.details?.product_page_url === "string" ? l.details.product_page_url : "";
    return url ? [{ label: "Strona produktu", url, hint: "Publiczna strona produktu na Cdiscount" }] : [];
  }
  if (l.marketplace === "backmarket") {
    const links: ListingLink[] = [];
    if (l.product_id) links.push({ label: "Strona produktu", url: `https://www.backmarket.fr/fr-fr/p/${slugify(l.title)}/${encodeURIComponent(l.product_id)}`, hint: "Publiczna strona produktu na backmarket.fr" });
    // Wzorzec adresu podany przez właściciela 13.10.2026 (lista aktywnych listingów przefiltrowana po SKU, najwięcej sztuk na górze).
    const sku = (l.sku ?? "").trim();
    links.push(
      sku
        ? { label: "Panel", url: `https://www.backmarket.fr/bo-seller/listings/active?orderBy=-quantity&pageSize=10&sku=${encodeURIComponent(sku)}`, hint: "Ta oferta w panelu sprzedawcy Back Market (lista przefiltrowana po SKU)" }
        : { label: "Panel", url: "https://www.backmarket.fr/bo-seller/listings/active", hint: "Lista aktywnych listingów w panelu sprzedawcy Back Market" }
    );
    return links;
  }
  // refurbed: szczegóły pojedynczej oferty w panelu — wzorzec podany przez właściciela 13.10.2026 (https://merchant.refurbed.com/offers/details/{id}; parametry tableOptions/freeSearchOptions
  // z jego przykładu to tylko stan listy, więc pomijamy je jak przy linku do zamówienia). {id} to Offer.id z API (nasze external_id).
  const id = (l.external_id ?? "").trim();
  return id
    ? [{ label: "Panel", url: `https://merchant.refurbed.com/offers/details/${encodeURIComponent(id)}`, hint: "Ta oferta w panelu sprzedawcy refurbed" }]
    : [{ label: "Panel", url: "https://merchant.refurbed.com/offers", hint: "Lista ofert w panelu sprzedawcy refurbed" }];
}
