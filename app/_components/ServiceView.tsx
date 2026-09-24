"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import InlineEditCell from "./InlineEditCell";
import ProductCardDrawer from "./ProductCardDrawer";
import {
  INTERVALS,
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
// Jeden wiersz = jedna naprawa, z cyklem życia w statusie (start -> naprawiony/uszkodzony).
// "Czas" (finished_at - started_at) jest tylko informacyjny dla zespołu — regulamin liczy
// wydajność jako punkty / godziny przepracowane (ewidencja czasu pracy), nie sumę czasów
// napraw. Punkty do podsumowania liczą się tylko dla status="naprawiony" (Regulamin §2 ust. 4:
// punkty nalicza się dopiero po prawidłowym zakończeniu procesu).

type TaskKey = (typeof SERVICE_TASKS)[number]["key"];
const TASK_LABEL: Record<string, string> = Object.fromEntries(SERVICE_TASKS.map((t) => [t.key, t.label]));

type StatusKey = (typeof STATUSES)[number]["key"];
const STATUS_STYLE: Record<StatusKey, string> = {
  w_naprawie: "bg-ambersoft text-amber",
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
}: {
  session: Session;
  members: MemberLite[];
  isAdmin: boolean;
}) {
  const [interval, setInterval] = useState<Interval>("today");
  const [rangeRows, setRangeRows] = useState<{ employee_email: string | null; points: number }[]>([]);
  const [recent, setRecent] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [taskType, setTaskType] = useState<TaskKey>(SERVICE_TASKS[0].key);
  const [deviceRef, setDeviceRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [openSerial, setOpenSerial] = useState<string | null>(null);

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
  }, [interval]);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [{ data: rangeData, error: rangeErr }, { data: recentData, error: recentErr }] = await Promise.all([
        supabase
          .from("service_log")
          .select("employee_email, points")
          .eq("status", "naprawiony")
          .gte("finished_at", rangeStart(interval)),
        supabase
          .from("service_log")
          .select("id, employee_email, task_type, points, device_ref, status, notes, started_at, finished_at")
          .order("started_at", { ascending: false })
          .limit(50),
      ]);
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

  const summary = useMemo(() => {
    const totals = new Map<string, { count: number; points: number }>();
    for (const r of rangeRows) {
      const key = r.employee_email || "—";
      const entry = totals.get(key) || { count: 0, points: 0 };
      entry.count += 1;
      entry.points += Number(r.points) || 0;
      totals.set(key, entry);
    }
    return Array.from(totals.entries())
      .map(([email, v]) => ({ email, ...v }))
      .sort((a, b) => b.points - a.points);
  }, [rangeRows]);

  async function submit() {
    setFormError("");
    setSubmitting(true);
    try {
      const task = SERVICE_TASKS.find((t) => t.key === taskType)!;
      const { error: err } = await supabase.from("service_log").insert({
        employee_user_id: session.user.id,
        employee_email: session.user.email,
        task_type: task.key,
        points: task.points,
        device_ref: deviceRef.trim() || null,
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

  // Usuwanie tylko dla Admina (polityka w bazie: is_admin(); każde usunięcie trafia do deleted_records).
  async function deleteRow(row: LogRow) {
    if (!confirm(`Usunąć wpis „${row.device_ref || TASK_LABEL[row.task_type] || row.task_type}”? Tej operacji nie można cofnąć.`)) return;
    const { data, error: err } = await supabase.from("service_log").delete().eq("id", row.id).select("id");
    if (err) setError(`Nie udało się usunąć: ${err.message}`);
    else if (!data?.length) setError("Nie usunięto — brak uprawnień (tylko Admin) albo wpis już nie istnieje.");
    else await load();
  }

  async function saveNotes(row: LogRow, notes: string | null) {
    const { error: err } = await supabase.from("service_log").update({ notes }).eq("id", row.id);
    if (err) setError(`Nie udało się zapisać uwag: ${err.message}`);
  }

  async function changeStatus(row: LogRow, status: StatusKey) {
    const patch: { status: StatusKey; finished_at: string | null } = {
      status,
      finished_at: status === "w_naprawie" ? null : new Date().toISOString(),
    };
    await supabase.from("service_log").update(patch).eq("id", row.id);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-inksoft">PODSUMOWANIE PUNKTACJI (naprawione)</h2>
        <div className="flex gap-2">
          {INTERVALS.map((i) => (
            <button key={i.key} onClick={() => setInterval(i.key)} className={pill(interval === i.key)}>{i.label}</button>
          ))}
        </div>
      </div>
      <div className="border border-line bg-white mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Pracownik</th>
              <th className="p-3 text-right">Liczba napraw</th>
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
                <td className="p-3 text-right font-mono">{s.count}</td>
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
            <label className="text-xs font-semibold text-inksoft block mb-1">Numer seryjny / identyfikator</label>
            <input
              value={deviceRef}
              onChange={(e) => setDeviceRef(e.target.value)}
              className="w-full border border-line bg-white px-2 py-2 rounded text-sm font-mono"
            />
          </div>
        </div>
        {formError && <p className="text-rust text-xs mb-2">{formError}</p>}
        <button onClick={submit} disabled={submitting} className={btnPrimary}>
          {submitting ? "Zapisywanie…" : "Rozpocznij naprawę"}
        </button>
      </div>

      <h2 className="text-xs font-semibold text-inksoft mb-2">OSTATNIE NAPRAWY</h2>
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Rozpoczęto</th>
              <th className="p-3">Pracownik</th>
              <th className="p-3">Czynność</th>
              <th className="p-3">Numer seryjny</th>
              <th className="p-3">Status</th>
              <th className="p-3">Uwagi</th>
              <th className="p-3">Czas</th>
              <th className="p-3 text-right">Punkty</th>
              {isAdmin && <th className="p-3"></th>}
            </tr>
          </thead>
          <tbody>
            {!loading && recent.length === 0 && (
              <tr><td colSpan={isAdmin ? 9 : 8} className="p-6 text-center text-inksoft text-sm">Brak wpisów — rozpocznij pierwszą naprawę powyżej.</td></tr>
            )}
            {recent.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-paper">
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(r.started_at)}</td>
                <td className="p-3">{displayNameForEmail(r.employee_email, members)}</td>
                <td className="p-3">{TASK_LABEL[r.task_type] || r.task_type}</td>
                <td className="p-3">
                  {r.device_ref ? (
                    <button onClick={() => setOpenSerial(r.device_ref)} className="font-mono font-semibold text-teal hover:underline">{r.device_ref}</button>
                  ) : (
                    "—"
                  )}
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
                <td className="p-3"><InlineEditCell value={r.notes} onSave={(n) => saveNotes(r, n)} /></td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDuration(r.started_at, r.finished_at)}</td>
                <td className="p-3 text-right font-mono font-semibold">{r.status === "naprawiony" ? r.points : "—"}</td>
                {isAdmin && (
                  <td className="p-3 text-right">
                    <button onClick={() => deleteRow(r)} className="text-xs font-semibold text-rust hover:underline">
                      Usuń
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openSerial && <ProductCardDrawer serial={openSerial} members={members} onClose={() => setOpenSerial(null)} />}
    </div>
  );
}
