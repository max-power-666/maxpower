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

async function getToken(cfg: OctopiaConfig): Promise<string> {
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
