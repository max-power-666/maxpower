import type { SupabaseClient } from "@supabase/supabase-js";
import { escapeLike } from "./search";

// Wyszukiwarka globalna (20.10.2026, na prośbę właściciela — "wyszukiwarka kontekstowa"): po wpisaniu numeru zamówienia albo numeru seryjnego pokazuje, GDZIE w systemie ta fraza występuje:
// zamówienia sprzedaży (numer zamówienia albo numer seryjny/pad pozycji), karta produktu, Towar, Serwis, Części, Testy, Trade-in, Do wystawienia, Magazyn, przesyłki, faktury, zapotrzebowania.
// Każde zapytanie idzie zwykłą sesją użytkownika, więc RLS ogranicza wyniki do tego, co dana osoba i tak widzi; dopasowanie jest dokładne (bez rozróżniania wielkości liter).

export type SearchHit =
  | { kind: "order"; key: string; marketplace: string; externalId: string; label: string; note: string }
  | { kind: "product"; key: string; serial: string; label: string; note: string }
  | { kind: "nav"; key: string; view: string; sub?: { storage: string; value: string }; prefillKey?: string; q: string; label: string; count: number; note?: string };

type Db = SupabaseClient<any, any, any>;
const MIN_LEN = 3;

const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
// Numery seryjne bywają zapisane z zerami wiodącymi albo bez — próbujemy kilku postaci
export function serialVariants(q: string): string[] {
  const base = q.replace(/^0+/, "");
  return Array.from(new Set([q, base, `0${base}`, `00${base}`].filter((x) => x.length >= MIN_LEN)));
}
const orFilter = (col: string, vals: string[]) => vals.map((v) => `${col}.ilike.${quote(escapeLike(v))}`).join(",");

async function safe<T>(p: PromiseLike<{ data: T | null; error: any; count?: number | null }>): Promise<{ data: T | null; count: number }> {
  try {
    const r = await p;
    return r.error ? { data: null, count: 0 } : { data: r.data, count: r.count ?? (Array.isArray(r.data) ? r.data.length : 0) };
  } catch {
    return { data: null, count: 0 };
  }
}

