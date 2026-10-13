import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";
import { BM_LISTINGS_PAGE_SIZE, bmFetchListingsPage, bmListingsConfigFromEnv, mapBmListing, mapRefurbedOffer, refurbedFetchOffersPage, type ListingMarketplace } from "@/lib/listings";
import { runListingsSnapshot, type SnapshotDeps, type SnapshotResult } from "@/lib/listingsSync";
import type { RefurbedClient } from "@/lib/refurbed";

// Magazyn -> Listingi (13.10.2026): synchronizuje oferty wystawione na Back Market (GET /ws/listings) i refurbed (OfferService/ListOffers) do marketplace_listings.
// Zapisuje KOMPLETNĄ migawkę (patrz lib/listingsSync.ts: kursor w listings_sync_meta, usuwanie ofert, których marketplace już nie zwraca, dopiero po ukończeniu).
// GET bez parametru (cron co 30 min) = oba marketplace'y po kolei; ?marketplace=backmarket|refurbed (przycisk "Odśwież" w zakładce Listingi) = jeden, z większym budżetem czasu.
// Kanał bez konfiguracji (brak BACKMARKET_AUTH / REFURBED_API_TOKEN) jest pomijany z komunikatem, nie błędem — jak przy synchronizacji zamówień.

export const maxDuration = 300;

const BOTH_BUDGET_MS = 115_000; // dwa marketplace'y w jednym wywołaniu (2 x 115 s mieści się w 300 s)
const SINGLE_BUDGET_MS = 230_000;

type Outcome = SnapshotResult | { skipped: string };

function deps(admin: SupabaseClient<any, any, any>, marketplace: ListingMarketplace, budgetMs: number, fetchPage: SnapshotDeps["fetchPage"], mapItem: SnapshotDeps["mapItem"]): SnapshotDeps {
  return {
    marketplace,
    budgetMs,
    fetchPage,
    mapItem,
    loadMeta: async () => {
      const { data, error } = await admin.from("listings_sync_meta").select("scan_cursor, scan_started_at").eq("marketplace", marketplace).maybeSingle();
      if (error) throw new Error(`Błąd odczytu z Supabase (listings_sync_meta): ${error.message}`);
      return data ? { scan_cursor: (data.scan_cursor as string | null) ?? null, scan_started_at: (data.scan_started_at as string | null) ?? null } : null;
    },
    saveRows: async (rows) => {
      const { error } = await admin.from("marketplace_listings").upsert(rows);
      if (error) throw new Error(`Błąd zapisu do Supabase (marketplace_listings): ${error.message}`);
    },
    countSnapshot: async (snapshotAt) => {
      const { count, error } = await admin.from("marketplace_listings").select("external_id", { count: "exact", head: true }).eq("marketplace", marketplace).eq("snapshot_at", snapshotAt);
      if (error) throw new Error(`Błąd odczytu z Supabase (marketplace_listings): ${error.message}`);
      return count ?? 0;
    },
    deleteOlderThan: async (snapshotAt) => {
      const { data, error } = await admin.from("marketplace_listings").delete().eq("marketplace", marketplace).lt("snapshot_at", snapshotAt).select("external_id");
      if (error) throw new Error(`Błąd usuwania nieaktualnych ofert: ${error.message}`);
      return data?.length ?? 0;
    },
    saveMeta: async (m) => {
      const nowIso = new Date().toISOString();
      const row: Record<string, unknown> = m.finished
        ? { marketplace, last_synced_at: nowIso, last_count: m.count, scan_cursor: null, scan_started_at: null, last_attempt_at: nowIso, last_error: null }
        : { marketplace, scan_cursor: m.scan_cursor, scan_started_at: m.scan_started_at, last_attempt_at: nowIso, last_error: m.error };
      const { error } = await admin.from("listings_sync_meta").upsert(row);
      if (error) throw new Error(`Błąd zapisu do Supabase (listings_sync_meta): ${error.message}`);
    },
  };
}

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych." }, { status: 500 });

  const wanted = new URL(request.url).searchParams.get("marketplace");
  if (wanted && wanted !== "backmarket" && wanted !== "refurbed") return NextResponse.json({ error: "Nieznany marketplace." }, { status: 400 });
  const targets: ListingMarketplace[] = wanted === "backmarket" || wanted === "refurbed" ? [wanted] : ["backmarket", "refurbed"];
  const budget = targets.length === 1 ? SINGLE_BUDGET_MS : BOTH_BUDGET_MS;
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const results: Record<string, Outcome> = {};
  for (const mp of targets) {
    try {
      if (mp === "backmarket") {
        const cfg = bmListingsConfigFromEnv();
        if (!cfg) {
          results[mp] = { skipped: "Back Market nie jest skonfigurowany (brak BACKMARKET_AUTH) — pominięto." };
          continue;
        }
        results[mp] = await runListingsSnapshot(
          deps(
            admin,
            mp,
            budget,
            async (cursor) => {
              const page = cursor ? Number(cursor) : 1;
              const { results: items, hasNext } = await bmFetchListingsPage(cfg, Number.isFinite(page) && page > 0 ? page : 1);
              // Pusta strona kończy listę nawet przy "next" (obrona przed pętlą na błędnej odpowiedzi API).
              return { items, nextCursor: hasNext && items.length > 0 ? String((Number.isFinite(page) && page > 0 ? page : 1) + 1) : null };
            },
            mapBmListing
          )
        );
      } else {
        if (!process.env.REFURBED_API_TOKEN) {
          results[mp] = { skipped: "Refurbed nie jest skonfigurowany (brak REFURBED_API_TOKEN) — pominięto." };
          continue;
        }
        const client: RefurbedClient = { token: process.env.REFURBED_API_TOKEN, userAgent: process.env.REFURBED_UA || "recoo-erp", baseUrl: process.env.REFURBED_BASE_URL || undefined };
        results[mp] = await runListingsSnapshot(
          deps(
            admin,
            mp,
            budget,
            async (cursor) => {
              const { offers, hasMore } = await refurbedFetchOffersPage(client, cursor);
              const last = offers.length ? String(offers[offers.length - 1]?.id ?? "") : "";
              return { items: offers, nextCursor: hasMore && last ? last : null };
            },
            mapRefurbedOffer
          )
        );
      }
    } catch (e: any) {
      // Awaria samej infrastruktury (np. brak tabel — nieuruchomione listings.sql) nie psuje drugiego marketplace'u.
      const msg = e?.message || "Błąd synchronizacji.";
      results[mp] = { finished: false, processed: 0, total: null, removed: 0, pages: 0, error: /relation .* does not exist|PGRST205|42P01/.test(msg) ? "Brak tabel listingów — uruchom supabase/listings.sql w Supabase." : msg };
    }
  }
  const failed = Object.values(results).some((r) => "error" in r && r.error);
  return NextResponse.json({ ok: !failed, pageSize: BM_LISTINGS_PAGE_SIZE, results }, { status: failed ? 502 : 200 });
}
