// Dni wolne w Polsce (06.10.2026) — do liczenia dni roboczych we wnioskach urlopowych i oznaczania świąt w ewidencji RCP. Daty jako "YYYY-MM-DD" (kalendarz, bez stref czasowych).

// Wielkanoc (algorytm Meeusa/Jonesa/Butchera) — niedziela; z niej wynikają Poniedziałek Wielkanocny i Boże Ciało.
export function easterSunday(year: number): { m: number; d: number } {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const cache = new Map<number, Set<string>>();

// Święta ustawowo wolne od pracy: 1.01, 6.01, Wielkanoc (poniedziałek), 1.05, 3.05, Boże Ciało (Wielkanoc + 60 dni), 15.08, 1.11, 11.11, 24.12 (od 2025), 25.12, 26.12.
// Niedziele (Wielkanoc, Zielone Świątki) i tak są wolne, więc osobno ich nie listujemy.
export function plHolidays(year: number): Set<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const e = easterSunday(year);
  const easter = Date.UTC(year, e.m - 1, e.d);
  const p = (m: number, d: number) => `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const set = new Set<string>([p(1, 1), p(1, 6), ymd(easter + 86400000), p(5, 1), p(5, 3), ymd(easter + 60 * 86400000), p(8, 15), p(11, 1), p(11, 11), p(12, 25), p(12, 26)]);
  if (year >= 2025) set.add(p(12, 24));
  cache.set(year, set);
  return set;
}

export const isHoliday = (day: string): boolean => plHolidays(Number(day.slice(0, 4))).has(day);
export const isWeekend = (day: string): boolean => {
  const w = new Date(day + "T12:00:00Z").getUTCDay();
  return w === 0 || w === 6;
};
export const isWorkday = (day: string): boolean => !isWeekend(day) && !isHoliday(day);

const addDay = (day: string): string => ymd(Date.parse(day + "T00:00:00Z") + 86400000);

// Liczba dni roboczych (pn–pt poza świętami) w przedziale [from, to] włącznie; opcjonalnie tylko w danym roku (urlop na przełomie lat dzieli się na lata).
export function workdaysBetween(from: string, to: string, onlyYear?: number): number {
  if (!(from <= to)) return 0;
  let n = 0;
  for (let d = from, guard = 0; d <= to && guard < 800; d = addDay(d), guard++) {
    if (onlyYear !== undefined && Number(d.slice(0, 4)) !== onlyYear) continue;
    if (isWorkday(d)) n++;
  }
  return n;
}
