import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";
import { ApiloError, apiloFindPlatformAccountId, apiloListOrders, apiloStatusMap, getAccessToken, type ApiloClient } from "@/lib/apilo";
import { apiloApp, apiloTokenStore, serviceClient } from "@/lib/apiloServer";
import { mapApiloItems, mapApiloOrder, mapApiloToSales, uniqueBy } from "@/lib/salesOrders";

// Synchronizuje zamówienia Amazon przez Apilo (GET /rest/api/orders/, filtrowane do konta Amazon) — TYMCZASOWY most,
// dopóki nie ma bezpośredniej integracji z Amazon SP-API (patrz CLAUDE.md). Zapisuje do apilo_orders (surowe dane) oraz
// sales_orders + sales_order_items (wspólna lista), tak jak pozostałe kanały.
//
// Lista jest sortowana po dacie aktualizacji rosnąco; kursor (updatedAt ostatniego zamówienia, z zapasem 10 minut)
// trzymamy w sales_orders_sync_meta.scan_cursor. Pierwszy przebieg pobiera całą historię (bez filtra daty) w porcjach.
// Bez konfiguracji albo bez połączenia (patrz orders/apilo-connect) endpoint nic nie robi i mówi o tym wprost.

export const maxDuration = 300;

const MARKETPLACE = "apilo";
const BUDGET_MS = 200_000;
const OVERLAP_MS = 10 * 60 * 1000;
const PAGE_SIZE = 200;

async function saveOrders(admin: SupabaseClient<any, any, any>, all: any[], statusMap: Record<number, string>) {
  const orders = uniqueBy(all, (o) => String(o.id));
  const statusOf = (o: any) => statusMap[Number(o.status)] ?? null;
  const { error: rawErr } = await admin.from("apilo_orders").upsert(orders.map((o) => mapApiloOrder(o, statusOf(o))));
  if (rawErr) throw new Error(`Błąd zapisu do Supabase (apilo_orders): ${rawErr.message}`);
  const { error: salesErr } = await admin.from("sales_orders").upsert(orders.map((o) => mapApiloToSales(o, statusOf(o))));
  if (salesErr) throw new Error(`Błąd zapisu do Supabase (sales_orders): ${salesErr.message}`);
  const items = uniqueBy(orders.flatMap(mapApiloItems), (i) => `${i.external_id}#${i.item_key}`);
  if (items.length > 0) {
    const { error: itemsErr } = await admin.from("sales_order_items").upsert(items);
    if (itemsErr) throw new Error(`Błąd zapisu do Supabase (sales_order_items): ${itemsErr.message}`);
  }
}

export async function GET(request: Request) {
  const startedAt = new Date().toISOString();
  if (!(await isAuthorized(request))) return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  const app = apiloApp();
  if (!app) return NextResponse.json({ ok: true, skipped: "Apilo nie jest skonfigurowane (brak APILO_CLIENT_ID / APILO_CLIENT_SECRET / APILO_BASE_URL) — pominięto." });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych." }, { status: 500 });

  const admin = serviceClient();
  const store = apiloTokenStore(admin);

  try {
    if (!(await store.load())) {
      return NextResponse.json({ ok: true, skipped: "Apilo nie jest połączone — Admin musi wymienić kod autoryzacyjny z panelu Apilo." });
    }
    const client: ApiloClient = { accessToken: await getAccessToken(app, store), baseUrl: app.baseUrl };
    const platformAccountId = await apiloFindPlatformAccountId(client);
    if (platformAccountId === null) {
      return NextResponse.json({ ok: true, skipped: "Nie znaleziono połączonego konta Amazon w Apilo (sprawdź Integracje w panelu Apilo)." });
    }
    const statusMap = await apiloStatusMap(client);

    const { data: meta, error: metaError } = await admin.from("sales_orders_sync_meta").select("full_scan_done, scan_cursor").eq("marketplace", MARKETPLACE).maybeSingle();
    if (metaError) throw new Error(`Błąd odczytu z Supabase: ${metaError.message}`);
    const firstRun = !meta?.full_scan_done;
    const updatedAfter = firstRun ? undefined : new Date(Date.parse((meta!.scan_cursor as string) || startedAt) - OVERLAP_MS).toISOString();

    let lastUpdatedAt: string | null = null;
    let offset = firstRun && meta?.scan_cursor ? Number(meta.scan_cursor) || 0 : 0;
    let processed = 0;
    let finished = false;
    const t0 = Date.now();
    while (Date.now() - t0 < BUDGET_MS) {
      const orders = await apiloListOrders(client, { platformAccountId, updatedAfter, offset });
      if (orders.length > 0) {
        await saveOrders(admin, orders, statusMap);
        processed += orders.length;
        for (const o of orders) if (!lastUpdatedAt || Date.parse(o.updatedAt) > Date.parse(lastUpdatedAt)) lastUpdatedAt = o.updatedAt;
      }
      if (orders.length < PAGE_SIZE) {
        finished = true;
        break;
      }
      offset += PAGE_SIZE;
    }

    const { error: metaWriteError } = await admin.from("sales_orders_sync_meta").upsert({
      marketplace: MARKETPLACE,
      scan_cursor: finished ? lastUpdatedAt ?? (meta?.scan_cursor as string | null) : firstRun ? String(offset) : lastUpdatedAt ?? (meta?.scan_cursor as string | null),
      ...(finished ? { full_scan_done: true } : {}),
    });
    if (metaWriteError) throw new Error(`Błąd zapisu do Supabase: ${metaWriteError.message}`);
    return NextResponse.json({ ok: true, mode: firstRun ? "full" : "incremental", finished, processed, nextPage: null, apiCount: null });
  } catch (e: any) {
    const status = e instanceof ApiloError && e.status && e.status >= 400 && e.status < 500 ? 422 : 502;
    return NextResponse.json({ error: e.message || "Błąd synchronizacji." }, { status });
  }
}
