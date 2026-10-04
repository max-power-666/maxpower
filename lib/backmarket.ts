// Klient Back Market: akceptacja zamówienia i zgłaszanie numeru przesyłki po nadaniu w module Wysyłka.
// Dokumentacja: https://api.backmarket.dev, sekcja Orders → "Update a specific order" (POST /ws/orders/{order_id}).
// UWAGA: wymóg SKU w body ZALEŻY od new_state — patrz opis przy każdej wartości niżej, nie jest jednolity.
//
// new_state — dopuszczalne wartości potwierdzone na produkcji to 2, 3, 4, 5, 6 (błąd API przy innej wartości:
// "new_state X must be in 2,3,4,5,6"), mimo że schema OrderState (do odczytu) wymienia też 0, 1, 8, 9, 10:
//   2 = zaakceptowane przez sprzedawcę (merchant-facing akcja "przyjmuję zamówienie do realizacji" — patrz
//       bmAcceptOrder). To NAPRAWDĘ jest stan POZYCJI (Table 6 dokumentacji BM), nie zamówienia, i W ODRÓŻNIENIU
//       OD stanu 3 wymaga podania "sku" — bez niego API zwraca błąd 400 "sku not found" (potwierdzone na
//       produkcji, zgłoszenie właściciela 29.09.2026). Zamówienie z kilkoma różnymi SKU wymaga osobnego wywołania
//       na KAŻDY z nich (patrz app/api/orders/validate/route.ts) — inaczej niż przy stanie 3, który obejmuje
//       wszystkie pozycje naraz jednym zapytaniem bez SKU.
//   3 = "Do wysyłki" (merchant-facing akcja "wysyłam to" — patrz bmMarkOrderShipped); bez SKU w body wszystkie
//       pozycje zamówienia przechodzą do tego stanu naraz (BM traktuje całe zamówienie jako jedną paczkę) —
//       dokładnie to nam odpowiada, bo nadajemy zawsze jedną przesyłkę na całe zamówienie.
//   9 = "wysłane" NIE DA SIĘ ustawić tym zapytaniem — to stan, który Back Market nadaje sam, gdy zweryfikuje
//       przesyłkę u przewoźnika, nie coś, co merchant wpisuje ręcznie.

export type BmShipConfig = { baseUrl: string; auth: string; lang: string; userAgent: string; fetchImpl?: typeof fetch; timeoutMs?: number };

export function bmShipConfigFromEnv(): BmShipConfig | null {
  if (!process.env.BACKMARKET_AUTH) return null;
  return {
    baseUrl: process.env.BACKMARKET_BASE_URL || "https://www.backmarket.fr",
    auth: process.env.BACKMARKET_AUTH,
    lang: process.env.BACKMARKET_LANG || "fr-fr",
    userAgent: process.env.BACKMARKET_UA || "backmarket@recoo.io",
  };
}

export class BmShipError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

// Back Market wymaga jednej z ustalonych nazw przewoźnika (schemat "Shipper" w dokumentacji). Nie ma tam wpisu
// specyficznego dla DHL Parcel Polska (DHL24) — najbliższa dostępna wartość to ogólne "DHL". Jeśli w back office
// Back Marketu wygląda to źle, popraw tę mapę (np. na "Other").
// UPS (04.10.2026): nazwa "UPS" — nie potwierdzona na żywym API Back Market; gdyby odrzucili, błąd widać przy przesyłce z przyciskiem "Ponów".
export const BM_SHIPPER_BY_CARRIER = { dhl_express: "DHL Express", dhl_parcel: "DHL", ups: "UPS" } as const;

