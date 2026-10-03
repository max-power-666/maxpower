import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { isCountedOrder } from "@/lib/salesOrders";
import { computeMargin, deriveBmRates, MARGIN_MARKETPLACES, type BmLine, type MarginDbRow, type MarginResult } from "@/lib/margin";
import type { NbpRate } from "@/lib/nbp";

// Zakładka Marża (03.10.2026) — lista sprzedanych sztuk z numerem seryjnym z marżą. Tylko Admin i Manager (ceny zakupu, prowizje).
// Całość liczona po stronie serwera: widok margin_items (supabase/margin.sql, dostępny tylko dla service_role) + kursy NBP + średnie stawki BM z
// wgranych faktur (lib/margin.ts). Liczymy wszystkie wiersze naraz (setki, nie dziesiątki tysięcy), a stronicowanie/sumy robimy na wyniku.

export const maxDuration = 60;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

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

export async function GET(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ["Admin", "Manager"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = [25, 50, 100].includes(Number(url.searchParams.get("pageSize"))) ? Number(url.searchParams.get("pageSize")) : 50;
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const marketplace = url.searchParams.get("marketplace") || "";

  try {
    const [rowsRaw, rateRows, lines] = await Promise.all([
      fetchAll<MarginDbRow>((from, to) => db.from("margin_items").select("*").in("marketplace", [...MARGIN_MARKETPLACES]).order("order_id").order("position").range(from, to)),
      fetchAll<{ currency: string; rate_date: string; mid: number | string }>((from, to) => db.from("nbp_rates").select("currency, rate_date, mid").in("currency", ["EUR", "DKK"]).range(from, to)),
      fetchAll<BmLine & { invoice_ref: string }>((from, to) => db.from("bm_invoice_lines").select("invoice_ref, invoice_key, order_id, amount").order("id").range(from, to)).catch(() => [] as (BmLine & { invoice_ref: string })[]),
    ]);
    const toRates = (cur: string): NbpRate[] => rateRows.filter((r) => r.currency === cur).map((r) => ({ currency: r.currency, rateDate: r.rate_date, mid: Number(r.mid) }));
    const bmRates = deriveBmRates(lines);
    const ctx = { eurRates: toRates("EUR"), dkkRates: toRates("DKK"), bmRates };

    // tylko zamówienia, które liczą się jako sprzedaż (bez anulowanych/zwróconych/nieopłaconych — ten sam isCountedOrder co Przegląd)
    let results: MarginResult[] = rowsRaw.filter((r) => isCountedOrder(r.marketplace, r.status)).map((r) => computeMargin(r, ctx));
    if (marketplace) results = results.filter((r) => r.marketplace === marketplace);
    if (search) results = results.filter((r) => [r.serial, r.orderId, r.sku, r.productName].some((v) => (v || "").toLowerCase().includes(search)));
    results.sort((a, b) => (b.orderDate || "").localeCompare(a.orderDate || ""));

    const withMargin = results.filter((r) => r.marginPln !== null);
    const sum = (f: (r: MarginResult) => number | null) => withMargin.reduce((s, r) => s + (f(r) ?? 0), 0);
    const totals = {
      count: results.length,
      withMargin: withMargin.length,
      sale: sum((r) => r.salePln),
      purchase: sum((r) => r.purchasePln),
      vat: sum((r) => r.vatPln),
      shipping: sum((r) => r.shippingPln),
      extra: sum((r) => r.extraPln),
      commission: sum((r) => r.commissionPln),
      margin: sum((r) => r.marginPln),
      incomplete: withMargin.filter((r) => r.flags.length > 0).length,
    };

    return NextResponse.json({
      ok: true,
      total: results.length,
      rows: results.slice((page - 1) * pageSize, page * pageSize),
      totals,
      bmRates,
      invoiceCount: new Set(lines.map((l) => l.invoice_ref)).size,
    });
  } catch (e: any) {
    return NextResponse.json({ error: `Nie udało się policzyć marży: ${e.message || e}. Czy uruchomiono supabase/margin.sql?` }, { status: 500 });
  }
}
