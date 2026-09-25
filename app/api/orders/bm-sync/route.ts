import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";
import { scanOrders } from "@/lib/scanOrders";
import { mapBmItems, mapBmOrder, mapBmToSales } from "@/lib/salesOrders";

// Synchronizuje zamówienia SPRZEDAŻY z Back Marketu (GET /ws/orders, dokumentacja: https://api.backmarket.dev,
// sekcja Orders) do bm_orders (surowe dane) i sales_orders (wspólna lista). Osobne od zamówień skupu
// (tradein/orders-sync). API nie zwraca zamówień w stanach 0 i 8 (nowe/nieopłacone) — tak działa endpoint.
//
// Tryby (sales_orders_sync_meta, wiersz 'backmarket') — tak samo jak przy zamówieniach BuyBack:
//  - pełny skan (full_scan_done = false): zamówienia od 1 stycznia bieżącego roku (date_creation), w porcjach
//    z kursorem scan_page (limit czasu funkcji); ukończony tylko gdy API samo zakończy listę;
//  - przyrostowy: tylko zamówienia zmienione po last_synced_at (date_modification), z zapasem 10 minut.
// Dodatkowo, po ukończonej synchronizacji, każdy przebieg odświeża pojedynczo (GET /ws/orders/{id}) do
// RECHECK_LIMIT zamówień, które nie są jeszcze w stanie końcowym (0, 10, 1, 3) i od godziny nie były
// odświeżone — siatka bezpieczeństwa na wypadek, gdyby filtr date_modification pominął zmianę statusu.
// Wywoływane przez Vercel Cron (vercel.json) i przycisk "Odśwież" w zakładce Zamówienia.

export const maxDuration = 300;

const MARKETPLACE = "backmarket";
const PAGE_SIZE = 50; // maksimum wg dokumentacji
const MAX_PAGES = 5000; // bezpiecznik; jego trafienie NIE kończy skanu
const BUDGET_MS = 200_000;
const REQUEST_TIMEOUT_MS = 30_000;
const OVERLAP_MS = 10 * 60 * 1000;
const OPEN_STATES = [0, 10, 1, 3]; // stan 9 (wysłane) i 8 (nieopłacone) są końcowe
const RECHECK_LIMIT = 25;
const RECHECK_MIN_AGE_MS = 60 * 60 * 1000;
const RECHECK_DEADLINE_MS = 250_000; // po tym czasie od startu funkcji nie zaczynamy kolejnego zapytania

// Zapis pobranych zamówień: surowe dane, wspólna lista i pozycje (kolejność ma znaczenie: pozycje mają klucz
// obcy do zamówienia). Upsert pozycji zawiera tylko pola z API, więc numery seryjne i pady wpisane
// przez zespół zostają nietknięte.
async function saveOrders(admin: SupabaseClient<any, any, any>, orders: any[]) {
  const { error: rawErr } = await admin.from("bm_orders").upsert(orders.map(mapBmOrder));
  if (rawErr) throw new Error(`Błąd zapisu do Supabase (bm_orders): ${rawErr.message}`);
  const { error: salesErr } = await admin.from("sales_orders").upsert(orders.map(mapBmToSales));
  if (salesErr) throw new Error(`Błąd zapisu do Supabase (sales_orders): ${salesErr.message}`);
  const items = orders.flatMap(mapBmItems);
  if (items.length > 0) {
    const { error: itemsErr } = await admin.from("sales_order_items").upsert(items);
    if (itemsErr) throw new Error(`Błąd zapisu do Supabase (sales_order_items): ${itemsErr.message}`);
  }
}

