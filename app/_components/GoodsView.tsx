"use client";

import { productStatusParts } from "@/lib/workLog";
import { skuCategoryOf, CAMERA_CATEGORY } from "@/lib/skuParts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { escapeLike } from "@/lib/search";
import type { MemberLite } from "@/lib/displayName";
import type { Session } from "@supabase/supabase-js";
import ProductCardDrawer from "./ProductCardDrawer";
import GoodsAddForm, { type GoodsEditRow } from "./GoodsAddForm";

// Zakładka Towar (10.10.2026, na prośbę właściciela): rejestr zakupionego towaru z arkusza Towar.numbers, dwie pigułki jak arkusze:
// VM, V23 (zakupy od firm i z Allegro, podział wg VAT) i Skup (dawniej Trade-in: zakupy ze skupu Back Market). Dane w tabeli goods_register (supabase/goods.sql),
// tylko do odczytu; kwoty ("cena PLN + koszty", "Cena PLN", "prowizja + PCC") to wartości z arkusza, niczego tu nie przeliczamy.

type Kind = "vm_v23" | "trade_in";

type Row = {
  id: number;
  kind: Kind;
  serial: string | null;
  name: string | null;
  supplier: string | null;
  purchased_on: string | null;
  delivered_on: string | null;
  order_no: string | null;
  invoice_no: string | null;
  category: string | null;
  price: number | null;
  vat: string | null;
  currency: string | null;
  nbp_rate: number | null;
  costs: number | null;
  total_pln: number | null;
  price_pln: number | null;
  pcc: number | null;
  country: string | null;
  commission_pcc: number | null;
  product_status_source?: string | null; // najświeższy status z Serwisu / Testów / Trade-in (widok goods_register_available)
  product_status?: string | null;
  product_status_at?: string | null;
  available?: boolean; // numer seryjny jest w magazynie Fakturowni (widok goods_register_available)
  pending?: boolean; // opłacony zakup z Buyback jeszcze nie w magazynie Fakturowni (widok goods_register_available)
  source?: string | null; // 'arkusz' | 'buyback' (wiersz dopisany automatycznie z opłaconego zamówienia Buyback)
  commission?: number | null; // Prowizja (PLN) = 10% + logistyka; dla wierszy z arkusza puste — liczone jako prowizja + PCC − PCC
};

type Totals = { price_pln: number; costs: number; total_pln: number; pcc: number; commission: number; commission_pcc: number };

// Trzy pigułki (10.10.2026): VM i V23 to podział wg VAT, Skup (dawniej "Trade-in") to zakupy ze skupu Back Market.
// V23 = każdy wiersz z VAT V23 (niezależnie od arkusza), VM i Skup = reszta swojego rodzaju (VAT VM albo pusty).
// Kanały skupu (jak w Trade-in: Buyback, Allegro, Vinted, OLX, Umowa) są pokazywane plakietką we wszystkich pigułkach — Buyback na teal, pozostałe na amber, tak jak w Trade-in.
// Zwykli dostawcy z arkusza VM/V23 (PCS, AAR, LW…) zostają tekstem.
const CHANNEL_NAMES = ["buyback", "allegro", "vinted", "olx", "umowa"];
const isChannelName = (v: string | null | undefined) => !!v && CHANNEL_NAMES.includes(v.trim().toLowerCase());
type Tab = "vm" | "v23" | "skup" | "all";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "Wszystkie" }, // wszystkie wiersze razem (10.10.2026); od 15.10.2026 pierwsza pigułka i widok domyślny
  { key: "vm", label: "VM" },
  { key: "v23", label: "V23" },
  { key: "skup", label: "Skup" },
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scopeFilter(q: any, tab: Tab) {
  if (tab === "all") return q;
  if (tab === "v23") return q.eq("vat", "V23");
  return q.eq("kind", tab === "skup" ? "trade_in" : "vm_v23").or("vat.is.null,vat.neq.V23");
}
const PAGE_SIZES = [50, 100, 200];
const NONE = "__brak__"; // w filtrach: wiersze z pustą wartością
const COLUMNS_OLD = "id, kind, serial, name, supplier, purchased_on, delivered_on, order_no, invoice_no, category, price, vat, currency, nbp_rate, costs, total_pln, price_pln, pcc, country, commission_pcc";

const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const selectCls = "border border-line bg-white px-2 py-2 rounded text-sm";

