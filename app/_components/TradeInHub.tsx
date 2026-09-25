"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import TradeInOrdersView from "./TradeInOrdersView";
import InlineEditCell from "./InlineEditCell";
import ProductCardDrawer from "./ProductCardDrawer";
import PadSerialsCell, { MAX_PADS } from "./PadSerialsCell";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { INTAKE_STATUSES, INTERVALS, fmtDuration, rangeStart, type Interval } from "@/lib/workLog";

// Zakładka Trade-in: domyślnie obsługa paczek przez pracowników (IntakeView — rejestr pracy
// wg Regulaminu premiowania, jak Serwis), plus podstrona "Raw data" z pełną, zsynchronizowaną
// listą zamówień BuyBack (TradeInOrdersView).
//
// Jedna paczka = jeden rekord z cyklem życia w statusie. Punkty (100/6 za paczkę) liczą się do
// podsumowania dopiero dla "Obsłużona" (Regulamin §2 ust. 4). "Czas" jest tylko informacyjny.

const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const btnPrimary = "bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50";

type FieldChange = { field: string; from: string | null; to: string | null };
type HistoryEntry = { action: "created" | "edited"; by_email: string | null; at: string; changes?: FieldChange[] };

type IntakeStatus = (typeof INTAKE_STATUSES)[number]["key"];
const INTAKE_STATUS_LABEL = Object.fromEntries(INTAKE_STATUSES.map((s) => [s.key, s.label])) as Record<IntakeStatus, string>;
const INTAKE_STATUS_STYLE: Record<IntakeStatus, string> = {
  w_trakcie: "bg-ambersoft text-amber",
  obsluzona: "bg-tealsoft text-teal",
  problem: "bg-rustsoft text-rust",
};

type IntakeEntry = {
  id: number;
  order_public_id: string;
  serial_number: string | null;
  sku: string | null;
  pads: number | null;
  pad_serials: string[] | null;
  docs: boolean;
  notes: string | null;
  entered_by_email: string | null;
  entered_at: string;
  finished_at: string | null;
  status: IntakeStatus;
  points: number;
  history: HistoryEntry[];
};

const INTAKE_COLUMNS = "id, order_public_id, serial_number, sku, pads, pad_serials, docs, notes, entered_by_email, entered_at, finished_at, status, points, history";

// Statusy Back Market po walidacji — takiego zamówienia nie walidujemy drugi raz.
const BM_ALREADY_VALIDATED = ["VALIDATED", "PAID", "MONEY_TRANSFERED"];

function fmtPoints(n: number | string) {
  return Number(n).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type OrderDetail = {
  order_public_id: string;
  status: string;
  market: string | null;
  creation_date: string;
  modification_date: string;
  shipping_date: string | null;
  suspension_date: string | null;
  receival_date: string | null;
  payment_date: string | null;
  counter_proposal_date: string | null;
  sku: string | null;
  product_id: number | null;
  product_title: string | null;
  grade: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_phone: string | null;
  return_address: { address1?: string; address2?: string; city?: string; zipcode?: string; country?: string } | null;
  original_price: number | null;
  original_price_currency: string | null;
  counter_offer_price: number | null;
  counter_offer_price_currency: string | null;
  tracking_number: string | null;
  shipper: string | null;
  transfer_certificate_link: string | null;
  suspend_reasons: { message: string; identifier: string; category?: string }[] | null;
  counter_offer_reasons: { message: string; identifier: string; category?: string }[] | null;
};

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtMoney(n: number | null, currency: string | null) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + (currency || "");
}

export default function TradeInHub({
  session,
  members,
  isAdmin,
}: {
  session: Session;
  members: MemberLite[];
  isAdmin: boolean;
}) {
  const [sub, setSub] = useState<"intake" | "raw">("intake");
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const [openSerial, setOpenSerial] = useState<string | null>(null);

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setSub("intake")} className={pill(sub === "intake")}>Wprowadzanie</button>
        <button onClick={() => setSub("raw")} className={pill(sub === "raw")}>Raw data</button>
      </div>

      {sub === "intake" && <IntakeView
          session={session}
          members={members}
          isAdmin={isAdmin}
          onOpenOrder={setOpenOrderId}
          onOpenProduct={setOpenSerial}
        />}
      {sub === "raw" && <TradeInOrdersView session={session} onOpenOrder={setOpenOrderId} />}

      {openOrderId && (
        <OrderCardDrawer orderPublicId={openOrderId} session={session} members={members} onClose={() => setOpenOrderId(null)} />
      )}

      {openSerial && <ProductCardDrawer serial={openSerial} members={members} onClose={() => setOpenSerial(null)} />}
    </div>
  );
}

