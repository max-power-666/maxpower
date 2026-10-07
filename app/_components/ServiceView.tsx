"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { escapeLike } from "@/lib/search";
import InlineEditCell from "./InlineEditCell";
import PartsCell from "./PartsCell";
import ProductCardDrawer from "./ProductCardDrawer";
import {
  INTERVALS,
  SERVICE_ACTIVE_STATUSES,
  SERVICE_STATUSES as STATUSES,
  SERVICE_TASKS,
  fmtDuration,
  rangeStart,
  type Interval,
} from "@/lib/workLog";

// Rejestracja pracy serwisanta wg tabeli punktowej z Regulaminu premiowania (§2, 12.10.2026).
// Nie liczy premii w zł (Regulamin §4-§7) — wymagałoby to danych o czasie pracy/urlopach,
// których apka nie ma. Tu tylko czynności + punkty + podsumowanie w wybranym okresie.
//
// Jeden wiersz = jedna naprawa, z cyklem życia w statusie (start -> [oczekuje na części] ->
// naprawiony/uszkodzony). "Oczekuje na części" (01.10.2026) to naprawa WSTRZYMANA, nie
// zakończona — jak "w_naprawie", finished_at zostaje null (SERVICE_ACTIVE_STATUSES w lib/workLog.ts).
// "Czas" (finished_at - started_at) jest tylko informacyjny dla zespołu — regulamin liczy
// wydajność jako punkty / godziny przepracowane (ewidencja czasu pracy), nie sumę czasów
// napraw. Punkty do podsumowania liczą się tylko dla status="naprawiony" (Regulamin §2 ust. 4:
// punkty nalicza się dopiero po prawidłowym zakończeniu procesu).

type TaskKey = (typeof SERVICE_TASKS)[number]["key"];
const TASK_LABEL: Record<string, string> = Object.fromEntries(SERVICE_TASKS.map((t) => [t.key, t.label]));

type StatusKey = (typeof STATUSES)[number]["key"];
const STATUS_STYLE: Record<StatusKey, string> = {
  w_naprawie: "bg-ambersoft text-amber",
  oczekuje_na_czesci: "bg-[#e3ecf9] text-[#2a6bb5]",
  wstrzymane: "bg-[#e9ecef] text-[#4b5563]",
  naprawiony: "bg-tealsoft text-teal",
  uszkodzony: "bg-rustsoft text-rust",
};

type LogRow = {
  id: number;
  employee_email: string | null;
  task_type: string;
  points: number;
  device_ref: string | null;
  status: StatusKey;
  notes: string | null;
  started_at: string;
  finished_at: string | null;
  part_serials: string[] | null;
  paused_seconds: number;
};

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const btnPrimary = "bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50";
const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

