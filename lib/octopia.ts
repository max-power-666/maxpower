// Klient API Octopia (marketplace'y takie jak Cdiscount) — https://developer.octopia-io.net, OpenAPI: "API REST Seller V2".
// Autoryzacja: OAuth2 client_credentials na osobnym serwerze (auth.octopia-io.net), token ważny 2h (limit 500 tokenów/h — więc
// pobieramy jeden token na cały przebieg synchronizacji, nie na każde zapytanie). Zapytania do API idą z nagłówkami
// Authorization: Bearer <token> oraz SellerId: <numer sprzedawcy>.

import { scanOrders } from "./scanOrders";

export const OCTOPIA_API_URL = "https://api.octopia-io.net/seller/v2";
export const OCTOPIA_AUTH_URL = "https://auth.octopia-io.net/auth/realms/maas/protocol/openid-connect/token";
const PAGE_SIZE = 100; // maksimum wg dokumentacji

export type OctopiaConfig = { clientId: string; clientSecret: string; sellerId: string; fetchImpl?: typeof fetch };

export function octopiaConfigFromEnv(env: Record<string, string | undefined> = process.env): OctopiaConfig | null {
  const clientId = env.OCTOPIA_CLIENT_ID?.trim();
  const clientSecret = env.OCTOPIA_CLIENT_SECRET?.trim();
  const sellerId = env.OCTOPIA_SELLER_ID?.trim();
  return clientId && clientSecret && sellerId ? { clientId, clientSecret, sellerId } : null;
}

export class OctopiaError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export async function getToken(cfg: OctopiaConfig): Promise<string> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(OCTOPIA_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "client_credentials" }).toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OctopiaError(`Octopia (autoryzacja) zwróciło błąd (${res.status}): ${text.slice(0, 200)}`, res.status);
  }
  const j = await res.json();
  return String(j.access_token);
}

