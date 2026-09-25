import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";
import { erliSweep, type ErliClient } from "@/lib/erli";
import { mapErliItems, mapErliOrder, mapErliToSales } from "@/lib/salesOrders";

// Synchronizuje zamówienia SPRZEDAŻY z Erli (POST /orders/_search, dokumentacja: https://erli.pl/svc/shop-api/doc/)
// do erli_orders (surowe dane) i sales_orders + sales_order_items (wspólna lista). Odpowiednik orders/bm-sync.
//
// Erli sortuje po dacie aktualizacji i daje kursor (`cursor` ostatniego zamówienia), więc wystarczy jeden mechanizm:
// zawsze wznawiamy od zapamiętanego kursora (sales_orders_sync_meta.scan_cursor) — to łapie i nowe zamówienia,
// i zmiany statusu w starych. Pierwszy przebieg startuje od 1 stycznia bieżącego roku i idzie w porcjach (limit czasu
// funkcji); "ukończone" oznacza, że doszliśmy do końca listy. Bez klucza (ERLI_API_KEY) endpoint nic nie robi
// i mówi o tym wprost, żeby "Odśwież" działało dalej dla pozostałych kanałów.
// Wywoływane przez Vercel Cron (vercel.json) i przycisk "Odśwież" w zakładce Zamówienia.

export const maxDuration = 300;

const MARKETPLACE = "erli";
const BUDGET_MS = 200_000;

// Zapis pobranych zamówień. Upsert pozycji zawiera tylko pola z API, więc numery seryjne i pady wpisane
// przez zespół zostają nietknięte (patrz bm-sync).
async function saveOrders(admin: SupabaseClient<any, any, any>, orders: any[]) {
  const { error: rawErr } = await admin.from("erli_orders").upsert(orders.map(mapErliOrder));
  if (rawErr) throw new Error(`Błąd zapisu do Supabase (erli_orders): ${rawErr.message}`);
  const { error: salesErr } = await admin.from("sales_orders").upsert(orders.map(mapErliToSales));
  if (salesErr) throw new Error(`Błąd zapisu do Supabase (sales_orders): ${salesErr.message}`);
  const items = orders.flatMap(mapErliItems);
  if (items.length > 0) {
    const { error: itemsErr } = await admin.from("sales_order_items").upsert(items);
    if (itemsErr) throw new Error(`Błąd zapisu do Supabase (sales_order_items): ${itemsErr.message}`);
  }
}

export async function GET(request: Request) {
  const startedAt = new Date().toISOString();
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  }
  if (!process.env.ERLI_API_KEY) {
    return NextResponse.json({ ok: true, skipped: "Erli nie jest skonfigurowane (brak ERLI_API_KEY) — pominięto." });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych." }, { status: 500 });
  }

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const client: ErliClient = {
    apiKey: process.env.ERLI_API_KEY,
    userAgent: process.env.ERLI_UA || "recoo-erp",
    baseUrl: process.env.ERLI_BASE_URL || undefined,
  };

  const { data: meta, error: metaError } = await admin
    .from("sales_orders_sync_meta")
    .select("full_scan_done, scan_cursor")
    .eq("marketplace", MARKETPLACE)
    .maybeSingle();
  if (metaError) return NextResponse.json({ error: `Błąd odczytu z Supabase: ${metaError.message}` }, { status: 500 });

  const firstRun = !meta?.full_scan_done;
  const after = (meta?.scan_cursor as string | null) ?? `${new Date().getFullYear()}-01-01T00:00:00.000Z`;

  try {
    const result = await erliSweep(client, { after, budgetMs: BUDGET_MS, save: (orders) => saveOrders(admin, orders) });
    const { error: metaWriteError } = await admin.from("sales_orders_sync_meta").upsert({
      marketplace: MARKETPLACE,
      scan_cursor: result.cursor,
      ...(result.finished ? { last_synced_at: startedAt, full_scan_done: true } : {}),
    });
    if (metaWriteError) throw new Error(`Błąd zapisu do Supabase: ${metaWriteError.message}`);
    return NextResponse.json({
      ok: true,
      mode: firstRun ? "full" : "incremental",
      finished: result.finished,
      processed: result.processed,
      nextPage: null,
      apiCount: null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Błąd synchronizacji." }, { status: 502 });
  }
}
