"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { ACTIVE_REQUEST_STATUSES, REQUEST_PRIORITIES, REQUEST_PRIORITY_LABEL, REQUEST_PRIORITY_RANK, REQUEST_STATUSES, REQUEST_STATUS_LABEL, requestCode, type RequestPriority, type RequestStatus } from "@/lib/serviceRequests";

// Zamówienia -> Zapotrzebowanie (08.10.2026): pracownicy zlecają zadania dla serwisu (dowolna treść albo numer zamówienia + priorytet; autor, data i numer ZAP-n automatycznie), serwisant przyjmuje zlecenie i ustawia status.
// Kto może zmieniać status, pilnuje baza (trigger service_requests_guard); tu przyciski i lista statusu pokazują się tylko serwisantom (canHandle).

type Req = {
  id: number;
  message: string;
  created_by_email: string | null;
  created_at: string;
  status: RequestStatus;
  priority: RequestPriority;
  accepted_by_email: string | null;
  accepted_at: string | null;
  status_changed_by_email: string | null;
  status_changed_at: string | null;
};
const COLS = "id, message, created_by_email, created_at, status, priority, accepted_by_email, accepted_at, status_changed_by_email, status_changed_at";
const STATUS_STYLE: Record<RequestStatus, string> = {
  nowe: "bg-ambersoft text-amber",
  przyjete: "bg-[#e3ecf9] text-[#2a6bb5]",
  w_realizacji: "bg-[#efe6f8] text-[#7a3fb0]",
  zrobione: "bg-tealsoft text-teal",
  odrzucone: "bg-rustsoft text-rust",
};
const PRIORITY_STYLE: Record<RequestPriority, string> = {
  wysoki: "bg-rustsoft text-rust",
  sredni: "bg-ambersoft text-amber",
  niski: "bg-paper text-inksoft border border-line",
};
const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const fmtDT = (iso: string) => new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default function ServiceRequestsView({ session, members, canHandle }: { session: Session; members: MemberLite[]; canHandle: boolean }) {
  const [rows, setRows] = useState<Req[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [priority, setPriority] = useState<RequestPriority>("sredni");
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<"active" | "all" | RequestStatus>("active");
  const [searchInput, setSearchInput] = useState("");

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.from("service_requests").select(COLS).order("id", { ascending: false }).limit(500);
    if (err) setError(err.code === "42P01" ? "Brak tabeli zleceń — uruchom supabase/service-requests.sql w Supabase." : `Nie udało się wczytać zleceń: ${err.message}`);
    else {
      setError("");
      setRows((data as Req[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel("service-requests-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "service_requests" }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(load, 500);
      })
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [load]);

  async function add() {
    const text = message.trim();
    if (!text) return;
    setSaving(true);
    setError("");
    const { error: err } = await supabase.from("service_requests").insert({ message: text, priority });
    setSaving(false);
    if (err) return setError(err.code === "42P01" ? "Brak tabeli zleceń — uruchom supabase/service-requests.sql w Supabase." : `Nie udało się dodać zadania: ${err.message}`);
    setMessage("");
    setPriority("sredni");
    load();
  }

  async function setStatus(id: number, status: RequestStatus) {
    setError("");
    const { data, error: err } = await supabase.from("service_requests").update({ status }).eq("id", id).select("id");
    if (err) setError(`Nie udało się zmienić statusu: ${err.message}`);
    else if (!data?.length) setError("Nie zmieniono — status zlecenia zmieniają tylko serwisanci.");
    load();
  }

  const name = (email: string | null) => (email ? displayNameForEmail(email, members) : "—");
  const search = searchInput.trim().toLowerCase();
  const visible = useMemo(
    () =>
      rows
        .filter((r) => {
        if (filter === "active" ? !ACTIVE_REQUEST_STATUSES.includes(r.status) : filter !== "all" && r.status !== filter) return false;
        if (!search) return true;
        return r.message.toLowerCase().includes(search) || requestCode(r.id).toLowerCase().includes(search) || name(r.created_by_email).toLowerCase().includes(search);
        })
        // aktywne: najpierw wysoki priorytet, potem najnowsze; pozostałe widoki po numerze malejąco
        .sort((a, b) => (filter === "active" ? REQUEST_PRIORITY_RANK[a.priority] - REQUEST_PRIORITY_RANK[b.priority] || b.id - a.id : b.id - a.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, filter, search, members]
  );
  const count = (f: (r: Req) => boolean) => rows.filter(f).length;
  void session;

  return (
    <div>
      <div className="border border-line bg-white p-4 mb-5">
        <div className="text-xs font-semibold text-inksoft mb-2">NOWE ZAPOTRZEBOWANIE DLA SERWISU</div>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Wpisz, czego potrzeba — np. „pad ps4 red” albo numer zamówienia"
          className="w-full border border-line bg-white px-3 py-2 rounded text-sm"
        />
        <div className="flex flex-wrap items-center justify-between gap-3 mt-2">
          <label className="flex items-center gap-2 text-xs font-semibold text-inksoft">
            Priorytet
            <select value={priority} onChange={(e) => setPriority(e.target.value as RequestPriority)} className="border border-line bg-white px-2 py-1.5 rounded text-sm font-normal text-ink">
              {REQUEST_PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
          <span className="text-[11px] text-inksoft flex-1 min-w-48">Numer zlecenia, datę i Twoje imię dodajemy automatycznie.</span>
          <button onClick={add} disabled={saving || !message.trim()} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">{saving ? "Dodawanie…" : "Dodaj zadanie"}</button>
        </div>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button onClick={() => setFilter("active")} className={pill(filter === "active")}>Aktywne ({count((r) => ACTIVE_REQUEST_STATUSES.includes(r.status))})</button>
        {REQUEST_STATUSES.filter((s) => s.key === "zrobione" || s.key === "odrzucone").map((s) => (
          <button key={s.key} onClick={() => setFilter(s.key)} className={pill(filter === s.key)}>{s.label} ({count((r) => r.status === s.key)})</button>
        ))}
        <button onClick={() => setFilter("all")} className={pill(filter === "all")}>Wszystkie ({rows.length})</button>
        <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Szukaj: treść, ZAP-nr, osoba" className="ml-auto border border-line bg-white px-3 py-1.5 rounded text-sm w-64" />
      </div>

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">ID</th>
              <th className="p-3">Data</th>
              <th className="p-3">Zlecił(a)</th>
              <th className="p-3">Priorytet</th>
              <th className="p-3">Zapotrzebowanie</th>
              <th className="p-3">Status</th>
              <th className="p-3">Przyjął(ęła)</th>
              {canHandle && <th className="p-3"></th>}
            </tr>
          </thead>
          <tbody>
            {!loading && visible.length === 0 && !error && <tr><td colSpan={canHandle ? 8 : 7} className="p-6 text-center text-inksoft text-sm">{rows.length === 0 ? "Brak zleceń — dodaj pierwsze powyżej." : "Brak zleceń w tym widoku."}</td></tr>}
            {visible.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-b-0 align-top">
                <td className="p-3 font-mono text-xs font-semibold whitespace-nowrap">{requestCode(r.id)}</td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDT(r.created_at)}</td>
                <td className="p-3 font-semibold whitespace-nowrap">{name(r.created_by_email)}</td>
                <td className="p-3 whitespace-nowrap"><span className={`text-xs font-semibold px-2 py-1 rounded ${PRIORITY_STYLE[r.priority]}`}>{REQUEST_PRIORITY_LABEL[r.priority]}</span></td>
                <td className="p-3 whitespace-pre-wrap break-words max-w-xl">{r.message}</td>
                <td className="p-3 whitespace-nowrap">
                  {canHandle ? (
                    <select value={r.status} onChange={(e) => setStatus(r.id, e.target.value as RequestStatus)} className={`text-xs font-semibold px-2 py-1 rounded border border-line ${STATUS_STYLE[r.status]}`}>
                      {REQUEST_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  ) : (
                    <span className={`text-xs font-semibold px-2 py-1 rounded ${STATUS_STYLE[r.status]}`}>{REQUEST_STATUS_LABEL[r.status]}</span>
                  )}
                  {r.status_changed_at && <div className="text-[10px] text-inksoft mt-1">{fmtDT(r.status_changed_at)}</div>}
                </td>
                <td className="p-3 text-xs whitespace-nowrap">{r.accepted_at ? <>{name(r.accepted_by_email)}<div className="text-[10px] text-inksoft">{fmtDT(r.accepted_at)}</div></> : <span className="text-inksoft">—</span>}</td>
                {canHandle && (
                  <td className="p-3 whitespace-nowrap">
                    {r.status === "nowe" && <button onClick={() => setStatus(r.id, "przyjete")} className="bg-teal text-paper px-3 py-1 rounded text-xs font-semibold">Przyjmij</button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-inksoft mt-3 max-w-3xl">Zapotrzebowania dodaje każdy; przyjmuje je i zmienia status serwisant (Serwis, Kierownik serwisu, Manager, Admin). „Przyjęte” zapisuje, kto i kiedy zajął się zleceniem.</p>
    </div>
  );
}