export async function searchEverywhere(db: Db, raw: string, marketplaceLabel: (k: string) => string): Promise<SearchHit[]> {
  const q = raw.trim();
  if (q.length < MIN_LEN) return [];
  const sv = serialVariants(q);
  const eq = escapeLike(q);
  const hits: SearchHit[] = [];

  const [orders, itemsSerial, itemsPad, boOrder, intakeOrder, shipments, invoices, reqs, goods, repairs, parts, tests, intakeSerial, queue, stock, product] = await Promise.all([
    safe(db.from("sales_orders").select("marketplace, external_id, status, order_date, sku").ilike("external_id", eq).limit(6)),
    safe(db.from("sales_order_items").select("marketplace, external_id, sku, serial_number").or(orFilter("serial_number", sv)).limit(6)),
    safe(db.from("sales_order_items").select("marketplace, external_id, sku, pad_serials").or(`pad_serials.cs.{${quote(q)}},pad_serials.cs.{${quote(q.toUpperCase())}}`).limit(6)),
    safe(db.from("buyback_orders").select("order_public_id", { count: "exact" }).ilike("order_public_id", eq).limit(1)),
    safe(db.from("buyback_order_intake").select("id", { count: "exact" }).ilike("order_public_id", eq).limit(1)),
    safe(db.from("shipments").select("id", { count: "exact" }).or(`tracking_number.ilike.${quote(eq)},order_external_id.ilike.${quote(eq)}`).limit(1)),
    safe(db.from("invoices").select("id", { count: "exact" }).or(`external_id.ilike.${quote(eq)},number.ilike.${quote(eq)}`).limit(1)),
    q.length >= 5 ? safe(db.from("service_requests").select("id", { count: "exact" }).ilike("message", `%${eq}%`).is("deleted_at", null).limit(1)) : Promise.resolve({ data: null, count: 0 }),
    safe(db.from("goods_register").select("id", { count: "exact" }).or(orFilter("serial", sv)).limit(1)),
    safe(db.from("service_log").select("id", { count: "exact" }).or(orFilter("device_ref", sv)).limit(1)),
    safe(db.from("service_parts").select("id", { count: "exact" }).or(orFilter("device_ref", sv)).limit(1)),
    safe(db.from("test_log").select("id", { count: "exact" }).or(orFilter("serial_number", sv)).limit(1)),
    safe(db.from("buyback_order_intake").select("id", { count: "exact" }).or(orFilter("serial_number", sv)).limit(1)),
    safe(db.from("listing_queue").select("id", { count: "exact" }).or(orFilter("serial_number", sv)).limit(1)),
    safe(db.from("fakturownia_stock_cache").select("id", { count: "exact" }).or(orFilter("name", sv)).limit(1)),
    Promise.resolve(null),
  ]);
  void product;

  // zamówienia sprzedaży: po numerze zamówienia, po numerze seryjnym pozycji i po numerze seryjnym pada
  const seen = new Map<string, Extract<SearchHit, { kind: "order" }>>();
  const addOrder = (marketplace: string, externalId: string, note: string) => {
    const k = `${marketplace}#${externalId}`;
    const ex = seen.get(k);
    if (ex) {
      if (!ex.note.includes(note)) ex.note += `; ${note}`;
      return;
    }
    seen.set(k, { kind: "order", key: `order-${k}`, marketplace, externalId, label: `Zamówienie ${marketplaceLabel(marketplace)} ${externalId}`, note });
  };
  for (const r of (orders.data as any[]) || []) addOrder(r.marketplace, r.external_id, "numer zamówienia");
  for (const r of (itemsSerial.data as any[]) || []) addOrder(r.marketplace, r.external_id, `numer seryjny pozycji${r.sku ? ` (${r.sku})` : ""}`);
  for (const r of (itemsPad.data as any[]) || []) addOrder(r.marketplace, r.external_id, "numer seryjny pada");
  hits.push(...seen.values());

  const serialHits = goods.count + repairs.count + parts.count + tests.count + intakeSerial.count + queue.count + stock.count + (itemsSerial.data?.length ?? 0) + (itemsPad.data?.length ?? 0);
  if (serialHits > 0) hits.push({ kind: "product", key: "product", serial: q, label: "Karta produktu", note: "historia numeru seryjnego: magazyn, towar, testy, serwis, Trade-in" });

  const nav = (key: string, view: string, label: string, count: number, extra: Partial<Extract<SearchHit, { kind: "nav" }>> = {}) => {
    if (count > 0) hits.push({ kind: "nav", key, view, q, label, count, ...extra });
  };
  nav("goods", "goods", "Towar (zakup)", goods.count, { prefillKey: "goods" });
  nav("repairs", "service", "Serwis — naprawy", repairs.count, { prefillKey: "service-repairs", sub: { storage: "service-sub", value: "repairs" } });
  nav("parts", "service", "Serwis — części przypisane do urządzenia", parts.count, { prefillKey: "service-parts", sub: { storage: "service-sub", value: "parts" } });
  nav("tests", "tests", "Testy", tests.count, { prefillKey: "tests" });
  nav("intake-serial", "orders", "Trade-in — obsługa paczek (numer seryjny)", intakeSerial.count, { prefillKey: "tradein-intake", sub: { storage: "tradein-sub", value: "intake" } });
  nav("queue", "toList", "Do wystawienia", queue.count, { prefillKey: "tolist" });
  nav("stock", "inventory", "Magazyn (Fakturownia) — Raw data", stock.count, { prefillKey: "inventory-raw", sub: { storage: "inv-sub", value: "raw" } });
  nav("bb-order", "orders", "Trade-in — zamówienie Buyback", boOrder.count, { prefillKey: "tradein-order", sub: { storage: "tradein-sub", value: "raw" }, note: "otwiera kartę zamówienia" });
  nav("intake-order", "orders", "Trade-in — obsługa paczki tego zamówienia", intakeOrder.count, { prefillKey: "tradein-intake", sub: { storage: "tradein-sub", value: "intake" } });
  nav("shipments", "shipping", "Wysyłka — nadane przesyłki", shipments.count);
  nav("invoices", "invoices", "Faktury", invoices.count);
  nav("requests", "service", "Zapotrzebowania (treść zawiera frazę)", reqs.count, { sub: { storage: "service-sub", value: "requests" }, prefillKey: "service-requests" });
  return hits;
}
