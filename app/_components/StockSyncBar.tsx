"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

// Pasek synchronizacji stanów Back Market <-> refurbed (16.10.2026, Magazyn -> Do wystawienia). Pokazuje, czy automat jest włączony i co zrobił ostatnio; Admin go włącza/wyłącza,
// Admin/Manager/Księgowa mogą uruchomić przebieg od razu. Logika w lib/stockSyncServer.ts (sprawdzane co minutę).
type Settings = { enabled: boolean; activated_at: string | null; activated_by: string | null; last_run_at: string | null; last_result: string | null };
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

export default function StockSyncBar({ session, isAdmin, canRun }: { session: Session; isAdmin: boolean; canRun: boolean }) {
  const [st, setSt] = useState<Settings | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("listing_stock_settings").select("enabled, activated_at, activated_by, last_run_at, last_result").eq("id", 1).maybeSingle();
    if (error) return setMissing(true);
    setMissing(false);
    setSt((data as Settings) ?? null);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function post(body: object) {
    const res = await fetch("/api/listings/stock-sync", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Błąd.");
    return data;
  }
  async function toggle() {
    const turnOn = !st?.enabled;
    if (turnOn && !confirm("Włączyć synchronizację stanów Back Market ↔ refurbed?\n\nOd teraz każda sprzedaż sztuki na jednym marketplace'ie zmniejszy ilość oferty z tym samym SKU na drugim (sprawdzane co minutę; sprzedaż na refurbed po zgłoszeniu webhooka — w kilka sekund). Dotychczasowe zamówienia nie zmienią żadnych stanów.")) return;
    setBusy(true);
    setNote(null);
    try {
      await post({ enabled: turnOn });
      setNote({ ok: true, text: turnOn ? "Synchronizacja włączona." : "Synchronizacja wyłączona." });
      await load();
    } catch (e: any) {
      setNote({ ok: false, text: e.message || String(e) });
    } finally {
      setBusy(false);
    }
  }
  async function runNow() {
    setBusy(true);
    setNote(null);
    try {
      const r = await post({ run: true });
      setNote({ ok: !r.errors?.length, text: r.ran ? `Przebieg zakończony: uwzględniono ${r.applied} szt., pominięto ${r.skipped}, czeka ${r.waiting}${r.errors?.length ? `; błędy: ${r.errors.join(" | ")}` : ""}.` : r.reason || "Nie uruchomiono." });
      await load();
    } catch (e: any) {
      setNote({ ok: false, text: e.message || String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (missing) return <p className="text-xs text-inksoft mb-3">Synchronizacja stanów BM ↔ refurbed: uruchom supabase/listing-stock-sync.sql w Supabase, żeby ją włączyć.</p>;
  if (!st) return null;
  return (
    <div className="text-xs mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span title="Sprzedaż sztuki z SKU na jednym marketplace'ie zmniejsza ilość oferty z tym samym SKU na drugim (sprawdzane co minutę).">
        Synchronizacja stanów BM ↔ refurbed:{" "}
        {st.enabled ? <b className="text-teal">włączona</b> : <b className="text-amber">wyłączona</b>}
        {st.enabled && <span className="text-inksoft"> (od {fmt(st.activated_at)}; ostatni przebieg {fmt(st.last_run_at)}{st.last_result ? ` — ${st.last_result}` : ""})</span>}
      </span>
      {isAdmin && <button onClick={toggle} disabled={busy} className="border border-line bg-white px-2 py-1 rounded font-semibold disabled:opacity-50">{st.enabled ? "Wyłącz" : "Włącz"}</button>}
      {canRun && st.enabled && <button onClick={runNow} disabled={busy} className="border border-line bg-white px-2 py-1 rounded font-semibold disabled:opacity-50">{busy ? "Pracuję…" : "Uruchom teraz"}</button>}
      {note && <span className={note.ok ? "text-teal" : "text-rust"}>{note.text}</span>}
    </div>
  );
}
