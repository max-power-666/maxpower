"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";

// Rejestracja pracy serwisanta wg tabeli punktowej z Regulaminu premiowania (§2, 12.10.2026).
// Nie liczy premii w zł (Regulamin §4-§7) — wymagałoby to danych o czasie pracy/urlopach,
// których apka nie ma. Tu tylko czynności + punkty + podsumowanie w wybranym okresie.

const SERVICE_TASKS = [
  { key: "joycon_pair", label: "Joy-Con, para (Nintendo Switch)", points: 15 },
  { key: "ps4_controller", label: "Kontroler PS4", points: 25 },
  { key: "xbox_controller", label: "Kontroler Xbox One / Xbox One X", points: 35 },
  { key: "ps5_controller", label: "Kontroler PS5 (DualSense)", points: 12 },
  { key: "console_cleaning", label: "Czyszczenie konsoli", points: 45 },
] as const;

type TaskKey = (typeof SERVICE_TASKS)[number]["key"];

const TASK_LABEL: Record<string, string> = Object.fromEntries(SERVICE_TASKS.map((t) => [t.key, t.label]));

type Interval = "today" | "week" | "month";
const INTERVALS: { key: Interval; label: string }[] = [
  { key: "today", label: "Dziś" },
  { key: "week", label: "Ostatnie 7 dni" },
  { key: "month", label: "Ostatnie 30 dni" },
];

type LogRow = {
  id: number;
  employee_email: string | null;
  task_type: string;
  points: number;
  device_ref: string | null;
  notes: string | null;
  created_at: string;
};

function rangeStart(interval: Interval): string {
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

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const btnPrimary = "bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50";
const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

export default function ServiceView({ session, members }: { session: Session; members: MemberLite[] }) {
  const [interval, setInterval] = useState<Interval>("today");
  const [rangeRows, setRangeRows] = useState<{ employee_email: string | null; points: number }[]>([]);
  const [recent, setRecent] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [taskType, setTaskType] = useState<TaskKey>(SERVICE_TASKS[0].key);
  const [deviceRef, setDeviceRef] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

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
        supabase.from("service_log").select("employee_email, points").gte("created_at", rangeStart(interval)),
        supabase
          .from("service_log")
          .select("id, employee_email, task_type, points, device_ref, notes, created_at")
          .order("created_at", { ascending: false })
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
        notes: notes.trim() || null,
      });
      if (err) throw err;
      setDeviceRef("");
      setNotes("");
    } catch (e: any) {
      setFormError(e.message || "Błąd zapisu.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-inksoft">PODSUMOWANIE PUNKTACJI</h2>
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
              <th className="p-3 text-right">Liczba czynności</th>
              <th className="p-3 text-right">Punkty</th>
            </tr>
          </thead>
          <tbody>
            {!loading && summary.length === 0 && (
              <tr><td colSpan={3} className="p-6 text-center text-inksoft text-sm">Brak zarejestrowanych czynności w tym okresie.</td></tr>
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
        <h2 className="text-xs font-semibold text-inksoft mb-3">ZAREJESTRUJ CZYNNOŚĆ</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
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
          <div className="md:col-span-2">
            <label className="text-xs font-semibold text-inksoft block mb-1">Uwagi</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full border border-line bg-white px-2 py-2 rounded text-sm"
            />
          </div>
        </div>
        {formError && <p className="text-rust text-xs mb-2">{formError}</p>}
        <button onClick={submit} disabled={submitting} className={btnPrimary}>
          {submitting ? "Zapisywanie…" : "Zarejestruj"}
        </button>
      </div>

      <h2 className="text-xs font-semibold text-inksoft mb-2">OSTATNIE WPISY</h2>
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Data i godzina</th>
              <th className="p-3">Pracownik</th>
              <th className="p-3">Czynność</th>
              <th className="p-3 text-right">Punkty</th>
              <th className="p-3">Numer seryjny</th>
              <th className="p-3">Uwagi</th>
            </tr>
          </thead>
          <tbody>
            {!loading && recent.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-inksoft text-sm">Brak wpisów — zarejestruj pierwszy powyżej.</td></tr>
            )}
            {recent.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-paper">
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                <td className="p-3">{displayNameForEmail(r.employee_email, members)}</td>
                <td className="p-3">{TASK_LABEL[r.task_type] || r.task_type}</td>
                <td className="p-3 text-right font-mono font-semibold">{r.points}</td>
                <td className="p-3 font-mono">{r.device_ref || "—"}</td>
                <td className="p-3 text-inksoft">{r.notes || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
