"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { MARKETPLACES, salesStatusLabel } from "@/lib/salesOrders";
import { escapeLike } from "@/lib/search";
import InlineEditCell from "./InlineEditCell";
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

export default function SalesOrdersHub({ session }: { session: Session }) {
  const [sub, setSub] = useState<"orders" | "bm">("orders");
  const [reloadKey, setReloadKey] = useState(0);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

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
    const { data } = await supabase.from("sales_orders_sync_meta").select("last_synced_at").eq("marketplace", "backmarket").maybeSingle();
    setLastSynced((data?.last_synced_at as string) ?? null);
  }

  async function syncNow() {
    setSyncing(true);
    setError("");
    setNote("");
    try {
      const res = await fetch("/api/orders/bm-sync", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Błąd synchronizacji.");
      // Pełny skan idzie w porcjach — niedokończony nie jest błędem, ale trzeba to powiedzieć.
      if (data.finished === false) {
        setNote(
          `Pobrano kolejną porcję (${data.processed} zamówień, ${data.mode === "full" ? "pierwsze pobieranie" : "synchronizacja"} w toku` +
            (data.apiCount ? `, Back Market zgłasza ${data.apiCount} łącznie` : "") +
            `). Reszta dociągnie się automatycznie co 15 minut — możesz też kliknąć Odśwież ponownie.`
        );
      }
      setReloadKey((k) => k + 1);
      await loadMeta();
    } catch (e: any) {
      setError(e.message || "Błąd synchronizacji.");
    } finally {
      setSyncing(false);
    }
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

      {sub === "orders" && <OrdersList reloadKey={reloadKey} />}
      {sub === "bm" && <BmRawView reloadKey={reloadKey} />}
    </div>
  );
}

/* ---------------- wspólna lista zamówień ---------------- */

type SalesRow = {
  marketplace: string;
  external_id: string;
  order_date: string | null;
  status: string;
  sku: string | null;
  serial_number: string | null; // od tąd dane wpisywane przez pracowników
  pads: number | null;
  pad_serials: string[] | null;
};
const SALES_COLUMNS = "marketplace, external_id, order_date, status, sku, serial_number, pads, pad_serials";
const rowKey = (r: { marketplace: string; external_id: string }) => `${r.marketplace}:${r.external_id}`;

// Kolor plakietki statusu Back Market: w toku (do zrobienia) bursztyn, wysłane zielone, reszta neutralnie.
function statusStyle(marketplace: string, status: string) {
  if (marketplace === "backmarket") {
    if (status === "9") return "bg-tealsoft text-teal";
    if (status === "1" || status === "3") return "bg-ambersoft text-amber";
  }
  return "bg-paper text-inksoft border border-line";
}

function OrdersList({ reloadKey }: { reloadKey: number }) {
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

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel("sales-orders-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "sales_orders" }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, search, reloadKey]);

  async function load() {
    setLoading(true);
    setError("");
    const from = (page - 1) * pageSize;
    let q = supabase.from("sales_orders").select(SALES_COLUMNS, { count: "exact" });
    if (search) q = q.ilike("external_id", `%${escapeLike(search)}%`);
    const { data, error: err, count } = await q
      .order("order_date", { ascending: false, nullsFirst: false })
      .range(from, from + pageSize - 1);
    if (err) setError(`Nie udało się wczytać zamówień: ${err.message}`);
    else {
      setRows((data as SalesRow[]) || []);
      setTotal(count ?? null);
    }
    setLoading(false);
  }

  function enqueueUpdate(key: string, label: string, build: (cur: SalesRow) => Partial<SalesRow> | null) {
    setError("");
    saveQueue.current = saveQueue.current.then(async () => {
      const cur = rowsRef.current.find((r) => rowKey(r) === key);
      const patch = cur && build(cur);
      if (!cur || !patch) return;
      const { error: err } = await supabase
        .from("sales_orders")
        .update(patch)
        .eq("marketplace", cur.marketplace)
        .eq("external_id", cur.external_id);
      if (err) {
        setError(`Nie udało się zapisać (${label}): ${err.message}`);
        return;
      }
      const next = rowsRef.current.map((r) => (rowKey(r) === key ? { ...r, ...patch } : r));
      rowsRef.current = next;
      setRows(next);
    });
  }

  function saveSerial(row: SalesRow, value: string | null) {
    enqueueUpdate(rowKey(row), "Numer seryjny", (cur) => (cur.serial_number === value ? null : { serial_number: value }));
  }

  // Pady to liczba całkowita 0..MAX_PADS (0 = zestaw bez padów).
  function savePads(row: SalesRow, text: string | null) {
    if (text !== null && (!/^\d{1,2}$/.test(text) || Number(text) > MAX_PADS)) {
      setError(`Pady: podaj liczbę całkowitą od 0 do ${MAX_PADS}.`);
      return;
    }
    const value = text === null ? null : Number(text);
    enqueueUpdate(rowKey(row), "Pady", (cur) => (cur.pads === value ? null : { pads: value }));
  }

  // Element i tablicy pad_serials = numer seryjny pada i+1.
  function savePadSerial(row: SalesRow, index: number, value: string | null) {
    enqueueUpdate(rowKey(row), `Nr seryjny pada ${index + 1}`, (cur) => {
      const arr = [...(cur.pad_serials ?? [])];
      while (arr.length <= index) arr.push("");
      if ((arr[index] || null) === value) return null;
      arr[index] = value ?? "";
      return { pad_serials: arr.every((x) => !x) ? null : arr };
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
              <th className="p-3">Nr zamówienia</th>
              <th className="p-3">Data zamówienia</th>
              <th className="p-3">Status</th>
              <th className="p-3">SKU</th>
              <th className="p-3">Numer seryjny</th>
              <th className="p-3">Pady</th>
              <th className="p-3">Nr seryjny padów</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-inksoft text-sm">{search ? "Nic nie znaleziono dla tego numeru." : "Brak zamówień — kliknij Odśwież, żeby pobrać je z Back Market."}</td></tr>
            )}
            {rows.map((r) => (
              <tr key={rowKey(r)} className="border-b border-line last:border-b-0 hover:bg-paper">
                <td className="p-3 font-mono font-semibold whitespace-nowrap" title={MARKETPLACES.find((m) => m.key === r.marketplace)?.label}>
                  {r.external_id}
                </td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(r.order_date)}</td>
                <td className="p-3">
                  <span className={`text-xs font-semibold px-2 py-1 rounded-full ${statusStyle(r.marketplace, r.status)}`}>
                    {salesStatusLabel(r.marketplace, r.status)}
                  </span>
                </td>
                <td className="p-3 font-mono">{r.sku || "—"}</td>
                <td className="p-3">
                  <InlineEditCell value={r.serial_number} placeholder="Dodaj numer" className="w-44 font-mono" onSave={(v) => saveSerial(r, v)} />
                </td>
                <td className="p-3">
                  <InlineEditCell value={r.pads === null ? null : String(r.pads)} placeholder="np. 2" className="w-16 font-mono" onSave={(v) => savePads(r, v)} />
                </td>
                <td className="p-3">
                  <PadSerialsCell count={r.pads} values={r.pad_serials} onSave={(i, v) => savePadSerial(r, i, v)} />
                </td>
              </tr>
            ))}
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