// POST /ws/orders/{order_id}: zgłasza numer przesyłki i przestawia zamówienie na "Do wysyłki" (3, patrz uwaga
// wyżej — 9 nie jest dopuszczalne w tym zapytaniu). imei/serial_number
// dołączamy tu tylko dla zamówień z JEDNĄ pozycją (bez sku ten sam numer trafiłby myląco do wszystkich pozycji) —
// przy kilku pozycjach służy do tego osobne wywołanie bmSetOrderlineIdentifier per pozycja.
export async function bmMarkOrderShipped(
  cfg: BmShipConfig,
  opts: { orderId: string; trackingNumber: string; trackingUrl?: string | null; shipper: string; dateShipping?: string; imei?: string | null; serialNumber?: string | null }
): Promise<void> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const orderIdNum = Number(opts.orderId);
  const res = await doFetch(`${cfg.baseUrl}/ws/orders/${opts.orderId}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Language": cfg.lang,
      Authorization: cfg.auth,
      "User-Agent": cfg.userAgent,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      order_id: Number.isFinite(orderIdNum) ? orderIdNum : opts.orderId,
      new_state: 3,
      tracking_number: opts.trackingNumber.slice(0, 200),
      ...(opts.trackingUrl ? { tracking_url: opts.trackingUrl.slice(0, 300) } : {}),
      shipper: opts.shipper.slice(0, 200),
      date_shipping: opts.dateShipping ?? new Date().toISOString(),
      ...(opts.imei ? { imei: opts.imei.slice(0, 15) } : {}),
      ...(opts.serialNumber ? { serial_number: opts.serialNumber.slice(0, 50) } : {}),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BmShipError(`Back Market zwrócił błąd (${res.status}) przy zgłaszaniu przesyłki: ${text.slice(0, 300)}`, res.status);
  }
}

// POST /ws/orders/{order_id}: akceptuje JEDNĄ pozycję zamówienia (new_state: 2) — wołane z przycisku "Zaakceptuj
// zamówienie" na karcie zamówienia (SalesOrderCard.tsx), patrz app/api/orders/validate/route.ts. WYMAGA "sku" w
// body — bez niego Back Market zwraca błąd 400 "sku not found" (potwierdzone na produkcji 29.09.2026), w
// odróżnieniu od stanu 3 (wysyłka), gdzie SKU jest zbędne, bo dotyczy całego zamówienia naraz. Zamówienie z kilkoma
// różnymi SKU wymaga osobnego wywołania tej funkcji na każdy z nich — route woła ją w pętli po unikalnych SKU
// z orderlines.
export async function bmAcceptOrder(cfg: BmShipConfig, opts: { orderId: string; sku: string }): Promise<void> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const orderIdNum = Number(opts.orderId);
  const res = await doFetch(`${cfg.baseUrl}/ws/orders/${opts.orderId}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Language": cfg.lang,
      Authorization: cfg.auth,
      "User-Agent": cfg.userAgent,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ order_id: Number.isFinite(orderIdNum) ? orderIdNum : opts.orderId, new_state: 2, sku: opts.sku }),
    cache: "no-store",
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BmShipError(`Back Market zwrócił błąd (${res.status}) przy akceptowaniu zamówienia (SKU ${opts.sku}): ${text.slice(0, 300)}`, res.status);
  }
}

// PATCH /ws/orderlines/{orderline_id}: zgłasza IMEI/numer seryjny pojedynczej pozycji zamówienia — do zamówień
// z kilkoma pozycjami, gdzie bmMarkOrderShipped (bez sku) nie może wskazać, do której pozycji numer należy.
// Wymaganie Back Marketu (od 1.01.2022, kategoria Smartfony): IMEI dla telefonów, inaczej możliwe kary — patrz
// CLAUDE.md. Ograniczenie API: działa tylko dla pozycji z ilością = 1 (ustala to notifyMarketplace przed wywołaniem).
export async function bmSetOrderlineIdentifier(
  cfg: BmShipConfig,
  opts: { orderlineId: string; imei?: string | null; serialNumber?: string | null }
): Promise<void> {
  const body: Record<string, string> = {};
  if (opts.imei) body.imei = opts.imei.slice(0, 15);
  if (opts.serialNumber) body.serial_number = opts.serialNumber.slice(0, 50);
  if (Object.keys(body).length === 0) return; // nic do wysłania

  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`${cfg.baseUrl}/ws/orderlines/${opts.orderlineId}`, {
    method: "PATCH",
    headers: { Accept: "application/json", Authorization: cfg.auth, "User-Agent": cfg.userAgent, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BmShipError(`Back Market zwrócił błąd (${res.status}) przy zgłaszaniu numeru seryjnego/IMEI pozycji ${opts.orderlineId}: ${text.slice(0, 300)}`, res.status);
  }
}
