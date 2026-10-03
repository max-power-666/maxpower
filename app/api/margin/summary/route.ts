import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { inPeriod, periodRange, MARGIN_MARKETPLACES, type MarginPeriod } from "@/lib/margin";
import { aggregateMargin, loadMarginResults, type MarginAgg } from "@/lib/marginServer";

// Wykres marży na Przeglądzie (03.10.2026): marża per marketplace (Back Market, refurbed) + łącznie, dla trzech okresów naraz
// (cały okres / bieżący / ubiegły miesiąc wg czasu polskiego), żeby przełączanie okresu w przeglądarce nie wołało serwera ponownie.
// Te same liczby co zakładka Marża (wspólny lib/marginServer.ts). Tylko Admin i Manager — marża to dane wrażliwe (ceny zakupu, prowizje).

export const maxDuration = 60;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PERIODS: MarginPeriod[] = ["all", "current", "previous"];

export async function GET(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ["Admin", "Manager"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  try {
    const { results } = await loadMarginResults(db);
    const periods: Record<string, { total: MarginAgg; byMarketplace: Record<string, MarginAgg> }> = {};
    for (const p of PERIODS) {
      const range = periodRange(p);
      const inRange = results.filter((r) => inPeriod(r.orderDate, range));
      const byMarketplace: Record<string, MarginAgg> = {};
      for (const m of MARGIN_MARKETPLACES) byMarketplace[m] = aggregateMargin(inRange.filter((r) => r.marketplace === m));
      periods[p] = { total: aggregateMargin(inRange), byMarketplace };
    }
    return NextResponse.json({ ok: true, periods });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Błąd liczenia marży." }, { status: 500 });
  }
}
