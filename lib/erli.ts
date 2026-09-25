// Klient API sprzedawcy Erli (https://erli.pl/svc/shop-api/doc/, definicja: /doc/swagger.json).
// Autoryzacja: "Authorization: Bearer <klucz API>" (klucz jest w panelu sklepu: Metoda integracji > Własna integracja
// po API). Zalecany jest sensowny User-Agent. Przy przekroczeniu limitu serwer odpowiada 429.

import { scanOrders } from "./scanOrders";

export const ERLI_BASE_URL = "https://erli.pl/svc/shop-api";
const PAGE_LIMIT = 200; // maksimum wg swaggera (domyślnie 50)

export type ErliClient = {
  apiKey: string;
  userAgent: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch; // do testów
  timeoutMs?: number;
};

// POST /orders/_search. Zwraca zwykłą tablicę zamówień (bez has_more) — koniec listy to strona krótsza niż limit.
// Sortujemy po `updated` rosnąco, a `after` przyjmuje datę albo pole `cursor` ostatniego zamówienia (data + id, więc
// zamówienia o tej samej dacie nie giną). Dzięki temu ten sam mechanizm łapie i nowe zamówienia, i zmiany w starych.
export async function erliSearchOrders(c: ErliClient, opts: { after?: string | null }): Promise<any[]> {
  const doFetch = c.fetchImpl ?? fetch;
  const body = {
    pagination: { sortField: "updated", order: "ASC", limit: PAGE_LIMIT, ...(opts.after ? { after: opts.after } : {}) },
  };

  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(`${c.baseUrl ?? ERLI_BASE_URL}/orders/_search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.apiKey.trim().replace(/^Bearer\s+/i, "")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": c.userAgent,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(c.timeoutMs ?? 30_000),
    });
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Erli zwróciło błąd (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }
}

// Przechodzi kolejne strony od kursora `after` (z budżetem czasu) i przekazuje je do save. Zwraca kursor ostatniego
// pobranego zamówienia — od niego trzeba wznowić (zarówno gdy skończył się budżet, jak i przy następnej synchronizacji).
export async function erliSweep(
  c: ErliClient,
  opts: { after?: string | null; budgetMs: number; save: (orders: any[]) => Promise<void>; now?: () => number }
) {
  let cursor: string | null = opts.after ?? null;
  const result = await scanOrders({
    startPage: 1,
    budgetMs: opts.budgetMs,
    maxPages: 100_000,
    now: opts.now,
    fetchPage: async () => {
      const orders = await erliSearchOrders(c, { after: cursor });
      const last = orders[orders.length - 1];
      const next: string | null = last ? String(last.cursor ?? last.updated ?? "") || null : null;
      // Bez postępu kursora (brak pola albo ta sama wartość) kończymy, zamiast w kółko pobierać tę samą stronę.
      const progressed = !!next && next !== cursor;
      if (progressed) cursor = next;
      return { results: orders, hasNext: orders.length >= PAGE_LIMIT && progressed };
    },
    save: opts.save,
  });
  return { finished: result.finished, processed: result.processed, cursor };
}
