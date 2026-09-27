import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";
import { octopiaConfigFromEnv, octopiaSweep, OctopiaError } from "@/lib/octopia";
import { mapOctopiaItems, mapOctopiaOrder, mapOctopiaToSales, uniqueBy } from "@/lib/salesOrders";

// Synchronizuje zamówienia SPRZEDAŻY z Octopia (GET /orders, dokumentacja: https://developer.octopia-io.net — marketplace'y takie
// jak Cdiscount) do octopia_orders (surowe dane) i sales_orders + sales_order_items (wspólna lista). Odpowiednik orders/bm-sync.
//
// Lista jest sortowana po updatedAt rosnąco; kursor (updatedAt ostatniego zamówienia, z zapasem 10 minut) trzymamy w
// sales_orders_sync_meta.scan_cursor — jeden mechanizm łapie i nowe zamówienia, i zmiany statusu w starych. Pierwszy przebieg
// startuje od 1 stycznia bieżącego roku i idzie w porcjach (limit czasu funkcji).
// Bez danych dostępowych (Client_ID/Secret/SellerId) endpoint nic nie robi i mówi o tym wprost, żeby "Odśwież" działało dalej
// dla pozostałych kanałów. Wywoływane przez Vercel Cron (vercel.json) i przycisk "Odśwież" w zakładce Zamówienia.

export const maxDuration = 300;

const MARKETPLACE = "octopia";
const BUDGET_MS = 200_000;
const OVERLAP_MS = 10 * 60 * 1000;

async function saveOrders(admin: SupabaseClient<any, any, any>, all: any[]) {
  const orders = uniqueBy(all, (o) => String(o.orderId));
  const { error: rawErr } = await admin.from("octopia_orders").upsert(orders.map(mapOctopiaOrder));
  if (rawErr) throw new Error(`Błąd zapisu do Supabase (octopia_orders): ${rawErr.message}`);
  const { error: salesErr } = await admin.from("sales_orders").upsert(orders.map(mapOctopiaToSales));
  if (salesErr) throw new Error(`Błąd zapisu do Supabase (sales_orders): ${salesErr.message}`);
  const items = uniqueBy(orders.flatMap(mapOctopiaItems), (i) => `${i.external_id}#${i.item_key}`);
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
  const cfg = octopiaConfigFromEnv();
  if (!cfg) {
    return NextResponse.json({ ok: true, skipped: "Octopia nie jest skonfigurowane (brak OCTOPIA_CLIENT_ID / OCTOPIA_CLIENT_SECRET / OCTOPIA_SELLER_ID) — pominięto." });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych." }, { status: 500 });
  }

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: meta, error: metaError } = await admin
    .from("sales_orders_sync_meta")
    .select("full_scan_done, scan_cursor")
    .eq("marketplace", MARKETPLACE)
    .maybeSingle();
  if (metaError) return NextResponse.json({ error: `Błąd odczytu z Supabase: ${metaError.message}` }, { status: 500 });

  const firstRun = !meta?.full_scan_done;
  const since = firstRun ? undefined : new Date(Date.parse((meta!.scan_cursor as string) || startedAt) - OVERLAP_MS).toISOString();
  const initialCursor = firstRun ? `${new Date().getFullYear()}-01-01T00:00:00Z` : meta!.scan_cursor;

  try {
    let lastUpdatedAt: string | null = null;
    const result = await octopiaSweep(cfg, {
      since: firstRun ? initialCursor ?? undefined : since,
      budgetMs: BUDGET_MS,
      save: async (orders) => {
        for (const o of orders) if (!lastUpdatedAt || Date.parse(o.updatedAt) > Date.parse(lastUpdatedAt)) lastUpdatedAt = o.updatedAt;
        await saveOrders(admin, orders);
      },
    });
    const { error: metaWriteError } = await admin.from("sales_orders_sync_meta").upsert({
      marketplace: MARKETPLACE,
      scan_cursor: lastUpdatedAt ?? (meta?.scan_cursor as string | null) ?? initialCursor,
      ...(result.finished ? { last_synced_at: startedAt, full_scan_done: true } : {}),
    });
    if (metaWriteError) throw new Error(`Błąd zapisu do Supabase: ${metaWriteError.message}`);
    return NextResponse.json({ ok: true, mode: firstRun ? "full" : "incremental", finished: result.finished, processed: result.processed, nextPage: null, apiCount: null });
  } catch (e: any) {
    const status = e instanceof OctopiaError && e.status && e.status >= 400 && e.status < 500 ? 422 : 502;
    return NextResponse.json({ error: e.message || "Błąd synchronizacji." }, { status });
  }
}