async function octopiaGet(cfg: OctopiaConfig, token: string, path: string): Promise<any> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`${OCTOPIA_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, SellerId: cfg.sellerId, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OctopiaError(`Octopia zwróciło błąd (${res.status}): ${text.slice(0, 200)}`, res.status);
  }
  return res.json();
}

// GET /orders — jedna strona. Odpowiedź nie podaje łącznej liczby wyników: koniec listy to strona krótsza niż pageSize.
export async function octopiaListOrders(cfg: OctopiaConfig, token: string, opts: { updatedAtMin?: string; pageIndex: number }): Promise<any[]> {
  const params = new URLSearchParams({ pageIndex: String(opts.pageIndex), pageSize: String(PAGE_SIZE), sort: "asc:updatedAt" });
  if (opts.updatedAtMin) params.set("updatedAtMin", opts.updatedAtMin);
  const data = await octopiaGet(cfg, token, `/orders?${params.toString()}`);
  return (data.items as any[]) || [];
}

// Przechodzi wszystkie strony od `since` (z budżetem czasu) i przekazuje je do save. Sortujemy po updatedAt rosnąco i idziemy
// numerem strony — w obrębie jednego przebiegu zamówienia mogą się zmieniać, ale kolejna synchronizacja (cron co 15 min) i tak
// pobierze zmienione ponownie dzięki nakładce czasowej w route'cie wywołującym.
export async function octopiaSweep(cfg: OctopiaConfig, opts: { since?: string; budgetMs: number; save: (orders: any[]) => Promise<void>; now?: () => number }) {
  const token = await getToken(cfg);
  const result = await scanOrders({
    startPage: 1,
    budgetMs: opts.budgetMs,
    maxPages: 100_000,
    now: opts.now,
    fetchPage: async (page) => {
      const orders = await octopiaListOrders(cfg, token, { updatedAtMin: opts.since, pageIndex: page });
      return { results: orders, hasNext: orders.length >= PAGE_SIZE };
    },
    save: opts.save,
  });
  return { finished: result.finished, processed: result.processed, nextPage: result.nextPage };
}

// ---- Akcje na zamówieniu (06.10.2026): akceptacja i zgłoszenie przesyłki ----
// Dokumentacja: https://developer.octopia-io.net/api-reference/orders-management/ (Approve an order / Ship an order).
// Zmieniają prawdziwe zamówienie u marketplace'u, więc ZAWSZE wołane z jawnej akcji użytkownika (przycisk / nadanie przesyłki).

// Nazwy przewoźników zgłaszane do Octopii (pole carrierName jest wolnym tekstem — w naszych zamówieniach występują m.in. "DHL",
// "DHL Express", "UPS"); te same, które już są na wysłanych zamówieniach.
export const OCTOPIA_CARRIER_BY_CARRIER = { dhl_express: "DHL Express", dhl_parcel: "DHL", ups: "UPS" } as const;

async function octopiaPost(cfg: OctopiaConfig, token: string, path: string, body: unknown): Promise<void> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`${OCTOPIA_API_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, SellerId: cfg.sellerId, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Odpowiedzi błędów to application/problem+json — "errors" niesie konkretną przyczynę (np. "Cannot switch to shipped status ...").
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      const errs = j?.errors ? Object.entries(j.errors).map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`).join("; ") : "";
      detail = [j?.detail, errs].filter(Boolean).join(" — ") || j?.title || detail;
    } catch {
      /* zostaje surowy tekst */
    }
    throw new OctopiaError(`Octopia zwróciło błąd (${res.status}): ${detail}`, res.status);
  }
}

export async function octopiaGetOrder(cfg: OctopiaConfig, orderId: string, token?: string): Promise<any> {
  return octopiaGet(cfg, token ?? (await getToken(cfg)), `/orders/${encodeURIComponent(orderId)}`);
}

// POST /orders/{id}/approval-status — tylko Cdiscount, tylko zamówienie w stanie WaitingAcceptance (po akceptacji: Accepted -> InPreparation).
export async function octopiaApproveOrder(cfg: OctopiaConfig, orderId: string): Promise<void> {
  const token = await getToken(cfg);
  await octopiaPost(cfg, token, `/orders/${encodeURIComponent(orderId)}/approval-status`, { approval_status: "Accepted" });
}

// POST /orders/{id}/shipments — zgłasza paczkę (przewoźnik + numer + link śledzenia) dla pozycji gotowych do wysyłki. Wymaga stanu
// InPreparation i supplyMode = Seller; nadaje się do wywołania PRZED odbiorem paczki przez kuriera. Zwraca, co zrobiono.
export async function octopiaShipOrder(
  cfg: OctopiaConfig,
  opts: { orderId: string; carrierName: string; parcelNumber: string; trackingUrl: string }
): Promise<{ alreadyShipped: boolean }> {
  const token = await getToken(cfg);
  const order = await octopiaGetOrder(cfg, opts.orderId, token);
  const lines: any[] = Array.isArray(order?.lines) ? order.lines : [];
  const hasParcel = lines.some((l) => (l?.parcels || []).some((p: any) => String(p?.parcelNumber) === opts.parcelNumber));
  if (hasParcel) return { alreadyShipped: true }; // ponowienie po udanym zgłoszeniu — nic do zrobienia
  const ready = lines.filter((l) => l?.status === "InPreparation" && (l?.offer?.supplyMode ?? "Seller") === "Seller");
  if (ready.length === 0) {
    const st = order?.status ? `status zamówienia: ${order.status}` : "brak pozycji gotowych do wysyłki";
    throw new OctopiaError(
      order?.status === "WaitingAcceptance" || order?.status === "Accepted"
        ? `Zamówienie nie jest jeszcze gotowe do wysyłki w Octopii (${st}) — zaakceptuj je i zgłoś numer przesyłki ponownie.`
        : `Octopia nie ma pozycji w stanie InPreparation (${st}) — nie da się zgłosić przesyłki.`
    );
  }
  await octopiaPost(cfg, token, `/orders/${encodeURIComponent(opts.orderId)}/shipments`, [
    { parcelNumber: opts.parcelNumber, carrierName: opts.carrierName, trackingUrl: opts.trackingUrl, orderLineIds: ready.map((l) => String(l.orderLineId)) },
  ]);
  return { alreadyShipped: false };
}

// ---- Oferty (16.10.2026, Magazyn -> Listingi -> Cdiscount) ----
// GET /offers?salesChannelId=CDISFR&limit=…&expand=salesChannelFeedback — paginacja kursorem: nagłówek Link z rel="next" i parametrem Cursor. expand dokłada dane kanału (BuyBox, konkurencja, jakość).
export const OCTOPIA_OFFERS_LIMIT = 200; // maksimum to 1000, ale z expand odpowiedzi są duże
export async function octopiaFetchOffersPage(cfg: OctopiaConfig, token: string, cursor: string | null, salesChannelId = "CDISFR"): Promise<{ items: any[]; nextCursor: string | null }> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const params = new URLSearchParams({ salesChannelId, limit: String(OCTOPIA_OFFERS_LIMIT), expand: "salesChannelFeedback" });
  if (cursor) params.set("Cursor", cursor);
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(`${OCTOPIA_API_URL}/offers?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, SellerId: cfg.sellerId, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if ([429, 502, 503, 504].includes(res.status) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new OctopiaError(`Octopia zwróciło błąd (${res.status}) przy pobieraniu ofert: ${text.slice(0, 200)}`, res.status);
    }
    const data = await res.json();
    const items = (data.items as any[]) || [];
    const link = res.headers.get("link") || "";
    let next: string | null = null;
    for (const part of link.split(/,\s*(?=<)/)) {
      if (!/rel="?next"?/i.test(part)) continue;
      const m = part.match(/[?&]Cursor=([^&>\s]+)/i);
      if (m) next = decodeURIComponent(m[1]);
    }
    // obrona przed pętlą: ten sam kursor albo pusta strona kończą listę
    return { items, nextCursor: next && next !== cursor && items.length > 0 ? next : null };
  }
}

