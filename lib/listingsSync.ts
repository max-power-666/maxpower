// Magazyn -> Listingi: synchronizacja KOMPLETNEJ migawki ofert jednego marketplace'u, w porcjach z kursorem (limit czasu funkcji).
// Czysta logika bez Supabase — zapis i metadane wstrzykiwane (route: app/api/listings/sync, test: scratchpad). Zasady:
//  - migawka = wszystkie oferty zwrócone przez API; każdy wiersz dostaje snapshot_at = początek migawki;
//  - migawka może zająć kilka przebiegów (kursor w meta); po jej UKOŃCZENIU usuwamy oferty ze starszym snapshot_at (marketplace już ich nie zwraca);
//  - nigdy nie usuwamy, gdy migawka nie zapisała ani jednej oferty (pusta odpowiedź API to nie "wszystko zniknęło");
//  - niedokończona migawka starsza niż RESTART_AFTER_MS zaczyna się od nowa (żeby nie sklejać bardzo starych porcji).

import type { ListingMarketplace, ListingRow } from "./listings";

export const RESTART_AFTER_MS = 3 * 60 * 60 * 1000;

export type ListingsMeta = { scan_cursor: string | null; scan_started_at: string | null };

export type SnapshotDeps = {
  marketplace: ListingMarketplace;
  budgetMs: number;
  now?: () => number;
  loadMeta: () => Promise<ListingsMeta | null>;
  // cursor === null: pierwsza strona. Zwraca surowe rekordy API i kursor następnej strony (null = koniec listy).
  fetchPage: (cursor: string | null) => Promise<{ items: any[]; nextCursor: string | null }>;
  mapItem: (item: any, snapshotAt: string) => ListingRow | null;
  saveRows: (rows: ListingRow[]) => Promise<void>;
  countSnapshot: (snapshotAt: string) => Promise<number>;
  deleteOlderThan: (snapshotAt: string) => Promise<number>;
  saveMeta: (m: { finished: boolean; scan_cursor: string | null; scan_started_at: string | null; count: number | null; error: string | null }) => Promise<void>;
};

export type SnapshotResult = { finished: boolean; processed: number; total: number | null; removed: number; pages: number; error: string | null };

export async function runListingsSnapshot(d: SnapshotDeps): Promise<SnapshotResult> {
  const now = d.now ?? Date.now;
  const t0 = now();
  const meta = await d.loadMeta();
  const resumable = !!meta?.scan_started_at && !!meta.scan_cursor && now() - Date.parse(meta.scan_started_at) < RESTART_AFTER_MS;
  const startedAt = resumable ? (meta!.scan_started_at as string) : new Date(now()).toISOString();
  let cursor: string | null = resumable ? (meta!.scan_cursor as string) : null;
  let processed = 0;
  let pages = 0;
  let finished = false;
  let error: string | null = null;

  try {
    // Zawsze robimy co najmniej jedną stronę, potem dopóki mieścimy się w budżecie.
    do {
      const { items, nextCursor } = await d.fetchPage(cursor);
      const seen = new Set<string>();
      const rows: ListingRow[] = [];
      for (const it of items) {
        const row = d.mapItem(it, startedAt);
        if (!row || seen.has(row.external_id)) continue; // jedna operacja upsert nie może mieć dwóch wierszy o tym samym kluczu
        seen.add(row.external_id);
        rows.push(row);
      }
      if (rows.length > 0) await d.saveRows(rows);
      processed += rows.length;
      pages += 1;
      cursor = nextCursor;
      if (cursor === null) {
        finished = true;
        break;
      }
    } while (now() - t0 < d.budgetMs);
  } catch (e: any) {
    error = e?.message || "Błąd synchronizacji listingów.";
  }

  let total: number | null = null;
  let removed = 0;
  if (finished) {
    total = await d.countSnapshot(startedAt);
    if (total > 0) removed = await d.deleteOlderThan(startedAt);
    await d.saveMeta({ finished: true, scan_cursor: null, scan_started_at: null, count: total, error: null });
  } else {
    // Postęp zostaje (kursor), nawet gdy przebieg skończył się błędem — następny przebieg wznowi od tego miejsca.
    await d.saveMeta({ finished: false, scan_cursor: cursor, scan_started_at: cursor !== null ? startedAt : null, count: null, error });
  }
  return { finished, processed, total, removed, pages, error };
}
