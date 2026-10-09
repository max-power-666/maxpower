// Przypomnienia (09.10.2026): rodzaje powtarzania i liczenie następnego terminu. Daty to "YYYY-MM-DD" (kalendarz, bez godzin); "dziś" wg czasu polskiego (lib/warsawDate.ts).
export const RECURRENCES = [
  { key: "none", label: "Jednorazowe" },
  { key: "daily", label: "Codziennie" },
  { key: "weekly", label: "Co tydzień" },
  { key: "monthly", label: "Co miesiąc" },
  { key: "yearly", label: "Co rok" },
] as const;
export type Recurrence = (typeof RECURRENCES)[number]["key"];
export const RECURRENCE_LABEL = Object.fromEntries(RECURRENCES.map((r) => [r.key, r.label])) as Record<Recurrence, string>;

const parse = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return { y, m, d: day };
};
const fmt = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addDays = (d: string, n: number) => {
  const p = parse(d);
  return new Date(Date.UTC(p.y, p.m - 1, p.d + n)).toISOString().slice(0, 10);
};

// Jeden krok powtarzania od terminu `due` (miesiąc/rok z przycięciem dnia do długości miesiąca; anchorDay przywraca pierwotny dzień, gdy miesiąc jest dłuższy).
function step(due: string, rec: Recurrence, anchorDay: number | null): string {
  const p = parse(due);
  if (rec === "daily") return addDays(due, 1);
  if (rec === "weekly") return addDays(due, 7);
  const want = anchorDay ?? p.d;
  if (rec === "monthly") {
    const m = p.m === 12 ? 1 : p.m + 1;
    const y = p.m === 12 ? p.y + 1 : p.y;
    return fmt(y, m, Math.min(want, daysInMonth(y, m)));
  }
  if (rec === "yearly") return fmt(p.y + 1, p.m, Math.min(want, daysInMonth(p.y + 1, p.m)));
  return due;
}

// Następny termin PO dzisiejszym dniu (zaległe cykle są pomijane — "Zrobione" zamyka bieżący cykl, kolejne wystąpienie jest dopiero w przyszłości). Dla "none" zwraca null.
export function nextDueDate(due: string, rec: Recurrence, today: string, anchorDay: number | null = null): string | null {
  if (rec === "none") return null;
  let next = step(due, rec, anchorDay);
  for (let i = 0; i < 5000 && next <= today; i++) next = step(next, rec, anchorDay);
  return next;
}

// Ile dni po terminie (0 = termin dziś, >0 = zaległe, <0 = jeszcze nie nadszedł).
export function daysOverdue(due: string, today: string): number {
  const a = parse(due);
  const b = parse(today);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}
export const fmtDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
