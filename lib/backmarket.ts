// Klient Back Market do zgłaszania numeru przesyłki po nadaniu w module Wysyłka.
// Dokumentacja: https://api.backmarket.dev, sekcja Orders → "Update a specific order" (POST /ws/orders/{order_id}).
// Bez SKU w body wszystkie pozycje zamówienia przechodzą do podanego stanu naraz (BM traktuje całe zamówienie
// jako jedną paczkę) — dokładnie to nam odpowiada, bo nadajemy zawsze jedną przesyłkę na całe zamówienie.
// new_state = 9 ("wysłane", patrz BM_ORDER_STATES w lib/salesOrders.ts).

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
export const BM_SHIPPER_BY_CARRIER = { dhl_express: "DHL Express", dhl_parcel: "DHL" } as const;

// POST /ws/orders/{order_id}: zgłasza numer przesyłki i przestawia zamówienie na "wysłane" (9).
export async function bmMarkOrderShipped(
  cfg: BmShipConfig,
  opts: { orderId: string; trackingNumber: string; trackingUrl?: string | null; shipper: string; dateShipping?: string }
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
      new_state: 9,
      tracking_number: opts.trackingNumber.slice(0, 200),
      ...(opts.trackingUrl ? { tracking_url: opts.trackingUrl.slice(0, 300) } : {}),
      shipper: opts.shipper.slice(0, 200),
      date_shipping: opts.dateShipping ?? new Date().toISOString(),
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BmShipError(`Back Market zwrócił błąd (${res.status}) przy zgłaszaniu przesyłki: ${text.slice(0, 300)}`, res.status);
  }
}
