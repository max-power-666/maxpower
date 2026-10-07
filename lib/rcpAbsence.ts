// Nieobecności w RCP (06.10.2026): rodzaje, statusy i liczenie wykorzystania limitu urlopowego. Czysta logika (testowana osobno); zapis robi serwer (api/rcp/absence).

import { workdaysBetween } from "./holidays";

export type AbsenceKind = "urlop_wypoczynkowy" | "urlop_na_zadanie" | "urlop_okolicznosciowy" | "urlop_bezplatny" | "l4" | "inne";
export type AbsenceStatus = "oczekuje" | "zaakceptowany" | "odrzucony" | "wycofany" | "anulowany";

export const ABSENCE_KINDS: { key: AbsenceKind; label: string; short: string; countsAgainstLimit: boolean }[] = [
  { key: "urlop_wypoczynkowy", label: "Urlop wypoczynkowy", short: "U", countsAgainstLimit: true },
  { key: "urlop_na_zadanie", label: "Urlop na żądanie", short: "UŻ", countsAgainstLimit: true },
  { key: "urlop_okolicznosciowy", label: "Urlop okolicznościowy", short: "UO", countsAgainstLimit: false },
  { key: "urlop_bezplatny", label: "Urlop bezpłatny", short: "UB", countsAgainstLimit: false },
  { key: "l4", label: "Zwolnienie lekarskie (L4)", short: "L4", countsAgainstLimit: false },
  { key: "inne", label: "Inna nieobecność", short: "N", countsAgainstLimit: false },
];
export const absenceKind = (k: string) => ABSENCE_KINDS.find((x) => x.key === k);
export const ABSENCE_STATUS_LABEL: Record<AbsenceStatus, string> = {
  oczekuje: "Oczekuje",
  zaakceptowany: "Zaakceptowany",
  odrzucony: "Odrzucony",
  wycofany: "Wycofany",
  anulowany: "Anulowany",
};
export const ACTIVE_STATUSES: AbsenceStatus[] = ["oczekuje", "zaakceptowany"];

export type Absence = {
  id: number;
  user_id: string | null;
  user_email: string;
  kind: AbsenceKind;
  date_from: string;
  date_to: string;
  workdays: number;
  note: string | null;
  status: AbsenceStatus;
  decided_by_email: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_by_email: string | null;
  created_at: string;
};

// Wykorzystanie limitu w roku: zaakceptowane + oczekujące urlopy zaliczane do limitu (wypoczynkowy, na żądanie); dni robocze tylko z danego roku.
export function leaveUsage(absences: Pick<Absence, "kind" | "status" | "date_from" | "date_to">[], year: number): { used: number; pending: number } {
  let used = 0;
  let pending = 0;
  for (const a of absences) {
    if (!absenceKind(a.kind)?.countsAgainstLimit) continue;
    const n = workdaysBetween(a.date_from, a.date_to, year);
    if (a.status === "zaakceptowany") used += n;
    else if (a.status === "oczekuje") pending += n;
  }
  return { used, pending };
}

export const datesOverlap = (a: { date_from: string; date_to: string }, b: { date_from: string; date_to: string }) => a.date_from <= b.date_to && b.date_from <= a.date_to;

// Dzień kalendarzowy -> nieobecność zaakceptowana tej osoby (do ewidencji).
export function absenceOnDay(absences: Pick<Absence, "kind" | "status" | "date_from" | "date_to">[], day: string) {
  return absences.find((a) => a.status === "zaakceptowany" && a.date_from <= day && day <= a.date_to) ?? null;
}
