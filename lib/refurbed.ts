// Klient API sprzedawcy refurbed (https://refurbed.notion.site/refurbed-API-7be4e188412d4ea2bd35ef339dab9e3e,
// definicja: gitlab.com/refurbed-community/public-apis). Wszystkie wywołania to POST z JSON-em, a token idzie
// w nagłówku "Authorization: Plain <token>". Limit: 10 zapytań na sekundę (429 -> ponawiamy po chwili).

import { scanOrders } from "./scanOrders";

export const REFURBED_BASE_URL = "https://api.refurbed.com";
const PAGE_LIMIT = 100; // maksimum wg dokumentacji

export type RefurbedClient = {
  token: string;
  userAgent: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch; // do testów
  timeoutMs?: number;
};

// OrderService/ListOrders — paginacja kursorem: starting_after = id ostatniego rekordu, has_more mówi, czy jest dalej.
export async function refurbedListOrders(
  c: RefurbedClient,
  opts: { filter?: object; startAfter?: string | null }
): Promise<{ orders: any[]; hasMore: boolean }> {
  const doFetch = c.fetchImpl ?? fetch;
  const body = {
    pagination: { limit: PAGE_LIMIT, ...(opts.startAfter ? { starting_after: opts.startAfter } : {}) },
    // Sortowanie po ID rosnąco, bo kursor to klucz główny — dzięki temu nowe zamówienia trafiają na koniec listy.
    sort: { order: "ASC", by: "ID" },
    ...(opts.filter ? { filter: opts.filter } : {}),
  };

  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(`${c.baseUrl ?? REFURBED_BASE_URL}/refb.merchant.v1.OrderService/ListOrders`, {
      method: "POST",
      headers: {
        // Tolerujemy token wklejony razem z przedrostkiem "Plain " (tak wygląda wartość nagłówka np. w Make.com).
        Authorization: `Plain ${c.token.trim().replace(/^Plain\s+/i, "")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": c.userAgent,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(c.timeoutMs ?? 30_000),
    });
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1100));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Refurbed zwrócił błąd (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return { orders: (data.orders || []) as any[], hasMore: !!data.has_more };
  }
}

// Przechodzi wszystkie strony dla danego filtra (z budżetem czasu) i przekazuje je do save. Zwraca kursor
// (id ostatniego pobranego zamówienia), od którego można wznowić, gdy budżet się skończył (finished = false).
export async function refurbedSweep(
  c: RefurbedClient,
  opts: {
    filter?: object;
    startAfter?: string | null;
    budgetMs: number;
    save: (orders: any[]) => Promise<void>;
    now?: () => number;
  }
) {
  let cursor: string | null = opts.startAfter ?? null;
  const result = await scanOrders({
    startPage: 1,
    budgetMs: opts.budgetMs,
    maxPages: 100_000,
    now: opts.now,
    fetchPage: async () => {
      const { orders, hasMore } = await refurbedListOrders(c, { filter: opts.filter, startAfter: cursor });
      if (orders.length > 0) cursor = String(orders[orders.length - 1].id);
      return { results: orders, hasNext: hasMore };
    },
    save: opts.save,
  });
  return { finished: result.finished, processed: result.processed, cursor };
}
