"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { workdaysBetween } from "@/lib/holidays";
import { ABSENCE_KINDS, ABSENCE_STATUS_LABEL, absenceKind, datesOverlap, leaveUsage, type Absence, type AbsenceStatus } from "@/lib/rcpAbsence";
import { warsawDay } from "@/lib/rcp";

// Wnioski urlopowe i nieobecności w RCP (07.10.2026). Pracownik: saldo, formularz wniosku, własna lista (z możliwością wycofania). Admin/Manager: wnioski do rozpatrzenia (z informacją,
// kto jeszcze jest wtedy nieobecny), wpisywanie nieobecności za pracownika (np. L4), historia z anulowaniem, limity urlopowe (edytuje Admin). Zapis idzie przez api/rcp/absence.

const inp = "border border-line bg-white px-2 py-1.5 rounded text-sm w-full";
const fmtD = (d: string) => `${d.slice(8)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const term = (a: { date_from: string; date_to: string }) => (a.date_from === a.date_to ? fmtD(a.date_from) : `${fmtD(a.date_from)} – ${fmtD(a.date_to)}`);
const STATUS_STYLE: Record<AbsenceStatus, string> = {
  oczekuje: "bg-ambersoft text-amber",
  zaakceptowany: "bg-tealsoft text-teal",
  odrzucony: "bg-rustsoft text-rust",
  wycofany: "bg-paper text-inksoft border border-line",
  anulowany: "bg-paper text-inksoft border border-line",
};
const Badge = ({ s }: { s: AbsenceStatus }) => <span className={`text-xs font-semibold px-2 py-1 rounded ${STATUS_STYLE[s]}`}>{ABSENCE_STATUS_LABEL[s]}</span>;

async function post(session: Session, body: Record<string, unknown>): Promise<{ ok?: boolean; error?: string; warning?: string | null; workdays?: number }> {
  const res = await fetch("/api/rcp/absence", { method: "POST", headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) return { error: data?.error || "Nie udało się zapisać." };
  return data;
}

async function fetchYear(year: number, userId?: string): Promise<Absence[]> {
  let q = supabase.from("rcp_absences").select("*").lte("date_from", `${year}-12-31`).gte("date_to", `${year}-01-01`).order("date_from", { ascending: false }).limit(1000);
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) throw error;
  return (data as Absence[]) || [];
}
const setupMsg = (e: { code?: string; message: string }) => (e.code === "42P01" ? "Brak tabel nieobecności — uruchom supabase/rcp.sql w Supabase." : `Nie udało się wczytać: ${e.message}`);

function AbsenceForm({ session, members, forUser, onDone }: { session: Session; members: { user_id: string; email: string }[]; forUser: boolean; onDone: () => void }) {
  const today = warsawDay(Date.now());
  const [f, setF] = useState({ user_id: "", kind: "urlop_wypoczynkowy", from: today, to: today, note: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const days = f.from && f.to && f.to >= f.from ? workdaysBetween(f.from, f.to) : 0;

  async function submit() {
    setBusy(true);
    setMsg(null);
    const r = await post(session, { action: forUser ? "create_for" : "create", user_id: f.user_id, kind: f.kind, date_from: f.from, date_to: f.to, note: f.note });
    setBusy(false);
    if (r.error) return setMsg({ text: r.error, bad: true });
    setMsg({ text: `${forUser ? "Wpisano nieobecność" : "Wniosek złożony"} (${r.workdays} dni roboczych).${r.warning ? ` Uwaga: ${r.warning}` : ""}`, bad: false });
    setF({ ...f, note: "" });
    onDone();
  }

  return (
    <div className="border border-line bg-white p-4">
      <div className="text-xs font-semibold text-inksoft mb-3">{forUser ? "DODAJ NIEOBECNOŚĆ PRACOWNIKA (od razu zaakceptowana)" : "NOWY WNIOSEK"}</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        {forUser && (
          <label className="text-xs font-semibold text-inksoft">Pracownik
            <select value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })} className={inp + " mt-1 font-normal"}>
              <option value="">— wybierz —</option>
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{displayNameForEmail(m.email, [])}</option>)}
            </select>
          </label>
        )}
        <label className="text-xs font-semibold text-inksoft">Rodzaj
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className={inp + " mt-1 font-normal"}>
            {ABSENCE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-inksoft">Od<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, to: f.to < e.target.value ? e.target.value : f.to })} className={inp + " mt-1 font-normal"} /></label>
        <label className="text-xs font-semibold text-inksoft">Do<input type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} className={inp + " mt-1 font-normal"} /></label>
        <label className={`text-xs font-semibold text-inksoft ${forUser ? "col-span-2 md:col-span-4" : "col-span-2 md:col-span-4"}`}>Uwagi (opcjonalnie)<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className={inp + " mt-1 font-normal"} /></label>
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <button onClick={submit} disabled={busy || days < 1 || (forUser && !f.user_id)} className="bg-ink text-paper px-5 py-2 rounded text-sm font-semibold disabled:opacity-50">{busy ? "Zapisywanie…" : forUser ? "Dodaj" : "Złóż wniosek"}</button>
        <span className="text-sm text-inksoft">Dni robocze w okresie: <b className="text-ink font-mono">{days}</b> <span className="text-xs">(weekendy i święta nie liczą się)</span></span>
      </div>
      {msg && <p className={`text-sm mt-3 ${msg.bad ? "text-rust" : "text-teal"}`}>{msg.text}</p>}
    </div>
  );
}

/* ---------------- Pracownik: Urlopy ---------------- */

export function MyLeave({ session }: { session: Session }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [abs, setAbs] = useState<Absence[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([fetchYear(year, session.user.id), supabase.from("rcp_leave_balances").select("days_total").eq("user_id", session.user.id).eq("year", year).maybeSingle()]);
      setAbs(a);
      setTotal(b.data ? Number(b.data.days_total) : null);
      setError("");
    } catch (e: any) {
      setError(setupMsg(e));
    }
  }, [year, session.user.id]);
  useEffect(() => {
    load();
  }, [load]);

  const { used, pending } = leaveUsage(abs, year);
  const left = total === null ? null : total - used - pending;

  async function withdraw(id: number) {
    const r = await post(session, { action: "withdraw", id });
    if (r.error) setError(r.error);
    else load();
  }

  return (
    <div className="max-w-4xl">
      {error && <p className="text-rust text-sm mb-3">{error}</p>}
      <div className="flex items-center gap-2 mb-3">
        <button onClick={() => setYear(year - 1)} className="bg-white border border-line px-3 py-1 rounded text-sm font-semibold">‹</button>
        <span className="text-sm font-semibold w-16 text-center">{year}</span>
        <button onClick={() => setYear(year + 1)} className="bg-white border border-line px-3 py-1 rounded text-sm font-semibold">›</button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line border border-line mb-6">
        {[
          ["LIMIT URLOPU (DNI)", total === null ? "—" : String(total)],
          ["WYKORZYSTANO", String(used)],
          ["OCZEKUJE NA ZATWIERDZENIE", String(pending)],
          ["POZOSTAŁO", left === null ? "—" : String(left)],
        ].map(([l, v]) => (
          <div key={l} className="bg-white p-5"><div className="text-xs text-inksoft mb-2">{l}</div><div className="text-3xl font-bold font-mono">{v}</div></div>
        ))}
      </div>
      {total === null && <p className="text-xs text-inksoft mb-4 -mt-3">Limit urlopowy na {year} nie został jeszcze ustawiony przez Admina — wniosek nie jest wtedy sprawdzany pod kątem limitu.</p>}
      <div className="mb-6"><AbsenceForm session={session} members={[]} forUser={false} onDone={load} /></div>

      <h2 className="text-xs font-semibold text-inksoft mb-2">MOJE WNIOSKI I NIEOBECNOŚCI</h2>
      <div className="bg-white border border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-inksoft border-b border-line"><th className="p-3">Rodzaj</th><th className="p-3">Termin</th><th className="p-3 text-right">Dni rob.</th><th className="p-3">Status</th><th className="p-3">Decyzja / uwagi</th><th className="p-3"></th></tr></thead>
          <tbody>
            {abs.map((a) => (
              <tr key={a.id} className="border-b border-line last:border-0 align-top">
                <td className="p-3">{absenceKind(a.kind)?.label}</td>
                <td className="p-3 whitespace-nowrap">{term(a)}</td>
                <td className="p-3 text-right font-mono">{a.workdays}</td>
                <td className="p-3"><Badge s={a.status} /></td>
                <td className="p-3 text-xs text-inksoft">{a.decision_note || a.note || "—"}{a.decided_by_email && a.status !== "oczekuje" ? ` · ${displayNameForEmail(a.decided_by_email, [])}` : ""}</td>
                <td className="p-3 text-right">{a.status === "oczekuje" && <button onClick={() => withdraw(a.id)} className="text-xs font-semibold text-rust hover:underline">Wycofaj</button>}</td>
              </tr>
            ))}
            {abs.length === 0 && !error && <tr><td colSpan={6} className="p-6 text-center text-inksoft text-sm">Brak wniosków w {year}.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Admin / Manager: Wnioski ---------------- */

function Decide({ session, a, label, requireNote, action, onDone }: { session: Session; a: Absence; label: string; requireNote: boolean; action: "decide" | "cancel"; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  async function go(decision?: string) {
    const r = await post(session, { action, id: a.id, decision, note });
    if (r.error) return setMsg(r.error);
    setOpen(false);
    onDone();
  }
  if (!open) return <button onClick={() => setOpen(true)} className="text-xs font-semibold text-rust hover:underline">{label}</button>;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={requireNote ? "Powód (wymagany)" : "Powód"} className="border border-line bg-white px-2 py-1 rounded text-xs w-44" />
      <button onClick={() => go(action === "decide" ? "odrzucony" : undefined)} className="text-xs font-semibold text-rust hover:underline">Potwierdź</button>
      <button onClick={() => setOpen(false)} className="text-xs text-inksoft hover:underline">Anuluj</button>
      {msg && <span className="text-xs text-rust">{msg}</span>}
    </div>
  );
}

export function Requests({ session, members, isAdmin }: { session: Session; members: MemberLite[]; isAdmin: boolean }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [abs, setAbs] = useState<Absence[]>([]);
  const [people, setPeople] = useState<{ user_id: string; email: string; role: string }[]>([]);
  const [bal, setBal] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | AbsenceStatus>("all");
  const [personFilter, setPersonFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const [a, m, b] = await Promise.all([fetchYear(year), supabase.from("members").select("user_id, email, role"), supabase.from("rcp_leave_balances").select("user_id, days_total").eq("year", year)]);
      setAbs(a);
      setPeople(((m.data as { user_id: string; email: string; role: string }[]) || []).filter((x) => x.role));
      setBal(Object.fromEntries(((b.data as { user_id: string; days_total: number }[]) || []).map((r) => [r.user_id, Number(r.days_total)])));
      setError("");
    } catch (e: any) {
      setError(setupMsg(e));
    }
  }, [year]);
  useEffect(() => {
    load();
  }, [load]);

  const name = (email: string) => displayNameForEmail(email, members);
  const pendingList = abs.filter((a) => a.status === "oczekuje").sort((a, b) => a.date_from.localeCompare(b.date_from));
  const rest = abs.filter((a) => a.status !== "oczekuje" && (statusFilter === "all" || a.status === statusFilter) && (!personFilter || a.user_id === personFilter));
  const sortedPeople = [...people].sort((a, b) => name(a.email).localeCompare(name(b.email), "pl"));

  async function saveLimit(userId: string, raw: string | null) {
    const n = raw === null || raw.trim() === "" ? null : Number(raw.trim().replace(",", "."));
    if (n !== null && (!Number.isFinite(n) || n < 0)) return setError("Limit musi być liczbą dni (0 lub więcej).");
    const { error: err } = n === null ? await supabase.from("rcp_leave_balances").delete().eq("user_id", userId).eq("year", year) : await supabase.from("rcp_leave_balances").upsert({ user_id: userId, year, days_total: n, updated_at: new Date().toISOString() });
    if (err) return setError(err.message);
    load();
  }

  return (
    <div className="max-w-6xl">
      {error && <p className="text-rust text-sm mb-3">{error}</p>}
      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => setYear(year - 1)} className="bg-white border border-line px-3 py-1 rounded text-sm font-semibold">‹</button>
        <span className="text-sm font-semibold w-16 text-center">{year}</span>
        <button onClick={() => setYear(year + 1)} className="bg-white border border-line px-3 py-1 rounded text-sm font-semibold">›</button>
      </div>

      <h2 className="text-xs font-semibold text-inksoft mb-2">DO ROZPATRZENIA ({pendingList.length})</h2>
      <div className="bg-white border border-line overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-inksoft border-b border-line"><th className="p-3">Pracownik</th><th className="p-3">Rodzaj</th><th className="p-3">Termin</th><th className="p-3 text-right">Dni rob.</th><th className="p-3">Uwagi</th><th className="p-3">W tym czasie nieobecni</th><th className="p-3"></th></tr></thead>
          <tbody>
            {pendingList.map((a) => {
              const others = abs.filter((o) => o.id !== a.id && o.user_id !== a.user_id && ["zaakceptowany", "oczekuje"].includes(o.status) && datesOverlap(a, o));
              return (
                <tr key={a.id} className="border-b border-line last:border-0 align-top">
                  <td className="p-3 font-semibold">{name(a.user_email)}</td>
                  <td className="p-3">{absenceKind(a.kind)?.label}</td>
                  <td className="p-3 whitespace-nowrap">{term(a)}</td>
                  <td className="p-3 text-right font-mono">{a.workdays}</td>
                  <td className="p-3 text-xs text-inksoft">{a.note || "—"}</td>
                  <td className="p-3 text-xs">{others.length ? others.map((o) => `${name(o.user_email)}${o.status === "oczekuje" ? " (wniosek)" : ""}`).join(", ") : <span className="text-inksoft">nikt</span>}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <button onClick={async () => { const r = await post(session, { action: "decide", id: a.id, decision: "zaakceptowany" }); if (r.error) setError(r.error); else load(); }} className="bg-teal text-paper px-3 py-1 rounded text-xs font-semibold">Zatwierdź</button>
                      <Decide session={session} a={a} label="Odrzuć" requireNote action="decide" onDone={load} />
                    </div>
                  </td>
                </tr>
              );
            })}
            {pendingList.length === 0 && !error && <tr><td colSpan={7} className="p-6 text-center text-inksoft text-sm">Brak wniosków do rozpatrzenia.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="mb-6"><AbsenceForm session={session} members={sortedPeople} forUser onDone={load} /></div>

      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <h2 className="text-xs font-semibold text-inksoft">HISTORIA {year}</h2>
        <select value={personFilter} onChange={(e) => setPersonFilter(e.target.value)} className="border border-line bg-white px-2 py-1 rounded text-xs">
          <option value="">wszyscy</option>
          {sortedPeople.map((p) => <option key={p.user_id} value={p.user_id}>{name(p.email)}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "all" | AbsenceStatus)} className="border border-line bg-white px-2 py-1 rounded text-xs">
          <option value="all">wszystkie statusy</option>
          {(Object.keys(ABSENCE_STATUS_LABEL) as AbsenceStatus[]).filter((s) => s !== "oczekuje").map((s) => <option key={s} value={s}>{ABSENCE_STATUS_LABEL[s]}</option>)}
        </select>
      </div>
      <div className="bg-white border border-line overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-inksoft border-b border-line"><th className="p-3">Pracownik</th><th className="p-3">Rodzaj</th><th className="p-3">Termin</th><th className="p-3 text-right">Dni rob.</th><th className="p-3">Status</th><th className="p-3">Decyzja</th><th className="p-3"></th></tr></thead>
          <tbody>
            {rest.map((a) => (
              <tr key={a.id} className="border-b border-line last:border-0 align-top">
                <td className="p-3 font-semibold">{name(a.user_email)}</td>
                <td className="p-3">{absenceKind(a.kind)?.label}</td>
                <td className="p-3 whitespace-nowrap">{term(a)}</td>
                <td className="p-3 text-right font-mono">{a.workdays}</td>
                <td className="p-3"><Badge s={a.status} /></td>
                <td className="p-3 text-xs text-inksoft">{[a.decided_by_email ? name(a.decided_by_email) : "", a.decision_note || a.note || ""].filter(Boolean).join(" · ") || "—"}</td>
                <td className="p-3">{a.status === "zaakceptowany" && <Decide session={session} a={a} label="Anuluj" requireNote action="cancel" onDone={load} />}</td>
              </tr>
            ))}
            {rest.length === 0 && !error && <tr><td colSpan={7} className="p-6 text-center text-inksoft text-sm">Brak wpisów.</td></tr>}
          </tbody>
        </table>
      </div>

      <h2 className="text-xs font-semibold text-inksoft mb-2">LIMITY URLOPOWE {year} (dni robocze){isAdmin ? " — kliknij limit, żeby go ustawić" : ""}</h2>
      <div className="bg-white border border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-inksoft border-b border-line"><th className="p-3">Pracownik</th><th className="p-3 text-right">Limit</th><th className="p-3 text-right">Wykorzystano</th><th className="p-3 text-right">Oczekuje</th><th className="p-3 text-right">Pozostało</th></tr></thead>
          <tbody>
            {sortedPeople.map((p) => {
              const u = leaveUsage(abs.filter((a) => a.user_id === p.user_id), year);
              const total = bal[p.user_id];
              return (
                <tr key={p.user_id} className="border-b border-line last:border-0">
                  <td className="p-3 font-semibold">{name(p.email)}</td>
                  <td className="p-3 text-right">
                    {isAdmin ? <LimitCell value={total ?? null} onSave={(v) => saveLimit(p.user_id, v)} /> : <span className="font-mono">{total ?? "—"}</span>}
                  </td>
                  <td className="p-3 text-right font-mono">{u.used}</td>
                  <td className="p-3 text-right font-mono">{u.pending}</td>
                  <td className="p-3 text-right font-mono font-semibold">{total === undefined ? "—" : total - u.used - u.pending}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-inksoft mt-3 max-w-3xl">Do limitu zaliczają się urlop wypoczynkowy i na żądanie (zaakceptowane i oczekujące); urlop okolicznościowy, bezpłatny, L4 i inne nie. Bez ustawionego limitu wniosek nie jest sprawdzany. Dni robocze = pn–pt bez świąt (24.12 jest wolny od 2025). Pracownik widzi tylko swoje wnioski; własnego wniosku Manager nie rozpatruje (robi to Admin).</p>
    </div>
  );
}

function LimitCell({ value, onSave }: { value: number | null; onSave: (v: string | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      value={draft ?? (value ?? "")}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() !== String(value ?? "")) onSave(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      placeholder="—"
      inputMode="decimal"
      className="w-20 border border-line bg-white px-2 py-1 rounded font-mono text-sm text-right"
    />
  );
}

// Licznik wniosków do rozpatrzenia (pigułka "Wnioski (n)" dla Admina/Managera).
export function usePendingCount(enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const run = async () => {
      const { count } = await supabase.from("rcp_absences").select("id", { count: "exact", head: true }).eq("status", "oczekuje");
      if (alive) setN(count ?? 0);
    };
    run();
    const t = setInterval(run, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);
  return n;
}
void useMemo;
