// Ilości ofert na marketplace'ach (16.10.2026, Magazyn -> Do wystawienia): odczyt na żywo i ustawianie ilości oraz czysta logika synchronizacji BM <-> refurbed. Tylko serwer (klucze API).
//  - Back Market: GET /ws/listings/{id} (pole quantity) i POST /ws/listings/{id} z samym quantity ("To put a Listing offline, just set its quantity to 0"); ilość jest wspólna dla wszystkich rynków oferty.
//  - refurbed: OfferService/GetOffer (offer.stock) i OfferService/UpdateOffer z polem stock (swagger refurbed: UpdateOfferRequest.stock).
// NIE testowane na żywych API — kształty sprawdzone na atrapie fetch wg specyfikacji; pierwsze użycie zrób na jednej ofercie.
import type { BmListingsConfig } from "./listings";
import { type RefurbedClient } from "./refurbed";
import { bmHeaders, rfHeaders, rfUrl, withRetry } from "./marketPricing";

export type StockMarketplace = "backmarket" | "refurbed";
const int = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

export async function bmGetQuantity(cfg: BmListingsConfig, listingId: string): Promise<number | null> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await withRetry(doFetch, `${cfg.baseUrl}/ws/listings/${encodeURIComponent(listingId)}`, { headers: bmHeaders(cfg) }, "Back Market (odczyt oferty)", cfg.timeoutMs);
  const data = await res.json().catch(() => null);
  return int(data?.quantity);
}
export async function bmSetQuantity(cfg: BmListingsConfig, listingId: string, quantity: number): Promise<number | null> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await withRetry(doFetch, `${cfg.baseUrl}/ws/listings/${encodeURIComponent(listingId)}`, { method: "POST", headers: bmHeaders(cfg, true), body: JSON.stringify({ quantity }) }, "Back Market (zmiana ilości)", cfg.timeoutMs);
  const data = await res.json().catch(() => null);
  return int(data?.quantity);
}
export async function refurbedGetStock(c: RefurbedClient, offerId: string): Promise<number | null> {
  const doFetch = c.fetchImpl ?? fetch;
  const res = await withRetry(doFetch, rfUrl(c, "GetOffer"), { method: "POST", headers: rfHeaders(c), body: JSON.stringify({ identifier: { id: offerId } }) }, "refurbed (odczyt oferty)", c.timeoutMs);
  const data = await res.json().catch(() => null);
  return int(data?.offer?.stock);
}
export async function refurbedSetStock(c: RefurbedClient, offerId: string, quantity: number): Promise<number | null> {
  const doFetch = c.fetchImpl ?? fetch;
  const res = await withRetry(doFetch, rfUrl(c, "UpdateOffer"), { method: "POST", headers: rfHeaders(c), body: JSON.stringify({ identifier: { id: offerId }, stock: quantity }) }, "refurbed (zmiana ilości)", c.timeoutMs);
  const data = await res.json().catch(() => null);
  return int(data?.offer?.stock);
}

// ---- czysta logika ----
// Klucz SKU do porównań: wielkie litery, bez końcówki -nM (liczba kontrolerów); oferta z dodatkiem ("PS4-500-BK-B+GTA5") to inny produkt i nie pasuje.
export const stockSkuKey = (sku: string | null | undefined): string => (sku || "").trim().toUpperCase().replace(/-\d+M$/, "");
export const otherMarketplace = (m: StockMarketplace): StockMarketplace => (m === "backmarket" ? "refurbed" : "backmarket");

export type PendingItem = { marketplace: string; external_id: string; item_key: string; sku: string | null };
export type SoldGroup = { soldOn: StockMarketplace; target: StockMarketplace; skuKey: string; count: number; items: PendingItem[] };

// Sprzedane pozycje -> grupy "ile sztuk SKU sprzedano na marketplace'ie X" (do odjęcia na drugim). Pozycje bez SKU nie wchodzą (zwracamy je osobno).
export function groupSold(items: PendingItem[]): { groups: SoldGroup[]; noSku: PendingItem[] } {
  const map = new Map<string, SoldGroup>();
  const noSku: PendingItem[] = [];
  for (const it of items) {
    if (it.marketplace !== "backmarket" && it.marketplace !== "refurbed") continue;
    const key = stockSkuKey(it.sku);
    if (!key || key.includes("+")) {
      noSku.push(it);
      continue;
    }
    const k = `${it.marketplace}|${key}`;
    const g = map.get(k) ?? { soldOn: it.marketplace as StockMarketplace, target: otherMarketplace(it.marketplace as StockMarketplace), skuKey: key, count: 0, items: [] };
    g.count += 1;
    g.items.push(it);
    map.set(k, g);
  }
  return { groups: [...map.values()], noSku };
}

export type OfferLite = { external_id: string; sku: string | null; quantity: number | null };
// Oferty "własne" dla SKU (bez dodatków). Jednoznaczne tylko przy dokładnie jednej — inaczej nie wiadomo, której ilość zmniejszyć.
export function ownOffers(offers: OfferLite[], skuKey: string): OfferLite[] {
  return offers.filter((o) => stockSkuKey(o.sku) === skuKey);
}
export const reducedQuantity = (current: number, sold: number) => Math.max(0, current - sold);
