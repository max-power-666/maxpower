// Synchronizacja stanów ofert Back Market <-> refurbed (16.10.2026): sprzedaż sztuki z SKU na jednym marketplace'ie zmniejsza ilość oferty z tym samym SKU na drugim. Marketplace, na którym sprzedano,
// sam zmniejsza swoją ilość — my ruszamy wyłącznie drugi. Zasady bezpieczeństwa:
//  - działa tylko po włączeniu przez Admina (listing_stock_settings.enabled); przy włączeniu historia zamówień jest oznaczana jako obsłużona (baseline), więc nic z przeszłości nie zmniejsza stanów;
//  - każda pozycja zamówienia (jedna sztuka) jest uwzględniana RAZ (listing_stock_synced; wpis "claimed" powstaje PRZED zmianą ilości, przy błędzie API jest cofany — lepiej zaniżyć niż zdublować);
//  - uwzględniamy tylko zamówienia liczone jako sprzedaż (nieanulowane, opłacone); anulowane/bez SKU/zestawy z dodatkiem są oznaczane jako pominięte; nieopłacone czekają na kolejny przebieg;
//  - nowa ilość = ILOŚĆ PRZECZYTANA NA ŻYWO z marketplace'u minus sprzedane (nie z migawki Listingów), nigdy poniżej 0; zmieniamy tylko, gdy oferta z tym SKU jest dokładnie jedna;
//  - blokada przed równoległymi przebiegami (running_since).
// Anulowanie zamówienia PO uwzględnieniu go NIE przywraca ilości na drugim marketplace'ie (zaniżenie, nie nadsprzedaż) — ilość poprawia ręczny przycisk "Zaktualizuj ilości".
import type { SupabaseClient } from "@supabase/supabase-js";
import { bmListingsConfigFromEnv } from "./listings";
import { bmGetQuantity, bmSetQuantity, groupSold, ownOffers, reducedQuantity, refurbedGetStock, refurbedSetStock, type PendingItem } from "./marketStock";
import type { RefurbedClient } from "./refurbed";
import { isCountedOrder, mapBmItems, mapBmToSales, mapRefurbedItems, mapRefurbedToSales, statusBucket } from "./salesOrders";
import { refurbedListOrders } from "./refurbed";

// Szybka ścieżka (16.10.2026, "zmiana stanu musi się odbywać szybciej"): Back Market nie ma webhooków, więc przy każdym przebiegu (cron co minutę) pytamy oba marketplace'y WPROST o świeże
// zamówienia (BM: zmienione w ostatnich 30 min, refurbed: złożone w ostatnich 30 min) i nie czekamy na 15-minutową synchronizację zamówień do bazy. Te same mappery co synchronizacja,
// więc klucze pozycji są identyczne i późniejszy zapis z synchronizacji niczego nie dubluje (pozycje są w dzienniku listing_stock_synced).
export type FastItem = PendingItem & { order_status: string; order_date: string | null; price?: number | null; currency?: string | null }; // price/currency: dla powiadomień o zamówieniach (orderWebhookServer)
const FAST_WINDOW_MS = 30 * 60_000;

