"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { warsawYmd } from "@/lib/warsawDate";
import { RECURRENCES, RECURRENCE_LABEL, daysOverdue, fmtDate, nextDueDate, type Recurrence } from "@/lib/reminders";

// Zakładka Przypomnienia (09.10.2026, na razie tylko Admin): ważne komunikaty i zadania cykliczne. Aktywne przypomnienie (termin dziś lub wcześniej, nie zrobione) wyświetla się jako baner
// na górze KAŻDEJ zakładki (ReminderBanners), aż zostanie oznaczone jako zrobione. Cykliczne po "Zrobione" wracają dopiero przy następnym terminie.

type Reminder = {
  id: number;
  message: string;
  due_date: string;
  recurrence: Recurrence;
  anchor_day: number | null;
  done_at: string | null;
  last_done_at: string | null;
  last_done_by_email: string | null;
  done_count: number;
  created_at: string;
};
const COLS = "id, message, due_date, recurrence, anchor_day, done_at, last_done_at, last_done_by_email, done_count, created_at";
const fmtDT = (iso: string) => new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const changed = () => window.dispatchEvent(new Event("reminders-changed")); // odśwież banery na górze strony

export default function RemindersView({ session }: { session: Session }) {
  const [rows, setRows] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const today = warsawYmd(Date.now());
  const [message, setMessage] = useState("");
  const [dueDate, setDueDate] = useState(today);
  const [recurrence, setRecurrence] = useState<Recurrence>("none");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.from("reminders").select(COLS).order("due_date").order("id").limit(500);
    if (err) setError(err.code === "42P01" ? "Brak tabeli przypomnień — uruchom supabase/reminders.sql w Supabase." : `Nie udało się wczytać przypomnień: ${err.message}`);
    else {
      setError("");
      setRows((data as Reminder[]) || []);
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
    const channel = supabase.channel("reminders-changes").on("postgres_changes", { event: "*", schema: "public", table: "reminders" }, () => load()).subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  async function add() {
    const text = message.trim();
    if (!text || !dueDate) return;
    setSaving(true);
    setError("");
    const { error: err } = await supabase.from("reminders").insert({ message: text, due_date: dueDate, recurrence, anchor_day: Number(dueDate.slice(8, 10)), created_by_email: session.user.email ?? null });
    setSaving(false);
    if (err) return setError(`Nie udało się dodać: ${err.message}`);
    setMessage("");
    setDueDate(today);
    setRecurrence("none");
    await load();
    changed();
  }

  async function markDone(r: Reminder) {
    setError("");
    const now = new Date().toISOString();
    const patch =
      r.recurrence === "none"
        ? { done_at: now, last_done_at: now, last_done_by_email: session.user.email ?? null, done_count: r.done_count + 1 }
        : { due_date: nextDueDate(r.due_date, r.recurrence, today, r.anchor_day) ?? r.due_date, last_done_at: now, last_done_by_email: session.user.email ?? null, done_count: r.done_count + 1 };
    const { error: err } = await supabase.from("reminders").update(patch).eq("id", r.id);
    if (err) setError(`Nie udało się oznaczyć jako zrobione: ${err.message}`);
    await load();
    changed();
  }

  async function remove(r: Reminder) {
    if (!confirm(`Usunąć przypomnienie „${r.message.slice(0, 60)}”?${r.recurrence !== "none" ? " Przestanie się powtarzać." : ""}`)) return;
    const { error: err } = await supabase.from("reminders").delete().eq("id", r.id);
    if (err) setError(`Nie udało się usunąć: ${err.message}`);
    await load();
    changed();
  }

  const active = rows.filter((r) => !r.done_at && r.due_date <= today);
  const planned = rows.filter((r) => !r.done_at && r.due_date > today);
  const done = rows.filter((r) => r.done_at).sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? "")).slice(0, 20);

  const Row = ({ r, state }: { r: Reminder; state: "active" | "planned" | "done" }) => {
    const late = daysOverdue(r.due_date, today);
    return (
      <tr className="border-b border-line last:border-b-0 align-top">
        <td className="p-3 whitespace-pre-wrap break-words max-w-xl">{r.message}</td>
        <td className="p-3 whitespace-nowrap text-xs">
          {state === "done" ? (
            <span className="text-inksoft">zrobione {r.done_at ? fmtDT(r.done_at) : ""}</span>
          ) : (
            <>
              <div className="font-mono">{fmtDate(r.due_date)}</div>
              {state === "active" ? (
                <div className={late > 0 ? "text-rust font-semibold" : "text-amber font-semibold"}>{late > 0 ? `zaległe od ${late} ${late === 1 ? "dnia" : "dni"}` : "dziś"}</div>
              ) : (
                <div className="text-inksoft">za {-late} {-late === 1 ? "dzień" : "dni"}</div>
              )}
            </>
          )}
        </td>
        <td className="p-3 text-xs whitespace-nowrap">{RECURRENCE_LABEL[r.recurrence]}</td>
        <td className="p-3 text-xs text-inksoft whitespace-nowrap">{r.last_done_at && r.recurrence !== "none" ? `ostatnio: ${fmtDT(r.last_done_at)} (${r.done_count}×)` : "—"}</td>
        <td className="p-3 whitespace-nowrap text-right">
          {state === "active" && <button onClick={() => markDone(r)} className="bg-teal text-paper px-3 py-1 rounded text-xs font-semibold mr-3">Zrobione ✓</button>}
          <button onClick={() => remove(r)} className="text-xs font-semibold text-rust hover:underline">Usuń</button>
        </td>
      </tr>
    );
  };
  const Table = ({ title, items, state, empty }: { title: string; items: Reminder[]; state: "active" | "planned" | "done"; empty: string }) => (
    <div className="mb-6">
      <h2 className="text-xs font-semibold text-inksoft mb-2">{title} ({items.length})</h2>
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Komunikat</th>
              <th className="p-3">{state === "done" ? "Zrobione" : "Termin"}</th>
              <th className="p-3">Powtarzanie</th>
              <th className="p-3">Cykl</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {!loading && items.length === 0 && <tr><td colSpan={5} className="p-5 text-center text-inksoft text-sm">{empty}</td></tr>}
            {items.map((r) => <Row key={r.id} r={r} state={state} />)}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="max-w-5xl">
      <div className="border border-line bg-white p-4 mb-6">
        <div className="text-xs font-semibold text-inksoft mb-2">NOWE PRZYPOMNIENIE</div>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} rows={2} placeholder="Treść komunikatu — będzie widoczna na górze strony, dopóki nie oznaczysz jako zrobione" className="w-full border border-line bg-white px-3 py-2 rounded text-sm" />
        <div className="flex flex-wrap items-center gap-4 mt-2">
          <label className="flex items-center gap-2 text-xs font-semibold text-inksoft">Od dnia
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="border border-line bg-white px-2 py-1.5 rounded text-sm font-normal text-ink" />
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-inksoft">Powtarzaj
            <select value={recurrence} onChange={(e) => setRecurrence(e.target.value as Recurrence)} className="border border-line bg-white px-2 py-1.5 rounded text-sm font-normal text-ink">
              {RECURRENCES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </label>
          <button onClick={add} disabled={saving || !message.trim() || !dueDate} className="ml-auto bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">{saving ? "Dodawanie…" : "Dodaj przypomnienie"}</button>
        </div>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}
      <Table title="AKTYWNE — widoczne na górze strony" items={active} state="active" empty="Brak aktywnych przypomnień." />
      <Table title="ZAPLANOWANE" items={planned} state="planned" empty="Brak zaplanowanych przypomnień." />
      <Table title="ZROBIONE (jednorazowe, ostatnie 20)" items={done} state="done" empty="Nic jeszcze nie zrobione." />
      <p className="text-[11px] text-inksoft max-w-3xl">Aktywne przypomnienie (termin dziś lub wcześniej) pojawia się na górze każdej zakładki. Jednorazowe znika po „Zrobione”. Cykliczne po „Zrobione” wraca dopiero przy następnym terminie (zaległe cykle są pomijane). Na górze strony pokazują się też automatyczne komunikaty: wnioski urlopowe do rozpatrzenia, zadania z Backlogu przypisane do Ciebie i nowe zapotrzebowania dla serwisu — znikają same, gdy sprawa zostanie załatwiona. Zakładka jest na razie tylko dla Admina.</p>
    </div>
  );
}
