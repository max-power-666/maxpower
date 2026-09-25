"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { MARKETPLACES, OUR_STATUSES, salesStatusLabel, type OurStatus } from "@/lib/salesOrders";
import { escapeLike } from "@/lib/search";
import { type MemberLite } from "@/lib/displayName";
import InlineEditCell from "./InlineEditCell";
import SalesOrderCard, { itemFieldLabel, updateSalesItem, type SalesHistoryEntry, type SalesItem } from "./SalesOrderCard";
import PadSerialsCell, { MAX_PADS } from "./PadSerialsCell";

// Zakładka Zamówienia: sprzedaż z marketplace'ów. Podstrona "Zamówienia" to wspólna lista ze wszystkich
// kanałów (tabela sales_orders; dziś tylko Back Market), "BM raw data" to podgląd wszystkiego, co zwróciło
// API Back Market (tabela bm_orders). Dane wypełnia serwer (app/api/orders/bm-sync, cron co 15 min);
// przycisk "Odśwież" uruchamia synchronizację od razu. To zamówienia SPRZEDAŻY — skup to zakładka Trade-in.

const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const PAGE_SIZES = [10, 20, 50];

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtNumber(n: number | null) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Wspólny pasek stron: ile na stronę + poprzednia/następna.
function Pager({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number | null;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}) {
  const pages = total === null ? 1 : Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-3">
        <label className="text-xs text-inksoft">Pokaż</label>
        <select
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          className="border border-line bg-white px-2 py-1.5 rounded text-sm font-semibold"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <span className="text-xs text-inksoft">{total !== null ? `z ${total} zamówień łącznie` : ""}</span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => onPage(page - 1)} disabled={page <= 1} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-40">←</button>
        <span className="text-xs text-inksoft">strona {page} z {pages}</span>
        <button onClick={() => onPage(page + 1)} disabled={page >= pages} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-40">→</button>
      </div>
    </div>
  );
}