function rfc3339(d: Date) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  }
  if (!process.env.BACKMARKET_AUTH) {
    return NextResponse.json({ error: "Brak BACKMARKET_AUTH w zmiennych środowiskowych." }, { status: 500 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych." }, { status: 500 });
  }

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const baseUrl = process.env.BACKMARKET_BASE_URL || "https://www.backmarket.fr";

  const { data: meta, error: metaError } = await admin
    .from("sales_orders_sync_meta")
    .select("last_synced_at, full_scan_done, scan_page, scan_started_at")
    .eq("marketplace", MARKETPLACE)
    .maybeSingle();
  if (metaError) return NextResponse.json({ error: `Błąd odczytu z Supabase: ${metaError.message}` }, { status: 500 });

  const fullScan = !meta?.full_scan_done || !meta?.last_synced_at;
  const startPage = Number(meta?.scan_page) > 0 ? Number(meta!.scan_page) : 1;
  const scanStartedAt = (meta?.scan_started_at as string | null) ?? new Date().toISOString();

  const baseParams = new URLSearchParams({ "page-size": String(PAGE_SIZE) });
  if (fullScan) {
    baseParams.set("date_creation", `${new Date().getFullYear()}-01-01T00:00:00Z`);
  } else {
    baseParams.set("date_modification", rfc3339(new Date(Date.parse(meta!.last_synced_at as string) - OVERLAP_MS)));
  }

  let result;
  try {
    result = await scanOrders({
      startPage,
      budgetMs: BUDGET_MS,
      maxPages: MAX_PAGES,
      fetchPage: async (page) => {
        const params = new URLSearchParams(baseParams);
        params.set("page", String(page));
        const res = await fetch(`${baseUrl}/ws/orders?${params.toString()}`, {
          headers: {
            Accept: "application/json",
            "Accept-Language": process.env.BACKMARKET_LANG || "fr-fr",
            Authorization: process.env.BACKMARKET_AUTH!,
            "User-Agent": process.env.BACKMARKET_UA || "backmarket@recoo.io",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Back Market zwrócił błąd (${res.status}) na stronie ${page}: ${text.slice(0, 200)}`);
        }
        const data = await res.json();
        return { results: (data.results || []) as any[], hasNext: !!data.next, count: data.count };
      },
      save: (rows) => saveOrders(admin, rows),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Błąd synchronizacji." }, { status: 502 });
  }

  const { error: metaWriteError } = await admin.from("sales_orders_sync_meta").upsert(
    result.finished
      ? { marketplace: MARKETPLACE, last_synced_at: scanStartedAt, full_scan_done: true, scan_page: 1, scan_started_at: null }
      : { marketplace: MARKETPLACE, scan_page: result.nextPage, scan_started_at: scanStartedAt }
  );
  if (metaWriteError) {
    return NextResponse.json({ error: `Błąd zapisu do Supabase: ${metaWriteError.message}` }, { status: 500 });
  }

  let rechecked = 0;
  if (result.finished) {
    const { data: stale } = await admin
      .from("bm_orders")
      .select("order_id")
      .in("state", OPEN_STATES)
      .lt("synced_at", new Date(Date.now() - RECHECK_MIN_AGE_MS).toISOString())
      .order("synced_at", { ascending: true })
      .limit(RECHECK_LIMIT);
    for (const { order_id } of stale || []) {
      if (Date.now() - startedAt > RECHECK_DEADLINE_MS) break;
      try {
        const res = await fetch(`${baseUrl}/ws/orders/${order_id}`, {
          headers: {
            Accept: "application/json",
            "Accept-Language": process.env.BACKMARKET_LANG || "fr-fr",
            Authorization: process.env.BACKMARKET_AUTH!,
            "User-Agent": process.env.BACKMARKET_UA || "backmarket@recoo.io",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) continue; // np. zamówienie zniknęło z API — spróbujemy przy następnym przebiegu
        const order = await res.json();
        if (!order?.order_id) continue;
        await saveOrders(admin, [order]);
        rechecked += 1;
      } catch {
        /* pojedyncza porażka nie psuje przebiegu */
      }
    }
  }

  return NextResponse.json({
    ok: true,
    rechecked,
    mode: fullScan ? "full" : "incremental",
    finished: result.finished,
    processed: result.processed,
    nextPage: result.finished ? null : result.nextPage,
    apiCount: result.apiCount,
    syncedAt: result.finished ? scanStartedAt : null,
  });
}