// ---- Zmiana cen ofert (19.10.2026, Magazyn -> Listingi -> Cdiscount, bidder) ----
// API Octopii zmienia ceny wyłącznie wsadowo i asynchronicznie, przez paczkę ofert typu Update (specyfikacja "API REST Seller V2", /offer-packages):
// (1) POST /offer-packages {packageType: "Update"} z nagłówkiem SalesChannelId — id paczki w Content-Location,
// (2) POST /offer-packages/{id}/offer-requests — do 100 ofert, każda: sellerExternalReference + price {price, taxes} (przy zmianie ceny trzeba podać PEŁNĄ listę podatków oferty),
// (3) PATCH /offer-packages/{id} {state: "Ready"} — paczka idzie do przetworzenia, (4) GET /offer-packages/{id} — stan (Ready -> IntegrationPending -> Integrated/Rejected),
// (5) GET /offer-packages/{id}/offer-requests-results — wynik per oferta. Podatki bierzemy z ofert pobranych tuż przed zmianą (kody z GET zamieniamy na nazwy z enumu żądania).
// NIE testowane na żywym API (brak danych dostępowych lokalnie) — kształty wg specyfikacji; pierwszą zmianę zrób na jednej ofercie i sprawdź w panelu Cdiscount.
const OCTOPIA_TAX_CODES: Record<string, string> = { vat: "VAT", ecotax: "Ecotax", deatax: "Deatax", privatecopy: "PrivateCopy", chemicaltax: "ChemicalTax" };

async function octopiaRequest(cfg: OctopiaConfig, token: string, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Headers; json: any }> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`${OCTOPIA_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, SellerId: cfg.sellerId, Accept: "application/json", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* odpowiedź bez JSON (np. 201/204) */
  }
  if (!res.ok) {
    let detail = text.slice(0, 300);
    if (json) {
      const errs = json.errors ? Object.entries(json.errors).map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`).join("; ") : "";
      detail = [json.detail, errs].filter(Boolean).join(" — ") || json.title || detail;
    }
    throw new OctopiaError(`Octopia zwróciło błąd (${res.status}) [${method} ${path.split("?")[0]}]: ${detail}`, res.status);
  }
  return { status: res.status, headers: res.headers, json };
}

