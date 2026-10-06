// Rynek bez konkurencji (06.10.2026, na prośbę właściciela): we Włoszech bywa, że nie ma konkurencji i "cena do wygrania" jest absurdalnie niska
// (np. 48 € za konsolę wartą ok. 400 €) — nikt takiej konsoli nie sprzeda za tyle, więc zamiast kupować po śmiesznej cenie ustawiamy tam cenę o 15% niższą
// od NAJWYŻSZEJ ceny ustawionej na pozostałych rynkach (czyli, przy cenie max, od ceny max). Czysta logika, wspólna dla biddera (serwer) i listy cen (UI).

export const NO_COMPETITION_MARKETS = ["IT"] as const; // rynki, na których stosujemy regułę (zmiana listy = jedno miejsce)
export const NO_COMPETITION_THRESHOLD = 0.55; // "brak konkurencji": cena do wygrania niższa niż 55% najwyższej ceny z pozostałych rynków (było 50% — XSS-512-C-1M: 76 € przy 151,65 € to 50,1%)
export const NO_COMPETITION_DISCOUNT = 0.15; // cena = (1 − 0,15) × najwyższa cena z pozostałych rynków

const r2 = (n: number) => Math.round(n * 100) / 100;

// Referencja: najwyższa cena (ustawiona/obliczona) na rynkach spoza listy reguły; null, gdy żaden inny rynek nie ma ceny.
export function noCompetitionReference(prices: Record<string, number | undefined | null>, markets: readonly string[]): number | null {
  const others = markets.filter((m) => !(NO_COMPETITION_MARKETS as readonly string[]).includes(m)).map((m) => Number(prices[m])).filter((x) => Number.isFinite(x) && x > 0);
  return others.length ? Math.max(...others) : null;
}

// Czy na rynku `market` obowiązuje reguła przy danej cenie do wygrania i cenach z pozostałych rynków.
export function isNoCompetition(market: string, ptw: number | null | undefined, reference: number | null): boolean {
  return (
    (NO_COMPETITION_MARKETS as readonly string[]).includes(market) &&
    reference !== null &&
    typeof ptw === "number" &&
    Number.isFinite(ptw) &&
    ptw < reference * NO_COMPETITION_THRESHOLD
  );
}

// Cena na rynku bez konkurencji: 85% referencji, nigdy powyżej ceny max SKU (referencja <= max, więc to tylko zabezpieczenie).
export function noCompetitionPrice(reference: number, maxPrice: number | null): number {
  const p = reference * (1 - NO_COMPETITION_DISCOUNT);
  return r2(maxPrice !== null ? Math.min(p, maxPrice) : p);
}

// Nakłada regułę na ceny obliczone `min(ptw, max)`: zwraca nowe ceny i listę rynków, na których zadziałała.
export function applyNoCompetition<M extends string>(
  prices: Partial<Record<M, number>>,
  ptws: Partial<Record<M, number>>,
  markets: readonly M[],
  maxPrice: number | null
): { prices: Partial<Record<M, number>>; applied: M[]; reference: number | null } {
  const reference = noCompetitionReference(prices as Record<string, number | undefined>, markets);
  const out = { ...prices };
  const applied: M[] = [];
  for (const m of markets) {
    if (isNoCompetition(m, ptws[m], reference)) {
      out[m] = noCompetitionPrice(reference!, maxPrice);
      applied.push(m);
    }
  }
  return { prices: out, applied, reference };
}
