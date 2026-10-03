// Kursy walut NBP (zakładka NBP, 01.10.2026) — tabela A (kursy średnie), api.nbp.pl, bez klucza/autoryzacji.
// Dziś potrzebne do przeliczania wartości zamówień z różnych kanałów na PLN na Przeglądzie (Back Market/
// refurbed/Octopia/Amazon głównie EUR, część refurbed w DKK, Allegro/Erli w PLN — sprawdzone na żywych danych,
// 01.10.2026), ale to osobna, reużywalna zakładka — przydadzą się gdzie indziej.

export const NBP_CURRENCIES = ["EUR", "DKK"] as const;
export type NbpCurrency = (typeof NBP_CURRENCIES)[number];

export type NbpRate = { currency: string; rateDate: string; mid: number };

// Pobiera kursy tabeli A dla jednej waluty z przedziału dat (włącznie z brzegami). NBP pomija dni bez notowania
// (weekendy/święta) — zwraca tylko dni robocze z tego zakresu. Gdy w całym zakresie nie ma ANI JEDNEGO dnia
// roboczego, NBP odpowiada 404 — traktujemy to jako "brak danych", nie błąd.
export async function fetchNbpRateRange(currency: string, dateFrom: string, dateTo: string): Promise<NbpRate[]> {
  const url = `https://api.nbp.pl/api/exchangerates/rates/A/${encodeURIComponent(currency)}/${dateFrom}/${dateTo}/?format=json`;
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`NBP zwróciło błąd (${res.status}) dla ${currency} ${dateFrom}..${dateTo}`);
  const data = (await res.json()) as { rates: { effectiveDate: string; mid: number }[] };
  return (data.rates || []).map((r) => ({ currency, rateDate: r.effectiveDate, mid: r.mid }));
}

// Kurs do przeliczenia zamówienia z dnia `date` — polska zasada księgowa: kurs z OSTATNIEGO dnia roboczego
// PRZED dniem transakcji, nigdy z samego dnia transakcji (zgłoszone przez właściciela 01.10.2026). `rates` to
// posortowane (albo dowolnie) kursy jednej waluty; zwraca najpóźniejszą datę ŚCIŚLE mniejszą niż `date`, albo
// null, gdy żadnej takiej nie ma (np. brak historii sprzed zakresu synchronizacji).
export function rateBeforeDate(rates: NbpRate[], date: string): number | null {
  let best: NbpRate | null = null;
  for (const r of rates) {
    if (r.rateDate < date && (!best || r.rateDate > best.rateDate)) best = r;
  }
  return best ? best.mid : null;
}

// To samo co rateBeforeDate, ale zwraca też DATĘ notowania użytego kursu (do wyjaśnień w UI: "kurs 4,2520 z 09.09").
export function rateInfoBeforeDate(rates: NbpRate[], date: string): { mid: number; rateDate: string } | null {
  let best: NbpRate | null = null;
  for (const r of rates) {
    if (r.rateDate < date && (!best || r.rateDate > best.rateDate)) best = r;
  }
  return best ? { mid: best.mid, rateDate: best.rateDate } : null;
}

// Przelicza kwotę na PLN. PLN (albo waluta nieznana/pusta — zakładamy PLN, ten sam fallback co reszta apki,
// np. fmtMoney w SalesOrdersHub.tsx) zostaje bez zmian. Zwraca null, gdy brak kursu dla danej daty (np. zamówienie
// sprzed zakresu zsynchronizowanych kursów) — wywołujący decyduje, co z tym zrobić (pominąć z sumy, pokazać "—").
export function convertToPln(amount: number, currency: string | null | undefined, date: string, ratesByCurrency: Record<string, NbpRate[]>): number | null {
  const cur = (currency || "PLN").toUpperCase();
  if (cur === "PLN") return amount;
  const rate = rateBeforeDate(ratesByCurrency[cur] || [], date);
  if (rate === null) return null;
  return amount * rate;
}

// Data kalendarzowa (YYYY-MM-DD) danej chwili w strefie Europe/Warsaw — do kursów liczonych od dnia WYPŁATY (Trade-in): wypłata o 00:30 czasu polskiego to
// w UTC jeszcze poprzedni dzień, a polska zasada "kurs z dnia poprzedniego" liczy się od polskiej daty.
export function warsawDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
}