export type OctopiaPriceResult = { offerId: string; ok: boolean; message: string; sellerExternalReference?: string; verifiedPrice?: number | null };
export type OctopiaPriceBatch = { packageId: string | null; packageState: string | null; results: OctopiaPriceResult[] };

export function octopiaTaxesForRequest(taxes: unknown): { code: string; value: number }[] | null {
  if (!Array.isArray(taxes) || taxes.length === 0) return null;
  const out: { code: string; value: number }[] = [];
  for (const t of taxes as any[]) {
    const code = OCTOPIA_TAX_CODES[String(t?.code || "").toLowerCase()];
    const value = Number(t?.value);
    if (!code || !Number.isFinite(value)) return null; // nieznany podatek — nie zgadujemy (przy Update lista podatków zastępuje całą istniejącą)
    out.push({ code, value });
  }
  return out;
}

// Zmienia ceny ofert (offerId z listingów, np. "331462_CAN4549292092707_2_CDISFR"). Jedna paczka na wywołanie (max 100 ofert).
export async function octopiaSetPrices(cfg: OctopiaConfig, changes: { offerId: string; price: number }[], opts: { salesChannelId?: string; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<OctopiaPriceBatch> {
  const channel = opts.salesChannelId ?? "CDISFR";
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (changes.length === 0) return { packageId: null, packageState: null, results: [] };
  if (changes.length > 100) throw new OctopiaError("Za dużo ofert w jednej paczce (max 100).");
  const token = await getToken(cfg);
  const fetchOffers = async () => {
    const params = new URLSearchParams({ salesChannelId: channel, limit: "100", offerIds: changes.map((c) => c.offerId).join(",") });
    const r = await octopiaRequest(cfg, token, "GET", `/offers?${params.toString()}`);
    const map = new Map<string, any>();
    for (const o of (r.json?.items as any[]) || []) map.set(String(o.offerId), o);
    return map;
  };
  const before = await fetchOffers();
  const results = new Map<string, OctopiaPriceResult>();
  const requests: { sellerExternalReference: string; price: { price: number; taxes: { code: string; value: number }[] } }[] = [];
  const refToOffer = new Map<string, string>();
  for (const c of changes) {
    const o = before.get(c.offerId);
    if (!o) {
      results.set(c.offerId, { offerId: c.offerId, ok: false, message: "Cdiscount nie zwrócił tej oferty — odśwież Listingi." });
      continue;
    }
    const ref = String(o.sellerExternalReference || "");
    const taxes = octopiaTaxesForRequest(o.integrationPrice?.taxes ?? o.facialPrice?.taxes);
    if (!ref) results.set(c.offerId, { offerId: c.offerId, ok: false, message: "Oferta nie ma referencji sprzedawcy (sellerExternalReference)." });
    else if (refToOffer.has(ref)) results.set(c.offerId, { offerId: c.offerId, ok: false, message: `Referencja ${ref} występuje w kilku ofertach — Cdiscount odrzuciłby duplikat.` });
    else if (!taxes) results.set(c.offerId, { offerId: c.offerId, ok: false, message: "Nie da się odczytać podatków oferty (przy zmianie ceny trzeba podać pełną listę) — zmień cenę w panelu Cdiscount." });
    else {
      refToOffer.set(ref, c.offerId);
      requests.push({ sellerExternalReference: ref, price: { price: Math.round(c.price * 100) / 100, taxes } });
      results.set(c.offerId, { offerId: c.offerId, ok: false, message: "Wysłano do Cdiscount — czekam na przetworzenie.", sellerExternalReference: ref });
    }
  }
  if (requests.length === 0) return { packageId: null, packageState: null, results: changes.map((c) => results.get(c.offerId)!) };

  const created = await octopiaRequest(cfg, token, "POST", "/offer-packages", { body: { packageType: "Update" }, headers: { SalesChannelId: channel } });
  const loc = created.headers.get("content-location") || created.headers.get("location") || "";
  const packageId = (loc.split("/").filter(Boolean).pop() || created.json?.packageId || "").toString();
  if (!packageId) throw new OctopiaError("Cdiscount utworzyło paczkę, ale nie zwróciło jej identyfikatora (Content-Location).");
  await octopiaRequest(cfg, token, "POST", `/offer-packages/${encodeURIComponent(packageId)}/offer-requests`, { body: requests });
  await octopiaRequest(cfg, token, "PATCH", `/offer-packages/${encodeURIComponent(packageId)}`, { body: { state: "Ready" } });

  // przetwarzanie jest asynchroniczne (czas nie jest podany w dokumentacji) — czekamy chwilę, a gdy się nie skończy, zwracamy "w trakcie"
  let state: string | null = "Ready";
  let message = "";
  const deadline = Date.now() + (opts.pollMs ?? 25_000);
  while (Date.now() < deadline) {
    await sleep(2000);
    const p = await octopiaRequest(cfg, token, "GET", `/offer-packages/${encodeURIComponent(packageId)}`);
    state = p.json?.state ?? null;
    message = p.json?.result?.message ?? "";
    if (state === "Integrated" || state === "Rejected") break;
  }
  if (state === "Rejected") {
    for (const r of requests) results.set(refToOffer.get(r.sellerExternalReference)!, { offerId: refToOffer.get(r.sellerExternalReference)!, ok: false, sellerExternalReference: r.sellerExternalReference, message: `Paczka odrzucona przez Cdiscount${message ? `: ${message}` : ""}` });
  } else if (state === "Integrated") {
    const rr = await octopiaRequest(cfg, token, "GET", `/offer-packages/${encodeURIComponent(packageId)}/offer-requests-results?limit=100`);
    const byRef = new Map<string, any>();
    for (const it of (rr.json?.items as any[]) || []) byRef.set(String(it.sellerExternalReference), it);
    let after: Map<string, any> | null = null;
    try {
      after = await fetchOffers();
    } catch {
      after = null;
    }
    for (const r of requests) {
      const offerId = refToOffer.get(r.sellerExternalReference)!;
      const it = byRef.get(r.sellerExternalReference);
      const okStatus = it?.integrationStatus === "Integrated";
      const msg = (it?.results || []).map((x: any) => x?.message).filter(Boolean).join("; ");
      const verified = after ? Number(after.get(offerId)?.integrationPrice?.price ?? after.get(offerId)?.facialPrice?.price) : NaN;
      const verifiedPrice = Number.isFinite(verified) ? verified : null;
      const mismatch = okStatus && verifiedPrice !== null && Math.abs(verifiedPrice - r.price.price) > 0.009;
      results.set(offerId, {
        offerId,
        ok: okStatus,
        sellerExternalReference: r.sellerExternalReference,
        verifiedPrice,
        message: okStatus ? (mismatch ? `Cdiscount przyjęło zmianę, ale cena w ofercie to jeszcze ${verifiedPrice} (przetwarzanie może potrwać — sprawdź za chwilę)` : msg || "Cena zmieniona") : `Odrzucone przez Cdiscount${it?.integrationStatus ? ` (${it.integrationStatus})` : ""}${msg ? `: ${msg}` : ""}`,
      });
    }
  } else {
    for (const r of requests) results.set(refToOffer.get(r.sellerExternalReference)!, { offerId: refToOffer.get(r.sellerExternalReference)!, ok: true, sellerExternalReference: r.sellerExternalReference, message: `Paczka ${packageId} wysłana (stan: ${state ?? "?"}) — Cdiscount jeszcze ją przetwarza; cena zmieni się po zakończeniu. Sprawdź w Listingach po chwili.` });
  }
  return { packageId, packageState: state, results: changes.map((c) => results.get(c.offerId)!) };
}
