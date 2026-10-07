// "Cena PLN" w Bidderze (07.10.2026, na prośbę właściciela): ile złotych kosztuje zakup po cenie max = (cena max + 10% + 16,90 €) × bieżący kurs EUR z NBP.
// 10% to prowizja Back Market od ceny (liczona od ceny max), 16,90 € to stała opłata na zakup — obie stałe do zmiany w jednym miejscu.
export const BIDDER_FEE_PCT = 0.1;
export const BIDDER_FIXED_FEE_EUR = 16.9;

// Cena max w EUR + koszty -> PLN, zaokrąglone do groszy. null, gdy brak ceny max (<= 0 znaczy "brak ceny max") albo kursu.
export function bidderPricePln(maxEur: number | string | null | undefined, eurRate: number | null | undefined): number | null {
  const max = Number(maxEur);
  if (maxEur === null || maxEur === undefined || maxEur === "" || !Number.isFinite(max) || max <= 0) return null;
  if (!eurRate || !Number.isFinite(eurRate) || eurRate <= 0) return null;
  return Math.round((max * (1 + BIDDER_FEE_PCT) + BIDDER_FIXED_FEE_EUR) * eurRate * 100) / 100;
}
