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
import { isCountedOrder, statusBucket } from "./salesOrders";

export type StockSyncSummary = { ran: boolean; reason?: string; processed: number; applied: number; skipped: number; waiting: number; errors: string[] };

const key = (i: { marketplace: string; external_id: string; item_key: string }) => ({ marketplace: i.marketplace, external_id: i.external_id, item_key: i.item_key });

export async function runStockSync(db: SupabaseClient<any, any, any>): Promise<StockSyncSummary> {
  const sum: StockSyncSummary = { ran: false, processed: 0, applied: 0, skipped: 0, waiting: 0, errors: [] };
  const { data: st, error: se } = await db.from("listing_stock_settings").select("enabled").eq("id", 1).maybeSingle();
  if (se) return { ...sum, reason: /listing_stock_settings/.test(se.message) ? "Brak tabel — uruchom supabase/listing-stock-sync.sql." : se.message };
  if (!st?.enabled) return { ...sum, reason: "Synchronizacja stanów jest wyłączona." };
  // blokada
  const { data: lock } = await db.from("listing_stock_settings").update({ running_since: new Date().toISOString() }).eq("id", 1).or(`running_since.is.null,running_since.lt.${new Date(Date.now() - 10 * 60_000).toISOString()}`).select("id");
  if (!lock?.length) return { ...sum, reason: "Poprzedni przebieg jeszcze trwa." };
  sum.ran = true;
  try {
    const { data: pend, error: pe } = await db.rpc("listing_stock_pending", { p_limit: 500 });
    if (pe) throw new Error(`Odczyt pozycji: ${pe.message}`);
    const rows = (pend as (PendingItem & { order_status: string })[]) || [];
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
