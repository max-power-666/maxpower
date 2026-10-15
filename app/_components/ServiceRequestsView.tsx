"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { MARKETPLACES } from "@/lib/salesOrders";
import { ACTIVE_REQUEST_STATUSES, canEditRequest, REQUEST_DELETE_ROLES, REQUEST_PRIORITIES, REQUEST_PRIORITY_LABEL, REQUEST_PRIORITY_RANK, REQUEST_STATUSES, REQUEST_STATUS_LABEL, requestCode, type RequestPriority, type RequestStatus } from "@/lib/serviceRequests";

// Zamówienia -> Zapotrzebowanie (08.10.2026): pracownicy zlecają zadania dla serwisu (dowolna treść albo numer zamówienia + priorytet; autor, data i numer ZAP-n automatycznie), serwisant przyjmuje zlecenie i ustawia status.
// Kto może zmieniać status, pilnuje baza (trigger service_requests_guard); tu przyciski i lista statusu pokazują się tylko serwisantom (canHandle).
// Karta zlecenia (13.10.2026): klik w ID otwiera panel z edycją treści i priorytetu (autor, dopóki zlecenie jest aktywne, albo serwisant), przyciskiem "Duplikuj" i logiem zmian (kolumna history, wypełniana triggerem).

type HistoryEntry = { at: string; by_email: string | null; action: "created" | "status" | "edited" | "deleted" | "restored"; from?: string; to?: string; changes?: { field: string; from: string | null; to: string | null }[] };
type Req = {
  id: number;
  message: string;
  created_by_user_id: string | null;
  created_by_email: string | null;
  created_at: string;
  status: RequestStatus;
  priority: RequestPriority;
  accepted_by_email: string | null;
  accepted_at: string | null;
  status_changed_by_email: string | null;
  status_changed_at: string | null;
  history: HistoryEntry[] | null;
  deleted_at?: string | null;
  deleted_by_email?: string | null;
};
const COLS_OLD = "id, message, created_by_user_id, created_by_email, created_at, status, priority, accepted_by_email, accepted_at, status_changed_by_email, status_changed_at, history";
const COLS = `${COLS_OLD}, deleted_at, deleted_by_email`;
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
// Numery zamówień wpisane w treści (09.10.2026): każde "słowo" o długości >= 5 znaków może być numerem zamówienia (external_id w sales_orders); SKU dociągamy dla tych, które pasują.
// Wielkość liter: zapytanie obejmuje też wersję małymi literami (UUID Allegro bywa wpisywany z dużych liter).
const orderTokens = (message: string): string[] => Array.from(new Set(message.split(/[\s,;]+/).map((t) => t.replace(/^[#:.]+|[.:]+$/g, "")).filter((t) => t.length >= 5 && t.length <= 80)));
type OrderSku = { marketplace: string; sku: string | null };
const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const fmtDT = (iso: string) => new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default function ServiceRequestsView({ session, members, role, canHandle }: { session: Session; members: MemberLite[]; role: string; canHandle: boolean }) {
  const [rows, setRows] = useState<Req[]>([]);
  const [orderSkus, setOrderSkus] = useState<Record<string, OrderSku>>({}); // numer zamówienia (małymi literami) -> SKU z zamówienia
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [priority, setPriority] = useState<RequestPriority>("sredni");
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<"active" | "all" | "deleted" | RequestStatus>("active");
  // "Miękkie" usuwanie (15.10.2026): kolumny deleted_at / deleted_by_email pojawiają się po ponownym uruchomieniu supabase/service-requests.sql; bez nich działa stare, trwałe usuwanie.
  const [softDelete, setSoftDelete] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  // Hurtowe usuwanie (13.10.2026): checkboxy po lewej widzą tylko role z prawem usuwania (Admin, Kierownik serwisu — jak polityka delete w bazie).
  const canDelete = REQUEST_DELETE_ROLES.includes(role);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const headerCb = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let { data, error: err }: { data: any; error: any } = await supabase.from("service_requests").select(COLS).order("id", { ascending: false }).limit(500);
    if (err && (err.code === "42703" || err.code === "PGRST204") && /deleted_/.test(err.message || "")) {
      setSoftDelete(false);
      ({ data, error: err } = await supabase.from("service_requests").select(COLS_OLD).order("id", { ascending: false }).limit(500));
    }
    if (err) setError(err.code === "42P01" ? "Brak tabeli zleceń — uruchom supabase/service-requests.sql w Supabase." : `Nie udało się wczytać zleceń: ${err.message}`);
    else {
      setError("");
      const list = (data as Req[]) || [];
      setRows(list);
      // SKU zamówień wymienionych w treści zleceń (paczkami po 100 numerów; brak dopasowania = zwykła treść, np. "pad ps4 red")
      const tokens = Array.from(new Set(list.flatMap((r) => orderTokens(r.message).flatMap((t) => [t, t.toLowerCase()]))));
      const found: Record<string, OrderSku> = {};
      for (let i = 0; i < tokens.length; i += 100) {
        const chunk = tokens.slice(i, i + 100).map((t) => `"${t.replace(/"/g, "")}"`).join(",");
        const { data: ord } = await supabase.from("sales_orders").select("marketplace, external_id, sku").filter("external_id", "in", `(${chunk})`);
        for (const o of (ord as { marketplace: string; external_id: string; sku: string | null }[]) || []) found[o.external_id.toLowerCase()] = { marketplace: o.marketplace, sku: o.sku };
      }
      setOrderSkus(found);
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

  // Duplikat = nowe zlecenie z tą samą treścią i priorytetem (autor, data, status "nowe" ustawia baza); po utworzeniu otwieramy jego kartę, żeby od razu poprawić treść.
  async function duplicate(src: Req) {
    setError("");
    const { data, error: err } = await supabase.from("service_requests").insert({ message: src.message, priority: src.priority }).select("id").single();
    if (err || !data) return setError(`Nie udało się zduplikować zlecenia: ${err?.message ?? "brak odpowiedzi"}`);
    await load();
    setOpenId((data as { id: number }).id);
  }

  // Zapis treści i priorytetu z karty. Zwraca komunikat błędu albo null. Baza dopisuje wpis do logu (trigger), więc po zapisie tylko przeładowujemy listę.
  async function saveEdit(id: number, patch: { message: string; priority: RequestPriority }): Promise<string | null> {
    const { data, error: err } = await supabase.from("service_requests").update(patch).eq("id", id).select("id");
    // Stary trigger w bazie (przed uruchomieniem service-requests.sql z 13.10.2026) odrzuca każdą zmianę treści, także serwisanta.
    if (err && /tylko system/i.test(err.message)) return "Edycja wymaga aktualizacji bazy — Admin musi uruchomić plik supabase/service-requests.sql w Supabase (SQL Editor).";
    if (err) return `Nie udało się zapisać: ${err.message}`;
    if (!data?.length) return "Nie zapisano — zlecenie może edytować jego autor (dopóki jest aktywne), Admin albo Manager.";
    await load();
    return null;
  }

  const name = (email: string | null) => (email ? displayNameForEmail(email, members) : "—");
  const search = searchInput.trim().toLowerCase();
  const visible = useMemo(
    () =>
      rows
        .filter((r) => {
        if (filter === "deleted" ? !r.deleted_at : !!r.deleted_at) return false; // usunięte tylko w widoku "Usunięte"
        if (filter === "active" ? !ACTIVE_REQUEST_STATUSES.includes(r.status) : filter !== "all" && filter !== "deleted" && r.status !== filter) return false;
        if (!search) return true;
        return r.message.toLowerCase().includes(search) || requestCode(r.id).toLowerCase().includes(search) || name(r.created_by_email).toLowerCase().includes(search);
        })
        // aktywne: najpierw wysoki priorytet, potem najnowsze; pozostałe widoki po numerze malejąco
        .sort((a, b) => (filter === "active" ? REQUEST_PRIORITY_RANK[a.priority] - REQUEST_PRIORITY_RANK[b.priority] || b.id - a.id : b.id - a.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, filter, search, members]
  );
  const live = rows.filter((r) => !r.deleted_at);
  const count = (f: (r: Req) => boolean) => live.filter(f).length;
  const deletedCount = rows.length - live.length;

  // Zaznaczenie dotyczy tylko widocznych wierszy: zmiana filtra/wyszukiwania i przeładowanie listy zdejmują zaznaczenie wierszy, których już nie widać.
  useEffect(() => {
    const ids = new Set(visible.map((r) => r.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visible]);
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));
  useEffect(() => {
    if (headerCb.current) headerCb.current.indeterminate = selected.size > 0 && !allVisibleSelected;
  }, [selected, allVisibleSelected]);
  const toggleOne = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allVisibleSelected ? new Set() : new Set(visible.map((r) => r.id)));

  const plural = (n: number) => (n === 1 ? "zlecenie" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "zlecenia" : "zleceń");

  // Usunięcie "miękkie": ustawiamy deleted_at (baza dopisuje autora i wpis do logu); zlecenie trafia do widoku "Usunięte" i można je przywrócić.
  // Bez kolumn z service-requests.sql (stara baza) — dawne trwałe usuwanie.
  async function removeIds(ids: number[], restore: boolean) {
    if (ids.length === 0) return;
    const codes = ids.slice().sort((a, b) => a - b).map(requestCode);
    const preview = codes.length > 8 ? `${codes.slice(0, 8).join(", ")} … (+${codes.length - 8})` : codes.join(", ");
    const msg = restore
      ? `Przywrócić ${ids.length} ${plural(ids.length)} (${preview})?`
      : softDelete
        ? `Usunąć ${ids.length} ${plural(ids.length)} (${preview})?\n\nZlecenia trafią do widoku „Usunięte” — stamtąd można je przywrócić.`
        : `Usunąć ${ids.length} ${plural(ids.length)} (${preview})?\n\nOperacji nie da się cofnąć w aplikacji — wiersze trafią do dziennika usunięć (tylko Admin w Supabase).`;
    if (!confirm(msg)) return;
    setDeleting(true);
    setError("");
    let done = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const q = softDelete
        ? supabase.from("service_requests").update({ deleted_at: restore ? null : new Date().toISOString() }).in("id", chunk).select("id")
        : supabase.from("service_requests").delete().in("id", chunk).select("id");
      const { data, error: err } = await q;
      if (err) {
        setError(`${restore ? "Przywrócono" : "Usunięto"} ${done} z ${ids.length}. Błąd: ${err.message}`);
        break;
      }
      done += data?.length ?? 0;
    }
    if (done < ids.length && !error) setError(`${restore ? "Przywrócono" : "Usunięto"} ${done} z ${ids.length} — pozostałych nie wolno Ci ${restore ? "przywrócić" : "usunąć"} (Admin, Kierownik serwisu i Zamówienia) albo już ich nie ma.`);
    setSelected(new Set());
    setDeleting(false);
    await load();
  }
  const deleteSelected = () => removeIds([...selected], filter === "deleted");

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
        <button onClick={() => setFilter("all")} className={pill(filter === "all")}>Wszystkie ({live.length})</button>
        {softDelete && <button onClick={() => setFilter("deleted")} className={pill(filter === "deleted")}>Usunięte ({deletedCount})</button>}
        <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Szukaj: treść, ZAP-nr, osoba" className="ml-auto border border-line bg-white px-3 py-1.5 rounded text-sm w-64" />
      </div>

      {canDelete && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-3 border border-line bg-white px-4 py-2 text-sm">
          <span className="font-semibold">Zaznaczono: {selected.size}</span>
          <button onClick={deleteSelected} disabled={deleting} className={`${filter === "deleted" ? "bg-teal" : "bg-rust"} text-paper px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-50`}>{deleting ? (filter === "deleted" ? "Przywracanie…" : "Usuwanie…") : filter === "deleted" ? `Przywróć zaznaczone (${selected.size})` : `Usuń zaznaczone (${selected.size})`}</button>
          <button onClick={() => setSelected(new Set())} disabled={deleting} className="text-inksoft hover:underline text-sm">Odznacz</button>
        </div>
      )}

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              {canDelete && (
                <th className="p-3 w-8">
                  <input ref={headerCb} type="checkbox" checked={allVisibleSelected} onChange={toggleAll} disabled={visible.length === 0 || deleting} aria-label="Zaznacz wszystkie widoczne" title="Zaznacz / odznacz wszystkie widoczne" />
                </th>
              )}
              <th className="p-3">ID</th>
              <th className="p-3">Data</th>
              <th className="p-3">Zlecił(a)</th>
              <th className="p-3">Priorytet</th>
              <th className="p-3">Zapotrzebowanie</th>
              <th className="p-3">SKU</th>
              <th className="p-3">Status</th>
              <th className="p-3">Przyjął(ęła)</th>
              {canHandle && <th className="p-3"></th>}
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {!loading && visible.length === 0 && !error && <tr><td colSpan={(canHandle ? 10 : 9) + (canDelete ? 1 : 0)} className="p-6 text-center text-inksoft text-sm">{rows.length === 0 ? "Brak zleceń — dodaj pierwsze powyżej." : filter === "deleted" ? "Brak usuniętych zleceń." : "Brak zleceń w tym widoku."}</td></tr>}
            {visible.map((r) => (
              <tr key={r.id} className={`border-b border-line last:border-b-0 align-top ${selected.has(r.id) ? "bg-tealsoft" : ""}`}>
                {canDelete && (
                  <td className="p-3">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} disabled={deleting} aria-label={`Zaznacz ${requestCode(r.id)}`} />
                  </td>
                )}
                <td className="p-3 whitespace-nowrap"><button onClick={() => setOpenId(r.id)} title="Otwórz kartę zlecenia" className="font-mono text-xs font-semibold text-teal hover:underline">{requestCode(r.id)}</button></td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDT(r.created_at)}</td>
                <td className="p-3 font-semibold whitespace-nowrap">{name(r.created_by_email)}</td>
                <td className="p-3 whitespace-nowrap"><span className={`text-xs font-semibold px-2 py-1 rounded ${PRIORITY_STYLE[r.priority]}`}>{REQUEST_PRIORITY_LABEL[r.priority]}</span></td>
                <td className="p-3 whitespace-pre-wrap break-words max-w-xl">{r.message}</td>
                <td className="p-3 font-mono text-xs">
                  {(() => {
                    const hits = orderTokens(r.message).map((t) => ({ t, o: orderSkus[t.toLowerCase()] })).filter((h) => h.o);
                    if (hits.length === 0) return <span className="text-inksoft">—</span>;
                    return hits.map(({ t, o }) => (
                      <div key={t} title={`Zamówienie ${t} (${MARKETPLACES.find((m) => m.key === o.marketplace)?.label ?? o.marketplace})`}>{o.sku || <span className="text-inksoft">brak SKU</span>}</div>
                    ));
                  })()}
                </td>
                <td className="p-3 whitespace-nowrap">
                  {canHandle && !r.deleted_at ? (
                    <select value={r.status} onChange={(e) => setStatus(r.id, e.target.value as RequestStatus)} className={`text-xs font-semibold px-2 py-1 rounded border border-line ${STATUS_STYLE[r.status]}`}>
                      {REQUEST_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  ) : (
                    <span className={`text-xs font-semibold px-2 py-1 rounded ${STATUS_STYLE[r.status]}`}>{REQUEST_STATUS_LABEL[r.status]}</span>
                  )}
                  {r.deleted_at && <div className="text-[10px] text-rust mt-1">Usunięto: {name(r.deleted_by_email ?? null)}, {fmtDT(r.deleted_at)}</div>}
                  {r.status_changed_at && <div className="text-[10px] text-inksoft mt-1">{fmtDT(r.status_changed_at)}</div>}
                </td>
                <td className="p-3 text-xs whitespace-nowrap">{r.accepted_at ? <>{name(r.accepted_by_email)}<div className="text-[10px] text-inksoft">{fmtDT(r.accepted_at)}</div></> : <span className="text-inksoft">—</span>}</td>
                {canHandle && (
                  <td className="p-3 whitespace-nowrap">
                    {r.status === "nowe" && !r.deleted_at && <button onClick={() => setStatus(r.id, "przyjete")} className="bg-teal text-paper px-3 py-1 rounded text-xs font-semibold">Przyjmij</button>}
                  </td>
                )}
                <td className="p-3 whitespace-nowrap">
                  <button onClick={() => duplicate(r)} title="Utwórz nowe zlecenie z tą samą treścią i priorytetem" className="text-xs font-semibold text-inksoft hover:text-ink hover:underline">Duplikuj</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {openId !== null && (() => {
        const r = rows.find((x) => x.id === openId);
        if (!r) return null;
        const isAuthor = !!r.created_by_user_id && r.created_by_user_id === session.user.id;
        const canEdit = canEditRequest(role, isAuthor, r.status);
        const skuHits = orderTokens(r.message).map((t) => ({ t, o: orderSkus[t.toLowerCase()] })).filter((h) => h.o);
        return (
          <RequestCard
            key={r.id}
            r={r}
            canEdit={canEdit && !r.deleted_at}
            canHandle={canHandle && !r.deleted_at}
            canDelete={canDelete && softDelete}
            onRemove={(restore) => removeIds([r.id], restore)}
            name={name}
            skuHits={skuHits}
            onClose={() => setOpenId(null)}
            onSave={(patch) => saveEdit(r.id, patch)}
            onSetStatus={(st) => setStatus(r.id, st)}
            onDuplicate={() => duplicate(r)}
          />
        );
      })()}
      <p className="text-[11px] text-inksoft mt-3 max-w-3xl">Gdy w treści jest numer zamówienia, kolumna SKU pokazuje SKU z tego zamówienia. Zapotrzebowania dodaje każdy; przyjmuje je i zmienia status serwisant (Serwis, Kierownik serwisu, Manager, Admin). „Przyjęte” zapisuje, kto i kiedy zajął się zleceniem.</p>
    </div>
  );
}

const CARD_BTN = "px-3 py-1.5 rounded text-sm font-semibold border border-line bg-white disabled:opacity-50";

function RequestCard({
  r, canEdit, canHandle, canDelete, onRemove, name, skuHits, onClose, onSave, onSetStatus, onDuplicate,
}: {
  r: Req;
  canEdit: boolean;
  canHandle: boolean;
  canDelete: boolean;
  onRemove: (restore: boolean) => void;
  name: (email: string | null) => string;
  skuHits: { t: string; o: OrderSku }[];
  onClose: () => void;
  onSave: (patch: { message: string; priority: RequestPriority }) => Promise<string | null>;
  onSetStatus: (st: RequestStatus) => void;
  onDuplicate: () => void;
}) {
  const [message, setMessage] = useState(r.message);
  const [priority, setPriority] = useState<RequestPriority>(r.priority);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [savedAt, setSavedAt] = useState(false);

  // Gdy zlecenie zmieni się z zewnątrz (realtime / zapis), a niczego tu nie edytujemy, pokaż świeże wartości.
  const dirty = message !== r.message || priority !== r.priority;
  useEffect(() => {
    if (!dirty) {
      setMessage(r.message);
      setPriority(r.priority);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.message, r.priority]);

  async function save() {
    const text = message.trim();
    if (!text) return setErr("Treść zlecenia nie może być pusta.");
    setSaving(true);
    setErr("");
    const e = await onSave({ message: text, priority });
    setSaving(false);
    if (e) return setErr(e);
    setMessage(text);
    setSavedAt(true);
    setTimeout(() => setSavedAt(false), 2000);
  }

  const history = r.history ?? [];
  const fieldLabel = (f: string) => (f === "message" ? "Treść" : f === "priority" ? "Priorytet" : f);
  const valueLabel = (f: string, v: string | null) => (f === "priority" ? REQUEST_PRIORITY_LABEL[v as RequestPriority] ?? v ?? "—" : v || "—");

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg bg-paper h-full overflow-y-auto p-6 border-l border-line">
        <div className="flex justify-between items-start mb-3">
          <div className="text-xs text-inksoft font-mono">{requestCode(r.id)}</div>
          <button onClick={onClose} className="text-inksoft text-lg" aria-label="Zamknij">✕</button>
        </div>

        {r.deleted_at && <div className="border border-rust bg-rustsoft text-rust text-xs font-semibold px-3 py-2 mb-3">Usunięte — {name(r.deleted_by_email ?? null)}, {fmtDT(r.deleted_at)}</div>}
        <div className="text-xs font-semibold text-inksoft mb-1">TREŚĆ</div>
        {canEdit ? (
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={2000}
            rows={4}
            className="w-full border border-line bg-white px-3 py-2 rounded text-sm mb-3"
          />
        ) : (
          <div className="border border-line bg-white p-3 text-sm whitespace-pre-wrap break-words mb-3">{r.message}</div>
        )}

        <div className="border border-line bg-white mb-3 text-sm">
          <div className="flex justify-between gap-3 px-3 py-2 border-b border-line">
            <span className="text-inksoft">Priorytet</span>
            {canEdit ? (
              <select value={priority} onChange={(e) => setPriority(e.target.value as RequestPriority)} className="border border-line bg-white px-2 py-1 rounded text-sm">
                {REQUEST_PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            ) : (
              <span className={`text-xs font-semibold px-2 py-1 rounded ${PRIORITY_STYLE[r.priority]}`}>{REQUEST_PRIORITY_LABEL[r.priority]}</span>
            )}
          </div>
          <div className="flex justify-between gap-3 px-3 py-2 border-b border-line">
            <span className="text-inksoft">Status</span>
            {canHandle ? (
              <select value={r.status} onChange={(e) => onSetStatus(e.target.value as RequestStatus)} className={`text-xs font-semibold px-2 py-1 rounded border border-line ${STATUS_STYLE[r.status]}`}>
                {REQUEST_STATUSES.map((st) => <option key={st.key} value={st.key}>{st.label}</option>)}
              </select>
            ) : (
              <span className={`text-xs font-semibold px-2 py-1 rounded ${STATUS_STYLE[r.status]}`}>{REQUEST_STATUS_LABEL[r.status]}</span>
            )}
          </div>
          <div className="flex justify-between gap-3 px-3 py-2 border-b border-line"><span className="text-inksoft">Zlecił(a)</span><span className="font-semibold">{name(r.created_by_email)}</span></div>
          <div className="flex justify-between gap-3 px-3 py-2 border-b border-line"><span className="text-inksoft">Dodano</span><span>{fmtDT(r.created_at)}</span></div>
          <div className="flex justify-between gap-3 px-3 py-2 border-b border-line">
            <span className="text-inksoft">Przyjął(ęła)</span>
            <span>{r.accepted_at ? `${name(r.accepted_by_email)}, ${fmtDT(r.accepted_at)}` : "—"}</span>
          </div>
          <div className="flex justify-between gap-3 px-3 py-2">
            <span className="text-inksoft">SKU z zamówienia</span>
            <span className="font-mono text-xs text-right">
              {skuHits.length === 0 ? "—" : skuHits.map(({ t, o }) => <div key={t} title={`Zamówienie ${t}`}>{o.sku || "brak SKU"}</div>)}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-2">
          {canEdit && <button onClick={save} disabled={saving || !dirty || !message.trim()} className="bg-ink text-paper px-4 py-1.5 rounded text-sm font-semibold disabled:opacity-50">{saving ? "Zapisywanie…" : "Zapisz zmiany"}</button>}
          {canEdit && dirty && <button onClick={() => { setMessage(r.message); setPriority(r.priority); setErr(""); }} className={CARD_BTN}>Cofnij zmiany</button>}
          <button onClick={onDuplicate} title="Utwórz nowe zlecenie z tą samą treścią i priorytetem" className={CARD_BTN}>Duplikuj</button>
          {canDelete && (r.deleted_at
            ? <button onClick={() => onRemove(true)} className={`${CARD_BTN} text-teal`}>Przywróć</button>
            : <button onClick={() => onRemove(false)} className={`${CARD_BTN} text-rust`}>Usuń</button>)}
          {savedAt && <span className="text-xs text-teal font-semibold">Zapisano ✓</span>}
        </div>
        {err && <p className="text-rust text-xs mb-2">{err}</p>}
        {!canEdit && <p className="text-[11px] text-inksoft mb-2">Treść i priorytet zmienia autor zlecenia (dopóki jest aktywne), Admin albo Manager. Serwis przyjmuje zlecenia i zmienia status.</p>}

        <h3 className="text-xs font-semibold text-inksoft mt-6 mb-2">LOG ZMIAN</h3>
        <div className="border border-line bg-white p-3 text-sm">
          {history.length === 0 && <div className="text-inksoft">Brak wpisów.</div>}
          {history.map((h, i) => (
            <div key={i} className="mb-2 last:mb-0">
              <div>
                <span className="font-mono text-inksoft mr-1">{i + 1}.</span>
                {h.action === "created" && <>Utworzono</>}
                {h.action === "status" && <>Status: <span className="font-semibold">{REQUEST_STATUS_LABEL[h.from as RequestStatus] ?? h.from}</span> → <span className="font-semibold">{REQUEST_STATUS_LABEL[h.to as RequestStatus] ?? h.to}</span></>}
                {h.action === "edited" && <>Edytowano</>}
                {h.action === "deleted" && <>Usunięto</>}
                {h.action === "restored" && <>Przywrócono</>}
                {" — "}<span className="font-semibold">{h.by_email ? name(h.by_email) : "system"}</span>, {fmtDT(h.at)}
              </div>
              {!!h.changes?.length && (
                <ul className="ml-6 list-disc text-xs text-inksoft">
                  {h.changes.map((c, j) => (
                    <li key={j} className="break-words">{fieldLabel(c.field)}: „{valueLabel(c.field, c.from)}” → „{valueLabel(c.field, c.to)}”</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
