import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";
import { AmazonError, amazonConfigFromEnv, amazonGetAccessToken, amazonGetOrderItems, amazonGetOrders } from "@/lib/amazon";
import { mapAmazonItems, mapAmazonOrder, mapAmazonToSales, uniqueBy } from "@/lib/salesOrders";

// Synchronizuje zamówienia Amazon (bezpośrednio przez SP-API, bez pośrednika). Dwie fazy w JEDNYM przebiegu, bo obie
// operacje mają BARDZO różne limity szybkości (patrz lib/amazon.ts):
//  FAZA 1 — GET /orders/v0/orders: limit 0,0167 req/s (~1 zapytanie/60 s, zapas 20) — dostaje same zamówienia, BEZ SKU.
//  FAZA 2 — GET /orders/v0/orders/{id}/orderItems: limit 0,5 req/s (zapas 30) — dogania SKU dla zamówień, które go
//           jeszcze nie mają (sales_orders.sku is null), niezależnie w którym przebiegu doszła do nich lista.
// Kursor (NextToken od Amazona, prawdziwy kursor API — nie data) trzymamy w sales_orders_sync_meta.scan_cursor.
// Pierwszy przebieg pobiera zamówienia od 1 stycznia bieżącego roku. Przez ciasny limit fazy 1 pełne pobranie historii
// może zająć wiele przebiegów cron (co 15 min) — to oczekiwane, nie błąd.
// Bez konfiguracji (AMAZON_CLIENT_ID/SECRET/REFRESH_TOKEN) endpoint nic nie robi i mówi o tym wprost.

export const maxDuration = 300;

const MARKETPLACE = "amazon";
const LIST_BUDGET_MS = 250_000; // reszta czasu (do 300 s) zostaje na fazę pozycji
const ITEMS_MAX_PER_RUN = 60; // przy 0,5 req/s to ~2 minuty — bezpieczny margines w pozostałym czasie

async function saveOrders(admin: SupabaseClient<any, any, any>, all: any[]) {
  const orders = uniqueBy(all, (o) => String(o.AmazonOrderId));
  const { error: rawErr } = await admin.from("amazon_orders").upsert(orders.map(mapAmazonOrder));
  if (rawErr) throw new Error(`Błąd zapisu do Supabase (amazon_orders): ${rawErr.message}`);
  // UWAGA: celowo bez pola "sku" — faza 1 nigdy nie nadpisuje SKU (patrz mapAmazonToSales); dogania je faza 2.
  const { error: salesErr } = await admin.from("sales_orders").upsert(orders.map(mapAmazonToSales));
  if (salesErr) throw new Error(`Błąd zapisu do Supabase (sales_orders): ${salesErr.message}`);
}

