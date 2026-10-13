// Podsumowanie miesięcznych kosztów wysyłki (13.10.2026, zakładka Wysyłka, pod listą "Nadane przesyłki").
// Liczymy z tabeli shipments: tylko przesyłki PRODUKCYJNE (testowe DHL Express nie są prawdziwe) i NIEANULOWANE. Koszt = cena z wyceny zapisana przy nadaniu
// (shipments.charges, netto) w PLN; przesyłka bez ceny w PLN (np. sprzed poprawki zapisu ceny, albo Erli Paczkomat — rozlicza Erli) nie wchodzi do sumy ani do średniej,
// tylko do licznika "bez ceny" — średnia to koszt łączny ÷ liczba przesyłek Z CENĄ. Miesiąc wg czasu polskiego (warsawYm), jak reszta aplikacji.
import { warsawYm } from "./warsawDate";

export type ShipmentCostRow = {
  created_at: string;
  carrier: string;
  cancelled_at: string | null;
  environment: string;
  charges: unknown;
};

// Cena przesyłki w PLN: najpierw koszt rozliczeniowy (BILLC), jeśli jest w PLN; potem lokalny (PULCL, u DHL Express waluta kraju nadania); inaczej null.
export function shipmentCostPln(charges: unknown): number | null {
  if (!Array.isArray(charges)) return null; // Erli i stare wpisy: inny kształt albo brak
  const pln = (c: any) => c && typeof c === "object" && String(c.priceCurrency ?? "").toUpperCase() === "PLN" && Number.isFinite(Number(c.price));
  const hit = charges.find((c: any) => c?.currencyType === "BILLC" && pln(c)) ?? charges.find((c: any) => c?.currencyType === "PULCL" && pln(c)) ?? charges.find(pln);
  return hit ? Number(hit.price) : null;
}

export type MonthCost = {
  month: string; // YYYY-MM
  shipments: number; // wszystkie nadane (bez anulowanych i testowych)
  priced: number; // z ceną w PLN
  total: number; // koszt łączny PLN netto
  average: number | null; // total / priced
  byCarrier: Record<string, { shipments: number; priced: number; total: number }>;
};

export function summarizeShippingCosts(rows: ShipmentCostRow[]): { months: MonthCost[]; all: MonthCost } {
  const by = new Map<string, MonthCost>();
  const mk = (month: string): MonthCost => ({ month, shipments: 0, priced: 0, total: 0, average: null, byCarrier: {} });
  const all = mk("all");
  const add = (m: MonthCost, carrier: string, cost: number | null) => {
    m.shipments++;
    const c = (m.byCarrier[carrier] ??= { shipments: 0, priced: 0, total: 0 });
    c.shipments++;
    if (cost !== null) {
      m.priced++;
      m.total += cost;
      c.priced++;
      c.total += cost;
    }
  };
  for (const r of rows) {
    if (r.cancelled_at || r.environment !== "production") continue;
    const month = warsawYm(new Date(r.created_at).getTime());
    let m = by.get(month);
    if (!m) by.set(month, (m = mk(month)));
    const cost = shipmentCostPln(r.charges);
    add(m, r.carrier, cost);
    add(all, r.carrier, cost);
  }
  const fin = (m: MonthCost) => {
    m.total = Math.round(m.total * 100) / 100;
    m.average = m.priced > 0 ? Math.round((m.total / m.priced) * 100) / 100 : null;
    for (const c of Object.values(m.byCarrier)) c.total = Math.round(c.total * 100) / 100;
    return m;
  };
  const months = [...by.values()].sort((a, b) => (a.month < b.month ? 1 : -1)).map(fin);
  return { months, all: fin(all) };
}
