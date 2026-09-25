import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";
import { AllegroReauthError, allegroSweep, attachShipments, getAccessToken, type AllegroClient } from "@/lib/allegro";
import { allegroApp, serviceClient, tokenStore } from "@/lib/allegroServer";
import { mapAllegroItems, mapAllegroOrder, mapAllegroToSales } from "@/lib/salesOrders";

// Synchronizuje zamówienia SPRZEDAŻY z Allegro (GET /order/checkout-forms, dokumentacja: https://developer.allegro.pl)
// do allegro_orders (surowe dane) i sales_orders + sales_order_items (wspólna lista). Odpowiednik orders/bm-sync.
//
// Lista jest sortowana po updatedAt rosnąco, a kursor (updatedAt ostatniego zamówienia) trzymamy w
// sales_orders_sync_meta.scan_cursor — jeden mechanizm łapie i nowe zamówienia, i zmiany w starych. Pierwszy przebieg
// startuje od 1 stycznia bieżącego roku i idzie w porcjach (limit czasu funkcji). Numery przesyłek (waybill) dociągamy
// osobnym zapytaniem dla zamówień, w których cokolwiek wysłano.
// Bez Client_ID/Secret albo bez połączonego konta (patrz allegro-auth) endpoint nic nie robi i mówi o tym wprost,
// żeby "Odśwież" działało dalej dla pozostałych kanałów.
// Wywoływane przez Vercel Cron (vercel.json) i przycisk "Odśwież" w zakładce Zamówienia.

export const maxDuration = 300;

const MARKETPLACE = "allegro";
const BUDGET_MS = 200_000;

// Zapis pobranych zamówień. Upsert pozycji zawiera tylko pola z API, więc numery seryjne i pady wpisane
// przez zespół zostają nietknięte (patrz bm-sync).
async function saveOrders(admin: SupabaseClient<any, any, any>, orders: any[]) {
  const { error: rawErr } = await admin.from("allegro_orders").upsert(orders.map(mapAllegroOrder));
  if (rawErr) throw new Error(`Błąd zapisu do Supabase (allegro_orders): ${rawErr.message}`);
  const { error: salesErr } = await admin.from("sales_orders").upsert(orders.map(mapAllegroToSales));
  if (salesErr) throw new Error(`Błąd zapisu do Supabase (sales_orders): ${salesErr.message}`);
  const items = orders.flatMap(mapAllegroItems);
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
  const app = allegroApp();
  if (!app) {
    return NextResponse.json({ ok: true, skipped: "Allegro nie jest skonfigurowane (brak ALLEGRO_CLIENT_ID / ALLEGRO_CLIENT_SECRET) — pominięto." });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych." }, { status: 500 });
  }

  const admin = serviceClient();
  const store = tokenStore(admin);

  try {
    if (!(await store.load())) {
      return NextResponse.json({ ok: true, skipped: "Allegro nie jest połączone — Admin musi kliknąć „Połącz z Allegro”." });
    }
    const client: AllegroClient = { accessToken: await getAccessToken(app, store), userAgent: process.env.ALLEGRO_UA || "recoo-erp" };

    const { data: meta, error: metaError } = await admin
      .from("sales_orders_sync_meta")
      .select("full_scan_done, scan_cursor")
      .eq("marketplace", MARKETPLACE)
      .maybeSingle();
    if (metaError) throw new Error(`Błąd odczytu z Supabase: ${metaError.message}`);

    const firstRun = !meta?.full_scan_done;
    const since = (meta?.scan_cursor as string | null) ?? `${new Date().getFullYear()}-01-01T00:00:00.000Z`;

    const result = await allegroSweep(client, {
      since,
      budgetMs: BUDGET_MS,
      save: async (orders) => {
        await attachShipments(client, orders);
        await saveOrders(admin, orders);
      },
    });
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
    // Wygasła/odwołana autoryzacja to nie awaria serwera, tylko prośba o ponowne połączenie konta.
    if (e instanceof AllegroReauthError) return NextResponse.json({ error: `${e.message} Admin: kliknij „Połącz z Allegro”.` }, { status: 401 });
    return NextResponse.json({ error: e.message || "Błąd synchronizacji." }, { status: 502 });
  }
}
