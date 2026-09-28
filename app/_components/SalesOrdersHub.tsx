"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { MARKETPLACES, OUR_STATUSES, salesStatusLabel, startOfYesterdayIso, summarizeDays, type DayCount, type OurStatus } from "@/lib/salesOrders";
import { escapeLike } from "@/lib/search";
import { type MemberLite } from "@/lib/displayName";
import type { ShipPrefill } from "@/lib/shipping";
import InlineEditCell from "./InlineEditCell";
import SalesOrderCard, { itemFieldLabel, updateSalesItem, type SalesHistoryEntry, type SalesItem } from "./SalesOrderCard";
import PadSerialsCell, { MAX_PADS } from "./PadSerialsCell";

// Zakładka Zamówienia: sprzedaż z marketplace'ów — wspólna lista ze wszystkich kanałów (tabela sales_orders).
// Dane wypełnia serwer (app/api/orders/*-sync, cron co 15 min); przycisk "Odśwież" uruchamia synchronizację od razu.
// To zamówienia SPRZEDAŻY — skup to zakładka Trade-in. (Podstrona "BM raw data" — surowy podgląd bm_orders —
// usunięta na prośbę właściciela, nieużywana; jeśli znów będzie potrzebna, patrz historia gita tego pliku.)

const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
// Mniejsza wersja — filtry w pasku ponad listą (np. "Nasz status"), obok "Pokaż"/"strona X z Y", nie sam przełącznik podstron.
const smallPill = (active: boolean) =>
  `px-2.5 py-1 rounded-full text-xs font-semibold border whitespace-nowrap ${active ? "bg-ink text-paper border-ink" : "bg-white border-line text-inksoft"}`;
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
  middle,
}: {
  page: number;
  pageSize: number;
  total: number | null;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
  middle?: ReactNode; // np. filtr statusu w Zamówieniach — puste dla list bez takiego filtra
}) {
  const pages = total === null ? 1 : Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
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
        <div className="flex items-center gap-2 ml-2">
          <button onClick={() => onPage(page - 1)} disabled={page <= 1} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-40">←</button>
          <span className="text-xs text-inksoft">strona {page} z {pages}</span>
          <button onClick={() => onPage(page + 1)} disabled={page >= pages} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-40">→</button>
        </div>
      </div>
      {middle}
    </div>
  );
}