export async function fetchBmRecent(): Promise<FastItem[]> {
  const cfg = bmListingsConfigFromEnv();
  if (!cfg) return [];
  const since = new Date(Date.now() - FAST_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const out: FastItem[] = [];
  for (let page = 1; page <= 3; page++) {
    const params = new URLSearchParams({ "page-size": "50", page: String(page), date_modification: since });
    const res = await (cfg.fetchImpl ?? fetch)(`${cfg.baseUrl}/ws/orders?${params.toString()}`, { headers: { Accept: "application/json", "Accept-Language": cfg.lang, Authorization: cfg.auth, "User-Agent": cfg.userAgent }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Back Market (świeże zamówienia): błąd ${res.status}`);
    const data = await res.json();
    for (const o of (data.results as any[]) || []) {
      const sales = mapBmToSales(o);
      for (const it of mapBmItems(o)) out.push({ marketplace: "backmarket", external_id: it.external_id, item_key: it.item_key, sku: it.sku, order_status: sales.status, order_date: sales.order_date ?? null, price: it.price ?? null, currency: it.currency ?? null });
    }
    if (!data.next) break;
  }
  return out;
}

export async function fetchRefurbedRecent(extraIds: string[]): Promise<FastItem[]> {
  const token = process.env.REFURBED_API_TOKEN;
  if (!token) return [];
  const c: RefurbedClient = { token, userAgent: process.env.REFURBED_UA || "recoo-erp", baseUrl: process.env.REFURBED_BASE_URL || undefined };
  const orders: any[] = [];
  let after: string | null = null;
  for (let page = 0; page < 2; page++) {
    const r = await refurbedListOrders(c, { filter: { released_at: { ge: new Date(Date.now() - FAST_WINDOW_MS).toISOString() } }, startAfter: after });
    orders.push(...r.orders);
    if (!r.hasMore || r.orders.length === 0) break;
    after = String(r.orders[r.orders.length - 1].id);
  }
  for (const id of extraIds) {
    if (orders.some((o) => String(o.id) === id)) continue;
    const res = await fetch(`${c.baseUrl ?? "https://api.refurbed.com"}/refb.merchant.v1.OrderService/GetOrder`, { method: "POST", headers: { Authorization: `Plain ${c.token.trim().replace(/^Plain\s+/i, "")}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": c.userAgent }, body: JSON.stringify({ id }), cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`refurbed (GetOrder ${id}): błąd ${res.status}`);
    const data = await res.json();
    if (data?.order) orders.push(data.order);
  }
  const out: FastItem[] = [];
  for (const o of orders) {
    const sales = mapRefurbedToSales(o);
    for (const it of mapRefurbedItems(o)) out.push({ marketplace: "refurbed", external_id: it.external_id, item_key: it.item_key, sku: it.sku, order_status: sales.status, order_date: sales.order_date ?? null, price: it.price ?? null, currency: it.currency ?? null });
  }
  return out;
}

export type StockSyncSummary = { ran: boolean; reason?: string; processed: number; applied: number; skipped: number; waiting: number; errors: string[] };

const key = (i: { marketplace: string; external_id: string; item_key: string }) => ({ marketplace: i.marketplace, external_id: i.external_id, item_key: i.item_key });

export async function runStockSync(db: SupabaseClient<any, any, any>, opts: { refurbedOrderIds?: string[] } = {}): Promise<StockSyncSummary> {
  const sum: StockSyncSummary = { ran: false, processed: 0, applied: 0, skipped: 0, waiting: 0, errors: [] };
  const { data: st, error: se } = await db.from("listing_stock_settings").select("enabled, activated_at").eq("id", 1).maybeSingle();
  if (se) return { ...sum, reason: /listing_stock_settings/.test(se.message) ? "Brak tabel — uruchom supabase/listing-stock-sync.sql." : se.message };
  if (!st?.enabled) return { ...sum, reason: "Synchronizacja stanów jest wyłączona." };
  // blokada
  const { data: lock } = await db.from("listing_stock_settings").update({ running_since: new Date().toISOString() }).eq("id", 1).or(`running_since.is.null,running_since.lt.${new Date(Date.now() - 10 * 60_000).toISOString()}`).select("id");
  if (!lock?.length) return { ...sum, reason: "Poprzedni przebieg jeszcze trwa." };
  sum.ran = true;
  try {
    const { data: pend, error: pe } = await db.rpc("listing_stock_pending", { p_limit: 500 });
    if (pe) throw new Error(`Odczyt pozycji: ${pe.message}`);
    const byKey = new Map<string, PendingItem & { order_status: string }>();
    for (const r of ((pend as (PendingItem & { order_status: string })[]) || [])) byKey.set(`${r.marketplace}|${r.external_id}|${r.item_key}`, r);
    // szybka ścieżka: świeże zamówienia wprost z marketplace'ów (tylko złożone po włączeniu synchronizacji i jeszcze nieobsłużone)
    try {
      const activatedMs = st.activated_at ? Date.parse(st.activated_at as string) : Date.now();
      const fast = [...(await fetchBmRecent().catch((e) => { sum.errors.push(String(e.message || e)); return [] as FastItem[]; })), ...(await fetchRefurbedRecent(opts.refurbedOrderIds ?? []).catch((e) => { sum.errors.push(String(e.message || e)); return [] as FastItem[]; }))]
        .filter((f) => f.order_date && Date.parse(f.order_date) >= activatedMs - 60_000 && !byKey.has(`${f.marketplace}|${f.external_id}|${f.item_key}`));
      const done = new Set<string>();
      for (const mp of ["backmarket", "refurbed"]) {
        const ids = Array.from(new Set(fast.filter((f) => f.marketplace === mp).map((f) => f.external_id)));
        for (let i = 0; i < ids.length; i += 100) {
          const { data: led } = await db.from("listing_stock_synced").select("marketplace, external_id, item_key").eq("marketplace", mp).in("external_id", ids.slice(i, i + 100));
          for (const l of (led as any[]) || []) done.add(`${l.marketplace}|${l.external_id}|${l.item_key}`);
        }
      }
      for (const f of fast) {
        const k = `${f.marketplace}|${f.external_id}|${f.item_key}`;
        if (!done.has(k)) byKey.set(k, f);
      }
    } catch (e: any) {
      sum.errors.push(`Szybka ścieżka: ${String(e?.message || e)}`);
    }
    const rows = [...byKey.values()];
    const sold: PendingItem[] = [];
    const skipRows: { marketplace: string; external_id: string; item_key: string; action: string; note: string }[] = [];
    for (const r of rows) {
      if (statusBucket(r.marketplace, r.order_status) === "anulowane") skipRows.push({ ...key(r), action: "skipped", note: "zamówienie anulowane" });
      else if (!isCountedOrder(r.marketplace, r.order_status)) sum.waiting += 1; // jeszcze nieopłacone — zostaje na kolejny przebieg
      else sold.push(r);
    }
    const { groups, noSku } = groupSold(sold);
    for (const n of noSku) skipRows.push({ ...key(n), action: "skipped", note: "brak SKU albo zestaw z dodatkiem" });

    const bm = bmListingsConfigFromEnv();
    const rf: RefurbedClient | null = process.env.REFURBED_API_TOKEN ? { token: process.env.REFURBED_API_TOKEN, userAgent: process.env.REFURBED_UA || "recoo-erp", baseUrl: process.env.REFURBED_BASE_URL || undefined } : null;

    for (const g of groups) {
      const claim = g.items.map((i) => ({ ...key(i), action: "claimed", note: `${g.soldOn} -> ${g.target} ${g.skuKey}` }));
      const finish = async (action: string, note: string) => {
        await db.from("listing_stock_synced").upsert(g.items.map((i) => ({ ...key(i), action, note })), { onConflict: "marketplace,external_id,item_key" });
      };
      const { data: offs } = await db.from("marketplace_listings").select("external_id, sku, quantity").eq("marketplace", g.target).ilike("sku", `${g.skuKey.replace(/[%_\\]/g, "\\$&")}%`).limit(200);
      const own = ownOffers((offs as any[]) || [], g.skuKey);
      if (own.length !== 1) {
        await finish("skipped", own.length === 0 ? `brak oferty z tym SKU na ${g.target}` : `${own.length} ofert z tym SKU na ${g.target} — nie wiadomo, której zmniejszyć`);
        sum.skipped += g.count;
        continue;
      }
      const offer = own[0];
      const { error: ce } = await db.from("listing_stock_synced").upsert(claim, { onConflict: "marketplace,external_id,item_key", ignoreDuplicates: true });
      if (ce) {
        sum.errors.push(`${g.skuKey}: nie zapisano znacznika (${ce.message})`);
        continue;
      }
      try {
        let current: number | null;
        if (g.target === "backmarket") {
          if (!bm) throw new Error("Back Market nie jest skonfigurowany.");
          current = await bmGetQuantity(bm, offer.external_id);
        } else {
          if (!rf) throw new Error("refurbed nie jest skonfigurowany.");
          current = await refurbedGetStock(rf, offer.external_id);
        }
        if (current === null) throw new Error("marketplace nie zwrócił aktualnej ilości");
        const next = reducedQuantity(current, g.count);
        if (next !== current) {
          if (g.target === "backmarket") await bmSetQuantity(bm!, offer.external_id, next);
          else await refurbedSetStock(rf!, offer.external_id, next);
          await db.from("marketplace_listings").update({ quantity: next }).eq("marketplace", g.target).eq("external_id", offer.external_id);
        }
        await db.from("listing_stock_log").insert({ source: "auto", marketplace: g.target, external_id: offer.external_id, sku: offer.sku, old_quantity: current, new_quantity: next, reason: `sprzedano ${g.count} szt. na ${g.soldOn === "backmarket" ? "Back Market" : "refurbed"}`, ok: true });
        await finish("applied", `${current} -> ${next}`);
        sum.applied += g.count;
      } catch (e: any) {
        // cofamy znacznik, żeby kolejny przebieg spróbował ponownie
        for (const i of g.items) await db.from("listing_stock_synced").delete().match({ ...key(i), action: "claimed" });
        const msg = String(e?.message || e).slice(0, 400);
        sum.errors.push(`${g.skuKey} (${g.target}): ${msg}`);
        await db.from("listing_stock_log").insert({ source: "auto", marketplace: g.target, external_id: offer.external_id, sku: offer.sku, old_quantity: null, new_quantity: null, reason: `sprzedano ${g.count} szt. na ${g.soldOn}`, ok: false, error: msg });
      }
    }
    if (skipRows.length) {
      await db.from("listing_stock_synced").upsert(skipRows, { onConflict: "marketplace,external_id,item_key", ignoreDuplicates: true });
      sum.skipped += skipRows.length;
    }
    sum.processed = rows.length - sum.waiting;
    return sum;
  } catch (e: any) {
    sum.errors.push(String(e?.message || e));
    return sum;
  } finally {
    await db.from("listing_stock_settings").update({ running_since: null, last_run_at: new Date().toISOString(), last_result: sum.errors.length ? `błędy: ${sum.errors.length}` : `uwzględniono ${sum.applied} szt., pominięto ${sum.skipped}` }).eq("id", 1);
  }
}
