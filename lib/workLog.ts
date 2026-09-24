// Wspólne dla rejestrów pracy z Regulaminu premiowania (Serwis, Trade-in):
// interwały podsumowania punktacji i czas trwania czynności (tylko informacyjny).

export type Interval = "today" | "week" | "month";

export const INTERVALS: { key: Interval; label: string }[] = [
  { key: "today", label: "Dziś" },
  { key: "week", label: "Ostatnie 7 dni" },
  { key: "month", label: "Ostatnie 30 dni" },
];

export function rangeStart(interval: Interval): string {
  const d = new Date();
  if (interval === "today") {
    d.setHours(0, 0, 0, 0);
  } else if (interval === "week") {
    d.setDate(d.getDate() - 7);
  } else {
    d.setDate(d.getDate() - 30);
  }
  return d.toISOString();
}

export function fmtDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return "w trakcie";
  const ms = Date.parse(endIso) - Date.parse(startIso);
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} godz. ${m} min` : `${m} min`;
}
