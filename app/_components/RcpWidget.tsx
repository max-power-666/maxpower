"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { RCP_AREAS, fmtHm, RCP_KIND_LABEL, type RcpKind } from "@/lib/rcp";

// Widżet RCP w prawym górnym rogu (06.10.2026): zegar, stan rejestracji i duże przyciski start / przerwa / wyjście / koniec. Widoczny na każdej zakładce dla każdej osoby z rolą.
// Rejestrować czas można tylko z komputerów w firmie (serwer sprawdza adres IP — patrz api/rcp/action); poza firmą widżet pokazuje stan, ale przyciski są zablokowane.

type Open = { id: number; kind: RcpKind; area: string | null; started_at: string; needs_review: boolean };
type State = { open: Open | null; ip: string; restricted: boolean; ipAllowed: boolean };

const ROLE_AREA: Record<string, string> = { Serwis: "Serwis", "Kierownik serwisu": "Serwis", Testy: "Testy", "Trade-in": "Trade-in", Magazyn: "Magazyn", Zamówienia: "Zamówienia" };
const btn = "px-4 py-2 rounded text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed";

export default function RcpWidget({ session, role, onOpenRcp }: { session: Session; role: string; onOpenRcp: () => void }) {
  const [st, setSt] = useState<State | null>(null);
  const [setup, setSetup] = useState(false);
  const [tick, setTick] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<"start" | "leave" | "area" | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const auth = { Authorization: `Bearer ${session.access_token}` };

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/rcp/state", { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
      const data = await res.json();
      if (data?.setup) return setSetup(true);
      if (res.ok && data?.ok) {
        setSetup(false);
        setSt({ open: data.open, ip: data.ip, restricted: data.restricted, ipAllowed: data.ipAllowed });
      }
    } catch {
      /* brak sieci — zostaje poprzedni stan */
    }
  }, [session.access_token]);

  useEffect(() => {
    load();
    const poll = setInterval(load, 30_000);
    const clock = setInterval(() => setTick(Date.now()), 1000);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setMenu(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  async function act(action: string, extra: Record<string, string> = {}) {
    setBusy(true);
    setError("");
    setMenu(null);
    try {
      const res = await fetch("/api/rcp/action", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw new Error(data?.error || "Nie udało się zarejestrować.");
      await load();
    } catch (e: any) {
      setError(e.message || "Nie udało się zarejestrować.");
      load();
    } finally {
      setBusy(false);
    }
  }

  if (setup || !st) return null;
  const open = st.open;
  const blocked = st.restricted && !st.ipAllowed;
  const clock = new Date(tick).toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const since = open ? Math.max(0, tick - Date.parse(open.started_at)) : 0;
  const suggested = ROLE_AREA[role];
  const areas = suggested ? [suggested, ...RCP_AREAS.filter((a) => a !== suggested)] : [...RCP_AREAS];
  const working = open?.kind === "praca";
  const dot = !open ? "bg-inksoft" : working ? "bg-teal" : "bg-amber";

  return (
    <div ref={box} className="relative flex items-center gap-4">
      <div className="text-right leading-tight">
        <div className="font-mono text-xl font-bold tabular-nums">{clock}</div>
        <button onClick={onOpenRcp} className="flex items-center justify-end gap-1.5 text-xs font-semibold text-inksoft hover:text-ink">
          <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
          {!open ? "Poza pracą" : working ? `W pracy · ${open.area ?? "—"}` : `${RCP_KIND_LABEL[open.kind]}`}
          {open && <span className="font-mono">· {fmtHm(since)}</span>}
        </button>
      </div>

      {!open && (
        <div className="relative">
          <button onClick={() => setMenu(menu === "start" ? null : "start")} disabled={busy || blocked} title={blocked ? "Tylko komputery w firmie" : undefined} className={`${btn} bg-teal text-paper text-base px-6 py-3`}>
            ▶ Rozpocznij pracę
          </button>
          {menu === "start" && (
            <div className="absolute right-0 top-full mt-1 z-30 w-56 border border-line bg-white rounded shadow-sm py-1">
              <div className="px-3 py-1 text-[11px] font-semibold text-inksoft">W JAKIM OBSZARZE PRACUJESZ?</div>
              {areas.map((a) => (
                <button key={a} onClick={() => act("start", { area: a })} className="w-full text-left px-3 py-2 text-sm font-semibold hover:bg-paper">{a}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {open && working && (
        <>
          <div className="relative">
            <button onClick={() => setMenu(menu === "area" ? null : "area")} disabled={busy || blocked} className={`${btn} bg-white border border-line`} title="Zmień obszar pracy">
              {open.area ?? "Obszar"} ▾
            </button>
            {menu === "area" && (
              <div className="absolute right-0 top-full mt-1 z-30 w-48 border border-line bg-white rounded shadow-sm py-1">
                {areas.filter((a) => a !== open.area).map((a) => (
                  <button key={a} onClick={() => act("change_area", { area: a })} className="w-full text-left px-3 py-2 text-sm font-semibold hover:bg-paper">→ {a}</button>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => act("break")} disabled={busy || blocked} className={`${btn} bg-ambersoft text-amber`}>⏸ Przerwa</button>
          <div className="relative">
            <button onClick={() => setMenu(menu === "leave" ? null : "leave")} disabled={busy || blocked} className={`${btn} bg-white border border-line`}>Wyjście ▾</button>
            {menu === "leave" && (
              <div className="absolute right-0 top-full mt-1 z-30 w-44 border border-line bg-white rounded shadow-sm py-1">
                <button onClick={() => act("leave", { leave: "sluzbowe" })} className="w-full text-left px-3 py-2 text-sm font-semibold hover:bg-paper">Służbowe</button>
                <button onClick={() => act("leave", { leave: "prywatne" })} className="w-full text-left px-3 py-2 text-sm font-semibold hover:bg-paper">Prywatne</button>
              </div>
            )}
          </div>
          <button onClick={() => confirm("Zakończyć pracę na dziś?") && act("end")} disabled={busy || blocked} className={`${btn} bg-rustsoft text-rust`}>⏹ Zakończ</button>
        </>
      )}

      {open && !working && (
        <>
          <button onClick={() => act("resume")} disabled={busy || blocked} className={`${btn} bg-teal text-paper text-base px-6 py-3`}>▶ Wróć do pracy</button>
          <button onClick={() => confirm("Zakończyć pracę na dziś?") && act("end")} disabled={busy || blocked} className={`${btn} bg-rustsoft text-rust`}>⏹ Zakończ</button>
        </>
      )}

      {(error || blocked) && (
        <div className="absolute right-0 top-full mt-2 z-20 max-w-sm text-xs text-rust bg-white border border-line rounded px-3 py-2 shadow-sm">
          {error || `Rejestracja czasu pracy działa tylko z komputerów w firmie. Twój adres: ${st.ip || "nieznany"}.`}
        </div>
      )}
    </div>
  );
}
