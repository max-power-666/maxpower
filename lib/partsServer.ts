import { fetchNbpRateRange } from "./nbp";

// Kurs NBP (tabela A) z ostatniego dnia roboczego PRZED datą dokumentu (zasada księgowa jak w całej aplikacji); PLN = 1;
// brak daty/kursu (np. waluta spoza tabeli A) = null — pracownik wpisze kurs ręcznie.
export async function nbpRateFor(currency: string, date: string | null): Promise<{ rate: number; rateDate: string | null } | null> {
  if (currency === "PLN") return { rate: 1, rateDate: null };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Z]{3}$/.test(currency)) return null;
  try {
    const from = new Date(Date.parse(date) - 12 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);
    const rates = await fetchNbpRateRange(currency, from, to);
    const best = rates.filter((r) => r.rateDate < date).sort((a, b) => b.rateDate.localeCompare(a.rateDate))[0];
    return best ? { rate: best.mid, rateDate: best.rateDate } : null;
  } catch {
    return null;
  }
}