export default function ServiceView({
  session,
  members,
  isAdmin,
  isAdminOrManager,
  isServiceLead = false,
}: {
  session: Session;
  members: MemberLite[];
  isAdmin: boolean;
  isAdminOrManager: boolean;
  isServiceLead?: boolean; // rola "Kierownik serwisu": widzi naprawy wszystkich i edytuje wiersz w każdym statusie
}) {
  // Zwykły pracownik widzi tylko własne naprawy (02.10.2026); Admin i Manager — wszystkie.
  const ownOnly = !isAdminOrManager && !isServiceLead;
  const canDelete = isAdmin || isServiceLead; // usuwanie wpisów: Admin i Kierownik serwisu
  const [interval, setInterval] = useState<Interval>("today");
  const [rangeRows, setRangeRows] = useState<{ employee_email: string | null; points: number; task_type: string }[]>([]);
  const [recent, setRecent] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Wyszukiwarka po numerze seryjnym (02.10.2026): bez niej lista to tylko najświeższe 50 wpisów, wyszukiwanie sięga całej tabeli.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [repairEmails, setRepairEmails] = useState<string[]>([]);
  const [employeeFilter, setEmployeeFilter] = useState(""); // filtr listy po kolumnie "Pracownik" (e-mail; pusty = wszyscy) — tylko dla osób widzących naprawy wszystkich

  const [taskType, setTaskType] = useState<TaskKey>(SERVICE_TASKS[0].key);
  const [deviceRef, setDeviceRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [openSerial, setOpenSerial] = useState<string | null>(null);

  // Jednorazowo (przy wejściu do zakładki): unikalne e-maile z całej tabeli napraw — PostgREST nie ma DISTINCT, więc czytamy samą kolumnę stronami po 1000.
  useEffect(() => {
    if (ownOnly) return;
    let alive = true;
    (async () => {
      const seen = new Set<string>();
      for (let from = 0; from < 50_000; from += 1000) {
        const { data, error: err } = await supabase.from("service_log").select("employee_email").order("id").range(from, from + 999);
        if (err || !data) break;
        for (const r of data as { employee_email: string | null }[]) if (r.employee_email) seen.add(r.employee_email.toLowerCase());
        if (data.length < 1000) break;
      }
      if (alive) setRepairEmails(Array.from(seen));
    })();
    return () => {
      alive = false;
    };
  }, [ownOnly]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel("service-log-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "service_log" }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, search, employeeFilter]);

  async function load() {
    setLoading(true);
    setError("");
    try {
      // Punkty po points_awarded_at (pierwsze zaliczenie, trigger w bazie) — zmiana statusu nie przesuwa naprawy do innego dnia. Przed uruchomieniem
      // aktualizacji service.sql kolumny nie ma — wtedy awaryjnie po finished_at (stare zachowanie).
      const rangeQuery = (col: string) => {
        const q = supabase.from("service_log").select("employee_email, points, task_type").eq("status", "naprawiony").gte(col, rangeStart(interval));
        return ownOnly ? q.eq("employee_user_id", session.user.id) : q;
      };
      const [rangeRes, { data: recentData, error: recentErr }] = await Promise.all([
        rangeQuery("points_awarded_at"),
        (() => {
          let q = supabase
            .from("service_log")
            .select("id, employee_email, task_type, points, device_ref, status, notes, started_at, finished_at, part_serials, paused_seconds");
          if (ownOnly) q = q.eq("employee_user_id", session.user.id);
          else if (employeeFilter) q = q.ilike("employee_email", escapeLike(employeeFilter));
          if (search) q = q.ilike("device_ref", `%${escapeLike(search)}%`);
          // Przy wyszukiwaniu limit rośnie — szukany wpis mógł dawno wypaść poza najświeższe 50.
          return q.order("started_at", { ascending: false }).limit(search ? 200 : 50);
        })(),
      ]);
      let { data: rangeData, error: rangeErr } = rangeRes;
      if (rangeErr && rangeErr.code === "42703") ({ data: rangeData, error: rangeErr } = await rangeQuery("finished_at"));
      if (rangeErr) throw rangeErr;
      if (recentErr) throw recentErr;
      setRangeRows(rangeData || []);
      setRecent((recentData as LogRow[]) || []);
    } catch (e: any) {
      setError(`Nie udało się wczytać danych serwisu: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  // Lista pracowników do filtra: TYLKO osoby, które mają jakąkolwiek naprawę w service_log (nie cały zespół), skrócone imię.
  const employeeOptions = useMemo(() => {
    const emails = new Set(repairEmails);
    if (employeeFilter) emails.add(employeeFilter.toLowerCase());
    return Array.from(emails).map((email) => ({ email, name: displayNameForEmail(email, members) }));
  }, [repairEmails, members, employeeFilter]);

  const summary = useMemo(() => {
    // "Poprawka" (0 pkt) nie jest naprawą — nie wchodzi do liczby napraw, tylko do osobnej liczby w nawiasie (07.10.2026).
    const totals = new Map<string, { count: number; corrections: number; points: number }>();
    for (const r of rangeRows) {
      const key = r.employee_email || "—";
      const entry = totals.get(key) || { count: 0, corrections: 0, points: 0 };
      if (r.task_type === "correction") entry.corrections += 1;
      else entry.count += 1;
      entry.points += Number(r.points) || 0;
      totals.set(key, entry);
    }
    return Array.from(totals.entries())
      .map(([email, v]) => ({ email, ...v }))
      .sort((a, b) => b.points - a.points);
  }, [rangeRows]);

  async function submit() {
    setFormError("");
    if (!deviceRef.trim()) {
      setFormError("Podaj numer seryjny / IMEI, żeby rozpocząć naprawę.");
      return;
    }
    setSubmitting(true);
    try {
      const task = SERVICE_TASKS.find((t) => t.key === taskType)!;
      const { error: err } = await supabase.from("service_log").insert({
        employee_user_id: session.user.id,
        employee_email: session.user.email,
        task_type: task.key,
        points: task.points,
        device_ref: deviceRef.trim(),
        status: "w_naprawie",
      });
      if (err) throw err;
      setDeviceRef("");
    } catch (e: any) {
      setFormError(e.message || "Błąd zapisu.");
    } finally {
      setSubmitting(false);
    }
  }

  // Usuwanie: Admin i Kierownik serwisu (polityka w bazie: is_admin() or is_service_lead(); każde usunięcie trafia do deleted_records).
  async function deleteRow(row: LogRow) {
    if (!confirm(`Usunąć wpis „${row.device_ref || TASK_LABEL[row.task_type] || row.task_type}”? Tej operacji nie można cofnąć.`)) return;
    const { data, error: err } = await supabase.from("service_log").delete().eq("id", row.id).select("id");
    if (err) setError(`Nie udało się usunąć: ${err.message}`);
    else if (!data?.length) setError("Nie usunięto — brak uprawnień (tylko Admin i Kierownik serwisu) albo wpis już nie istnieje.");
    else await load();
  }

  async function saveNotes(row: LogRow, notes: string | null) {
    const { error: err } = await supabase.from("service_log").update({ notes }).eq("id", row.id);
    if (err) setError(`Nie udało się zapisać uwag: ${err.message}`);
  }

  async function saveDeviceRef(row: LogRow, deviceRef: string | null) {
    const { error: err } = await supabase.from("service_log").update({ device_ref: deviceRef }).eq("id", row.id);
    if (err) setError(`Nie udało się zapisać numeru seryjnego: ${err.message}`);
  }

  async function savePartSerials(row: LogRow, partSerials: string[]) {
    const { error: err } = await supabase.from("service_log").update({ part_serials: partSerials.length > 0 ? partSerials : null }).eq("id", row.id);
    if (err) setError(`Nie udało się zapisać części: ${err.message}`);
  }

  async function changeStatus(row: LogRow, status: StatusKey) {
    const patch: { status: StatusKey; finished_at: string | null } = {
      status,
      finished_at: SERVICE_ACTIVE_STATUSES.includes(status) ? null : new Date().toISOString(),
    };
    await supabase.from("service_log").update(patch).eq("id", row.id);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-inksoft">PODSUMOWANIE PUNKTACJI (naprawione)</h2>
      </div>
      <div className="border border-line bg-white mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Pracownik</th>
              <th className="p-3 text-right">Liczba napraw (poprawka)</th>
              <th className="p-3 text-right">Punkty</th>
            </tr>
          </thead>
          <tbody>
            {!loading && summary.length === 0 && (
              <tr><td colSpan={3} className="p-6 text-center text-inksoft text-sm">Brak zakończonych napraw w tym okresie.</td></tr>
            )}
            {summary.map((s) => (
              <tr key={s.email} className="border-b border-line last:border-b-0">
                <td className="p-3 font-semibold">{displayNameForEmail(s.email, members)}</td>
                <td className="p-3 text-right font-mono">{s.count} <span className="text-inksoft">({s.corrections})</span></td>
                <td className="p-3 text-right font-mono font-semibold">{s.points.toLocaleString("pl-PL")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <div className="border border-line bg-white p-4 mb-6">
        <h2 className="text-xs font-semibold text-inksoft mb-3">ROZPOCZNIJ NAPRAWĘ</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="text-xs font-semibold text-inksoft block mb-1">Typ czynności *</label>
            <select
              value={taskType}
              onChange={(e) => setTaskType(e.target.value as TaskKey)}
              className="w-full border border-line bg-white px-2 py-2 rounded text-sm"
            >
              {SERVICE_TASKS.map((t) => (
                <option key={t.key} value={t.key}>{t.label} — {t.points} pkt</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-inksoft block mb-1">Numer seryjny / IMEI *</label>
            <input
              value={deviceRef}
              onChange={(e) => setDeviceRef(e.target.value)}
              className="w-full border border-line bg-white px-2 py-2 rounded text-sm font-mono"
            />
          </div>
        </div>
        {formError && <p className="text-rust text-xs mb-2">{formError}</p>}
        <button onClick={submit} disabled={submitting || !deviceRef.trim()} className={btnPrimary}>
          {submitting ? "Zapisywanie…" : "Rozpocznij naprawę"}
        </button>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        {!ownOnly && (
          <select
            value={employeeFilter}
            onChange={(e) => setEmployeeFilter(e.target.value)}
            title="Pokaż naprawy jednego pracownika"
            className="border border-line bg-white px-2 py-1.5 rounded text-sm"
          >
            <option value="">Pracownik: wszyscy</option>
            {[...employeeOptions].sort((a, b) => a.name.localeCompare(b.name, "pl")).map((o) => <option key={o.email} value={o.email}>{o.name}</option>)}
          </select>
        )}
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Szukaj po numerze seryjnym…"
          className="border border-line bg-white px-3 py-1.5 rounded text-sm w-64"
        />
        <div className="flex gap-2 ml-auto" title="Okres podsumowania punktacji u góry">
          {INTERVALS.map((i) => (
            <button key={i.key} onClick={() => setInterval(i.key)} className={pill(interval === i.key)}>{i.label}</button>
          ))}
        </div>
      </div>
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Rozpoczęto</th>
              <th className="p-3">Pracownik</th>
              <th className="p-3">Czynność</th>
              <th className="p-3">Numer seryjny</th>
              <th className="p-3">Części</th>
              <th className="p-3">Status</th>
              <th className="p-3">Uwagi</th>
              {isAdminOrManager && <th className="p-3">Czas</th>}
              <th className="p-3 text-right">Punkty</th>
              {canDelete && <th className="p-3"></th>}
            </tr>
          </thead>
          <tbody>
            {!loading && recent.length === 0 && (
              <tr><td colSpan={8 + (isAdminOrManager ? 1 : 0) + (canDelete ? 1 : 0)} className="p-6 text-center text-inksoft text-sm">{search ? "Brak wyników." : "Brak wpisów — rozpocznij pierwszą naprawę powyżej."}</td></tr>
            )}
            {recent.map((r) => {
              // Wiersz edytowalny tylko w statusie "w naprawie" (02.10.2026) — żeby nic nie zmienić przez przypadek.
              // Zmiana statusu zostaje zawsze dostępna (inaczej nie dałoby się wrócić do edycji ani zakończyć naprawy).
              const locked = r.status !== "w_naprawie" && !isServiceLead; // Kierownik serwisu edytuje rozpoczętą czynność w każdym statusie
              return (
              <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-paper">
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(r.started_at)}</td>
                <td className="p-3">{displayNameForEmail(r.employee_email, members)}</td>
                <td className="p-3">{TASK_LABEL[r.task_type] || r.task_type}</td>
                <td className="p-3">
                  <div className="flex items-center gap-1">
                    <InlineEditCell
                      value={r.device_ref}
                      placeholder="Numer seryjny / IMEI"
                      className="w-36 font-mono"
                      readOnly={locked}
                      onSave={(next) => saveDeviceRef(r, next)}
                    />
                    {r.device_ref && (
                      <button onClick={() => setOpenSerial(r.device_ref)} title="Otwórz kartę produktu" className="text-teal shrink-0">↗</button>
                    )}
                  </div>
                </td>
                <td className="p-3">
                  <PartsCell values={r.part_serials} readOnly={locked} onSave={(next) => savePartSerials(r, next)} />
                </td>
                <td className="p-3">
                  <select
                    value={r.status}
                    onChange={(e) => changeStatus(r, e.target.value as StatusKey)}
                    className={`text-xs font-semibold px-2 py-1 rounded-full border-none ${STATUS_STYLE[r.status]}`}
                  >
                    {STATUSES.map((s) => (
                      <option key={s.key} value={s.key}>{s.label}</option>
                    ))}
                  </select>
                </td>
                <td className="p-3"><InlineEditCell value={r.notes} onSave={(n) => saveNotes(r, n)} multiline readOnly={locked} className="w-64" /></td>
                {isAdminOrManager && <td className="p-3 text-xs text-inksoft whitespace-nowrap">{r.status === "wstrzymane" ? "wstrzymane" : fmtDuration(r.started_at, r.finished_at, r.paused_seconds)}</td>}
                <td className="p-3 text-right font-mono font-semibold">{r.status === "naprawiony" ? r.points : "—"}</td>
                {canDelete && (
                  <td className="p-3 text-right">
                    <button onClick={() => deleteRow(r)} className="text-xs font-semibold text-rust hover:underline">
                      Usuń
                    </button>
                  </td>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {openSerial && <ProductCardDrawer serial={openSerial} members={members} onClose={() => setOpenSerial(null)} />}
    </div>
  );
}
