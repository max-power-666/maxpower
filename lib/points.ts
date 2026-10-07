// Podsumowanie punktacji pracowników (zakładka Punktacja, 06.10.2026) — czysta logika: miesiące wg czasu polskiego i agregacja punktów z trzech modułów.
// Zasady wg Regulaminu premiowania (patrz CLAUDE.md): punkty tylko za PRAWIDŁOWO zakończony proces (§2 ust. 4), każda paczka/urządzenie raz (data zaliczenia =
// points_awarded_at, nie przesuwa się przy zmianie statusu), punkty z różnych obszarów sumują się w jeden wynik miesięczny (§2 ust. 6).

import { warsawYm } from "./warsawDate";

export type PointsArea = "service" | "tests" | "tradein";
export const POINTS_AREAS: { key: PointsArea; label: string; unit: string }[] = [
  { key: "service", label: "Serwis", unit: "napraw" },
  { key: "tests", label: "Testy", unit: "testów" },
  { key: "tradein", label: "Trade-in", unit: "paczek" },
];

export type AreaTotals = { count: number; points: number };
export type EmployeeMonth = Record<PointsArea, AreaTotals> & { serviceByTask: Record<string, AreaTotals> };
export const emptyMonth = (): EmployeeMonth => ({ service: { count: 0, points: 0 }, tests: { count: 0, points: 0 }, tradein: { count: 0, points: 0 }, serviceByTask: {} });
export const monthTotal = (m: EmployeeMonth) => m.service.points + m.tests.points + m.tradein.points;
export const monthCount = (m: EmployeeMonth) => m.service.count + m.tests.count + m.tradein.count;

// Offset strefy Europe/Warsaw (w minutach) w danej chwili UTC.
function warsawOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs) / 60000;
}

// Chwila UTC (ms) polskiej północy rozpoczynającej dzień y-m-d.
export function warsawMidnightUtcMs(y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - warsawOffsetMinutes(guess) * 60000;
  return guess - warsawOffsetMinutes(first) * 60000;
}

export const monthKeyOf = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return warsawYm(t); // YYYY-MM (z części, nie z locale — patrz lib/warsawDate.ts)
};

// Zakres miesiąca kalendarzowego wg czasu polskiego: [from, to) jako znaczniki ISO (UTC).
export function monthRange(key: string): { from: string; to: string } {
  const [y, m] = key.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { from: new Date(warsawMidnightUtcMs(y, m, 1)).toISOString(), to: new Date(warsawMidnightUtcMs(ny, nm, 1)).toISOString() };
}

// Ostatnie n miesięcy kończąc na bieżącym (wg czasu polskiego), od najstarszego do bieżącego.
export function lastMonths(n: number, now: Date = new Date()): string[] {
  const cur = monthKeyOf(now.toISOString())!;
  let [y, m] = cur.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

export type PointRow = { email: string | null; at: string | null; points: number | string | null; task?: string | null };

// Agregacja punktów jednego obszaru do struktury pracownik -> miesiąc. Wiersze poza listą miesięcy są pomijane.
export function addAreaRows(acc: Map<string, Record<string, EmployeeMonth>>, area: PointsArea, rows: PointRow[], months: string[]) {
  for (const r of rows) {
    const key = monthKeyOf(r.at);
    if (!key || !months.includes(key)) continue;
    const email = (r.email || "—").trim().toLowerCase() || "—";
    const byMonth = acc.get(email) ?? {};
    const m = byMonth[key] ?? emptyMonth();
    const pts = Number(r.points) || 0;
    m[area].count += 1;
    m[area].points += pts;
    if (area === "service" && r.task) {
      const t = m.serviceByTask[r.task] ?? { count: 0, points: 0 };
      t.count += 1;
      t.points += pts;
      m.serviceByTask[r.task] = t;
    }
    byMonth[key] = m;
    acc.set(email, byMonth);
  }
}
