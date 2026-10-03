import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { inPeriod, periodRange, type MarginResult } from "@/lib/margin";
import { loadMarginResults } from "@/lib/marginServer";

// Zakładka Marża (03.10.2026) — lista sprzedanych sztuk z numerem seryjnym z marżą. Tylko Admin i Manager (ceny zakupu, prowizje).
// Całość liczona po stronie serwera: widok margin_items (supabase/margin.sql, dostępny tylko dla service_role) + kursy NBP + średnie stawki BM z
// wgranych faktur (lib/margin.ts). Liczymy wszystkie wiersze naraz (setki, nie dziesiątki tysięcy), a stronicowanie/sumy robimy na wyniku.

export const maxDuration = 60;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function GET(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ["Admin", "Manager"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = [25, 50, 100].includes(Number(url.searchParams.get("pageSize"))) ? Number(url.searchParams.get("pageSize")) : 50;
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const marketplace = url.searchParams.get("marketplace") || "";
  const range = periodRange(url.searchParams.get("period") || "all"); // all (null) | current | previous — miesiące kalendarzowe wg czasu polskiego

  try {
    const { results: all, bmRates, invoiceCount, purchasesCount } = await loadMarginResults(db);
    let results: MarginResult[] = all;
    if (marketplace) results = results.filter((r) => r.marketplace === marketplace);
    if (range) results = results.filter((r) => inPeriod(r.orderDate, range));
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
      invoiceCount,
      purchasesCount,
    });
  } catch (e: any) {
    return NextResponse.json({ error: `Nie udało się policzyć marży: ${e.message || e}. Czy uruchomiono supabase/margin.sql?` }, { status: 500 });
  }
}
