"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { SERVICE_TASKS } from "@/lib/workLog";
import { emptyMonth, monthCount, monthTotal, POINTS_AREAS, type EmployeeMonth } from "@/lib/points";

// Punktacja pracowników (06.10.2026, tylko Admin): miesięczne podsumowanie punktów z Serwisu, Testów i Trade-in wg Regulaminu premiowania —
// punkty tylko za prawidłowo zakończony proces, każda paczka/urządzenie raz (data zaliczenia), obszary sumują się w jeden wynik miesięczny (§2 ust. 6).
// Czego tu jeszcze NIE ma: Zwroty (17 pkt — moduł nie istnieje) oraz wszystko, co wymaga godzin pracy (wydajność pkt/h, norma 45 pkt/h, kwota premii) — brak ewidencji RCP.

type Employee = { email: string; months: Record<string, EmployeeMonth> };
const MONTH_NAMES = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];
const monthLabel = (key: string) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const fmtPts = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const TASK_LABEL = Object.fromEntries(SERVICE_TASKS.map((t) => [t.key, t.label])) as Record<string, string>;

export default function PointsView({ session, members }: { session: Session; members: MemberLite[] }) {
  const [months, setMonths] = useState<string[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [month, setMonth] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fallback, setFallback] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/points/summary", { headers: { Authorization: `Bearer ${session.access_token}` } });
        const data = await res.json();
        if (!res.ok || data?.error) throw new Error(data?.error || "Nie udało się wczytać punktacji.");
        setMonths(data.months);
        setEmployees(data.employees);
        setFallback(!!data.fallbackDate);
        setMonth(data.months[data.months.length - 1]);
      } catch (e: any) {
        setError(e.message || "Błąd wczytywania.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo(() => {
    return employees
      .map((e) => ({ email: e.email, m: e.months[month] ?? emptyMonth(), trend: months.map((k) => monthTotal(e.months[k] ?? emptyMonth())) }))
      .filter((r) => monthCount(r.m) > 0)
      .sort((a, b) => monthTotal(b.m) - monthTotal(a.m));
  }, [employees, month, months]);

  const totals = useMemo(() => {
    const t = emptyMonth();
    for (const r of rows) for (const a of POINTS_AREAS) {
      t[a.key].count += r.m[a.key].count;
      t[a.key].points += r.m[a.key].points;
    }
    return t;
  }, [rows]);
  const maxTotal = Math.max(1, ...rows.map((r) => monthTotal(r.m)));
  const trendMax = Math.max(1, ...rows.flatMap((r) => r.trend));

  if (loading) return <p className="text-inksoft text-sm">Liczenie punktacji…</p>;
  if (error) return <p className="text-rust text-sm">{error}</p>;

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <span className="text-xs font-semibold text-inksoft mr-1">MIESIĄC</span>
        {months.slice().reverse().map((k) => (
          <button key={k} onClick={() => setMonth(k)} className={pill(month === k)}>{monthLabel(k)}</button>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-px bg-line border border-line mb-px">
        <div className="bg-white p-5"><div className="text-xs text-inksoft mb-2">PUNKTY RAZEM — {monthLabel(month).toUpperCase()}</div><div className="text-2xl font-bold font-mono">{fmtPts(monthTotal(totals))}</div></div>
        {POINTS_AREAS.map((a) => (
          <div key={a.key} className="bg-white p-5">
            <div className="text-xs text-inksoft mb-2">{a.label.toUpperCase()}</div>
            <div className="text-2xl font-bold font-mono">{fmtPts(totals[a.key].points)}</div>
            <div className="text-xs text-inksoft mt-1">{totals[a.key].count} {a.unit}</div>
          </div>
        ))}
      </div>

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3 w-8"></th>
              <th className="p-3">Pracownik</th>
              {POINTS_AREAS.map((a) => (
                <th key={a.key} className="p-3 text-right">{a.label}</th>
              ))}
              <th className="p-3 text-right" title="Obsługa zwrotu — 17 pkt wg regulaminu; moduł Zwroty jeszcze nie istnieje">Zwroty</th>
              <th className="p-3 text-right">Razem</th>
              <th className="p-3 w-48"></th>
              <th className="p-3">Ostatnie {months.length} mies.</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} className="p-6 text-center text-inksoft text-sm">Brak zaliczonych punktów w tym miesiącu.</td></tr>}
            {rows.map((r) => {
              const open = expanded.has(r.email);
              const total = monthTotal(r.m);
              return (
                <Fragment key={r.email}>
                  <tr className="border-b border-line last:border-b-0 hover:bg-paper">
                    <td className="p-3">
                      {Object.keys(r.m.serviceByTask).length > 0 && (
                        <button onClick={() => setExpanded((p) => { const n = new Set(p); if (n.has(r.email)) n.delete(r.email); else n.add(r.email); return n; })} title="Rozbicie napraw wg typu czynności" className="text-inksoft">{open ? "▾" : "▸"}</button>
                      )}
                    </td>
                    <td className="p-3 font-semibold">{displayNameForEmail(r.email, members)}</td>
                    {POINTS_AREAS.map((a) => (
                      <td key={a.key} className="p-3 text-right font-mono whitespace-nowrap">
                        {r.m[a.key].count > 0 ? <>{fmtPts(r.m[a.key].points)}<span className="text-inksoft text-xs"> ({r.m[a.key].count})</span></> : <span className="text-inksoft">—</span>}
                      </td>
                    ))}
                    <td className="p-3 text-right text-inksoft">—</td>
                    <td className="p-3 text-right font-mono font-bold">{fmtPts(total)}</td>
                    <td className="p-3">
                      <div className="bg-paper rounded h-3 w-full overflow-hidden"><div className="h-full bg-teal rounded" style={{ width: `${(total / maxTotal) * 100}%` }} /></div>
                    </td>
                    <td className="p-3">
                      <div className="flex items-end gap-1 h-6" title={months.map((k, i) => `${monthLabel(k)}: ${fmtPts(r.trend[i])}`).join(" · ")}>
                        {r.trend.map((v, i) => (
                          <div key={months[i]} className={`w-3 rounded-sm ${months[i] === month ? "bg-teal" : "bg-line"}`} style={{ height: `${Math.max(2, (v / trendMax) * 24)}px` }} />
                        ))}
                      </div>
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-line bg-paper">
                      <td colSpan={9} className="p-3 text-xs">
                        <ul className="space-y-0.5 max-w-md">
                          {Object.entries(r.m.serviceByTask).sort((a, b) => b[1].points - a[1].points).map(([task, v]) => (
                            <li key={task} className="flex justify-between"><span>Serwis — {TASK_LABEL[task] || task}</span><span className="font-mono">{v.count} × → {fmtPts(v.points)} pkt</span></li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-inksoft mt-3 max-w-4xl space-y-1">
        <p>W nawiasie liczba zaliczonych sztuk. Liczą się wyłącznie prawidłowo zakończone procesy (Regulamin §2 ust. 4): Serwis — „naprawiony”, Testy — „przetestowane”, Trade-in — obsłużona / kontroferta / ok. dok. / problem. Każda paczka i urządzenie raz — miesiąc to data pierwszego zaliczenia (zmiana statusu jej nie przesuwa); miesiące wg czasu polskiego. Punkty z obszarów sumują się w jeden wynik miesięczny (§2 ust. 6).</p>
        <p>Jeszcze nie uwzględnione: obsługa zwrotów (17 pkt — zakładka Zwroty to na razie szkielet) oraz wszystko oparte na godzinach pracy — wydajność pkt/h, norma 45 pkt/h, wskaźnik kwalifikacyjny 80%, kwota premii i rozliczenie niepełnego miesiąca (§4–§7) — do tego potrzebna jest ewidencja czasu pracy (RCP).</p>
        {fallback && <p className="text-amber">Uwaga: daty zaliczenia liczone jeszcze po dacie zakończenia — uruchom service.sql, tests.sql i buyback-orders.sql, żeby punkty nie przeskakiwały między miesiącami przy zmianie statusu.</p>}
      </div>
    </div>
  );
}
