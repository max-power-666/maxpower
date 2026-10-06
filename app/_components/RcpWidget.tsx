"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { RCP_AREAS, fmtHm, RCP_KIND_LABEL, type RcpKind } from "@/lib/rcp";

// Widżet RCP na górze paska bocznego po lewej (06.10.2026; wcześniej w prawym górnym rogu): zegar i JEDEN duży przycisk, którego kolor mówi o stanie — czerwony (nie pracujesz),
// zielony (pracujesz), pomarańczowy (przerwa / wyjście); kliknięcie otwiera menu akcji dla bieżącego stanu. Widoczny na każdej zakładce dla każdej osoby z rolą.
// Rejestrować czas można tylko z komputerów w firmie (serwer sprawdza adres IP — patrz api/rcp/action); poza firmą widżet pokazuje stan, ale przyciski są zablokowane.

type Open = { id: number; kind: RcpKind; area: string | null; started_at: string; needs_review: boolean };
type State = { open: Open | null; ip: string; restricted: boolean; ipAllowed: boolean };

const ROLE_AREA: Record<string, string> = { Serwis: "Serwis", "Kierownik serwisu": "Serwis", Testy: "Testy", "Trade-in": "Trade-in", Magazyn: "Magazyn", Zamówienia: "Zamówienia" };

export default function RcpWidget({ session, role, onOpenRcp }: { session: Session; role: string; onOpenRcp: () => void }) {
  const [st, setSt] = useState<State | null>(null);
  const [setup, setSetup] = useState(false);
  const [tick, setTick] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<"main" | "area" | "end" | null>(null);
  const [loadError, setLoadError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const auth = { Authorization: `Bearer ${session.access_token}` };

  // Trwający odcinek czytamy BEZPOŚREDNIO z bazy przez RLS (własne wiersze — to samo zapytanie, którego używa lista "Teraz w pracy"), a z serwera (api/rcp/state)
  // tylko adres IP i ograniczenie do komputerów w firmie. Dzięki temu kolor przycisku zawsze zgadza się z tym, co jest w bazie.
  const load = useCallback(async () => {
    const [own, srv] = await Promise.allSettled([
      supabase.from("rcp_segments").select("id, kind, area, started_at, needs_review").eq("user_id", session.user.id).is("ended_at", null).maybeSingle(),
      fetch("/api/rcp/state", { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" }).then((r) => r.json()),
    ]);
    const srvData = srv.status === "fulfilled" ? srv.value : null;
    if (srvData?.setup) return setSetup(true);
    const ownRes = own.status === "fulfilled" ? own.value : null;
    if (ownRes?.error?.code === "42P01") return setSetup(true);
    setSetup(false);
    setLoadError(!srvData?.ok ? `Nie udało się sprawdzić adresu komputera${srvData?.error ? `: ${srvData.error}` : ""}.` : ownRes?.error ? `Nie udało się wczytać stanu: ${ownRes.error.message}` : "");
    setSt((prev) => ({
      open: ownRes && !ownRes.error ? ((ownRes.data as Open | null) ?? null) : srvData?.ok ? srvData.open : prev?.open ?? null,
      ip: srvData?.ok ? srvData.ip : prev?.ip ?? "",
      restricted: srvData?.ok ? srvData.restricted : prev?.restricted ?? false,
      ipAllowed: srvData?.ok ? srvData.ipAllowed : prev?.ipAllowed ?? true,
    }));
  }, [session.access_token, session.user.id]);

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
      setSt((prev) => (prev ? { ...prev, open: (data.open as Open | null) ?? null } : prev)); // od razu, bez czekania na odczyt
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
  // Kolor przycisku = stan: czerwony (nie pracujesz), zielony (pracujesz), pomarańczowy (przerwa albo wyjście).
  const tone = !open ? "bg-rust text-paper" : working ? "bg-teal text-paper" : "bg-amber text-paper";
  const label = !open ? "Rozpocznij pracę" : working ? `W pracy${open.area ? ` · ${open.area}` : ""}` : RCP_KIND_LABEL[open.kind];
  const item = "w-full text-left px-3 py-2 text-sm font-semibold hover:bg-paper";

  return (
    <div ref={box} className="relative mb-5">
      <div className="font-mono text-lg font-bold tabular-nums text-center mb-2">{clock}</div>
      <button
        onClick={() => setMenu(menu ? null : "main")}
        disabled={busy || blocked}
        title={blocked ? "Tylko komputery w firmie" : "Rejestracja czasu pracy"}
        className={`w-full rounded px-2 py-3 text-center font-bold leading-tight shadow-sm disabled:opacity-50 disabled:cursor-not-allowed ${tone}`}
      >
        <div className="text-sm">{!open ? "▶ " : working ? "● " : "⏸ "}{label}</div>
        {open && <div className="font-mono text-xs font-semibold opacity-90 mt-0.5">{fmtHm(since)}</div>}
      </button>

      {menu && (
        <div className="absolute left-0 top-full mt-1 z-30 w-56 border border-line bg-white rounded shadow-sm py-1">
          {menu === "main" && !open && (
            <>
              <div className="px-3 py-1 text-[11px] font-semibold text-inksoft">W JAKIM OBSZARZE PRACUJESZ?</div>
              {areas.map((a) => (
                <button key={a} onClick={() => act("start", { area: a })} className={item}>{a}</button>
              ))}
            </>
          )}
          {menu === "main" && open && working && (
            <>
              <button onClick={() => act("break")} className={item}>⏸ Przerwa</button>
              <button onClick={() => act("leave", { leave: "sluzbowe" })} className={item}>Wyjście służbowe</button>
              <button onClick={() => act("leave", { leave: "prywatne" })} className={item}>Wyjście prywatne</button>
              <button onClick={() => setMenu("area")} className={item}>Zmień obszar ›</button>
              <button onClick={() => setMenu("end")} className={`${item} text-rust`}>⏹ Zakończ pracę</button>
            </>
          )}
          {menu === "main" && open && !working && (
            <>
              <button onClick={() => act("resume")} className={item}>▶ Wróć do pracy</button>
              <button onClick={() => setMenu("end")} className={`${item} text-rust`}>⏹ Zakończ pracę</button>
            </>
          )}
          {menu === "end" && (
            <>
              <div className="px-3 py-1 text-[11px] font-semibold text-inksoft">ZAKOŃCZYĆ PRACĘ NA DZIŚ?</div>
              <button onClick={() => act("end")} className={`${item} text-rust`}>Tak, zakończ</button>
              <button onClick={() => setMenu("main")} className={item}>Anuluj</button>
            </>
          )}
          {menu === "area" && open && (
            <>
              <div className="px-3 py-1 text-[11px] font-semibold text-inksoft">ZMIEŃ OBSZAR PRACY</div>
              {areas.filter((a) => a !== open.area).map((a) => (
                <button key={a} onClick={() => act("change_area", { area: a })} className={item}>→ {a}</button>
              ))}
            </>
          )}
        </div>
      )}

      <button onClick={onOpenRcp} className="block w-full text-center text-[11px] font-semibold text-inksoft hover:text-ink mt-1.5">Mój czas ›</button>
      {(error || blocked || loadError) && (
        <div className="mt-1.5 text-[11px] leading-snug text-rust">
          {error || (blocked ? `Rejestracja czasu działa tylko z komputerów w firmie. Twój adres: ${st.ip || "nieznany"}.` : loadError)}
        </div>
      )}
    </div>
  );
}