/* ---------------- obsługa paczek Trade-in przez pracowników ---------------- */

function IntakeView({
  session,
  members,
  isAdmin,
  onOpenOrder,
  onOpenProduct,
}: {
  session: Session;
  members: MemberLite[];
  isAdmin: boolean;
  onOpenOrder: (id: string) => void;
  onOpenProduct: (serial: string) => void;
}) {
  const [interval, setInterval] = useState<Interval>("today");
  const [rangeRows, setRangeRows] = useState<{ entered_by_email: string | null; points: number }[]>([]);
  const [entries, setEntries] = useState<IntakeEntry[]>([]);
  const entriesRef = useRef<IntakeEntry[]>([]);
  entriesRef.current = entries;
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const validating = useRef(new Set<number>()); // paczki, dla których trwa zmiana statusu z walidacją (blokada podwójnego kliknięcia)
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [lookup, setLookup] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    load();
    const channel = supabase
      .channel("buyback-order-intake-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "buyback_order_intake" }, () => load())
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
      const [{ data: rangeData, error: rangeErr }, { data: listData, error: listErr }] = await Promise.all([
        supabase
          .from("buyback_order_intake")
          .select("entered_by_email, points")
          .eq("status", "obsluzona")
          .gte("finished_at", rangeStart(interval)),
        supabase
          .from("buyback_order_intake")
          .select(INTAKE_COLUMNS)
          .order("entered_at", { ascending: false })
          .limit(50),
      ]);
      if (rangeErr) throw rangeErr;
      if (listErr) throw listErr;
      setRangeRows(rangeData || []);
      setEntries((listData as IntakeEntry[]) || []);
    } catch (e: any) {
      setError(`Nie udało się wczytać paczek: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  const summary = useMemo(() => {
    const totals = new Map<string, { count: number; points: number }>();
    for (const r of rangeRows) {
      const key = r.entered_by_email || "—";
      const entry = totals.get(key) || { count: 0, points: 0 };
      entry.count += 1;
      entry.points += Number(r.points) || 0;
      totals.set(key, entry);
    }
    return Array.from(totals.entries())
      .map(([email, v]) => ({ email, ...v }))
      .sort((a, b) => b.points - a.points);
  }, [rangeRows]);

  // Numer zamówienia albo numer przesyłki -> order_public_id z zsynchronizowanych zamówień.
  async function resolveOrderId(value: string): Promise<string> {
    const { data: byOrder } = await supabase
      .from("buyback_orders")
      .select("order_public_id")
      .eq("order_public_id", value)
      .maybeSingle();
    if (byOrder) return byOrder.order_public_id as string;

    const { data: byTracking } = await supabase
      .from("buyback_orders")
      .select("order_public_id")
      .eq("tracking_number", value)
      .limit(2);
    if (byTracking && byTracking.length === 1) return byTracking[0].order_public_id as string;
    if (byTracking && byTracking.length > 1) {
      throw new Error(`Numer przesyłki "${value}" pasuje do kilku zamówień — podaj numer zamówienia.`);
    }
    throw new Error(
      `Nie znaleziono zamówienia ani przesyłki "${value}" wśród zsynchronizowanych — sprawdź numer albo poczekaj na synchronizację (zakładka Raw data).`
    );
  }

  async function submit() {
    setFormError("");
    const value = lookup.trim().toUpperCase();
    if (!value) {
      setFormError("Podaj numer zamówienia lub numer przesyłki.");
      return;
    }
    setSubmitting(true);
    try {
      const orderId = await resolveOrderId(value);
      const { error: err } = await supabase.from("buyback_order_intake").insert({
        order_public_id: orderId,
        entered_by_user_id: session.user.id,
        entered_by_email: session.user.email,
        status: "w_trakcie",
        history: [{ action: "created", by_email: session.user.email, at: new Date().toISOString() }],
      });
      if (err) {
        if (err.code === "23505" || err.message.includes("duplicate key")) {
          throw new Error(`Paczka ${orderId} jest już zarejestrowana — otwórz ją z listy poniżej.`);
        }
        throw err;
      }
      setLookup("");
    } catch (e: any) {
      setFormError(e.message || "Błąd zapisu.");
    } finally {
      setSubmitting(false);
    }
  }

  // Usuwanie tylko dla Admina (polityka w bazie: is_admin(); każde usunięcie trafia do deleted_records).
  async function deleteRow(row: IntakeEntry) {
    if (!confirm(`Usunąć wpis „${row.order_public_id}”? Tej operacji nie można cofnąć.`)) return;
    const { data, error: err } = await supabase.from("buyback_order_intake").delete().eq("id", row.id).select("id");
    if (err) setError(`Nie udało się usunąć: ${err.message}`);
    else if (!data?.length) setError("Nie usunięto — brak uprawnień (tylko Admin) albo wpis już nie istnieje.");
    else await load();
  }

  // Zapisy z listy idą jeden po drugim (kolejka) i zawsze na najświeższym wierszu. Bez tego szybkie
  // skanowanie kilku pól pod rząd nadpisywałoby sobie nawzajem tablicę numerów padów i log zmian.
  function enqueueUpdate(
    id: number,
    label: string,
    build: (cur: IntakeEntry) => { patch: Partial<IntakeEntry>; changes: FieldChange[] } | null
  ) {
    saveQueue.current = saveQueue.current.then(async () => {
      const cur = entriesRef.current.find((r) => r.id === id);
      const built = cur && build(cur);
      if (!cur || !built) return;
      const entry: HistoryEntry = { action: "edited", by_email: session.user.email ?? null, at: new Date().toISOString(), changes: built.changes };
      const history = [...(cur.history || []), entry];
      const { error: err } = await supabase.from("buyback_order_intake").update({ ...built.patch, history }).eq("id", id);
      if (err) {
        setError(`Nie udało się zapisać (${label}): ${err.message}`);
        return;
      }
      const next = entriesRef.current.map((r) => (r.id === id ? { ...r, ...built.patch, history } : r));
      entriesRef.current = next;
      setEntries(next);
    });
  }

  // Edycje z listy (uwagi, numer seryjny, SKU, pady) trafiają do tego samego logu zmian co edycja na karcie.
  function saveField(row: IntakeEntry, column: "notes" | "serial_number" | "sku" | "pads", label: string, value: string | number | null) {
    setError("");
    enqueueUpdate(row.id, label, (cur) => ({
      patch: { [column]: value },
      changes: [{ field: label, from: cur[column] === null ? null : String(cur[column]), to: value === null ? null : String(value) }],
    }));
  }

  // Element i tablicy pad_serials = numer seryjny pada i+1.
  function savePadSerial(row: IntakeEntry, index: number, value: string | null) {
    setError("");
    enqueueUpdate(row.id, `Nr seryjny pada ${index + 1}`, (cur) => {
      const arr = [...(cur.pad_serials ?? [])];
      while (arr.length <= index) arr.push("");
      const before = arr[index] || null;
      if (before === value) return null;
      arr[index] = value ?? "";
      return {
        patch: { pad_serials: arr.every((x) => !x) ? null : arr },
        changes: [{ field: `Nr seryjny pada ${index + 1}`, from: before, to: value }],
      };
    });
  }

  function saveDocs(row: IntakeEntry, checked: boolean) {
    setError("");
    enqueueUpdate(row.id, "Dok.", (cur) =>
      cur.docs === checked ? null : { patch: { docs: checked }, changes: [{ field: "Dok.", from: cur.docs ? "tak" : "nie", to: checked ? "tak" : "nie" }] }
    );
  }

  // Pady to liczba całkowita >= 0 (0 = zestaw bez padów, też jest poprawną, uzupełnioną wartością).
  function savePads(row: IntakeEntry, text: string | null) {
    if (text === null) return saveField(row, "pads", "Pady", null);
    if (!/^\d{1,2}$/.test(text) || Number(text) > MAX_PADS) {
      setError(`Pady: podaj liczbę całkowitą od 0 do ${MAX_PADS}.`);
      return;
    }
    return saveField(row, "pads", "Pady", Number(text));
  }

  // Brakujące dane blokujące status "Obsłużona" (ten sam warunek pilnuje trigger w bazie).
  function missingForDone(row: IntakeEntry): string[] {
    const missing: string[] = [];
    if (!row.serial_number?.trim()) missing.push("numer seryjny");
    if (!row.sku?.trim()) missing.push("SKU");
    if (row.pads === null || row.pads === undefined) missing.push("pady");
    return missing;
  }

  // Walidacja zamówienia w Back Market przy statusie "Obsłużona". Zwraca null, gdy użytkownik anulował
  // albo Back Market odmówił (wtedy status paczki się NIE zmienia); błąd jest już pokazany w `error`.
  async function validateAtBackMarket(row: IntakeEntry): Promise<{ already: boolean } | null> {
    const { data: order, error: orderErr } = await supabase
      .from("buyback_orders")
      .select("status, original_price, original_price_currency, counter_offer_price, counter_offer_price_currency")
      .eq("order_public_id", row.order_public_id)
      .maybeSingle();
    if (orderErr || !order) {
      setError(`Nie udało się odczytać zamówienia ${row.order_public_id}: ${orderErr?.message || "brak w zsynchronizowanych"}.`);
      return null;
    }
    if (BM_ALREADY_VALIDATED.includes(order.status)) return { already: true };

    const price = order.counter_offer_price ?? order.original_price;
    const currency = order.counter_offer_price != null ? order.counter_offer_price_currency : order.original_price_currency;
    const ok = confirm(
      `UWAGA — walidacja zamówienia w Back Market\n\n` +
        `Zmiana statusu na „Obsłużona” automatycznie ZWALIDUJE zamówienie ${row.order_public_id} w Back Market ` +
        `i uruchomi wypłatę dla klienta${price != null ? ` (${fmtMoney(price, currency)})` : ""}.\n` +
        `Tej operacji nie można cofnąć.\n\n` +
        `Status w Back Market (ostatnia synchronizacja): ${order.status}` +
        (order.status !== "RECEIVED" ? "\nZwykle walidować można dopiero zamówienie w statusie RECEIVED — Back Market może odmówić." : "") +
        `\n\nSprawdź numer seryjny, SKU i pady. Zwalidować i oznaczyć jako Obsłużona?`
    );
    if (!ok) return null;

    const res = await fetch("/api/tradein/validate", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ orderPublicId: row.order_public_id }),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    if (!res || !res.ok) {
      setError(data?.error || "Nie udało się połączyć z serwerem walidacji. Zamówienie NIE zostało zwalidowane.");
      return null;
    }
    return { already: !!data?.alreadyValidated };
  }

  async function changeStatus(row: IntakeEntry, status: IntakeStatus) {
    if (status === row.status) return;
    setError("");
    if (validating.current.has(row.id)) return;
    validating.current.add(row.id);
    try {
      const changes: FieldChange[] = [{ field: "Status", from: INTAKE_STATUS_LABEL[row.status], to: INTAKE_STATUS_LABEL[status] }];
      let validatedNow = false;
      if (status === "obsluzona") {
        const missing = missingForDone(row);
        if (missing.length > 0) {
          setError(`Paczki ${row.order_public_id} nie można oznaczyć jako Obsłużona — uzupełnij: ${missing.join(", ")}.`);
          return;
        }
        const validation = await validateAtBackMarket(row);
        if (!validation) return;
        if (!validation.already) {
          validatedNow = true;
          changes.push({ field: "Walidacja Back Market", from: null, to: "zwalidowano" });
        }
      }
      const now = new Date().toISOString();
      const entry: HistoryEntry = { action: "edited", by_email: session.user.email ?? null, at: now, changes };
      const { error: err } = await supabase
        .from("buyback_order_intake")
        .update({
          status,
          finished_at: status === "w_trakcie" ? null : now,
          history: [...((entriesRef.current.find((r) => r.id === row.id) ?? row).history || []), entry],
        })
        .eq("id", row.id);
      if (err) {
        setError(
          validatedNow
            ? `Zamówienie ${row.order_public_id} ZOSTAŁO zwalidowane w Back Market, ale status paczki się nie zapisał (${err.message}). Ustaw „Obsłużona” ponownie — walidacja nie powtórzy się.`
            : `Nie udało się zmienić statusu: ${err.message}`
        );
      }
    } finally {
      validating.current.delete(row.id);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-inksoft">PODSUMOWANIE PUNKTACJI (obsłużone paczki)</h2>
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
              <th className="p-3 text-right">Liczba paczek</th>
              <th className="p-3 text-right">Punkty</th>
            </tr>
          </thead>
          <tbody>
            {!loading && summary.length === 0 && (
              <tr><td colSpan={3} className="p-6 text-center text-inksoft text-sm">Brak obsłużonych paczek w tym okresie.</td></tr>
            )}
            {summary.map((s) => (
              <tr key={s.email} className="border-b border-line last:border-b-0">
                <td className="p-3 font-semibold">{displayNameForEmail(s.email, members)}</td>
                <td className="p-3 text-right font-mono">{s.count}</td>
                <td className="p-3 text-right font-mono font-semibold">{fmtPoints(s.points)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <div className="border border-line bg-white p-4 mb-6">
        <h2 className="text-xs font-semibold text-inksoft mb-3">ROZPOCZNIJ OBSŁUGĘ PACZKI</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <div className="md:col-span-2">
            <label className="text-xs font-semibold text-inksoft block mb-1">Numer zamówienia lub numer przesyłki *</label>
            <input
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !submitting && submit()}
              placeholder="np. ES-26394-ODTNR"
              className="w-full border border-line bg-white px-2 py-2 rounded text-sm font-mono"
            />
          </div>
        </div>
        {formError && <p className="text-rust text-xs mb-2">{formError}</p>}
        <button onClick={submit} disabled={submitting} className={btnPrimary}>
          {submitting ? "Szukanie…" : "Rozpocznij"}
        </button>
      </div>

      <h2 className="text-xs font-semibold text-inksoft mb-2">OSTATNIE PACZKI</h2>
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Rozpoczęto</th>
              <th className="p-3">Pracownik</th>
              <th className="p-3">Numer zamówienia</th>
              <th className="p-3">Numer seryjny</th>
              <th className="p-3">SKU</th>
              <th className="p-3">Pady</th>
              <th className="p-3">Nr seryjny padów</th>
              <th className="p-3">Dok.</th>
              <th className="p-3">Status</th>
              <th className="p-3">Uwagi</th>
              <th className="p-3">Czas</th>
              <th className="p-3 text-right">Punkty</th>
              {isAdmin && <th className="p-3"></th>}
            </tr>
          </thead>
          <tbody>
            {!loading && entries.length === 0 && (
              <tr><td colSpan={isAdmin ? 13 : 12} className="p-6 text-center text-inksoft text-sm">Brak paczek — rozpocznij pierwszą powyżej.</td></tr>
            )}
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-line last:border-b-0 hover:bg-paper">
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(e.entered_at)}</td>
                <td className="p-3">{displayNameForEmail(e.entered_by_email, members)}</td>
                <td className="p-3">
                  <button onClick={() => onOpenOrder(e.order_public_id)} className="font-mono font-semibold text-teal hover:underline">
                    {e.order_public_id}
                  </button>
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-1">
                    <InlineEditCell
                      value={e.serial_number}
                      placeholder="Dodaj numer"
                      className="w-44 font-mono"
                      onSave={(v) => saveField(e, "serial_number", "Numer seryjny", v)}
                    />
                    {e.serial_number && (
                      <button
                        onClick={() => onOpenProduct(e.serial_number!)}
                        title="Karta produktu"
                        className="text-teal text-sm px-1 hover:underline"
                      >
                        ↗
                      </button>
                    )}
                  </div>
                </td>
                <td className="p-3">
                  <InlineEditCell
                    value={e.sku}
                    placeholder="Dodaj SKU"
                    className="w-40 font-mono"
                    onSave={(v) => saveField(e, "sku", "SKU", v)}
                  />
                </td>
                <td className="p-3">
                  <InlineEditCell
                    value={e.pads === null ? null : String(e.pads)}
                    placeholder="np. 2"
                    className="w-16 font-mono"
                    onSave={(v) => savePads(e, v)}
                  />
                </td>
                <td className="p-3">
                  <PadSerialsCell count={e.pads} values={e.pad_serials} onSave={(i, v) => savePadSerial(e, i, v)} />
                </td>
                <td className="p-3 text-center">
                  <input
                    type="checkbox"
                    checked={e.docs}
                    onChange={(ev) => saveDocs(e, ev.target.checked)}
                    className="w-4 h-4 accent-teal"
                    aria-label="Dok."
                  />
                </td>
                <td className="p-3">
                  <select
                    value={e.status}
                    onChange={(ev) => changeStatus(e, ev.target.value as IntakeStatus)}
                    className={`text-xs font-semibold px-2 py-1 rounded-full border-none ${INTAKE_STATUS_STYLE[e.status]}`}
                  >
                    {INTAKE_STATUSES.map((s) => (
                      <option key={s.key} value={s.key}>{s.label}</option>
                    ))}
                  </select>
                </td>
                <td className="p-3"><InlineEditCell value={e.notes} onSave={(n) => saveField(e, "notes", "Uwagi", n)} /></td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDuration(e.entered_at, e.finished_at)}</td>
                <td className="p-3 text-right font-mono font-semibold">{e.status === "obsluzona" ? fmtPoints(e.points) : "—"}</td>
                {isAdmin && (
                  <td className="p-3 text-right">
                    <button onClick={() => deleteRow(e)} className="text-xs font-semibold text-rust hover:underline">
                      Usuń
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- karta zamówienia (dane z API + dane pracownika + log) ---------------- */

const ACTION_LABEL: Record<HistoryEntry["action"], string> = { created: "Utworzono", edited: "Edytowano" };

function OrderCardDrawer({
  orderPublicId,
  session,
  members,
  onClose,
}: {
  orderPublicId: string;
  session: Session;
  members: MemberLite[];
  onClose: () => void;
}) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [intake, setIntake] = useState<IntakeEntry | null>(null);
  const [error, setError] = useState("");

  const [editing, setEditing] = useState(false);
  const [serialDraft, setSerialDraft] = useState("");
  const [skuDraft, setSkuDraft] = useState("");
  const [padsDraft, setPadsDraft] = useState("");
  const [padSerialsDraft, setPadSerialsDraft] = useState<string[]>([]);
  const [docsDraft, setDocsDraft] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderPublicId]);

  async function load() {
    const [{ data: orderData, error: orderErr }, { data: intakeData }] = await Promise.all([
      supabase.from("buyback_orders").select("*").eq("order_public_id", orderPublicId).maybeSingle(),
      supabase
        .from("buyback_order_intake")
        .select(INTAKE_COLUMNS)
        .eq("order_public_id", orderPublicId)
        .maybeSingle(),
    ]);
    if (orderErr) setError(orderErr.message);
    setOrder((orderData as OrderDetail) ?? null);
    setIntake((intakeData as IntakeEntry) ?? null);
  }

  function startEdit() {
    setSerialDraft(intake?.serial_number || "");
    setSkuDraft(intake?.sku || "");
    setPadsDraft(intake?.pads === null || intake?.pads === undefined ? "" : String(intake.pads));
    setPadSerialsDraft(intake?.pad_serials ?? []);
    setDocsDraft(!!intake?.docs);
    setNotesDraft(intake?.notes || "");
    setEditing(true);
  }

  async function saveEdit() {
    if (!intake) return;
    const padsText = padsDraft.trim();
    if (padsText && (!/^\d{1,2}$/.test(padsText) || Number(padsText) > MAX_PADS)) {
      setError(`Pady: podaj liczbę całkowitą od 0 do ${MAX_PADS}.`);
      return;
    }
    const padCount = padsText ? Number(padsText) : 0;
    const padSerialsList = Array.from({ length: Math.max(padCount, padSerialsDraft.length) }, (_, i) => (padSerialsDraft[i] ?? "").trim());
    const padSerialsNext = padSerialsList.every((x) => !x) ? null : padSerialsList;
    const next = {
      serial_number: serialDraft.trim() || null,
      sku: skuDraft.trim() || null,
      pads: padsText ? Number(padsText) : null,
      pad_serials: padSerialsNext,
      docs: docsDraft,
      notes: notesDraft.trim() || null,
    };
    const changes: FieldChange[] = [];
    const diff = (field: string, from: string | number | null, to: string | number | null) => {
      if ((from ?? "") !== (to ?? "")) changes.push({ field, from: from === null ? null : String(from), to: to === null ? null : String(to) });
    };
    diff("Numer seryjny", intake.serial_number, next.serial_number);
    diff("SKU", intake.sku, next.sku);
    diff("Pady", intake.pads, next.pads);
    for (let i = 0; i < Math.max(intake.pad_serials?.length ?? 0, next.pad_serials?.length ?? 0); i++) {
      diff(`Nr seryjny pada ${i + 1}`, intake.pad_serials?.[i] || null, next.pad_serials?.[i] || null);
    }
    diff("Dok.", intake.docs ? "tak" : "nie", next.docs ? "tak" : "nie");
    diff("Uwagi", intake.notes, next.notes);

    if (changes.length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setError("");
    try {
      const entry: HistoryEntry = { action: "edited", by_email: session.user.email ?? null, at: new Date().toISOString(), changes };
      const { error: err } = await supabase
        .from("buyback_order_intake")
        .update({ ...next, history: [...(intake.history || []), entry] })
        .eq("id", intake.id);
      if (err) throw err;
      setEditing(false);
      await load();
    } catch (e: any) {
      setError(e.message || "Błąd zapisu.");
    } finally {
      setSaving(false);
    }
  }

  const address = order?.return_address;

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg bg-paper h-full overflow-y-auto p-6 border-l border-line">
        <div className="flex justify-between items-start mb-1">
          <h2 className="text-lg font-semibold font-mono">{orderPublicId}</h2>
          <button onClick={onClose} className="text-inksoft text-lg">✕</button>
        </div>

        {error && <p className="text-rust text-xs mb-4">{error}</p>}
        {!order && !error && <p className="text-inksoft text-sm">Wczytywanie…</p>}

        {order && (
          <>
            <div className="flex items-center gap-3 mb-6">
              <span className="inline-block text-xs font-semibold px-2 py-1 rounded-full bg-tealsoft text-teal">{order.status}</span>
              {/* Panel sprzedawcy Back Market: jedna domena (.fr) dla zamówień ze wszystkich rynków */}
              <a
                href={`https://www.backmarket.fr/bo-seller/buyback/orders/${encodeURIComponent(order.order_public_id)}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-semibold text-teal hover:underline"
              >
                Otwórz w Back Market ↗
              </a>
            </div>

            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-inksoft">DANE WPROWADZONE PRZEZ PRACOWNIKA</h3>
              {intake && !editing && (
                <button onClick={startEdit} className="text-xs font-semibold text-teal hover:underline">Edytuj</button>
              )}
            </div>
            <div className="border border-line bg-white mb-6">
              {!intake && !editing && (
                <div className="p-3 text-sm text-inksoft">Ta paczka nie jest jeszcze zarejestrowana — rozpocznij jej obsługę w zakładce "Wprowadzanie".</div>
              )}
              {intake && !editing && (
                <>
                  <Row label="Status" value={INTAKE_STATUS_LABEL[intake.status] || intake.status} />
                  <Row label="Czas obsługi" value={fmtDuration(intake.entered_at, intake.finished_at)} />
                  <Row label="Numer seryjny" value={intake.serial_number} mono />
                  <Row label="SKU" value={intake.sku} mono />
                  <Row label="Pady" value={intake.pads === null ? null : String(intake.pads)} mono />
                  {Array.from({ length: intake.pads ?? 0 }, (_, i) => (
                    <Row key={i} label={`Nr seryjny pada ${i + 1}`} value={intake.pad_serials?.[i]} mono />
                  ))}
                  <Row label="Dok." value={intake.docs ? "tak" : "nie"} />
                  <Row label="Uwagi" value={intake.notes} />
                </>
              )}
              {editing && (
                <div className="p-3 space-y-2">
                  <div>
                    <label className="text-xs font-semibold text-inksoft block mb-1">Numer seryjny</label>
                    <input value={serialDraft} onChange={(e) => setSerialDraft(e.target.value)} className="w-full border border-line bg-white px-2 py-1.5 rounded text-sm font-mono" />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-inksoft block mb-1">SKU</label>
                    <input value={skuDraft} onChange={(e) => setSkuDraft(e.target.value)} className="w-full border border-line bg-white px-2 py-1.5 rounded text-sm font-mono" />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-inksoft block mb-1">Pady (liczba w zestawie)</label>
                    <input value={padsDraft} onChange={(e) => setPadsDraft(e.target.value)} inputMode="numeric" className="w-full border border-line bg-white px-2 py-1.5 rounded text-sm font-mono" />
                  </div>
                  {Array.from({ length: Math.min(Number(padsDraft) || 0, MAX_PADS) }, (_, i) => (
                    <div key={i}>
                      <label className="text-xs font-semibold text-inksoft block mb-1">Nr seryjny pada {i + 1}</label>
                      <input
                        value={padSerialsDraft[i] ?? ""}
                        onChange={(e) => {
                          const next = [...padSerialsDraft];
                          while (next.length <= i) next.push("");
                          next[i] = e.target.value;
                          setPadSerialsDraft(next);
                        }}
                        className="w-full border border-line bg-white px-2 py-1.5 rounded text-sm font-mono"
                      />
                    </div>
                  ))}
                  <label className="flex items-center gap-2 text-sm font-semibold">
                    <input type="checkbox" checked={docsDraft} onChange={(e) => setDocsDraft(e.target.checked)} className="w-4 h-4 accent-teal" />
                    Dok.
                  </label>
                  <div>
                    <label className="text-xs font-semibold text-inksoft block mb-1">Uwagi</label>
                    <input value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} className="w-full border border-line bg-white px-2 py-1.5 rounded text-sm" />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={saveEdit} disabled={saving} className={btnPrimary}>{saving ? "Zapisywanie…" : "Zapisz"}</button>
                    <button onClick={() => setEditing(false)} className="px-4 py-2 border border-line rounded text-sm font-semibold">Anuluj</button>
                  </div>
                </div>
              )}
            </div>

            <h3 className="text-xs font-semibold text-inksoft mb-2">PRODUKT</h3>
            <div className="border border-line bg-white mb-6">
              <Row label="Nazwa" value={order.product_title} />
              <Row label="SKU" value={order.sku} mono />
              <Row label="Ocena" value={order.grade} />
              <Row label="Rynek" value={order.market} />
            </div>

            <h3 className="text-xs font-semibold text-inksoft mb-2">DATY</h3>
            <div className="border border-line bg-white mb-6">
              <Row label="Utworzono" value={fmtDateTime(order.creation_date)} />
              <Row label="Zmieniono" value={fmtDateTime(order.modification_date)} />
              <Row label="Wysłano" value={fmtDateTime(order.shipping_date)} />
              <Row label="Odebrano" value={fmtDateTime(order.receival_date)} />
              <Row label="Płatność" value={fmtDateTime(order.payment_date)} />
              <Row label="Kontroferta" value={fmtDateTime(order.counter_proposal_date)} />
              <Row label="Zawieszono" value={fmtDateTime(order.suspension_date)} />
            </div>

            <h3 className="text-xs font-semibold text-inksoft mb-2">KLIENT</h3>
            <div className="border border-line bg-white mb-6">
              <Row label="Imię i nazwisko" value={[order.customer_first_name, order.customer_last_name].filter(Boolean).join(" ")} />
              <Row label="Telefon" value={order.customer_phone} />
              <Row
                label="Adres zwrotny"
                value={address ? [address.address1, address.address2, address.zipcode, address.city, address.country].filter(Boolean).join(", ") : null}
              />
            </div>

            <h3 className="text-xs font-semibold text-inksoft mb-2">CENA I PRZESYŁKA</h3>
            <div className="border border-line bg-white mb-6">
              <Row label="Cena początkowa" value={fmtMoney(order.original_price, order.original_price_currency)} />
              <Row label="Kontroferta" value={fmtMoney(order.counter_offer_price, order.counter_offer_price_currency)} />
              <Row label="Numer przesyłki" value={order.tracking_number} mono />
              <Row label="Przewoźnik" value={order.shipper} />
              {order.transfer_certificate_link && (
                <div className="flex justify-between px-3 py-2 text-sm">
                  <span className="text-inksoft">Certyfikat przeniesienia</span>
                  <a href={order.transfer_certificate_link} target="_blank" rel="noreferrer" className="text-teal hover:underline">
                    otwórz
                  </a>
                </div>
              )}
            </div>

            {(order.suspend_reasons?.length || order.counter_offer_reasons?.length) ? (
              <>
                <h3 className="text-xs font-semibold text-inksoft mb-2">POWODY</h3>
                <div className="border border-line bg-white mb-6 p-3 text-sm">
                  {order.suspend_reasons?.map((r, i) => (
                    <div key={`s${i}`} className="mb-1"><span className="text-rust font-semibold">Zawieszenie:</span> {r.message}</div>
                  ))}
                  {order.counter_offer_reasons?.map((r, i) => (
                    <div key={`c${i}`} className="mb-1"><span className="text-amber font-semibold">Kontroferta:</span> {r.message}</div>
                  ))}
                </div>
              </>
            ) : null}

            <h3 className="text-xs font-semibold text-inksoft mb-2">LOG ZMIAN</h3>
            <div className="border border-line bg-white mb-6 p-3 text-sm">
              {!intake?.history?.length && <div className="text-inksoft">Brak jeszcze wpisów.</div>}
              {intake?.history?.map((h, i) => (
                <div key={i} className="mb-2">
                  <div>
                    <span className="font-mono text-inksoft mr-1">{i + 1}.</span>
                    {ACTION_LABEL[h.action] || h.action} przez <span className="font-semibold">{displayNameForEmail(h.by_email, members)}</span>, {fmtDateTime(h.at)}
                  </div>
                  {!!h.changes?.length && (
                    <ul className="ml-6 list-disc text-xs text-inksoft">
                      {h.changes.map((c, j) => (
                        <li key={j}>{c.field}: „{c.from || "—"}” → „{c.to || "—"}”</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex justify-between px-3 py-2 border-b border-line last:border-b-0 text-sm">
      <span className="text-inksoft">{label}</span>
      <span className={`font-semibold ${mono ? "font-mono" : ""}`}>{value || "—"}</span>
    </div>
  );
}
