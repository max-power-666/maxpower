import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";
import { refurbedSweep, type RefurbedClient } from "@/lib/refurbed";
import { mapRefurbedItems, mapRefurbedOrder, mapRefurbedToSales } from "@/lib/salesOrders";

// Synchronizuje zamówienia SPRZEDAŻY z refurbed (OrderService/ListOrders, dokumentacja w CLAUDE.md) do
// refurbed_orders (surowe dane) i sales_orders + sales_order_items (wspólna lista). Odpowiednik orders/bm-sync.
//
// refurbed NIE ma filtra po dacie modyfikacji — zmiana statusu (NEW -> ACCEPTED -> SHIPPED) nie zmienia released_at.
// Dlatego:
//  - pełny skan (full_scan_done = false): zamówienia od 1 stycznia bieżącego roku (released_at), rosnąco po ID,
//    w porcjach z kursorem (sales_orders_sync_meta.scan_cursor = id ostatniego zamówienia) — limit czasu funkcji;
//  - przyrostowo, przy każdym przebiegu: (A) nowe zamówienia — released_at od ostatniej synchronizacji (z zapasem
//    10 minut) oraz (B) odświeżenie zamówień jeszcze niezakończonych (NEW, ACCEPTED, SHIPPED) z ostatnich 60 dni.
// Bez tokena (REFURBED_API_TOKEN) endpoint nic nie robi i mówi o tym wprost, żeby "Odśwież" działało dalej dla Back Market.
// Wywoływane przez Vercel Cron (vercel.json) i przycisk "Odśwież" w zakładce Zamówienia.

export const maxDuration = 300;

const MARKETPLACE = "refurbed";
const BUDGET_MS = 200_000;
const OVERLAP_MS = 10 * 60 * 1000;
const OPEN_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const OPEN_STATES = ["NEW", "ACCEPTED", "SHIPPED"];

// Zapis pobranych zamówień. Upsert pozycji zawiera tylko pola z API, więc numery seryjne i pady wpisane
// przez zespół zostają nietknięte (patrz bm-sync).
async function saveOrders(admin: SupabaseClient<any, any, any>, orders: any[]) {
  const { error: rawErr } = await admin.from("refurbed_orders").upsert(orders.map(mapRefurbedOrder));
  if (rawErr) throw new Error(`Błąd zapisu do Supabase (refurbed_orders): ${rawErr.message}`);
  const { error: salesErr } = await admin.from("sales_orders").upsert(orders.map(mapRefurbedToSales));
  if (salesErr) throw new Error(`Błąd zapisu do Supabase (sales_orders): ${salesErr.message}`);
  const items = orders.flatMap(mapRefurbedItems);
  if (items.length > 0) {
    const { error: itemsErr } = await admin.from("sales_order_items").upsert(items);
    if (itemsErr) throw new Error(`Błąd zapisu do Supabase (sales_order_items): ${itemsErr.message}`);
  }
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  }
  if (!process.env.REFURBED_API_TOKEN) {
    return NextResponse.json({ ok: true, skipped: "Refurbed nie jest skonfigurowany (brak REFURBED_API_TOKEN) — pominięto." });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych." }, { status: 500 });
  }

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const client: RefurbedClient = {
    token: process.env.REFURBED_API_TOKEN,
    userAgent: process.env.REFURBED_UA || "recoo-erp",
    baseUrl: process.env.REFURBED_BASE_URL || undefined,
  };
  const save = (orders: any[]) => saveOrders(admin, orders);

  const { data: meta, error: metaError } = await admin
    .from("sales_orders_sync_meta")
    .select("last_synced_at, full_scan_done, scan_cursor, scan_started_at")
    .eq("marketplace", MARKETPLACE)
    .maybeSingle();
  if (metaError) return NextResponse.json({ error: `Błąd odczytu z Supabase: ${metaError.message}` }, { status: 500 });

  const fullScan = !meta?.full_scan_done || !meta?.last_synced_at;

  try {
    if (fullScan) {
      const scanStartedAt = (meta?.scan_started_at as string | null) ?? new Date().toISOString();
      const result = await refurbedSweep(client, {
        filter: { released_at: { ge: `${new Date().getFullYear()}-01-01T00:00:00Z` } },
        startAfter: (meta?.scan_cursor as string | null) ?? null,
        budgetMs: BUDGET_MS,
        save,
      });
      const { error: metaWriteError } = await admin.from("sales_orders_sync_meta").upsert(
        result.finished
          ? { marketplace: MARKETPLACE, last_synced_at: scanStartedAt, full_scan_done: true, scan_cursor: null, scan_started_at: null }
          : { marketplace: MARKETPLACE, scan_cursor: result.cursor, scan_started_at: scanStartedAt }
      );
      if (metaWriteError) throw new Error(`Błąd zapisu do Supabase: ${metaWriteError.message}`);
      return NextResponse.json({
        ok: true,
        mode: "full",
        finished: result.finished,
        processed: result.processed,
        nextPage: null,
        apiCount: null,
      });
    }

    const lastSynced = Date.parse(meta!.last_synced_at as string);
    const fresh = await refurbedSweep(client, {
      filter: { released_at: { ge: new Date(lastSynced - OVERLAP_MS).toISOString() } },
      budgetMs: BUDGET_MS,
      save,
    });
    const open = await refurbedSweep(client, {
      filter: {
        state: { any_of: OPEN_STATES },
        released_at: { ge: new Date(Date.now() - OPEN_WINDOW_MS).toISOString() },
      },
      budgetMs: Math.max(BUDGET_MS - (Date.now() - startedAt), 10_000),
      save,
    });
    // Znacznik przesuwamy tylko po pełnym przebiegu nowych zamówień; niedokończone odświeżanie otwartych
    // zamówień nadrobi się w kolejnym przebiegu (cron co 15 min).
    if (fresh.finished) {
      const { error: metaWriteError } = await admin
        .from("sales_orders_sync_meta")
        .upsert({ marketplace: MARKETPLACE, last_synced_at: new Date(startedAt).toISOString() });
      if (metaWriteError) throw new Error(`Błąd zapisu do Supabase: ${metaWriteError.message}`);
    }
    return NextResponse.json({
      ok: true,
      mode: "incremental",
      finished: fresh.finished && open.finished,
      processed: fresh.processed + open.processed,
      nextPage: null,
      apiCount: null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Błąd synchronizacji." }, { status: 502 });
  }
}
