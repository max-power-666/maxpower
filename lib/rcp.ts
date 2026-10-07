// RCP — rejestracja czasu pracy (06.10.2026): czysta logika liczenia czasu z odcinków (patrz supabase/rcp.sql). Dni liczymy wg czasu polskiego (Europe/Warsaw).
// Do czasu pracy liczą się "praca" i "wyjście służbowe"; "przerwa" i "wyjście prywatne" nie.

import { warsawMidnightUtcMs } from "./points";

export const RCP_AREAS = ["Serwis", "Testy", "Trade-in", "Magazyn", "Zamówienia", "Inne"] as const;
export type RcpKind = "praca" | "przerwa" | "wyjscie_prywatne" | "wyjscie_sluzbowe";
export const RCP_KIND_LABEL: Record<RcpKind, string> = {
  praca: "Praca",
  przerwa: "Przerwa",
  wyjscie_prywatne: "Wyjście prywatne",
  wyjscie_sluzbowe: "Wyjście służbowe",
};
export const COUNTS_AS_WORK: RcpKind[] = ["praca", "wyjscie_sluzbowe"];

export type RcpSegment = {
  id: number;
  user_id: string | null;
  user_email: string;
  kind: RcpKind;
  area: string | null;
  started_at: string;
  ended_at: string | null;
  needs_review: boolean;
  source: string;
  note: string | null;
  history?: { at: string; by_email: string | null; reason: string; changes?: { field: string; from: string | null; to: string | null }[] }[];
};

export const warsawDay = (ms: number): string => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date(ms)); // YYYY-MM-DD

const nextDay = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};
export const dayStartMs = (day: string): number => {
  const [y, m, d] = day.split("-").map(Number);
  return warsawMidnightUtcMs(y, m, d);
};

// Dzieli odcinek na kawałki po dobach polskich (odcinek może przekraczać północ — np. korekta Managera). Trwający odcinek kończy się na `nowMs`.
export function splitByDay(startMs: number, endMs: number): { day: string; ms: number }[] {
  const out: { day: string; ms: number }[] = [];
  if (!(endMs > startMs)) return out;
  let day = warsawDay(startMs);
  let cursor = startMs;
  for (let guard = 0; guard < 400 && cursor < endMs; guard++) {
    const boundary = dayStartMs(nextDay(day));
    const to = Math.min(endMs, boundary);
    out.push({ day, ms: to - cursor });
    cursor = to;
    day = nextDay(day);
  }
  return out;
}

export type DaySummary = {
  day: string;
  workMs: number; // praca + wyjście służbowe
  breakMs: number;
  privateMs: number;
  firstStartMs: number | null; // pierwszy początek odcinka w tym dniu
  lastEndMs: number | null; // koniec ostatniego odcinka (null, gdy trwa)
  open: boolean;
  review: boolean;
  areaMs: Record<string, number>; // czas pracy wg obszaru
};

export function summarizeDays(segments: RcpSegment[], nowMs: number): Map<string, DaySummary> {
  const days = new Map<string, DaySummary>();
  const get = (day: string): DaySummary => {
    let d = days.get(day);
    if (!d) days.set(day, (d = { day, workMs: 0, breakMs: 0, privateMs: 0, firstStartMs: null, lastEndMs: 0, open: false, review: false, areaMs: {} }));
    return d;
  };
  for (const s of segments) {
    const start = Date.parse(s.started_at);
    const isOpen = !s.ended_at;
    const end = isOpen ? nowMs : Date.parse(s.ended_at!);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const startDay = get(warsawDay(start));
    startDay.firstStartMs = startDay.firstStartMs === null ? start : Math.min(startDay.firstStartMs, start);
    if (s.needs_review) startDay.review = true;
    for (const piece of splitByDay(start, end)) {
      const d = get(piece.day);
      if (COUNTS_AS_WORK.includes(s.kind)) {
        d.workMs += piece.ms;
        const a = s.area || "Inne";
        d.areaMs[a] = (d.areaMs[a] || 0) + piece.ms;
      } else if (s.kind === "przerwa") d.breakMs += piece.ms;
      else d.privateMs += piece.ms;
      if (isOpen) d.open = true;
      else d.lastEndMs = Math.max(d.lastEndMs ?? 0, Math.min(end, dayStartMs(nextDay(piece.day))));
    }
  }
  for (const d of days.values()) if (d.open) d.lastEndMs = null;
  return days;
}

export const totalWorkMs = (days: Map<string, DaySummary>) => Array.from(days.values()).reduce((n, d) => n + d.workMs, 0);

// 8 h 05 min -> "8:05"; ujemne wartości z minusem.
export function fmtHm(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const min = Math.round(Math.abs(ms) / 60000);
  return `${sign}${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}
export const fmtClock = (ms: number | null): string => (ms === null ? "—" : new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" }).format(new Date(ms)));

// Adres IP komputera jest dozwolony, gdy lista jest pusta (brak ograniczenia) albo zawiera ten adres (z normalizacją ::ffff:1.2.3.4 -> 1.2.3.4).
export const normalizeIp = (ip: string | null | undefined): string => (ip || "").trim().toLowerCase().replace(/^::ffff:/, "");
export function isIpAllowed(ip: string | null | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const n = normalizeIp(ip);
  return !!n && allowed.some((a) => normalizeIp(a) === n);
}
export const isValidIp = (s: string): boolean => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) ? s.split(".").every((x) => Number(x) <= 255) : /^[0-9a-f:]+$/i.test(s) && s.includes(":");

// Miesięczna ewidencja jako CSV (średnik, UTF-8 z BOM — Excel w polskich ustawieniach): wiersz na osobę, kolumny dni miesiąca + suma.
export function ewidencjaCsv(month: string, daysInMonth: number, rows: { name: string; byDay: Map<string, DaySummary>; absenceCode?: (day: string) => string }[]): string {
  const head = ["Pracownik", ...Array.from({ length: daysInMonth }, (_, i) => String(i + 1)), "Razem (h:mm)"];
  const lines = [head.join(";")];
  for (const r of rows) {
    const cells = Array.from({ length: daysInMonth }, (_, i) => {
      const d = r.byDay.get(`${month}-${String(i + 1).padStart(2, "0")}`);
      return d && d.workMs > 0 ? fmtHm(d.workMs) : r.absenceCode?.(`${month}-${String(i + 1).padStart(2, "0")}`) ?? "";
    });
    lines.push([`"${r.name.replace(/"/g, '""')}"`, ...cells, fmtHm(totalWorkMs(r.byDay))].join(";"));
  }
  return "﻿" + lines.join("\r\n");
}
