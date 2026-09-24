"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import TradeInOrdersView from "./TradeInOrdersView";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { INTERVALS, fmtDuration, rangeStart, type Interval } from "@/lib/workLog";

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

const INTAKE_STATUSES = [
  { key: "w_trakcie", label: "W trakcie" },
  { key: "obsluzona", label: "Obsłużona" },
  { key: "problem", label: "Problem" },
] as const;
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
  notes: string | null;
  entered_by_email: string | null;
  entered_at: string;
  finished_at: string | null;
  status: IntakeStatus;
  points: number;
  history: HistoryEntry[];
  buyback_orders?: { tracking_number: string | null } | null;
};

const INTAKE_COLUMNS = "id, order_public_id, serial_number, sku, notes, entered_by_email, entered_at, finished_at, status, points, history";

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

export default function TradeInHub({ session, members }: { session: Session; members: MemberLite[] }) {
  const [sub, setSub] = useState<"intake" | "raw">("intake");
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setSub("intake")} className={pill(sub === "intake")}>Wprowadzanie</button>
        <button onClick={() => setSub("raw")} className={pill(sub === "raw")}>Raw data</button>
      </div>

      {sub === "intake" && <IntakeView session={session} members={members} onOpenOrder={setOpenOrderId} />}
      {sub === "raw" && <TradeInOrdersView session={session} onOpenOrder={setOpenOrderId} />}

      {openOrderId && (
        <OrderCardDrawer orderPublicId={openOrderId} session={session} members={members} onClose={() => setOpenOrderId(null)} />
      )}
    </div>
  );
}

/* ---------------- obsługa paczek Trade-in przez pracowników ---------------- */

function IntakeView({
  session,
  members,
  onOpenOrder,
}: {
  session: Session;
  members: MemberLite[];
  onOpenOrder: (id: string) => void;
}) {
  const [interval, setInterval] = useState<Interval>("today");
  const [rangeRows, setRangeRows] = useState<{ entered_by_email: string | null; points: number }[]>([]);
  const [entries, setEntries] = useState<IntakeEntry[]>([]);
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
          .select(`${INTAKE_COLUMNS}, buyback_orders(tracking_number)`)
          .order("entered_at", { ascending: false })
          .limit(50),
      ]);
      if (rangeErr) throw rangeErr;
      if (listErr) throw listErr;
      setRangeRows(rangeData || []);
      setEntries((listData as unknown as IntakeEntry[]) || []);
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

  async function changeStatus(row: IntakeEntry, status: IntakeStatus) {
    if (status === row.status) return;
    const now = new Date().toISOString();
    const entry: HistoryEntry = {
      action: "edited",
      by_email: session.user.email ?? null,
      at: now,
      changes: [{ field: "Status", from: INTAKE_STATUS_LABEL[row.status], to: INTAKE_STATUS_LABEL[status] }],
    };
    const { error: err } = await supabase
      .from("buyback_order_intake")
      .update({
        status,
        finished_at: status === "w_trakcie" ? null : now,
        history: [...(row.history || []), entry],
      })
      .eq("id", row.id);
    if (err) setError(`Nie udało się zmienić statusu: ${err.message}`);
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
              <th className="p-3">Numer przesyłki</th>
              <th className="p-3">Status</th>
              <th className="p-3">Czas</th>
              <th className="p-3 text-right">Punkty</th>
            </tr>
          </thead>
          <tbody>
            {!loading && entries.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-inksoft text-sm">Brak paczek — rozpocznij pierwszą powyżej.</td></tr>
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
                <td className="p-3 font-mono">{e.buyback_orders?.tracking_number || "—"}</td>
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
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDuration(e.entered_at, e.finished_at)}</td>
                <td className="p-3 text-right font-mono font-semibold">{e.status === "obsluzona" ? fmtPoints(e.points) : "—"}</td>
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
    setNotesDraft(intake?.notes || "");
    setEditing(true);
  }

  async function saveEdit() {
    if (!intake) return;
    const next = {
      serial_number: serialDraft.trim() || null,
      sku: skuDraft.trim() || null,
      notes: notesDraft.trim() || null,
    };
    const changes: FieldChange[] = [];
    const diff = (field: string, from: string | null, to: string | null) => {
      if ((from ?? "") !== (to ?? "")) changes.push({ field, from, to });
    };
    diff("Numer seryjny", intake.serial_number, next.serial_number);
    diff("SKU", intake.sku, next.sku);
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
            <span className="inline-block text-xs font-semibold px-2 py-1 rounded-full bg-tealsoft text-teal mb-6">{order.status}</span>

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
