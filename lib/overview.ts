// Statystyki sprzedaży na Przeglądzie (01.10.2026) — kafelki Dziś/30 dni, wykres dzienny i udział kanałów.
// Wzorowane na dashboardzie Apilo (zrzut ekranu od właściciela): "ostatnie 30 dni" to 30 PEŁNYCH dni PRZED
// dzisiaj (bez dzisiaj) — potwierdzone wprost na zrzucie: wykres kończy się dzień przed "dzisiaj", nie na nim.
// Bucketing po lokalnym dniu kalendarzowym (przeglądarka), ten sam duch co summarizeDays w lib/salesOrders.ts
// (tam tylko dziś/wczoraj, tu dowolna liczba dni) — serwer (app/api/overview/sales-stats) oddaje surowe, już
// przeliczone na PLN wiersze, a bucketing/strefę czasu liczy przeglądarka, żeby "dzisiaj" zawsze zgadzało się
// z zegarem osoby patrzącej na ekran, nie z serwerem (Vercel może działać w innej strefie).

export type OrderValueRow = { marketplace: string; order_date: string; value_pln: number };

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayStats(rows: OrderValueRow[], now: Date = new Date()): { count: number; value: number } {
  const key = localDayKey(now);
  let count = 0;
  let value = 0;
  for (const r of rows) {
    if (r.order_date && localDayKey(new Date(r.order_date)) === key) {
      count += 1;
      value += r.value_pln;
    }
  }
  return { count, value };
}

// Klucze dni (YYYY-MM-DD) dla "ostatnich `days` dni" — dzień wczorajszy do dnia sprzed `days` dni, BEZ dzisiaj.
export function lastNDaysKeys(now: Date, days: number): string[] {
  const keys: string[] = [];
  for (let i = days; i >= 1; i--) {
    keys.push(localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return keys;
}

export function rangeStats(rows: OrderValueRow[], now: Date, days: number): { count: number; value: number } {
  const keys = new Set(lastNDaysKeys(now, days));
  let count = 0;
  let value = 0;
  for (const r of rows) {
    if (r.order_date && keys.has(localDayKey(new Date(r.order_date)))) {
      count += 1;
      value += r.value_pln;
    }
  }
  return { count, value };
}

export type DailyBucket = { date: string; value: number; count: number };

export function dailySeries(rows: OrderValueRow[], now: Date, days: number): DailyBucket[] {
  const keys = lastNDaysKeys(now, days);
  const buckets = new Map<string, { value: number; count: number }>(keys.map((k) => [k, { value: 0, count: 0 }]));
  for (const r of rows) {
    if (!r.order_date) continue;
    const k = localDayKey(new Date(r.order_date));
    const b = buckets.get(k);
    if (b) {
      b.value += r.value_pln;
      b.count += 1;
    }
  }
  return keys.map((k) => ({ date: k, ...buckets.get(k)! }));
}

export type MarketplaceShare = { marketplace: string; value: number; pct: number };

export function marketplaceShares(rows: OrderValueRow[], now: Date, days: number): MarketplaceShare[] {
  const keys = new Set(lastNDaysKeys(now, days));
  const totals = new Map<string, number>();
  let grand = 0;
  for (const r of rows) {
    if (!r.order_date || !keys.has(localDayKey(new Date(r.order_date)))) continue;
    totals.set(r.marketplace, (totals.get(r.marketplace) || 0) + r.value_pln);
    grand += r.value_pln;
  }
  return Array.from(totals.entries())
    .map(([marketplace, value]) => ({ marketplace, value, pct: grand > 0 ? (value / grand) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}