export async function GET(request: Request) {
  const startedAt = new Date().toISOString();
  if (!(await isAuthorized(request))) return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  const cfg = amazonConfigFromEnv();
  if (!cfg) return NextResponse.json({ ok: true, skipped: "Amazon nie jest skonfigurowany (brak AMAZON_CLIENT_ID / AMAZON_CLIENT_SECRET / AMAZON_REFRESH_TOKEN) — pominięto." });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych." }, { status: 500 });

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const t0 = Date.now();

  try {
    const accessToken = await amazonGetAccessToken(cfg);

    /* ---------------- FAZA 1: lista zamówień (bardzo wolno) ---------------- */
    const { data: meta, error: metaError } = await admin.from("sales_orders_sync_meta").select("full_scan_done, scan_cursor, last_synced_at").eq("marketplace", MARKETPLACE).maybeSingle();
    if (metaError) throw new Error(`Błąd odczytu z Supabase: ${metaError.message}`);
    const firstRun = !meta?.full_scan_done;
    // Kursor to albo NextToken Amazona (skan w toku — zaczyna zawsze od tych samych filtrów daty), albo (po ukończeniu)
    // brak kursora — kolejny przebieg zaczyna nowe, przyrostowe pobieranie od ostatniej udanej synchronizacji.
    const nextToken = typeof meta?.scan_cursor === "string" && meta.scan_cursor.startsWith("NT:") ? meta.scan_cursor.slice(3) : undefined;
    const lastUpdatedAfter = nextToken
      ? undefined
      : firstRun
        ? `${new Date().getFullYear()}-01-01T00:00:00Z`
        : new Date(Date.parse((meta?.last_synced_at as string) || startedAt) - 10 * 60 * 1000).toISOString();

    let processed = 0;
    let pageNextToken = nextToken ?? null;
    let finished = false;
    let firstPage = true;
    while (Date.now() - t0 < LIST_BUDGET_MS) {
      const { orders, nextToken: newToken } = await amazonGetOrders(cfg, accessToken, firstPage ? { lastUpdatedAfter, nextToken: pageNextToken ?? undefined } : { nextToken: pageNextToken ?? undefined });
      firstPage = false;
      if (orders.length > 0) {
        await saveOrders(admin, orders);
        processed += orders.length;
      }
      pageNextToken = newToken;
      if (!pageNextToken) {
        finished = true;
        break;
      }
    }

    const { error: metaWriteError } = await admin.from("sales_orders_sync_meta").upsert({
      marketplace: MARKETPLACE,
      scan_cursor: finished ? null : `NT:${pageNextToken}`,
      ...(finished ? { last_synced_at: startedAt, full_scan_done: true } : {}),
    });
    if (metaWriteError) throw new Error(`Błąd zapisu do Supabase: ${metaWriteError.message}`);

    /* ---------------- FAZA 2: pozycje zamówień bez SKU (szybciej, ale nadal ostrożnie) ---------------- */
    let itemsDone = 0;
    let itemsFailed = 0;
    const { data: pending } = await admin.from("sales_orders").select("external_id").eq("marketplace", MARKETPLACE).is("sku", null).limit(ITEMS_MAX_PER_RUN);
    for (const row of pending || []) {
      if (Date.now() - t0 > 290_000) break; // twardy limit funkcji (300 s) — reszta poczeka na kolejny przebieg
      try {
        const items = await amazonGetOrderItems(cfg, accessToken, row.external_id);
        const sku = Array.from(new Set(items.map((it) => (typeof it?.SellerSKU === "string" ? it.SellerSKU.trim() : "")).filter(Boolean))).join(", ") || null;
        // Doklejamy pozycje do surowego zamówienia i uzupełniamy SKU (tylko te dwa pola — nic więcej nie ruszamy).
        const { data: existing } = await admin.from("amazon_orders").select("raw").eq("id", row.external_id).maybeSingle();
        if (existing) await admin.from("amazon_orders").update({ raw: { ...existing.raw, orderItems: items } }).eq("id", row.external_id);
        await admin.from("sales_orders").update({ sku }).eq("marketplace", MARKETPLACE).eq("external_id", row.external_id);
        const itemRows = uniqueBy(mapAmazonItems(row.external_id, items), (i) => i.item_key);
        if (itemRows.length > 0) {
          const { error: itemsErr } = await admin.from("sales_order_items").upsert(itemRows);
          if (itemsErr) throw new Error(itemsErr.message);
        }
        itemsDone++;
      } catch {
        itemsFailed++; // pojedyncza porażka nie psuje przebiegu — spróbujemy przy następnym cronie
      }
    }

    return NextResponse.json({ ok: true, mode: firstRun ? "full" : "incremental", finished, processed, itemsDone, itemsFailed, nextPage: null, apiCount: null });
  } catch (e: any) {
    const status = e instanceof AmazonError && e.status && e.status >= 400 && e.status < 500 && e.status !== 429 ? 422 : 502;
    return NextResponse.json({ error: e.message || "Błąd synchronizacji." }, { status });
  }
}
