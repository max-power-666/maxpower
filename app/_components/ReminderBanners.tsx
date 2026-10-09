"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { warsawYmd } from "@/lib/warsawDate";
import { daysOverdue, fmtDate, isVisibleReminder, nextDueDate, RECURRENCE_LABEL, type Recurrence } from "@/lib/reminders";

// Komunikaty na górze strony (09.10.2026, na razie tylko Admin): (1) aktywne przypomnienia z zakładki Przypomnienia — aż do "Zrobione", (2) automatyczne: wnioski urlopowe do rozpatrzenia,
// zadania Backlogu przypisane do zalogowanej osoby (do zrobienia / w toku / do sprawdzenia) i nowe zapotrzebowania dla serwisu. Automatyczne znikają same po załatwieniu sprawy.

type Active = { id: number; message: string; due_date: string; recurrence: Recurrence; anchor_day: number | null; done_count: number; lead_days?: number };
type Auto = { key: string; icon: string; text: string; view: string; sub?: { storage: string; value: string } };

export default function ReminderBanners({ session, onOpen }: { session: Session; onOpen: (view: string) => void }) {
  const [active, setActive] = useState<Active[]>([]);
  const [auto, setAuto] = useState<Auto[]>([]);
  const today = warsawYmd(Date.now());
  const email = session.user.email ?? "";

  const load = useCallback(async () => {
    const day = warsawYmd(Date.now());
    const horizon = new Date(Date.now() + 61 * 86_400_000); // najdalszy możliwy termin z wyprzedzeniem (max 60 dni)
    const [rem, leave, backlog, reqs] = await Promise.all([
      supabase.from("reminders").select("id, message, due_date, recurrence, anchor_day, done_count, lead_days").is("done_at", null).lte("due_date", warsawYmd(horizon.getTime())).order("due_date").limit(200),
      supabase.from("rcp_absences").select("id", { count: "exact", head: true }).eq("status", "oczekuje"),
      email ? supabase.from("backlog_items").select("id, priority").ilike("assignee_email", email.replace(/[\\%_]/g, "\\$&")).in("status", ["todo", "in_progress", "review"]).limit(500) : Promise.resolve({ data: [], error: null }),
      supabase.from("service_requests").select("id", { count: "exact", head: true }).eq("status", "nowe"),
    ]);
    let remRows = rem.error ? [] : ((rem.data as Active[]) || []);
    if (rem.error?.code === "42703") {
      // brak kolumny lead_days (nie uruchomiono reminders.sql) — działamy jak dotąd: baner dopiero w dniu terminu
      const old = await supabase.from("reminders").select("id, message, due_date, recurrence, anchor_day, done_count").is("done_at", null).lte("due_date", day).order("due_date").limit(200);
      remRows = old.error ? [] : ((old.data as Active[]) || []);
    }
    setActive(remRows.filter((r) => isVisibleReminder(r.due_date, r.lead_days ?? 0, day)));
    const list: Auto[] = [];
    const leaveN = leave.error ? 0 : leave.count ?? 0;
    if (leaveN > 0) list.push({ key: "leave", icon: "🏖", text: `Wnioski urlopowe do rozpatrzenia: ${leaveN}`, view: "rcp", sub: { storage: "rcp-sub", value: "requests" } });
    const bl = (backlog.error ? [] : (backlog.data as { id: number; priority: string }[])) || [];
    if (bl.length > 0) {
      const p1 = bl.filter((b) => b.priority === "p1").length;
      list.push({ key: "backlog", icon: "📋", text: `Zadania w Backlogu przypisane do Ciebie: ${bl.length}${p1 > 0 ? ` (w tym pilne P1: ${p1})` : ""}`, view: "backlog" });
    }
    const reqN = reqs.error ? 0 : reqs.count ?? 0;
    if (reqN > 0) list.push({ key: "requests", icon: "🔧", text: `Nowe zapotrzebowania dla serwisu: ${reqN}`, view: "sales", sub: { storage: "sales-sub", value: "requests" } });
    setAuto(list);
  }, [email]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    const onFocus = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("reminders-changed", load);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("reminders-changed", load);
    };
  }, [load]);

  async function done(r: Active) {
    const now = new Date().toISOString();
    const patch =
      r.recurrence === "none"
        ? { done_at: now, last_done_at: now, last_done_by_email: email || null, done_count: r.done_count + 1 }
        : { due_date: nextDueDate(r.due_date, r.recurrence, today, r.anchor_day) ?? r.due_date, last_done_at: now, last_done_by_email: email || null, done_count: r.done_count + 1 };
    setActive((prev) => prev.filter((x) => x.id !== r.id)); // od razu znika, serwer dociągnie resztę
    await supabase.from("reminders").update(patch).eq("id", r.id);
    window.dispatchEvent(new Event("reminders-changed"));
  }

  function open(a: Auto) {
    try {
      if (a.sub) sessionStorage.setItem(a.sub.storage, a.sub.value);
    } catch {
      /* sessionStorage może być niedostępne — otworzymy zakładkę bez podstrony */
    }
    onOpen(a.view);
  }

  if (active.length === 0 && auto.length === 0) return null;
  return (
    <div className="px-8 pt-4 space-y-2">
      {active.map((r) => {
        const late = daysOverdue(r.due_date, today);
        return (
          <div key={r.id} className={`flex items-start gap-3 border px-4 py-3 rounded ${late > 0 ? "bg-rustsoft border-rust text-rust" : late === 0 ? "bg-ambersoft border-amber text-ink" : "bg-tealsoft border-teal text-ink"}`}>
            <span className="text-lg leading-none">🔔</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold whitespace-pre-wrap break-words">{r.message}</div>
              <div className="text-[11px] opacity-80 mt-0.5">{late > 0 ? `zaległe od ${late} ${late === 1 ? "dnia" : "dni"} (termin ${fmtDate(r.due_date)})` : late === 0 ? "termin: dziś" : `termin za ${-late} ${-late === 1 ? "dzień" : "dni"} (${fmtDate(r.due_date)})`}{r.recurrence !== "none" ? ` · ${RECURRENCE_LABEL[r.recurrence].toLowerCase()}` : ""}</div>
            </div>
            <button onClick={() => done(r)} className="shrink-0 bg-ink text-paper px-3 py-1.5 rounded text-xs font-semibold">Zrobione ✓</button>
          </div>
        );
      })}
      {auto.map((a) => (
        <div key={a.key} className="flex items-center gap-3 border border-line bg-white px-4 py-2.5 rounded">
          <span className="text-lg leading-none">{a.icon}</span>
          <div className="flex-1 text-sm font-semibold">{a.text}</div>
          <button onClick={() => open(a)} className="shrink-0 text-xs font-semibold text-teal hover:underline">Otwórz →</button>
        </div>
      ))}
    </div>
  );
}
