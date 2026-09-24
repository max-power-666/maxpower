// Stronicowane pobieranie zamówień z Back Marketu z budżetem czasu i kursorem.
//
// Dlaczego osobna funkcja: wcześniej synchronizacja miała twardy limit stron i po cichu kończyła się
// na 2000 zamówieniach (200 stron x 10), po czym oznaczała pobieranie jako ukończone — zamówienia
// nowsze niż ~15 lutego nigdy się nie pobrały. Tu "niedokończone" jest osobnym, jawnym wynikiem:
// wywołujący zapisuje kursor (nextPage) i kontynuuje w kolejnym wywołaniu, zamiast uznać skan za gotowy.

export type ScanPage = { results: any[]; hasNext: boolean; count?: number };

export type ScanResult = {
  finished: boolean; // true tylko gdy API samo zakończyło listę (brak następnej strony / pusta strona)
  nextPage: number; // od tej strony trzeba kontynuować, gdy finished = false
  processed: number;
  apiCount: number | null; // łączna liczba zamówień, którą deklaruje API (pole count)
};

export async function scanOrders(opts: {
  startPage: number;
  budgetMs: number; // po jego przekroczeniu nie zaczynamy kolejnej strony
  maxPages: number; // bezpiecznik bezwzględny; jego trafienie NIE oznacza ukończenia
  batchPages?: number; // co ile stron zapisywać do bazy (mniej zapytań)
  now?: () => number;
  fetchPage: (page: number) => Promise<ScanPage>;
  save: (rows: any[]) => Promise<void>;
}): Promise<ScanResult> {
  const now = opts.now ?? Date.now;
  const batchPages = opts.batchPages ?? 10;
  const t0 = now();

  let page = opts.startPage;
  let buffer: any[] = [];
  let pagesInBuffer = 0;
  let processed = 0;
  let apiCount: number | null = null;
  let finished = false;

  while (page <= opts.maxPages && now() - t0 <= opts.budgetMs) {
    const res = await opts.fetchPage(page);
    if (apiCount === null && typeof res.count === "number") apiCount = res.count;

    buffer.push(...res.results);
    processed += res.results.length;
    pagesInBuffer += 1;
    page += 1;

    if (res.results.length === 0 || !res.hasNext) {
      finished = true;
      break;
    }
    if (pagesInBuffer >= batchPages) {
      await opts.save(buffer);
      buffer = [];
      pagesInBuffer = 0;
    }
  }

  if (buffer.length > 0) await opts.save(buffer);
  return { finished, nextPage: page, processed, apiCount };
}
