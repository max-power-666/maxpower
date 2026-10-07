"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { monthKeyOf, monthRange } from "@/lib/points";
import { MyLeave, Requests, usePendingCount } from "./RcpAbsences";
import { absenceKind, absenceOnDay, type Absence } from "@/lib/rcpAbsence";
import { isHoliday } from "@/lib/holidays";
import {
  RCP_AREAS, RCP_KIND_LABEL, dayStartMs, ewidencjaCsv, fmtClock, fmtHm, summarizeDays, totalWorkMs, warsawDay,
  type RcpKind, type RcpSegment,
} from "@/lib/rcp";

// Zakładka RCP (06.10.2026, etap 1). Pracownik: "Mój czas" (dziś, miesiąc, godziny, przerwy), widzi TYLKO swoje (RLS w bazie). Admin i Manager dodatkowo: "Teraz w pracy",
// "Ewidencja" miesięczna (z korektami i eksportem CSV) i ustawienia (adresy IP komputerów w firmie — zmienia tylko Admin). Rejestracja idzie z widżetu na lewym pasku.

type Sub = "mine" | "leave" | "requests" | "now" | "records" | "settings";
const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const DOW = ["nd", "pn", "wt", "śr", "cz", "pt", "so"];
const KIND_STYLE: Record<RcpKind, string> = {
  praca: "bg-tealsoft text-teal",
  administracja: "bg-[#e3ecf9] text-[#2a6bb5]",
  przerwa: "bg-ambersoft text-amber",
  wyjscie_prywatne: "bg-rustsoft text-rust",
  wyjscie_sluzbowe: "bg-[#e3ecf9] text-[#2a6bb5]",
};
const dowOf = (day: string) => DOW[new Date(day + "T12:00:00Z").getUTCDay()];
const shiftMonth = (key: string, delta: number) => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const daysIn = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const monthLabel = (key: string) => new Date(key + "-15T12:00:00Z").toLocaleDateString("pl-PL", { month: "long", year: "numeric", timeZone: "UTC" });