export default function SalesOrdersHub({ session, members }: { session: Session; members: MemberLite[] }) {
  const [sub, setSub] = useState<"orders" | "bm">("orders");
  const [reloadKey, setReloadKey] = useState(0);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [openOrder, setOpenOrder] = useState<{ marketplace: string; externalId: string } | null>(null);

  useEffect(() => {
    loadMeta();
    const channel = supabase
      .channel("sales-orders-meta")
      .on("postgres_changes", { event: "*", schema: "public", table: "sales_orders_sync_meta" }, () => loadMeta())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function loadMeta() {
    // Pokazujemy najświeższą synchronizację spośród wszystkich kanałów.
    const { data } = await supabase.from("sales_orders_sync_meta").select("last_synced_at");
    const times = (data || []).map((r) => r.last_synced_at as string | null).filter((t): t is string => !!t);
    setLastSynced(times.length > 0 ? times.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)) : null);
  }

  // "Odśwież" synchronizuje wszystkie kanały po kolei; błąd jednego nie blokuje pozostałych.
  async function syncNow() {
    setSyncing(true);
    setError("");
    setNote("");
    const channels = [
      { label: "Back Market", url: "/api/orders/bm-sync" },
      { label: "Refurbed", url: "/api/orders/refurbed-sync" },
    ];
    const errors: string[] = [];
    const notes: string[] = [];
    for (const ch of channels) {
      try {
        const res = await fetch(ch.url, { headers: { Authorization: `Bearer ${session.access_token}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Błąd synchronizacji.");
        if (data.skipped) notes.push(`${ch.label}: ${data.skipped}`);
        // Pełny skan idzie w porcjach — niedokończony nie jest błędem, ale trzeba to powiedzieć.
        else if (data.finished === false) {
          notes.push(
            `${ch.label}: pobrano kolejną porcję (${data.processed} zamówień, ${data.mode === "full" ? "pierwsze pobieranie" : "synchronizacja"} w toku` +
              (data.apiCount ? `, łącznie ${data.apiCount}` : "") +
              `). Reszta dociągnie się automatycznie co 15 minut — możesz też kliknąć Odśwież ponownie.`
          );
        }
      } catch (e: any) {
        errors.push(`${ch.label}: ${e.message || "Błąd synchronizacji."}`);
      }
    }
    setError(errors.join(" · "));
    setNote(notes.join(" "));
    setReloadKey((k) => k + 1);
    await loadMeta();
    setSyncing(false);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          <button onClick={() => setSub("orders")} className={pill(sub === "orders")}>Zamówienia</button>
          <button onClick={() => setSub("bm")} className={pill(sub === "bm")}>BM raw data</button>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={syncNow} disabled={syncing} className="bg-white border border-line px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">
            {syncing ? "Synchronizowanie…" : "Odśwież"}
          </button>
          <span className="text-xs text-inksoft lowercase">
            {lastSynced ? `ostatnia synchronizacja: ${fmtDateTime(lastSynced)}` : "brak jeszcze synchronizacji"}
          </span>
        </div>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}
      {note && <p className="text-inksoft text-xs mb-3">{note}</p>}

      {sub === "orders" && (
        <OrdersList reloadKey={reloadKey} session={session} onOpen={(marketplace, externalId) => setOpenOrder({ marketplace, externalId })} />
      )}
      {sub === "bm" && <BmRawView reloadKey={reloadKey} />}

      {openOrder && (
        <SalesOrderCard
          marketplace={openOrder.marketplace}
          externalId={openOrder.externalId}
          session={session}
          members={members}
          onClose={() => setOpenOrder(null)}
        />
      )}
    </div>
  );
}

/* ---------------- wspólna lista zamówień ---------------- */

// Zamówienie może mieć kilka pozycji (sztuk). Każda pozycja ma własny wiersz z własnym SKU, numerem seryjnym,
// padami i numerami padów; numer, data i status zamówienia są wspólne (rowSpan).
type SalesRow = {
  marketplace: string;
  external_id: string;
  order_date: string | null;
  status: string;
  sku: string | null;
  tracking_number: string | null;
  our_status: OurStatus;
  sales_order_items: SalesItem[];
};
const SALES_COLUMNS =
  "marketplace, external_id, order_date, status, sku, tracking_number, our_status, sales_order_items(item_key, position, sku, serial_number, pads, pad_serials)";
const rowKey = (r: { marketplace: string; external_id: string }) => `${r.marketplace}:${r.external_id}`;

// Back Market daje numer przesyłki, refurbed tylko link śledzenia — link pokazujemy jako klikalne "śledzenie".
function TrackingCell({ value }: { value: string | null }) {
  if (!value) return <>—</>;
  if (/^https?:\/\//i.test(value)) {
    return <a href={value} target="_blank" rel="noreferrer" className="text-teal hover:underline font-sans">śledzenie ↗</a>;
  }
  return <>{value}</>;
}

// Kolor plakietki kanału — żeby na liście od razu było widać, skąd jest zamówienie (inne barwy niż statusy).
const MARKETPLACE_STYLE: Record<string, string> = {
  backmarket: "bg-[#e3ecf9] text-[#2a6bb5]",
  refurbed: "bg-[#efe6f8] text-[#7a3fb0]",
};

const OUR_STATUS_STYLE: Record<OurStatus, string> = {
  nowe: "bg-rustsoft text-rust",
  w_realizacji: "bg-ambersoft text-amber",
  wyslane: "bg-tealsoft text-teal",
};

// Kolor plakietki statusu Back Market: w toku (do zrobienia) bursztyn, wysłane zielone, reszta neutralnie.
function statusStyle(marketplace: string, status: string) {
  if (marketplace === "backmarket") {
    if (status === "9") return "bg-tealsoft text-teal";
    if (status === "1" || status === "3") return "bg-ambersoft text-amber";
  }
  if (marketplace === "refurbed") {
    if (status === "SHIPPED" || status === "FULFILLED") return "bg-tealsoft text-teal";
    if (status === "NEW" || status === "ACCEPTED") return "bg-ambersoft text-amber";
  }
  return "bg-paper text-inksoft border border-line";
}

function OrdersList({
  reloadKey,
  session,
  onOpen,
}: {
  reloadKey: number;
  session: Session;
  onOpen: (marketplace: string, externalId: string) => void;
}) {
  const [rows, setRows] = useState<SalesRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Zapisy idą jeden po drugim na najświeższym wierszu, żeby szybkie skanowanie kilku pól pod rząd
  // nie nadpisywało sobie nawzajem tablicy numerów padów.
  const rowsRef = useRef<SalesRow[]>([]);
  rowsRef.current = rows;
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const loadSeq = useRef(0); // numer ostatniego zapytania — starsze odpowiedzi są ignorowane
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    load();
    // Synchronizacja zapisuje setki zamówień naraz i każda zmiana wysyła zdarzenie — przeładowanie po każdym
    // z nich zalewało przeglądarkę zapytaniami ("Failed to fetch"). Zbieramy zdarzenia w jedno odświeżenie.
    const scheduleReload = () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(load, 1500);
    };
    const channel = supabase
      .channel("sales-orders-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "sales_orders" }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "sales_order_items" }, scheduleReload)
      .subscribe();
    return () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, search, reloadKey]);

  async function load() {
    const seq = ++loadSeq.current;
    setLoading(true);
    const from = (page - 1) * pageSize;
    let q = supabase.from("sales_orders").select(SALES_COLUMNS, { count: "exact" });
    if (search) q = q.ilike("external_id", `%${escapeLike(search)}%`);
    try {
      const { data, error: err, count } = await q
        .order("order_date", { ascending: false, nullsFirst: false })
        .order("position", { referencedTable: "sales_order_items" })
        .range(from, from + pageSize - 1);
      if (seq !== loadSeq.current) return; // przyszła nowsza odpowiedź
      if (err) throw new Error(err.message);
      setRows((data as unknown as SalesRow[]) || []);
      setTotal(count ?? null);
      setError("");
    } catch (e: any) {
      // Błąd sieci przy odświeżaniu w tle nie kasuje listy — zostaje poprzedni stan i komunikat.
      if (seq === loadSeq.current) setError(`Nie udało się wczytać zamówień: ${e.message || e}`);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  // build dostaje aktualną pozycję i zwraca jej nowy stan oraz opis zmiany do logu (albo null, gdy nic się nie zmienia).
  function enqueueItemUpdate(
    orderKey: string,
    itemKey: string,
    field: string,
    build: (it: SalesItem) => { next: Pick<SalesItem, "serial_number" | "pads" | "pad_serials">; from: string | null; to: string | null } | null
  ) {
    setError("");
    saveQueue.current = saveQueue.current.then(async () => {
      const order = rowsRef.current.find((r) => rowKey(r) === orderKey);
      const item = order?.sales_order_items.find((i) => i.item_key === itemKey);
      const built = item && build(item);
      if (!order || !item || !built) return;
      const entry: SalesHistoryEntry = {
        action: "edited",
        by_email: session.user.email ?? null,
        at: new Date().toISOString(),
        changes: [{ field: itemFieldLabel(field, item, order.sales_order_items.length > 1), from: built.from, to: built.to }],
      };
      const { error: err } = await updateSalesItem({
        marketplace: order.marketplace,
        externalId: order.external_id,
        itemKey,
        serial: built.next.serial_number,
        pads: built.next.pads,
        padSerials: built.next.pad_serials,
        entry,
      });
      if (err) {
        setError(`Nie udało się zapisać (${field}): ${err.message}`);
        return;
      }
      const next = rowsRef.current.map((r) =>
        rowKey(r) !== orderKey
          ? r
          : { ...r, sales_order_items: r.sales_order_items.map((i) => (i.item_key === itemKey ? { ...i, ...built.next } : i)) }
      );
      rowsRef.current = next;
      setRows(next);
    });
  }

  // Nasz status realizacji (poziom zamówienia): zmiana + wpis do logu w jednej transakcji (funkcja bazy).
  function changeOurStatus(order: SalesRow, status: OurStatus) {
    setError("");
    const key = rowKey(order);
    saveQueue.current = saveQueue.current.then(async () => {
      const cur = rowsRef.current.find((r) => rowKey(r) === key);
      if (!cur || cur.our_status === status) return;
      const label = (k: string) => OUR_STATUSES.find((o) => o.key === k)?.label ?? k;
      const entry: SalesHistoryEntry = {
        action: "edited",
        by_email: session.user.email ?? null,
        at: new Date().toISOString(),
        changes: [{ field: "Nasz status", from: label(cur.our_status), to: label(status) }],
      };
      const { error: err } = await supabase.rpc("sales_order_set_status", {
        p_marketplace: cur.marketplace,
        p_external_id: cur.external_id,
        p_status: status,
        p_entry: entry,
      });
      if (err) {
        setError(`Nie udało się zmienić statusu: ${err.message}`);
        await load(); // select jest kontrolowany przez React — przywróć stan z bazy
        return;
      }
      const next = rowsRef.current.map((r) => (rowKey(r) === key ? { ...r, our_status: status } : r));
      rowsRef.current = next;
      setRows(next);
    });
  }

  function saveSerial(order: SalesRow, item: SalesItem, value: string | null) {
    enqueueItemUpdate(rowKey(order), item.item_key, "Numer seryjny", (cur) =>
      cur.serial_number === value ? null : { next: { serial_number: value, pads: cur.pads, pad_serials: cur.pad_serials }, from: cur.serial_number, to: value }
    );
  }

  // Pady to liczba całkowita 0..MAX_PADS (0 = zestaw bez padów).
  function savePads(order: SalesRow, item: SalesItem, text: string | null) {
    if (text !== null && (!/^\d{1,2}$/.test(text) || Number(text) > MAX_PADS)) {
      setError(`Pady: podaj liczbę całkowitą od 0 do ${MAX_PADS}.`);
      return;
    }
    const value = text === null ? null : Number(text);
    enqueueItemUpdate(rowKey(order), item.item_key, "Pady", (cur) =>
      cur.pads === value
        ? null
        : {
            next: { serial_number: cur.serial_number, pads: value, pad_serials: cur.pad_serials },
            from: cur.pads === null ? null : String(cur.pads),
            to: value === null ? null : String(value),
          }
    );
  }

  // Element i tablicy pad_serials = numer seryjny pada i+1.
  function savePadSerial(order: SalesRow, item: SalesItem, index: number, value: string | null) {
    enqueueItemUpdate(rowKey(order), item.item_key, `Nr seryjny pada ${index + 1}`, (cur) => {
      const arr = [...(cur.pad_serials ?? [])];
      while (arr.length <= index) arr.push("");
      const before = arr[index] || null;
      if (before === value) return null;
      arr[index] = value ?? "";
      return {
        next: { serial_number: cur.serial_number, pads: cur.pads, pad_serials: arr.every((x) => !x) ? null : arr },
        from: before,
        to: value,
      };
    });
  }

  return (
    <div>
      <input
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        placeholder="Szukaj po numerze zamówienia"
        className="w-72 border border-line bg-white px-3 py-2 rounded text-sm font-mono mb-3"
      />
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
      {error && <p className="text-rust text-xs mb-3">{error}</p>}
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Marketplace</th>
              <th className="p-3">Nr zamówienia</th>
              <th className="p-3">Data zamówienia</th>
              <th className="p-3">Status</th>
              <th className="p-3">Nr przesyłki</th>
              <th className="p-3">SKU</th>
              <th className="p-3">Numer seryjny</th>
              <th className="p-3">Pady</th>
              <th className="p-3">Nr seryjny padów</th>
              <th className="p-3">Nasz status</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr><td colSpan={10} className="p-6 text-center text-inksoft text-sm">{search ? "Nic nie znaleziono dla tego numeru." : "Brak zamówień — kliknij Odśwież, żeby pobrać je z Back Market."}</td></tr>
            )}
            {rows.map((r) => {
              // Zamówienie bez pozycji (jeszcze nie zsynchronizowane) pokazujemy jednym wierszem z samym SKU.
              const items: (SalesItem | null)[] = r.sales_order_items.length > 0 ? r.sales_order_items : [null];
              return items.map((it, idx) => (
                <tr
                  key={`${rowKey(r)}#${it?.item_key ?? "none"}`}
                  className={`align-top ${idx === items.length - 1 ? "border-b border-line" : "border-b border-dashed border-line"}`}
                >
                  {idx === 0 && (
                    <>
                      <td rowSpan={items.length} className="p-3 whitespace-nowrap">
                        <span className={`text-xs font-semibold px-2 py-1 rounded-full ${MARKETPLACE_STYLE[r.marketplace] ?? "bg-paper text-inksoft border border-line"}`}>
                          {MARKETPLACES.find((m) => m.key === r.marketplace)?.label ?? r.marketplace}
                        </span>
                      </td>
                      <td rowSpan={items.length} className="p-3 whitespace-nowrap">
                        <button
                          onClick={() => onOpen(r.marketplace, r.external_id)}
                          className="font-mono font-semibold text-teal hover:underline"
                        >
                          {r.external_id}
                        </button>
                      </td>
                      <td rowSpan={items.length} className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(r.order_date)}</td>
                      <td rowSpan={items.length} className="p-3">
                        <span className={`text-xs font-semibold px-2 py-1 rounded-full ${statusStyle(r.marketplace, r.status)}`}>
                          {salesStatusLabel(r.marketplace, r.status)}
                        </span>
                      </td>
                      <td rowSpan={items.length} className="p-3 font-mono whitespace-nowrap">
                        <TrackingCell value={r.tracking_number} />
                      </td>
                    </>
                  )}
                  <td className="p-3 font-mono whitespace-nowrap">{it ? it.sku || "—" : r.sku || "—"}</td>
                  {it ? (
                    <>
                      <td className="p-3">
                        <InlineEditCell value={it.serial_number} placeholder="Dodaj numer" className="w-44 font-mono" onSave={(v) => saveSerial(r, it, v)} />
                      </td>
                      <td className="p-3">
                        <InlineEditCell value={it.pads === null ? null : String(it.pads)} placeholder="np. 2" className="w-16 font-mono" onSave={(v) => savePads(r, it, v)} />
                      </td>
                      <td className="p-3">
                        <PadSerialsCell count={it.pads} values={it.pad_serials} onSave={(i, v) => savePadSerial(r, it, i, v)} />
                      </td>
                    </>
                  ) : (
                    <td colSpan={3} className="p-3 text-xs text-inksoft">—</td>
                  )}
                  {idx === 0 && (
                    <td rowSpan={items.length} className="p-3">
                      <select
                        value={r.our_status}
                        onChange={(ev) => changeOurStatus(r, ev.target.value as OurStatus)}
                        className={`text-xs font-semibold px-2 py-1 rounded-full border-none ${OUR_STATUS_STYLE[r.our_status]}`}
                      >
                        {OUR_STATUSES.map((o) => (
                          <option key={o.key} value={o.key}>{o.label}</option>
                        ))}
                      </select>
                    </td>
                  )}
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- BM raw data: wszystko, co zwróciło API Back Market ---------------- */

type BmRow = {
  order_id: number;
  state: number;
  country_code: string | null;
  date_creation: string | null;
  date_modification: string | null;
  date_payment: string | null;
  date_shipping: string | null;
  expected_dispatch_date: string | null;
  price: number | null;
  shipping_price: number | null;
  currency: string | null;
  sales_taxes: number | null;
  payment_method: string | null;
  installment_payment: boolean | null;
  paypal_reference: string | null;
  delivery_mode: string | null;
  tracking_number: string | null;
  shipper_display: string | null;
  is_backship: boolean | null;
  orderlines: { listing?: string; quantity?: number }[] | null;
  raw: unknown;
};

const yesNo = (b: boolean | null) => (b === null || b === undefined ? "—" : b ? "tak" : "nie");

const BM_COLUMNS: { label: string; cell: (r: BmRow) => string; mono?: boolean; right?: boolean }[] = [
  { label: "order_id", cell: (r) => String(r.order_id), mono: true },
  { label: "state", cell: (r) => `${r.state} · ${salesStatusLabel("backmarket", String(r.state))}` },
  { label: "country_code", cell: (r) => r.country_code || "—" },
  { label: "date_creation", cell: (r) => fmtDateTime(r.date_creation) },
  { label: "date_modification", cell: (r) => fmtDateTime(r.date_modification) },
  { label: "date_payment", cell: (r) => fmtDateTime(r.date_payment) },
  { label: "date_shipping", cell: (r) => fmtDateTime(r.date_shipping) },
  { label: "expected_dispatch_date", cell: (r) => fmtDateTime(r.expected_dispatch_date) },
  { label: "orderlines (listing × ilość)", cell: (r) => (r.orderlines || []).map((l) => `${l.listing ?? "?"} × ${l.quantity ?? 1}`).join(", ") || "—", mono: true },
  { label: "price", cell: (r) => fmtNumber(r.price), right: true, mono: true },
  { label: "shipping_price", cell: (r) => fmtNumber(r.shipping_price), right: true, mono: true },
  { label: "currency", cell: (r) => r.currency || "—" },
  { label: "sales_taxes", cell: (r) => fmtNumber(r.sales_taxes), right: true, mono: true },
  { label: "payment_method", cell: (r) => r.payment_method || "—" },
  { label: "installment_payment", cell: (r) => yesNo(r.installment_payment) },
  { label: "paypal_reference", cell: (r) => r.paypal_reference || "—", mono: true },
  { label: "delivery_mode", cell: (r) => r.delivery_mode || "—" },
  { label: "shipper_display", cell: (r) => r.shipper_display || "—" },
  { label: "is_backship", cell: (r) => yesNo(r.is_backship) },
  { label: "tracking_number", cell: (r) => r.tracking_number || "—", mono: true },
];

function BmRawView({ reloadKey }: { reloadKey: number }) {
  const [rows, setRows] = useState<BmRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, reloadKey]);

  async function load() {
    setLoading(true);
    setError("");
    const from = (page - 1) * pageSize;
    const { data, error: err, count } = await supabase
      .from("bm_orders")
      .select("*", { count: "exact" })
      .order("date_creation", { ascending: false, nullsFirst: false })
      .range(from, from + pageSize - 1);
    if (err) setError(`Nie udało się wczytać danych: ${err.message}`);
    else {
      setRows((data as BmRow[]) || []);
      setTotal(count ?? null);
    }
    setLoading(false);
  }

  return (
    <div>
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
      {error && <p className="text-rust text-xs mb-3">{error}</p>}
      <p className="text-xs text-inksoft mb-2">Nazwy kolumn są takie jak w API Back Market. „JSON” pokazuje całą odpowiedź dla zamówienia (razem z adresami).</p>
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              {BM_COLUMNS.map((c) => (
                <th key={c.label} className={`p-3 whitespace-nowrap ${c.right ? "text-right" : ""}`}>{c.label}</th>
              ))}
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr><td colSpan={BM_COLUMNS.length + 1} className="p-6 text-center text-inksoft text-sm">Brak danych — kliknij Odśwież, żeby pobrać zamówienia z Back Market.</td></tr>
            )}
            {rows.map((r) => (
              <Fragment key={r.order_id}>
                <tr className="border-b border-line last:border-b-0 hover:bg-paper">
                  {BM_COLUMNS.map((c) => (
                    <td key={c.label} className={`p-3 whitespace-nowrap ${c.mono ? "font-mono" : ""} ${c.right ? "text-right" : ""}`}>{c.cell(r)}</td>
                  ))}
                  <td className="p-3 whitespace-nowrap">
                    <button onClick={() => setExpanded(expanded === r.order_id ? null : r.order_id)} className="text-xs font-semibold text-teal hover:underline">
                      {expanded === r.order_id ? "Ukryj JSON" : "JSON"}
                    </button>
                  </td>
                </tr>
                {expanded === r.order_id && (
                  <tr className="border-b border-line bg-paper">
                    <td colSpan={BM_COLUMNS.length + 1} className="p-3">
                      <pre className="text-xs font-mono overflow-x-auto whitespace-pre-wrap">{JSON.stringify(r.raw, null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
