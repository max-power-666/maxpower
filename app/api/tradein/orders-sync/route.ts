import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";
import { scanOrders } from "@/lib/scanOrders";
import { mapOrder } from "@/lib/buybackOrders";

// Synchronizuje zamówienia BuyBack z Back Marketu do tabeli buyback_orders w Supabase.
// GET /ws/buyback/v1/orders — dokumentacja: https://api.backmarket.dev (sekcja BuyBack).
//
// Tryby (buyback_orders_sync_meta):
//  - pełny skan (full_scan_done = false): WSZYSTKIE zamówienia od 1 stycznia bieżącego roku
//    (creationDate). Trwa kilka minut, więc idzie w porcjach: po wyczerpaniu budżetu czasu zapisujemy
//    kursor (scan_page) i kontynuujemy przy następnym wywołaniu (cron co 15 min albo "Odśwież").
//  - przyrostowy (full_scan_done = true): tylko zamówienia zmienione po last_synced_at
//    (modificationDate) — jedno pole łapie i nowe zamówienia, i zmiany statusu istniejących.
// Skan jest uznany za ukończony (i last_synced_at przesuwa się) wyłącznie, gdy API samo zakończyło listę.
// Wcześniej twardy limit 200 stron urywał pełny skan na 2000 zamówieniach po cichu, a potem
// oznaczał go jako ukończony — patrz lib/scanOrders.ts.
//
// Wywoływane przez: (1) Vercel Cron (patrz vercel.json), (2) ręcznie z tym samym tokenem
// co bidder (isAuthorized w lib/buyback.ts: sekret crona albo token zalogowanego użytkownika).

export const maxDuration = 300;

const MAX_PAGES = 5000; // bezpiecznik; jego trafienie NIE kończy skanu
const BUDGET_MS = 200_000; // po tym czasie nie zaczynamy kolejnej strony (limit funkcji to 300 s)
const REQUEST_TIMEOUT_MS = 30_000;

function supabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

function bmHeaders() {
  return {
    Accept: "application/json",
    "Accept-Language": process.env.BACKMARKET_LANG || "fr-fr",
    Authorization: process.env.BACKMARKET_AUTH!,
    "User-Agent": process.env.BACKMARKET_UA || "backmarket@recoo.io",
  };
}

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  }
  if (!process.env.BACKMARKET_AUTH) {
    return NextResponse.json({ error: "Brak BACKMARKET_AUTH w .env.local" }, { status: 500 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY w .env.local" }, { status: 500 });
  }

  const admin = supabaseAdmin();
  const baseUrl = process.env.BACKMARKET_BASE_URL || "https://www.backmarket.fr";

  const { data: meta, error: metaError } = await admin
    .from("buyback_orders_sync_meta")
    .select("last_synced_at, full_scan_done, scan_page, scan_started_at")
    .eq("id", 1)
    .maybeSingle();
  if (metaError) return NextResponse.json({ error: `Błąd odczytu z Supabase: ${metaError.message}` }, { status: 500 });

  const fullScan = !meta?.full_scan_done || !meta?.last_synced_at;
  const startPage = Number(meta?.scan_page) > 0 ? Number(meta!.scan_page) : 1;
  // Skan wznowiony z kursora zachowuje datę startu — od niej liczymy kolejne przyrostowe synchronizacje.
  const scanStartedAt = (meta?.scan_started_at as string | null) ?? new Date().toISOString();

  const baseParams = new URLSearchParams();
  if (fullScan) {
    baseParams.set("creationDate", `${new Date().getFullYear()}-01-01`);
  } else {
    baseParams.set("modificationDate", (meta!.last_synced_at as string).slice(0, 10));
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
        const res = await fetch(`${baseUrl}/ws/buyback/v1/orders?${params.toString()}`, {
          headers: bmHeaders(),
          cache: "no-store",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Back Market zwrócił błąd (${res.status}) na stronie ${page}`);
        const data = await res.json();
        return { results: (data.results || []) as any[], hasNext: !!data.next, count: data.count };
      },
      save: async (rows) => {
        const { error } = await admin.from("buyback_orders").upsert(rows.map(mapOrder));
        if (error) throw new Error(`Błąd zapisu do Supabase: ${error.message}`);
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Błąd synchronizacji." }, { status: 502 });
  }

  const { error: metaWriteError } = await admin.from("buyback_orders_sync_meta").upsert(
    result.finished
      ? { id: 1, last_synced_at: scanStartedAt, full_scan_done: true, scan_page: 1, scan_started_at: null }
      : { id: 1, scan_page: result.nextPage, scan_started_at: scanStartedAt }
  );
  if (metaWriteError) {
    return NextResponse.json({ error: `Błąd zapisu do Supabase: ${metaWriteError.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    mode: fullScan ? "full" : "incremental",
    finished: result.finished,
    processed: result.processed,
    nextPage: result.finished ? null : result.nextPage,
    apiCount: result.apiCount,
    syncedAt: result.finished ? scanStartedAt : null,
  });
}