export default function SalesOrdersHub({
  session,
  members,
  isAdmin,
  canShip,
  onShip,
}: {
  session: Session;
  members: MemberLite[];
  isAdmin: boolean;
  canShip: boolean; // wyliczane z ROLE_ACCESS[role] w app/page.tsx (rola ma dostęp do Wysyłki)
  onShip: (prefill: ShipPrefill) => void;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [openOrder, setOpenOrder] = useState<{ marketplace: string; externalId: string } | null>(null);
  // Połączenie z Allegro (OAuth) — widoczne i obsługiwane tylko przez Admina.
  const [allegro, setAllegro] = useState<{ configured: boolean; connected: boolean; redirectUri: string } | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    // Powrót z Allegro po autoryzacji (allegro-callback przekierowuje na /?allegro=connected|error&msg=...).
    const params = new URLSearchParams(window.location.search);
    const result = params.get("allegro");
    if (result) {
      if (result === "connected") setNote("Allegro połączone — kliknij Odśwież, żeby pobrać zamówienia.");
      else setError(params.get("msg") || "Nie udało się połączyć z Allegro.");
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (isAdmin) {
      loadAllegro();
    }
    loadMeta();
    const channel = supabase
      .channel("sales-orders-meta")
      .on("postgres_changes", { event: "*", schema: "public", table: "sales_orders_sync_meta" }, () => loadMeta())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function loadAllegro() {
    try {
      const res = await fetch("/api/orders/allegro-auth", { headers: { Authorization: `Bearer ${session.access_token}` } });
      if (res.ok) setAllegro(await res.json());
    } catch {
      /* brak połączenia — panel Allegro po prostu się nie pokaże */
    }
  }

  // Zaczyna autoryzację: serwer wydaje adres strony Allegro, na którą przechodzimy, żeby wyrazić zgodę (odczyt zamówień).
  async function connectAllegro() {
    setConnecting(true);
    setError("");
    try {
      const res = await fetch("/api/orders/allegro-auth", { method: "POST", headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Nie udało się rozpocząć łączenia z Allegro.");
      window.location.href = data.url;
    } catch (e: any) {
      setError(e.message || "Nie udało się rozpocząć łączenia z Allegro.");
      setConnecting(false);
    }
  }

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
      { label: "Erli", url: "/api/orders/erli-sync" },
      { label: "Allegro", url: "/api/orders/allegro-sync" },
      { label: "Amazon", url: "/api/orders/amazon-sync" },
      { label: "Octopia", url: "/api/orders/octopia-sync" },
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
      <div className="flex items-center justify-end gap-3 mb-4">
        <button onClick={syncNow} disabled={syncing} className="bg-white border border-line px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">
          {syncing ? "Synchronizowanie…" : "Odśwież"}
        </button>
        <span className="text-xs text-inksoft lowercase">
          {lastSynced ? `ostatnia synchronizacja: ${fmtDateTime(lastSynced)}` : "brak jeszcze synchronizacji"}
        </span>
      </div>

      {/* Gdy Allegro jest połączone, nie pokazujemy nic — komunikat ma sens tylko, gdy trzeba coś zrobić. */}
      {isAdmin && allegro && (!allegro.configured || !allegro.connected) && (
        <div className="text-xs text-inksoft mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          {!allegro.configured && <span>Allegro: brak ALLEGRO_CLIENT_ID / ALLEGRO_CLIENT_SECRET / ALLEGRO_UA w zmiennych środowiskowych.</span>}
          {allegro.configured && !allegro.connected && (
            <>
              <button onClick={connectAllegro} disabled={connecting} className="bg-white border border-line px-3 py-1.5 rounded text-xs font-semibold disabled:opacity-50">
                {connecting ? "Przekierowanie…" : "Połącz z Allegro"}
              </button>
              <span>Adres przekierowania do wpisania w aplikacji Allegro: <span className="font-mono">{allegro.redirectUri}</span></span>
            </>
          )}
        </div>
      )}


      {error && <p className="text-rust text-xs mb-3">{error}</p>}
      {note && <p className="text-inksoft text-xs mb-3">{note}</p>}

      <DaySummary reloadKey={reloadKey} />

      <OrdersList reloadKey={reloadKey} session={session} onOpen={(marketplace, externalId) => setOpenOrder({ marketplace, externalId })} />

      {openOrder && (
        <SalesOrderCard
          marketplace={openOrder.marketplace}
          externalId={openOrder.externalId}
          session={session}
          members={members}
          onClose={() => setOpenOrder(null)}
          onShip={canShip ? onShip : undefined}
        />
      )}
    </div>
  );
}

/* ---------------- podsumowanie: zamówienia dziś i wczoraj ---------------- */

// Liczy zamówienia z dzisiejszej i wczorajszej doby (czas lokalny), bez anulowanych, zwróconych i nieopłaconych
// (patrz isCountedOrder). Data zamówienia = order_date z listy, więc liczby zgadzają się z tym, co widać poniżej.
function DaySummary({ reloadKey }: { reloadKey: number }) {
  const [days, setDays] = useState<{ today: DayCount; yesterday: DayCount } | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    load();
    // Synchronizacja zmienia setki wierszy naraz — odświeżamy z opóźnieniem, jednym zapytaniem (jak lista poniżej).
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 3000);
    };
    const channel = supabase
      .channel("sales-day-summary")
      .on("postgres_changes", { event: "*", schema: "public", table: "sales_orders" }, schedule)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  async function load() {
    try {
      const since = startOfYesterdayIso();
      const rows: { marketplace: string; status: string; order_date: string | null }[] = [];
      // PostgREST oddaje max 1000 wierszy na zapytanie — czytamy stronami.
      for (let from = 0; ; from += 1000) {
        const { data, error: err } = await supabase
          .from("sales_orders")
          .select("marketplace, status, order_date")
          .gte("order_date", since)
          .order("order_date", { ascending: false })
          .range(from, from + 999);
        if (err) throw new Error(err.message);
        rows.push(...((data as typeof rows) || []));
        if (!data || data.length < 1000) break;
      }
      setDays(summarizeDays(rows));
      setError("");
    } catch (e: any) {
      setError(`Nie udało się policzyć zamówień: ${e.message || e}`);
    }
  }

  const tile = (label: string, d: DayCount | undefined) => (
    <div className="border border-line bg-white px-4 py-3 min-w-[13rem]">
      <div className="text-xs font-semibold text-inksoft">{label}</div>
      <div className="text-3xl font-semibold font-mono">{d ? d.total : "—"}</div>
      <div className="flex flex-wrap gap-1 mt-1 min-h-[1.5rem]">
        {d &&
          MARKETPLACES.filter((m) => d.byMarketplace[m.key]).map((m) => (
            <span key={m.key} className={`text-xs font-semibold px-2 py-0.5 rounded-full ${MARKETPLACE_STYLE[m.key] ?? "bg-paper text-inksoft border border-line"}`}>
              {m.label} {d.byMarketplace[m.key]}
            </span>
          ))}
      </div>
    </div>
  );

  return (
    <div className="mb-5">
      <div className="flex flex-wrap gap-3" title="Bez anulowanych, zwróconych i nieopłaconych zamówień">
        {tile("Zamówienia dzisiaj", days?.today)}
        {tile("Zamówienia wczoraj", days?.yesterday)}
      </div>
      {error && <p className="text-rust text-xs mt-2">{error}</p>}
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
  country_code: string | null;
  our_status: OurStatus;
  sales_order_items: SalesItem[];
};
const SALES_COLUMNS =
  "marketplace, external_id, order_date, status, sku, tracking_number, country_code, our_status, sales_order_items(item_key, position, sku, serial_number, pads, pad_serials)";
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
  erli: "bg-[#fbe4ef] text-[#b0296b]",
  allegro: "bg-[#fde3d3] text-[#c2410c]",
  octopia: "bg-[#dcf5e3] text-[#1a7a3d]",
  apilo: "bg-[#fdecc8] text-[#a15c00]",
  amazon: "bg-[#2a2a2a] text-[#ff9900]",
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
  if (marketplace === "allegro") {
    if (status === "READY_FOR_PROCESSING") return "bg-ambersoft text-amber"; // opłacone — do obsłużenia
    if (status === "READY_FOR_PROCESSING_COD") return "bg-rustsoft text-rust font-bold"; // za pobraniem — nie mylić z opłaconym
  }
  if (marketplace === "amazon") {
    if (status === "Unshipped" || status === "PartiallyShipped" || status === "Pending") return "bg-ambersoft text-amber";
    if (status === "Shipped") return "bg-tealsoft text-teal";
  }
  if (marketplace === "octopia") {
    if (status === "WaitingAcceptance" || status === "Accepted" || status === "InPreparation") return "bg-ambersoft text-amber";
    if (status === "Shipped" || status === "Delivered") return "bg-tealsoft text-teal";
  }
  if (marketplace === "erli") {
    if (status === "purchased") return "bg-ambersoft text-amber"; // opłacone — do obsłużenia
    if (status === "purchased_cod") return "bg-rustsoft text-rust font-bold"; // za pobraniem — płatność dopiero przy odbiorze, nie mylić z opłaconym
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
  const [statusFilter, setStatusFilter] = useState<OurStatus | "wszystkie">("wszystkie");
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
  }, [page, pageSize, search, statusFilter, reloadKey]);

  async function load() {
    const seq = ++loadSeq.current;
    setLoading(true);
    const from = (page - 1) * pageSize;
    let q = supabase.from("sales_orders").select(SALES_COLUMNS, { count: "exact" });
    if (search) q = q.ilike("external_id", `%${escapeLike(search)}%`);
    if (statusFilter !== "wszystkie") q = q.eq("our_status", statusFilter);
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

      // "W realizacji" = bierzemy się za to — odpowiada akcji "zaakceptuj zamówienie" u marketplace'u (dziś: Back
      // Market). Nie cofa zmiany statusu, gdyby się nie udało — to tylko ostrzeżenie, nie blokada.
      if (status === "w_realizacji") {
        try {
          const res = await fetch("/api/orders/validate", {
            method: "POST",
            headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ marketplace: cur.marketplace, externalId: cur.external_id }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || (data && data.error)) setError(`Zamówienie ${cur.external_id}: nie udało się zaakceptować u marketplace'u — ${data?.error ?? "błąd serwera"}.`);
        } catch (e: any) {
          setError(`Zamówienie ${cur.external_id}: nie udało się zaakceptować u marketplace'u — ${e?.message ?? "błąd sieci"}.`);
        }
      }
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
      <Pager
        page={page}
        pageSize={pageSize}
        total={total}
        onPage={setPage}
        onPageSize={(n) => { setPageSize(n); setPage(1); }}
        middle={
          <div className="flex items-center gap-2">
            <button onClick={() => { setStatusFilter("wszystkie"); setPage(1); }} className={smallPill(statusFilter === "wszystkie")}>Wszystkie</button>
            {OUR_STATUSES.map((s) => (
              <button key={s.key} onClick={() => { setStatusFilter(s.key); setPage(1); }} className={smallPill(statusFilter === s.key)}>{s.label}</button>
            ))}
          </div>
        }
      />
      {error && <p className="text-rust text-xs mb-3">{error}</p>}
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Marketplace</th>
              <th className="p-3">Nr zamówienia</th>
              <th className="p-3">Data zamówienia</th>
              <th className="p-3">Status</th>
              <th className="p-3">Kraj</th>
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
              <tr><td colSpan={11} className="p-6 text-center text-inksoft text-sm">{search ? "Nic nie znaleziono dla tego numeru." : "Brak zamówień — kliknij Odśwież, żeby pobrać je z Back Market."}</td></tr>
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
                        <span className={`text-xs font-semibold px-2 py-1 rounded-full whitespace-nowrap ${statusStyle(r.marketplace, r.status)}`}>
                          {salesStatusLabel(r.marketplace, r.status)}
                        </span>
                      </td>
                      <td rowSpan={items.length} className="p-3 text-xs font-mono whitespace-nowrap">{r.country_code || "—"}</td>
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