// Odcinki dotykające miesiąca (zaczęte przed jego końcem, niezakończone albo zakończone po jego początku); stronicowane po 1000.
async function fetchSegments(month: string, userId?: string): Promise<RcpSegment[]> {
  const { from, to } = monthRange(month);
  const out: RcpSegment[] = [];
  for (let offset = 0; ; offset += 1000) {
    let q = supabase.from("rcp_segments").select("*").lt("started_at", to).or(`ended_at.is.null,ended_at.gte.${from}`).order("started_at").range(offset, offset + 999);
    if (userId) q = q.eq("user_id", userId);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...((data as RcpSegment[]) || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export default function RcpView({ session, role, members }: { session: Session; role: string; members: MemberLite[] }) {
  const isManager = role === "Admin" || role === "Manager";
  const isAdmin = role === "Admin";
  const [sub, setSub] = useState<Sub>(isManager ? "now" : "mine");
  const pending = usePendingCount(isManager);
  return (
    <div>
      <div className="flex gap-2 mb-5 flex-wrap">
        {isManager && <button onClick={() => setSub("now")} className={pill(sub === "now")}>Teraz w pracy</button>}
        {isManager && <button onClick={() => setSub("records")} className={pill(sub === "records")}>Ewidencja</button>}
        <button onClick={() => setSub("mine")} className={pill(sub === "mine")}>Mój czas</button>
        <button onClick={() => setSub("leave")} className={pill(sub === "leave")}>Urlopy</button>
        {isManager && <button onClick={() => setSub("requests")} className={pill(sub === "requests")}>Wnioski{pending > 0 ? ` (${pending})` : ""}</button>}
        {isManager && <button onClick={() => setSub("settings")} className={pill(sub === "settings")}>Ustawienia</button>}
      </div>
      {sub === "leave" && <MyLeave session={session} />}
      {sub === "requests" && isManager && <Requests session={session} members={members} isAdmin={isAdmin} />}
      {sub === "mine" && <MyTime session={session} members={members} />}
      {sub === "now" && isManager && <NowBoard members={members} />}
      {sub === "records" && isManager && <Records session={session} members={members} isAdmin={isAdmin} />}
      {sub === "settings" && isManager && <Settings session={session} isAdmin={isAdmin} />}
    </div>
  );
}

/* ---------------- Mój czas ---------------- */

function SegmentChips({ segs }: { segs: RcpSegment[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {segs.map((s) => (
        <span key={s.id} className={`text-xs font-semibold px-2 py-1 rounded ${KIND_STYLE[s.kind]}`}>
          {RCP_KIND_LABEL[s.kind]}
          {s.kind === "praca" && s.area ? ` · ${s.area}` : ""} {fmtClock(Date.parse(s.started_at))}–{s.ended_at ? fmtClock(Date.parse(s.ended_at)) : "trwa"}
        </span>
      ))}
    </div>
  );
}

function MyTime({ session, members }: { session: Session; members: MemberLite[] }) {
  const [month, setMonth] = useState(monthKeyOf(new Date().toISOString())!);
  const [segs, setSegs] = useState<RcpSegment[]>([]);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  void members;

  const load = useCallback(async () => {
    try {
      setSegs(await fetchSegments(month, session.user.id));
      setError("");
    } catch (e: any) {
      setError(e.code === "42P01" ? "Brak tabel RCP — uruchom supabase/rcp.sql w Supabase." : `Nie udało się wczytać czasu pracy: ${e.message}`);
    }
    setNow(Date.now());
  }, [month, session.user.id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const days = useMemo(() => summarizeDays(segs, now), [segs, now]);
  const today = warsawDay(now);
  const todaySegs = segs.filter((s) => warsawDay(Date.parse(s.started_at)) === today || (!s.ended_at && Date.parse(s.started_at) < now));
  const t = days.get(today);
  const monthDays = Array.from({ length: daysIn(month) }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  const worked = monthDays.filter((d) => (days.get(d)?.workMs ?? 0) > 0).length;
  const hasAdmin = Array.from(days.values()).some((d) => d.adminMs > 0);

  return (
    <div className="max-w-5xl">
      {error && <p className="text-rust text-sm mb-3">{error}</p>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line border border-line mb-6">
        {[
          ["DZIŚ — PRACA", fmtHm(t?.workMs ?? 0)],
          ["DZIŚ — PRZERWY", fmtHm(t?.breakMs ?? 0)],
          [`${monthLabel(month).toUpperCase()} — PRACA`, fmtHm(totalWorkMs(days))],
          ["DNI PRACY W MIESIĄCU", String(worked)],
        ].map(([l, v]) => (
          <div key={l} className="bg-white p-5">
            <div className="text-xs text-inksoft mb-2">{l}</div>
            <div className="text-3xl font-bold font-mono">{v}</div>
          </div>
        ))}
      </div>

      <h2 className="text-xs font-semibold text-inksoft mb-2">DZISIAJ</h2>
      <div className="border border-line bg-white p-4 mb-6">{todaySegs.length === 0 ? <span className="text-sm text-inksoft">Dziś jeszcze nic nie zarejestrowano — użyj przycisku „Rozpocznij pracę” na lewym pasku.</span> : <SegmentChips segs={todaySegs} />}</div>

      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-inksoft">MOJE DNI</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setMonth(shiftMonth(month, -1))} className="bg-white border border-line px-3 py-1 rounded text-sm font-semibold">‹</button>
          <span className="text-sm font-semibold w-36 text-center capitalize">{monthLabel(month)}</span>
          <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= monthKeyOf(new Date().toISOString())!} className="bg-white border border-line px-3 py-1 rounded text-sm font-semibold disabled:opacity-40">›</button>
        </div>
      </div>
      <div className="bg-white border border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Dzień</th>
              <th className="p-3">Początek</th>
              <th className="p-3">Koniec</th>
              <th className="p-3 text-right">Praca</th>
              {hasAdmin && <th className="p-3 text-right" title="Wliczone w Pracę">w tym admin.</th>}
              <th className="p-3 text-right">Przerwy</th>
              <th className="p-3 text-right">Wyjścia prywatne</th>
              <th className="p-3">Obszary</th>
            </tr>
          </thead>
          <tbody>
            {monthDays.filter((d) => days.has(d)).reverse().map((d) => {
              const s = days.get(d)!;
              return (
                <tr key={d} className="border-b border-line last:border-0">
                  <td className="p-3 whitespace-nowrap"><span className="text-inksoft w-6 inline-block">{dowOf(d)}</span> {d.slice(8)}.{d.slice(5, 7)}{s.review && <span title="Wpis do sprawdzenia przez Managera (np. nie kliknięto „Zakończ”)" className="ml-1 text-amber">⚠</span>}</td>
                  <td className="p-3 font-mono">{fmtClock(s.firstStartMs)}</td>
                  <td className="p-3 font-mono">{s.open ? <span className="text-teal font-semibold">trwa</span> : fmtClock(s.lastEndMs)}</td>
                  <td className="p-3 text-right font-mono font-semibold">{fmtHm(s.workMs)}</td>
                  {hasAdmin && <td className="p-3 text-right font-mono text-inksoft">{s.adminMs ? fmtHm(s.adminMs) : "—"}</td>}
                  <td className="p-3 text-right font-mono text-inksoft">{s.breakMs ? fmtHm(s.breakMs) : "—"}</td>
                  <td className="p-3 text-right font-mono text-inksoft">{s.privateMs ? fmtHm(s.privateMs) : "—"}</td>
                  <td className="p-3 text-xs text-inksoft">{Object.entries(s.areaMs).map(([a, ms]) => `${a} ${fmtHm(ms)}`).join(" · ")}</td>
                </tr>
              );
            })}
            {monthDays.every((d) => !days.has(d)) && <tr><td colSpan={8} className="p-6 text-center text-inksoft text-sm">Brak zarejestrowanego czasu w tym miesiącu.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-inksoft mt-3 max-w-3xl">Do czasu pracy liczy się praca i wyjścia służbowe; przerwy i wyjścia prywatne nie. Widzisz tylko swój czas. Jeśli zapomniałeś kliknąć „Rozpocznij”/„Zakończ”, poproś Managera o korektę.</p>
    </div>
  );
}

/* ---------------- Teraz w pracy ---------------- */

function NowBoard({ members }: { members: MemberLite[] }) {
  const [open, setOpen] = useState<RcpSegment[]>([]);
  const [todaySegs, setTodaySegs] = useState<RcpSegment[]>([]);
  const [list, setList] = useState<{ user_id: string; email: string; role: string }[]>([]);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const dayFrom = new Date(dayStartMs(warsawDay(Date.now()))).toISOString();
    const [o, t, m] = await Promise.all([
      supabase.from("rcp_segments").select("*").is("ended_at", null),
      supabase.from("rcp_segments").select("*").gte("started_at", dayFrom).order("started_at"),
      supabase.from("members").select("user_id, email, role"),
    ]);
    if (o.error) return setError(o.error.code === "42P01" ? "Brak tabel RCP — uruchom supabase/rcp.sql w Supabase." : o.error.message);
    setError("");
    setOpen((o.data as RcpSegment[]) || []);
    setTodaySegs((t.data as RcpSegment[]) || []);
    setList(((m.data as { user_id: string; email: string; role: string }[]) || []).filter((x) => x.role));
    setNow(Date.now());
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const rows = list.map((m) => {
    const cur = open.find((s) => s.user_id === m.user_id) ?? null;
    const mine = todaySegs.filter((s) => s.user_id === m.user_id);
    const day = summarizeDays(mine, now).get(warsawDay(now));
    return { m, cur, workMs: day?.workMs ?? 0, last: mine.length ? mine[mine.length - 1] : null };
  });
  const rank = (r: (typeof rows)[number]) => (r.cur?.kind === "praca" || r.cur?.kind === "administracja" ? 0 : r.cur ? 1 : r.last ? 2 : 3);
  rows.sort((a, b) => rank(a) - rank(b) || displayNameForEmail(a.m.email, members).localeCompare(displayNameForEmail(b.m.email, members), "pl"));
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;

  return (
    <div className="max-w-5xl">
      {error && <p className="text-rust text-sm mb-3">{error}</p>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line border border-line mb-6">
        {[
          ["W PRACY", count((r) => r.cur?.kind === "praca" || r.cur?.kind === "administracja")],
          ["PRZERWA / WYJŚCIE", count((r) => !!r.cur && r.cur.kind !== "praca" && r.cur.kind !== "administracja")],
          ["ZAKOŃCZYLI DZIŚ", count((r) => !r.cur && !!r.last)],
          ["NIE ROZPOCZĘLI DZIŚ", count((r) => !r.cur && !r.last)],
        ].map(([l, v]) => (
          <div key={String(l)} className="bg-white p-5">
            <div className="text-xs text-inksoft mb-2">{l}</div>
            <div className="text-3xl font-bold font-mono">{v}</div>
          </div>
        ))}
      </div>
      <div className="bg-white border border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Pracownik</th>
              <th className="p-3">Status</th>
              <th className="p-3">Obszar</th>
              <th className="p-3">Od</th>
              <th className="p-3 text-right">Dziś przepracowano</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, cur, workMs, last }) => (
              <tr key={m.user_id} className="border-b border-line last:border-0">
                <td className="p-3 font-semibold">{displayNameForEmail(m.email, members)}</td>
                <td className="p-3">
                  {cur ? (
                    <span className={`text-xs font-semibold px-2 py-1 rounded ${KIND_STYLE[cur.kind]}`}>{cur.kind === "praca" ? "W pracy" : RCP_KIND_LABEL[cur.kind]}</span>
                  ) : last ? (
                    <span className="text-xs text-inksoft">Zakończył(a) o {fmtClock(last.ended_at ? Date.parse(last.ended_at) : null)}</span>
                  ) : (
                    <span className="text-xs text-inksoft">Nie rozpoczął(a)</span>
                  )}
                </td>
                <td className="p-3 text-xs">{cur?.area ?? "—"}</td>
                <td className="p-3 font-mono text-xs">{cur ? fmtClock(Date.parse(cur.started_at)) : "—"}</td>
                <td className="p-3 text-right font-mono font-semibold">{workMs ? fmtHm(workMs) : "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && !error && <tr><td colSpan={5} className="p-6 text-center text-inksoft text-sm">Brak pracowników.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-inksoft mt-3">Odświeża się co 30 s. Osoby z rolą "Admin" i "Manager" też rejestrują czas (widżet na lewym pasku).</p>
    </div>
  );
}

/* ---------------- Ewidencja ---------------- */

const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function Records({ session, members, isAdmin }: { session: Session; members: MemberLite[]; isAdmin: boolean }) {
  const [month, setMonth] = useState(monthKeyOf(new Date().toISOString())!);
  const [segs, setSegs] = useState<RcpSegment[]>([]);
  const [list, setList] = useState<{ user_id: string; email: string; role: string }[]>([]);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [openCell, setOpenCell] = useState<{ userId: string; email: string; day: string } | null>(null);
  const [absences, setAbsences] = useState<Absence[]>([]);

  const load = useCallback(async () => {
    try {
      const nd = daysIn(month);
      const [s, m, ab] = await Promise.all([
        fetchSegments(month),
        supabase.from("members").select("user_id, email, role"),
        supabase.from("rcp_absences").select("*").eq("status", "zaakceptowany").lte("date_from", `${month}-${String(nd).padStart(2, "0")}`).gte("date_to", `${month}-01`).limit(1000),
      ]);
      setAbsences(ab.error ? [] : ((ab.data as Absence[]) || [])); // brak tabeli nieobecności nie psuje ewidencji
      setSegs(s);
      setList(((m.data as { user_id: string; email: string; role: string }[]) || []).filter((x) => x.role));
      setError("");
    } catch (e: any) {
      setError(e.code === "42P01" ? "Brak tabel RCP — uruchom supabase/rcp.sql w Supabase." : `Nie udało się wczytać ewidencji: ${e.message}`);
    }
    setNow(Date.now());
  }, [month]);
  useEffect(() => {
    load();
  }, [load]);

  const people = useMemo(() => {
    return list
      .map((m) => ({ ...m, name: displayNameForEmail(m.email, members), byDay: summarizeDays(segs.filter((s) => s.user_id === m.user_id), now) }))
      .sort((a, b) => a.name.localeCompare(b.name, "pl"));
  }, [list, segs, members, now]);
  const n = daysIn(month);
  const dayKeys = Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  const reviewCount = segs.filter((s) => s.needs_review).length;

  function exportCsv() {
    const csv = ewidencjaCsv(month, n, people.filter((p) => p.byDay.size > 0 || absences.some((a) => a.user_id === p.user_id)).map((p) => ({ name: p.name, byDay: p.byDay, absenceCode: (day: string) => absenceKind(absenceOnDay(absences.filter((a) => a.user_id === p.user_id), day)?.kind ?? "")?.short ?? "" })));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `ewidencja-czasu-${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div>
      {error && <p className="text-rust text-sm mb-3">{error}</p>}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold">‹</button>
        <span className="text-sm font-semibold w-40 text-center capitalize">{monthLabel(month)}</span>
        <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= monthKeyOf(new Date().toISOString())!} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-40">›</button>
        {reviewCount > 0 && <span className="text-xs font-semibold text-amber bg-ambersoft px-2 py-1 rounded">⚠ {reviewCount} wpisów do sprawdzenia (zamknięte automatycznie)</span>}
        <button onClick={exportCsv} className="ml-auto bg-white border border-line px-4 py-2 rounded text-sm font-semibold">Pobierz CSV</button>
      </div>
      <div className="bg-white border border-line overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr className="text-inksoft border-b border-line">
              <th className="p-2 text-left sticky left-0 bg-white">Pracownik</th>
              {dayKeys.map((d) => {
                const wk = dowOf(d);
                return <th key={d} title={isHoliday(d) ? "Święto" : undefined} className={`p-1.5 font-mono font-normal ${wk === "nd" || wk === "so" || isHoliday(d) ? "bg-paper" : ""} ${isHoliday(d) ? "text-rust" : ""}`}><div>{d.slice(8)}</div><div className="text-[9px]">{wk}</div></th>;
              })}
              <th className="p-2 text-right">Razem</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.user_id} className="border-b border-line last:border-0">
                <td className="p-2 font-semibold whitespace-nowrap sticky left-0 bg-white">{p.name}</td>
                {dayKeys.map((d) => {
                  const s = p.byDay.get(d);
                  const wk = dowOf(d);
                  const ab = absenceOnDay(absences.filter((a) => a.user_id === p.user_id), d);
                  return (
                    <td key={d} onClick={() => setOpenCell({ userId: p.user_id, email: p.email, day: d })} title={ab ? absenceKind(ab.kind)?.label : undefined} className={`p-1.5 text-center font-mono cursor-pointer hover:bg-tealsoft ${wk === "nd" || wk === "so" || isHoliday(d) ? "bg-paper" : ""} ${s?.open ? "text-teal font-bold" : ""}`}>
                      {s && s.workMs > 0 ? fmtHm(s.workMs) : ab ? <span className="text-[10px] font-bold text-amber">{absenceKind(ab.kind)?.short}</span> : ""}
                      {s?.review && <span className="text-amber">⚠</span>}
                    </td>
                  );
                })}
                <td className="p-2 text-right font-mono font-bold">{fmtHm(totalWorkMs(p.byDay))}</td>
              </tr>
            ))}
            {people.length === 0 && !error && <tr><td colSpan={n + 2} className="p-6 text-center text-inksoft text-sm">Brak pracowników.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-inksoft mt-3 max-w-3xl">Godziny pracy = praca + wyjścia służbowe (przerwy i wyjścia prywatne nie). Kody nieobecności: U urlop, UŻ na żądanie, UO okolicznościowy, UB bezpłatny, L4, N inna; szare tło = weekend lub święto. Kliknij komórkę, żeby zobaczyć szczegóły dnia, poprawić wpis albo dodać brakujący. ⚠ = wpis zamknięty automatycznie (nikt nie kliknął „Zakończ”) — sprawdź i popraw.</p>
      {openCell && <DayDrawer session={session} cell={openCell} segs={segs.filter((s) => s.user_id === openCell.userId)} members={members} isAdmin={isAdmin} onClose={() => setOpenCell(null)} onChanged={load} />}
    </div>
  );
}

function DayDrawer({ session, cell, segs, members, isAdmin, onClose, onChanged }: { session: Session; cell: { userId: string; email: string; day: string }; segs: RcpSegment[]; members: MemberLite[]; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const dayFrom = dayStartMs(cell.day);
  const dayTo = dayFrom + 25 * 3600_000;
  const todays = segs.filter((s) => Date.parse(s.started_at) < dayTo && (!s.ended_at || Date.parse(s.ended_at) > dayFrom) && warsawDay(Date.parse(s.started_at)) === cell.day);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [form, setForm] = useState({ kind: "praca" as RcpKind, area: "Serwis", start: "", end: "", reason: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const auth = { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };

  function startEdit(s: RcpSegment | null) {
    setError("");
    setEditing(s ? s.id : "new");
    const base = `${cell.day}T08:00`;
    setForm(s ? { kind: s.kind, area: s.area || "Serwis", start: toLocalInput(s.started_at), end: toLocalInput(s.ended_at), reason: "" } : { kind: "praca", area: "Serwis", start: base, end: `${cell.day}T16:00`, reason: "" });
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const body =
        editing === "new"
          ? { action: "add", user_id: cell.userId, kind: form.kind, area: form.kind === "praca" || form.kind === "przerwa" ? form.area : form.area, started_at: new Date(form.start).toISOString(), ended_at: form.end ? new Date(form.end).toISOString() : null, reason: form.reason }
          : { action: "update", id: editing, kind: form.kind, area: form.area, started_at: new Date(form.start).toISOString(), ended_at: form.end ? new Date(form.end).toISOString() : null, reason: form.reason };
      const res = await fetch("/api/rcp/edit", { method: "POST", headers: auth, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw new Error(data?.error || "Nie udało się zapisać.");
      setEditing(null);
      onChanged();
    } catch (e: any) {
      setError(e.message || "Nie udało się zapisać.");
    } finally {
      setBusy(false);
    }
  }
  async function remove(s: RcpSegment) {
    if (!confirm("Usunąć ten wpis? Trafi do dziennika usunięć.")) return;
    const { data, error: err } = await supabase.from("rcp_segments").delete().eq("id", s.id).select("id");
    if (err || !data?.length) return setError(err?.message || "Nie usunięto (tylko Admin).");
    onChanged();
  }
  const inp = "border border-line bg-white px-2 py-1.5 rounded text-sm w-full";

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg bg-paper h-full overflow-y-auto p-6 border-l border-line">
        <div className="flex justify-between items-start mb-4">
          <div>
            <div className="text-xs text-inksoft">{displayNameForEmail(cell.email, members)}</div>
            <h2 className="text-lg font-semibold">{cell.day.split("-").reverse().join(".")} ({dowOf(cell.day)})</h2>
          </div>
          <button onClick={onClose} className="text-inksoft text-lg">✕</button>
        </div>
        {error && <p className="text-rust text-xs mb-3">{error}</p>}
        <div className="border border-line bg-white mb-4">
          {todays.length === 0 && <div className="p-3 text-sm text-inksoft">Brak wpisów tego dnia.</div>}
          {todays.map((s) => (
            <div key={s.id} className="p-3 border-b border-line last:border-0 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className={`text-xs font-semibold px-2 py-1 rounded mr-2 ${KIND_STYLE[s.kind]}`}>{RCP_KIND_LABEL[s.kind]}</span>
                  <span className="font-mono">{fmtClock(Date.parse(s.started_at))}–{s.ended_at ? fmtClock(Date.parse(s.ended_at)) : "trwa"}</span>
                  {s.area && <span className="text-xs text-inksoft ml-2">{s.area}</span>}
                  {s.needs_review && <span className="ml-2 text-amber" title="Zamknięty automatycznie">⚠</span>}
                  {s.source === "manual" && <span className="ml-2 text-[10px] text-inksoft">ręczny</span>}
                </div>
                <div className="flex gap-3 text-xs font-semibold shrink-0">
                  <button onClick={() => startEdit(s)} className="text-teal hover:underline">Popraw</button>
                  {isAdmin && <button onClick={() => remove(s)} className="text-rust hover:underline">Usuń</button>}
                </div>
              </div>
              {!!s.history?.length && (
                <ul className="mt-2 ml-2 text-[11px] text-inksoft list-disc list-inside">
                  {s.history.map((h, i) => (
                    <li key={i}>{new Date(h.at).toLocaleString("pl-PL")}{h.by_email ? ` · ${displayNameForEmail(h.by_email, members)}` : ""}: {h.reason}{h.changes?.length ? ` (${h.changes.map((c) => `${c.field}: ${c.from ?? "—"} → ${c.to ?? "—"}`).join("; ")})` : ""}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        {editing === null ? (
          <button onClick={() => startEdit(null)} className="bg-white border border-line px-4 py-2 rounded text-sm font-semibold">+ Dodaj brakujący wpis</button>
        ) : (
          <div className="border border-line bg-white p-4 space-y-3">
            <div className="text-xs font-semibold text-inksoft">{editing === "new" ? "NOWY WPIS" : "POPRAWA WPISU"}</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-semibold text-inksoft">Rodzaj
                <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as RcpKind })} className={inp + " mt-1 font-normal"}>
                  {(Object.keys(RCP_KIND_LABEL) as RcpKind[]).map((k) => <option key={k} value={k}>{RCP_KIND_LABEL[k]}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold text-inksoft">Obszar
                <select value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} className={inp + " mt-1 font-normal"}>
                  {RCP_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold text-inksoft">Początek<input type="datetime-local" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} className={inp + " mt-1 font-normal"} /></label>
              <label className="text-xs font-semibold text-inksoft">Koniec<input type="datetime-local" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} className={inp + " mt-1 font-normal"} /></label>
            </div>
            <label className="text-xs font-semibold text-inksoft block">Uzasadnienie (wymagane — trafia do historii wpisu)
              <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="np. zapomniał kliknąć Zakończ, wyszedł o 16:00" className={inp + " mt-1 font-normal"} />
            </label>
            <div className="flex gap-2">
              <button onClick={save} disabled={busy || form.reason.trim().length < 3 || !form.start} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">{busy ? "Zapisywanie…" : "Zapisz"}</button>
              <button onClick={() => setEditing(null)} className="px-4 py-2 border border-line rounded text-sm font-semibold">Anuluj</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Ustawienia ---------------- */

function Settings({ session, isAdmin }: { session: Session; isAdmin: boolean }) {
  const [ips, setIps] = useState<string[] | null>(null);
  const [myIp, setMyIp] = useState("");
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const auth = { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };

  useEffect(() => {
    fetch("/api/rcp/settings", { headers: auth, cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok) {
          setIps(d.allowedIps);
          setMyIp(d.myIp);
        } else setMsg(d?.error || "Nie udało się wczytać ustawień.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(next: string[]) {
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/rcp/settings", { method: "POST", headers: auth, body: JSON.stringify({ allowedIps: next }) });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || d?.error) return setMsg(d?.error || "Nie udało się zapisać.");
    setIps(d.allowedIps);
    setDraft("");
    setMsg("Zapisano.");
  }

  if (ips === null) return <p className="text-sm text-inksoft">{msg || "Wczytywanie…"}</p>;
  return (
    <div className="max-w-2xl">
      <h2 className="text-xs font-semibold text-inksoft mb-2">KOMPUTERY W FIRMIE (ADRESY IP)</h2>
      <div className="border border-line bg-white p-4 mb-4">
        {ips.length === 0 ? (
          <p className="text-sm text-amber font-semibold">Brak ograniczenia — czas można rejestrować z każdego komputera. Dodaj adres firmowy, żeby ograniczyć rejestrację do biura.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ips.map((ip) => (
              <span key={ip} className="inline-flex items-center gap-2 font-mono text-sm bg-paper border border-line rounded px-2 py-1">
                {ip}
                {isAdmin && <button onClick={() => save(ips.filter((x) => x !== ip))} disabled={busy} className="text-rust font-sans" title="Usuń adres">×</button>}
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="text-sm mb-3">Adres tego komputera: <span className="font-mono font-semibold">{myIp || "nieznany"}</span> {ips.some((x) => x === myIp) ? <span className="text-teal text-xs font-semibold">· jest na liście</span> : null}</p>
      {isAdmin ? (
        <div className="flex gap-2 flex-wrap items-center">
          {myIp && !ips.includes(myIp) && <button onClick={() => save([...ips, myIp])} disabled={busy} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">Dodaj adres tego komputera</button>}
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="inny adres IP" className="border border-line bg-white px-3 py-2 rounded text-sm font-mono w-52" />
          <button onClick={() => draft.trim() && save([...ips, draft.trim()])} disabled={busy || !draft.trim()} className="bg-white border border-line px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">Dodaj</button>
        </div>
      ) : (
        <p className="text-xs text-inksoft">Adresy zmienia tylko Admin.</p>
      )}
      {msg && <p className="text-xs text-inksoft mt-3">{msg}</p>}
      <p className="text-[11px] text-inksoft mt-4">Najprościej: Admin otwiera tę stronę <b>z komputera w biurze</b> i klika „Dodaj adres tego komputera” (to publiczny adres całej sieci firmy — obejmie wszystkie komputery w biurze). Gdy adres firmy się zmieni (dostawca internetu), trzeba go zaktualizować. Pusta lista = bez ograniczenia.</p>
    </div>
  );
}