const fmtDate = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "—");
const fmtNum = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString("pl-PL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtPln = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${fmtNum(n)} zł`);

type Facets = { category: Map<string, number>; supplier: Map<string, number> };

export default function GoodsView({ session, members, isAdmin }: { session: Session; members: MemberLite[]; isAdmin: boolean }) {
  const [tab, setTab] = useState<Tab>("all");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [supplier, setSupplier] = useState("");
  // Dostępność (14.10.2026): "Dostępny" = numer seryjny jest w magazynie Fakturowni; domyślnie pokazujemy tylko dostępne. Dane z widoku goods_register_available
  // (supabase/goods-available.sql); bez widoku lista działa jak dotąd, bez kolumny i filtra.
  const [availFilter, setAvailFilter] = useState<"yes" | "all" | "no">("yes");
  const [availView, setAvailView] = useState(true);
  const [statusCols, setStatusCols] = useState(true); // kolumny product_status_* w widoku (po ponownym uruchomieniu goods-available.sql)
  // Kolumna `pending` (15.10.2026): opłacony zakup z Buyback, który jeszcze nie dotarł do magazynu Fakturowni — liczy się jako "dostępne" w filtrze, żeby nowe zakupy były widoczne od razu.
  const [pendingCol, setPendingCol] = useState(true);
  const listTable = availView ? "goods_register_available" : "goods_register";
  const [serialFilter, setSerialFilter] = useState<"" | "with" | "without">(""); // filtr numeru seryjnego: z numerem / bez numeru (14.10.2026)
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  // Nowe kolumny Skupu (source, commission) pojawiają się po uruchomieniu supabase/goods-buyback.sql; bez nich widok działa jak dotąd (bez prowizji i znacznika automatu).
  const [newCols, setNewCols] = useState(true);
  const COLUMNS = newCols ? `${COLUMNS_OLD}, source, commission` : COLUMNS_OLD;
  const [facets, setFacets] = useState<Facets | null>(null);
  const [tabCounts, setTabCounts] = useState<Partial<Record<Tab, number>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openSerial, setOpenSerial] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editRow, setEditRow] = useState<GoodsEditRow | null>(null); // edycja wiersza (każdy z dostępem do zakładki)
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  const [reloadKey, setReloadKey] = useState(0); // rośnie po dodaniu/usunięciu wiersza — odświeża listę, sumy i listy filtrów
  const seq = useRef(0);

  // Wyszukiwanie z opóźnieniem — zapytanie nie leci przy każdym znaku.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Zmiana pigułki czyści filtry (każda ma inne kategorie i dostawców).
  function changeTab(t: Tab) {
    if (t === tab) return;
    setTab(t);
    setCategory("");
    setSupplier("");
    setSerialFilter("");
    setPage(1);
  }

  // Filtr dostępności: "dostępne" = jest w magazynie ALBO oczekuje na magazyn (świeży zakup z Buyback); "niedostępne" = żadne z tych dwóch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const withAvail = (q: any) => {
    if (!availView || availFilter === "all") return q;
    if (!pendingCol) return q.eq("available", availFilter === "yes");
    return availFilter === "yes" ? q.or("available.eq.true,pending.eq.true") : q.eq("available", false).eq("pending", false);
  };

  // Wspólne filtry zapytania (wyszukiwarka i trzy listy).
  const applyFilters = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q: any) => {
      q = scopeFilter(q, tab);
      if (category && tab === "skup") {
        // Skup: kategoria z SKU (pierwszy człon przed myślnikiem, aparaty = APARAT) — jak "Kategoria z SKU" w Magazynie; filtr po kolumnie `name` (SKU)
        if (category === NONE) q = q.or("name.is.null,name.eq.");
        else if (category === CAMERA_CATEGORY) q = q.ilike("name", "%(%/%)");
        else {
          const c = escapeLike(category).replace(/[,()"]/g, " ").trim();
          q = q.or(`name.ilike.${c}-%,name.ilike.${c}`);
        }
      } else if (category) q = category === NONE ? q.is("category", null) : q.eq("category", category);
      if (supplier) q = supplier === NONE ? q.is("supplier", null) : q.eq("supplier", supplier);
      q = withAvail(q);
      if (serialFilter === "without") q = q.or("serial.is.null,serial.eq.");
      else if (serialFilter === "with") q = q.not("serial", "is", null).neq("serial", "");
      if (search) {
        const s = escapeLike(search).replace(/[,()"]/g, " ").trim(); // przecinki i nawiasy rozbiłyby składnię .or()
        if (s) q = q.or(["serial", "name", "order_no", "invoice_no", "supplier"].map((c) => `${c}.ilike.%${s}%`).join(","));
      }
      return q;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, category, supplier, search, serialFilter, availFilter, availView, pendingCol]
  );

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const from = (page - 1) * pageSize;
      const { data, error: err, count: total } = await applyFilters(supabase.from(listTable).select(availView ? `${COLUMNS}, available${pendingCol ? ", pending" : ""}${statusCols ? ", product_status_source, product_status, product_status_at" : ""}` : COLUMNS, { count: "exact" }))
        .order("purchased_on", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .range(from, from + pageSize - 1);
      if (mine !== seq.current) return;
      if (err) {
        if (err.code === "PGRST103" && page > 1) {
          setPage(1);
          return;
        }
        if (availView && (err.code === "42P01" || err.code === "PGRST205")) {
          setAvailView(false); // brak widoku dostępności (nieuruchomione supabase/goods-available.sql) — lista po staremu
          return;
        }
        if (availView && pendingCol && (err.code === "42703" || err.code === "PGRST204" || err.code === "PGRST100") && /pending/.test(err.message || "")) {
          setPendingCol(false); // widok bez kolumny pending (stara wersja goods-available.sql) — filtr dostępności po staremu
          return;
        }
        if (availView && statusCols && (err.code === "42703" || err.code === "PGRST204") && /product_status/.test(err.message || "")) {
          setStatusCols(false); // widok bez kolumn statusu (stara wersja goods-available.sql) — ładujemy bez nich
          return;
        }
        if (newCols && (err.code === "42703" || err.code === "PGRST204")) {
          setNewCols(false); // brak kolumn source/commission — przełączamy się na starszy zestaw i ładujemy ponownie
          return;
        }
        throw new Error(err.code === "42P01" || err.code === "PGRST205" ? "Brak tabeli towaru — uruchom supabase/goods.sql (i plik z danymi) w Supabase." : err.message);
      }
      setRows(((data as Row[]) || []).map((r) => ({ ...r })));
      setCount(total ?? null);
    } catch (e: any) {
      if (mine === seq.current) setError(e.message || String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [applyFilters, page, pageSize, reloadKey, newCols, availView, statusCols, pendingCol]);

  useEffect(() => {
    load();
  }, [load]);

  // Sumy dla CAŁEGO wyniku filtrów (nie tylko widocznej strony): kolejne porcje po 1000 (limit PostgREST), liczone tylko przy zmianie filtrów.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const acc: Totals = { price_pln: 0, costs: 0, total_pln: 0, pcc: 0, commission: 0, commission_pcc: 0 };
      for (let from = 0; ; from += 1000) {
        const { data, error: err } = await applyFilters(supabase.from(listTable).select(newCols ? "price_pln, costs, total_pln, pcc, commission, commission_pcc" : "price_pln, costs, total_pln, pcc, commission_pcc"))
          .order("id")
          .range(from, from + 999);
        if (cancelled) return;
        if (err) return setTotals(null);
        for (const r of (data as (Partial<Totals> & { commission?: number | null })[]) || []) {
          acc.price_pln += Number(r.price_pln ?? 0);
          acc.costs += Number(r.costs ?? 0);
          acc.total_pln += Number(r.total_pln ?? 0);
          acc.pcc += Number(r.pcc ?? 0);
          acc.commission_pcc += Number(r.commission_pcc ?? 0);
          acc.commission += Number(r.commission ?? (r.commission_pcc !== null && r.commission_pcc !== undefined ? Number(r.commission_pcc) - Number(r.pcc ?? 0) : 0));
        }
        if (!data || data.length < 1000) break;
      }
      if (!cancelled) setTotals(acc);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyFilters, reloadKey, newCols, listTable]);

  // Wartości do list rozwijanych (z licznikami) i liczniki pigułek — raz na rodzaj.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const f: Facets = { category: new Map(), supplier: new Map() };
      const bump = (m: Map<string, number>, v: string | null) => m.set(v ?? NONE, (m.get(v ?? NONE) ?? 0) + 1);
      for (let from = 0; ; from += 1000) {
        const { data, error: err } = await withAvail(scopeFilter(supabase.from(listTable).select("category, supplier, name"), tab)).order("id").range(from, from + 999);
        if (cancelled || err) return;
        for (const r of (data as { category: string | null; supplier: string | null; name: string | null }[]) || []) {
          bump(f.category, tab === "skup" ? skuCategoryOf(r.name) || null : r.category);
          bump(f.supplier, r.supplier);
        }
        if (!data || data.length < 1000) break;
      }
      if (!cancelled) setFacets(f);
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, reloadKey, listTable, availFilter, pendingCol]);

  useEffect(() => {
    (async () => {
      const out: Partial<Record<Tab, number>> = {};
      for (const t of TABS) {
        const { count: c } = await withAvail(scopeFilter(supabase.from(listTable).select("id", { count: "exact", head: true }), t.key));
        if (c !== null && c !== undefined) out[t.key] = c;
      }
      setTabCounts(out);
    })();
  }, [reloadKey, listTable, availFilter, pendingCol]);

  async function removeRow(r: Row) {
    if (!confirm(`Usunąć z rejestru pozycję ${r.serial ?? r.name ?? r.id}? Tej operacji nie można cofnąć (zapis zostaje tylko w dzienniku usunięć).`)) return;
    const { data, error: err } = await supabase.from("goods_register").delete().eq("id", r.id).select("id");
    if (err) return setError(`Nie udało się usunąć: ${err.message}`);
    if (!data?.length) return setError("Nie usunięto — brak uprawnień (tylko Admin) albo pozycja już nie istnieje.");
    setReloadKey((k) => k + 1);
  }

  // Skup: ręczne uruchomienie tej samej synchronizacji, którą co 15 min robi cron (opłacone zamówienia Buyback -> wiersze Skupu).
  async function syncBuyback() {
    setSyncing(true);
    setSyncNote("");
    setError("");
    try {
      const res = await fetch("/api/goods/sync-buyback", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Błąd synchronizacji.");
      setSyncNote(`Dodano ${data.created}, uzupełniono ${data.updated} (opłaconych od ${data.from}: ${data.candidates}${data.skippedSheet ? `, ${data.skippedSheet} już w arkuszu` : ""}${data.noSerial ? `, ${data.noSerial} bez numeru seryjnego` : ""}).`);
      setReloadKey((k) => k + 1);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setSyncing(false);
    }
  }

  // Edycja: dociągamy cały wiersz razem z historią zmian (lista jej nie niesie; bez kolumny history — sam wiersz).
  async function startEdit(r: Row) {
    setError("");
    let res = await supabase.from("goods_register").select(`${COLUMNS}, history`).eq("id", r.id).maybeSingle();
    if (res.error && (res.error.code === "42703" || res.error.code === "PGRST204")) res = await supabase.from("goods_register").select(COLUMNS).eq("id", r.id).maybeSingle();
    if (res.error || !res.data) return setError(`Nie udało się wczytać pozycji do edycji: ${res.error?.message ?? "nie istnieje"}`);
    setAdding(false);
    setEditRow(res.data as unknown as GoodsEditRow);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / pageSize));
  const isSkup = tab === "skup"; // pigułka Skup ma własny układ kolumn (14.10.2026): SKU, Waluta, Serwis, Prowizja; bez daty dostawy i nr faktury/DW
  const isTradeIn = tab === "skup" || tab === "all"; // kolumny PCC / Kraj / Prowizja + PCC (w "Wszystkie" puste dla VM i V23)
  const kind: Kind = tab === "skup" ? "trade_in" : "vm_v23"; // rodzaj wiersza zapisywany z formularza (arkusz źródłowy)
  const options = (m: Map<string, number> | undefined) =>
    Array.from(m?.entries() ?? [])
      .sort((a, b) => (a[0] === NONE ? 1 : b[0] === NONE ? -1 : a[0].localeCompare(b[0], "pl")))
      .map(([v, n]) => ({ value: v, label: `${v === NONE ? "— (brak)" : v} (${n})` }));
  const anyFilter = !!(search || category || supplier || serialFilter);
  const showGroup = tab === "all"; // w "Wszystkie" pierwsza kolumna mówi, do której pigułki należy wiersz
  const colSpan = (isSkup ? 18 : (isTradeIn ? 17 : 14) + (showGroup ? 1 : 0) + 1) + (availView ? (statusCols ? 2 : 1) : 0); // kolumna akcji (Edytuj / Usuń)
  const groupOf = (r: Row) => (r.vat === "V23" ? "V23" : r.kind === "trade_in" ? "Skup" : "VM");

  const headers = useMemo(
    () => isSkup ? [
      "Numer seryjny", ...(availView ? ["Dostępny", ...(statusCols ? ["Status"] : [])] : []), "SKU", "Kanał", "Data zakupu", "Nr zamówienia", "Kategoria z SKU", "Cena zakupu", "VAT", "Waluta", "NBP", "Serwis", "Cena + koszty (PLN)", "Cena PLN", "PCC", "Kraj", "Prowizja", "Prowizja + PCC", "",
    ] : [
      ...(showGroup ? ["Grupa"] : []),
      "Numer seryjny",
      ...(availView ? ["Dostępny", ...(statusCols ? ["Status"] : [])] : []),
      "Nazwa",
      "Dostawca",
      "Data zakupu",
      "Data dostawy",
      "Nr zamówienia",
      "Nr faktury/DW",
      "Kategoria",
      "Cena zakupu",
      "VAT",
      "NBP",
      "Koszty",
      "Cena PLN + koszty",
      "Cena PLN",
      ...(isTradeIn ? ["PCC", "Kraj", "Prowizja + PCC"] : []),
      "", // kolumna akcji
    ],
    [isTradeIn, showGroup, isSkup, availView, statusCols]
  );

  return (
    <div>
      <div className="flex gap-2 mb-4">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => changeTab(t.key)} className={pill(tab === t.key)}>
            {t.label}
            {tabCounts[t.key] !== undefined && <span className="ml-1.5 text-xs font-normal opacity-70">{tabCounts[t.key]}</span>}
          </button>
        ))}
        {tab === "skup" && <button onClick={syncBuyback} disabled={syncing} className="ml-auto border border-line bg-white px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-50" title="Dopisz opłacone zamówienia Buyback (to samo robi automat co 15 min)">{syncing ? "Synchronizacja…" : "Odśwież z Buyback"}</button>}
        {tab !== "all" && <button onClick={() => { setEditRow(null); setAdding((a) => !a); }} className={`${tab === "skup" ? "" : "ml-auto"} bg-ink text-paper px-4 py-1.5 rounded text-sm font-semibold`}>{adding ? "Zamknij formularz" : "+ Dodaj towar"}</button>}
      </div>

      {editRow && (
        <GoodsAddForm
          key={`edit-${editRow.id}`}
          kind={editRow.kind}
          vatFixed={editRow.vat === "V23" ? "V23" : "VM"}
          session={session}
          categories={options(facets?.category).map((o) => o.value).filter((v) => v !== NONE)}
          suppliers={options(facets?.supplier).map((o) => o.value).filter((v) => v !== NONE)}
          onAdded={() => setReloadKey((k) => k + 1)}
          onClose={() => setEditRow(null)}
          edit={editRow}
          members={members}
        />
      )}

      {adding && tab !== "all" && !editRow && (
        <GoodsAddForm
          key={tab}
          kind={kind}
          vatFixed={tab === "v23" ? "V23" : "VM"}
          session={session}
          categories={options(facets?.category).map((o) => o.value).filter((v) => v !== NONE)}
          suppliers={options(facets?.supplier).map((o) => o.value).filter((v) => v !== NONE)}
          onAdded={() => {
            setAvailFilter("all"); // świeżo dodana pozycja może jeszcze nie być w Fakturowni — pokazujemy wszystkie, żeby było ją widać
            setPage(1);
            setReloadKey((k) => k + 1);
          }}
          onClose={() => setAdding(false)}
        />
      )}

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={isSkup ? "Szukaj: numer seryjny, SKU, nr zamówienia, kanał" : "Szukaj: numer seryjny, nazwa, nr zamówienia, faktura, dostawca"}
          className="w-96 border border-line bg-white px-3 py-2 rounded text-sm"
        />
        <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} className={selectCls}>
          <option value="">{isSkup ? "Kategoria z SKU: wszystkie" : "Kategoria: wszystkie"}</option>
          {options(facets?.category).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={supplier} onChange={(e) => { setSupplier(e.target.value); setPage(1); }} className={selectCls}>
          <option value="">{isSkup ? "Kanał: wszystkie" : "Dostawca: wszyscy"}</option>
          {options(facets?.supplier).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={serialFilter} onChange={(e) => { setSerialFilter(e.target.value as "" | "with" | "without"); setPage(1); }} className={selectCls}>
          <option value="">Numer seryjny: wszystkie</option>
          <option value="with">Z numerem seryjnym</option>
          <option value="without">Bez numeru seryjnego</option>
        </select>
        {availView && (
          <select value={availFilter} onChange={(e) => { setAvailFilter(e.target.value as "yes" | "all" | "no"); setPage(1); }} className={selectCls}>
            <option value="yes">Dostępność: dostępne</option>
            <option value="all">Dostępność: wszystkie</option>
            <option value="no">Dostępność: niedostępne</option>
          </select>
        )}
        {anyFilter && (
          <button
            onClick={() => {
              setSearchInput("");
              setSearch("");
              setCategory("");
              setSupplier("");
              setSerialFilter("");
              setPage(1);
            }}
            className="text-xs font-semibold text-teal hover:underline"
          >
            Wyczyść filtry
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <label className="text-xs text-inksoft">Pokaż</label>
        <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} className="border border-line bg-white px-2 py-1.5 rounded text-sm font-semibold">
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="text-xs text-inksoft">{count !== null ? `z ${count} pozycji · strona ${Math.min(page, totalPages)} z ${totalPages}` : ""}</span>
        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-40">‹ Poprzednia</button>
        <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-40">Następna ›</button>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}
      {syncNote && <p className="text-teal text-xs mb-3">{syncNote}</p>}

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-inksoft border-b border-line">
              {headers.map((h) => <th key={h} className="p-2 whitespace-nowrap font-semibold">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && !error && (
              <tr><td colSpan={colSpan} className="p-6 text-center text-inksoft text-sm">{anyFilter ? `Nic nie pasuje do filtrów.${availView && availFilter === "yes" ? " Pokazane są tylko dostępne — zmień „Dostępność” na „wszystkie”." : ""}` : availView && availFilter === "yes" ? "Brak dostępnych pozycji — zmień filtr „Dostępność” na „wszystkie”." : "Brak danych — wgraj plik z danymi towaru (patrz supabase/goods.sql)."}</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-paper align-top">
                {showGroup && <td className="p-2 whitespace-nowrap font-semibold">{groupOf(r)}</td>}
                <td className="p-2 font-mono whitespace-nowrap">
                  {r.serial ? <button onClick={() => setOpenSerial(r.serial)} className="text-teal hover:underline">{r.serial}</button> : "—"}
                  {r.source === "buyback" && <span className="ml-1.5 text-[9px] font-sans font-semibold text-teal border border-teal rounded px-1" title="Wiersz dopisany automatycznie z opłaconego zamówienia Buyback">auto</span>}
                </td>
                {availView && (
                  <td className="p-2 whitespace-nowrap">
                    {!r.available && r.pending ? (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-ambersoft text-amber" title="Opłacony zakup z Buyback — paczka jeszcze nie jest w magazynie Fakturowni (nie wprowadzona albo w drodze)">Oczekuje</span>
                    ) : (
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${r.available ? "bg-tealsoft text-teal" : "bg-paper text-inksoft border border-line"}`}>{r.available ? "Tak" : "Nie"}</span>
                    )}
                  </td>
                )}
                {availView && statusCols && (
                  <td className="p-2 whitespace-nowrap">
                    {r.product_status ? (
                      <span title={r.product_status_at ? `ostatnia zmiana: ${new Date(r.product_status_at).toLocaleString("pl-PL")}` : undefined}>
                        <span className="text-inksoft">{productStatusParts(r.product_status_source, r.product_status)?.source}: </span>
                        <span className="font-semibold">{productStatusParts(r.product_status_source, r.product_status)?.status}</span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                )}
                <td className="p-2 min-w-[12rem]">{r.name || "—"}</td>
                <td className="p-2 whitespace-nowrap">{isSkup || isChannelName(r.supplier) ? (r.supplier ? <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${r.supplier === "Buyback" ? "bg-tealsoft text-teal" : "bg-ambersoft text-amber"}`}>{r.supplier}</span> : "—") : r.supplier || "—"}</td>
                <td className="p-2 whitespace-nowrap">{fmtDate(r.purchased_on)}</td>
                {!isSkup && <td className="p-2 whitespace-nowrap">{fmtDate(r.delivered_on)}</td>}
                <td className="p-2 font-mono whitespace-nowrap">{r.order_no || "—"}</td>
                {!isSkup && <td className="p-2 whitespace-nowrap">{r.invoice_no || "—"}</td>}
                <td className="p-2 whitespace-nowrap">{(isSkup ? skuCategoryOf(r.name) : r.category) || "—"}</td>
                <td className="p-2 whitespace-nowrap text-right">{r.price === null ? "—" : isSkup ? fmtNum(r.price) : `${fmtNum(r.price)} ${r.currency ?? ""}`.trim()}</td>
                <td className="p-2 whitespace-nowrap">{r.vat || "—"}</td>
                {isSkup && <td className="p-2 whitespace-nowrap">{r.currency || "—"}</td>}
                <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.nbp_rate, 4)}</td>
                {isSkup ? (
                  <>
                    <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.costs)}</td>
                    <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.total_pln)}</td>
                    <td className="p-2 whitespace-nowrap text-right font-semibold">{fmtNum(r.price_pln)}</td>
                    <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.pcc)}</td>
                    <td className="p-2 whitespace-nowrap">{r.country || "—"}</td>
                    <td className="p-2 whitespace-nowrap text-right" title={r.commission === null || r.commission === undefined ? "Wiersz z arkusza: prowizja wyliczona jako „Prowizja + PCC” − PCC" : undefined}>
                      {fmtNum(r.commission ?? (r.commission_pcc !== null ? Number(r.commission_pcc) - Number(r.pcc ?? 0) : null))}
                    </td>
                    <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.commission_pcc)}</td>
                  </>
                ) : (
                  <>
                    <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.costs)}</td>
                    <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.total_pln)}</td>
                    <td className="p-2 whitespace-nowrap text-right font-semibold">{fmtNum(r.price_pln)}</td>
                  </>
                )}
                {isTradeIn && !isSkup && (
                  <>
                    <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.pcc)}</td>
                    <td className="p-2 whitespace-nowrap">{r.country || "—"}</td>
                    <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.commission_pcc)}</td>
                  </>
                )}
                <td className="p-2 whitespace-nowrap text-right">
                  <button onClick={() => startEdit(r)} className="text-teal hover:underline">Edytuj</button>
                  {isAdmin && <button onClick={() => removeRow(r)} className="text-rust hover:underline ml-3">Usuń</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Podsumowanie całego wyniku filtrów (nie tylko tej strony) */}
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm border border-line bg-white px-4 py-3">
        <span className="font-semibold text-inksoft text-xs self-center">PODSUMOWANIE WYNIKU</span>
        <span>Pozycji: <span className="font-semibold">{count ?? "—"}</span></span>
        <span>Cena PLN: <span className="font-semibold">{fmtPln(totals?.price_pln)}</span></span>
        <span>{isSkup ? "Serwis" : "Koszty"}: <span className="font-semibold">{fmtPln(totals?.costs)}</span></span>
        <span>{isSkup ? "Cena + koszty (PLN)" : "Cena PLN + koszty"}: <span className="font-semibold">{fmtPln(totals?.total_pln)}</span></span>
        {isTradeIn && <span>PCC: <span className="font-semibold">{fmtPln(totals?.pcc)}</span></span>}
        {isSkup && <span>Prowizja: <span className="font-semibold">{fmtPln(totals?.commission)}</span></span>}
        {isTradeIn && <span>Prowizja + PCC: <span className="font-semibold">{fmtPln(totals?.commission_pcc)}</span></span>}
      </div>
      <p className="text-[11px] text-inksoft mt-2 max-w-3xl">Dane z arkusza Towar.numbers i dopisane formularzem „Dodaj towar”; edytować może każdy, kto ma zakładkę Towar (każda edycja zapisuje się w historii zmian: kto, kiedy, co), a usuwać tylko Admin. Kwoty „Cena PLN”, „Koszty”, „Cena PLN + koszty” i „Prowizja + PCC” to wartości z arkusza, nie przeliczenia aplikacji; sumy dotyczą całego wyniku filtrów.</p>

      {openSerial && <ProductCardDrawer serial={openSerial} members={members} onClose={() => setOpenSerial(null)} />}
    </div>
  );
}
