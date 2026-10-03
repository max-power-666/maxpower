// Wspólne, serwerowe ładowanie i liczenie marży (używają go route'y margin/list i margin/summary — jedna definicja, te same liczby w zakładce Marża i na Przeglądzie).
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCountedOrder } from "@/lib/salesOrders";
import { computeMargin, deriveBmRates, MARGIN_MARKETPLACES, type BmLine, type BmRates, type MarginDbRow, type MarginResult } from "@/lib/margin";
import type { NbpRate } from "@/lib/nbp";

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function loadMarginResults(db: SupabaseClient<any, any, any>): Promise<{ results: MarginResult[]; bmRates: BmRates | null; invoiceCount: number; purchasesCount: number }> {
  const [rowsRaw, rateRows, lines] = await Promise.all([
    fetchAll<MarginDbRow>((from, to) => db.from("margin_items").select("*").in("marketplace", [...MARGIN_MARKETPLACES]).order("order_id").order("position").range(from, to)),
    fetchAll<{ currency: string; rate_date: string; mid: number | string }>((from, to) => db.from("nbp_rates").select("currency, rate_date, mid").in("currency", ["EUR", "DKK"]).range(from, to)),
    fetchAll<BmLine & { invoice_ref: string }>((from, to) => db.from("bm_invoice_lines").select("invoice_ref, invoice_key, order_id, amount, sku, designation").order("id").range(from, to)).catch(() => [] as (BmLine & { invoice_ref: string })[]),
  ]);
  // ile produktów z Fakturowni (historia zakupów) mamy w bazie — gdy 0, zakładka podpowiada pełną synchronizację
  const { count: purchasesCount } = await db.from("fakturownia_purchases").select("id", { count: "exact", head: true });
  const toRates = (cur: string): NbpRate[] => rateRows.filter((r) => r.currency === cur).map((r) => ({ currency: r.currency, rateDate: r.rate_date, mid: Number(r.mid) }));
  const bmRates = deriveBmRates(lines);
  const ctx = { eurRates: toRates("EUR"), dkkRates: toRates("DKK"), bmRates };
  // tylko zamówienia, które liczą się jako sprzedaż (bez anulowanych/zwróconych/nieopłaconych — ten sam isCountedOrder co Przegląd)
  const results = rowsRaw.filter((r) => isCountedOrder(r.marketplace, r.status)).map((r) => computeMargin(r, ctx));
  return { results, bmRates, invoiceCount: new Set(lines.map((l) => l.invoice_ref)).size, purchasesCount: purchasesCount ?? 0 };
}

export type MarginAgg = { count: number; withMargin: number; sale: number; margin: number; incomplete: number };
export const emptyAgg = (): MarginAgg => ({ count: 0, withMargin: 0, sale: 0, margin: 0, incomplete: 0 });

// Agregat marży: liczone tylko pozycje z policzoną marżą (sprzedaż i marża sumowane po TYCH SAMYCH pozycjach, żeby procent był spójny); incomplete = z ostrzeżeniami.
export function aggregateMargin(results: MarginResult[]): MarginAgg {
  const a = emptyAgg();
  for (const r of results) {
    a.count += 1;
    if (r.marginPln === null || r.salePln === null) continue;
    a.withMargin += 1;
    a.sale += r.salePln;
    a.margin += r.marginPln;
    if (r.flags.length > 0) a.incomplete += 1;
  }
  return a;
}
