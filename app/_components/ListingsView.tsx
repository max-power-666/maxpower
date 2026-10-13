"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { fmtWarsawDateTime } from "@/lib/warsawDate";
import {
  BM_GRADE_LABEL,
  isListingLive,
  LISTING_MARKETPLACES,
  listingStateLabel,
  type ListingMarketplace,
  type MarketPriceBrief,
} from "@/lib/listings";

// Magazyn -> Listingi (13.10.2026): oferty wystawione na Back Market i refurbed (SKU, ilość, cena, stan oferty, klasa, gwarancja...). Dane z tabeli marketplace_listings
// (synchronizacja: app/api/listings/sync — cron co 30 min + przycisk "Odśwież"). Lista jednego marketplace'u to kilka tysięcy lekkich wierszy, więc wczytujemy ją raz
// i filtrujemy, sortujemy oraz stronicujemy w przeglądarce — liczniki i sumy zawsze zgadzają się z tym, co widać.

type Listing = {
  marketplace: ListingMarketplace;
  external_id: string;
  sku: string | null;
  title: string | null;
  quantity: number | null;
  price: number | null;
  currency: string | null;
  min_price: number | null;
  max_price: number | null;
  state: string | null;
  grade: string | null;
  warranty_months: number | null;
  product_id: string | null;
  listing_ref: string | null;
  details: Record<string, any> | null;
  listed_at: string | null;
  snapshot_at: string;
};
type Meta = { last_synced_at: string | null; last_count: number | null; scan_cursor: string | null; scan_started_at: string | null; last_attempt_at: string | null; last_error: string | null };
type SortKey = "sku" | "title" | "quantity" | "price" | "state";
type StockFilter = "all" | "live" | "zero";

const COLS = "marketplace, external_id, sku, title, quantity, price, currency, min_price, max_price, state, grade, warranty_months, product_id, listing_ref, details, listed_at, snapshot_at";
const PAGE_SIZES = [50, 100, 200];
const MISSING_TABLE = "Brak tabel listingów — uruchom supabase/listings.sql w Supabase.";

const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const smallPill = (active: boolean) => `px-3 py-1 rounded-full text-xs font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const fmtMoney = (v: number | null, cur: string | null) => (v === null ? "—" : `${v.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur ? " " + cur : ""}`);
const fmtInt = (v: number) => v.toLocaleString("pl-PL");

function stateStyle(l: Listing): string {
  if (isListingLive(l)) return "bg-tealsoft text-teal";
  if (l.marketplace === "backmarket" ? l.state === "4" || l.state === "0" : l.state === "REJECTED") return "bg-rustsoft text-rust";
  return "bg-ambersoft text-amber";
}
function gradeLabel(l: Listing): string {
  if (!l.grade) return "—";
  return l.marketplace === "backmarket" ? BM_GRADE_LABEL[l.grade] ?? l.grade : l.grade;
}

export default function ListingsView({ session }: { session: Session }) {
  const [mp, setMp] = useState<ListingMarketplace>("backmarket");
  const [rows, setRows] = useState<Listing[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [counts, setCounts] = useState<Partial<Record<ListingMarketplace, number>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [stock, setStock] = useState<StockFilter>("all");
  const [stateFilter, setStateFilter] = useState("");
  const [gradeFilter, setGradeFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "sku", dir: 1 });
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim().toLowerCase());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async (which: ListingMarketplace) => {
    setLoading(true);
    setError("");
    try {
      // PostgREST oddaje max 1000 wierszy na zapytanie — wczytujemy całą listę marketplace'u stronami.
      const all: Listing[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: err } = await supabase.from("marketplace_listings").select(COLS).eq("marketplace", which).order("external_id").range(from, from + 999);
        if (err) {
          setError(err.code === "42P01" || err.code === "PGRST205" ? MISSING_TABLE : `Nie udało się wczytać listingów: ${err.message}`);
          setRows([]);
          return;
        }
        all.push(...((data as Listing[]) || []));
        if (!data || data.length < 1000) break;
      }
      setRows(all);
      const { data: m } = await supabase.from("listings_sync_meta").select("last_synced_at, last_count, scan_cursor, scan_started_at, last_attempt_at, last_error").eq("marketplace", which).maybeSingle();
      setMeta((m as Meta | null) ?? null);
      setCounts((c) => ({ ...c, [which]: all.length }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setStateFilter("");
    setGradeFilter("");
    setOpen(null);
    setPage(1);
    load(mp);
  }, [mp, load]);

  // Liczniki na pigułce drugiego marketplace'u (lekkie zapytania head).
  useEffect(() => {
    (async () => {
      for (const m of LISTING_MARKETPLACES) {
        const { count, error: err } = await supabase.from("marketplace_listings").select("external_id", { count: "exact", head: true }).eq("marketplace", m.key);
        if (!err) setCounts((c) => ({ ...c, [m.key]: count ?? 0 }));
      }
    })();
  }, [rows.length]);

  async function refresh() {
    setSyncing(true);
    setError("");
    setNote("");
    try {
      const res = await fetch(`/api/listings/sync?marketplace=${mp}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await res.json().catch(() => ({}));
      const r = data?.results?.[mp];
      if (!res.ok && !r) throw new Error(data?.error || `Błąd synchronizacji (${res.status}).`);
      if (r?.skipped) setNote(r.skipped);
      else if (r?.error) setError(r.error);
      else if (r && r.finished === false) setNote(`Pobrano kolejną porcję (${fmtInt(r.processed)} ofert, ${r.pages} str.). Reszta dociągnie się automatycznie albo kliknij Odśwież ponownie.`);
      else if (r) setNote(`Zsynchronizowano ${fmtInt(r.total ?? r.processed)} ofert${r.removed ? `, usunięto ${r.removed} nieaktualnych` : ""}.`);
      await load(mp);
    } catch (e: any) {
      setError(e.message || "Nie udało się odświeżyć listingów.");
    } finally {
      setSyncing(false);
    }
  }

  // Facety (listy rozwijane) z całego marketplace'u.
  const facets = useMemo(() => {
    const st = new Map<string, number>();
    const gr = new Map<string, number>();
    for (const r of rows) {
      st.set(r.state ?? "", (st.get(r.state ?? "") ?? 0) + 1);
      gr.set(r.grade ?? "", (gr.get(r.grade ?? "") ?? 0) + 1);
    }
    return { states: [...st.entries()].sort((a, b) => b[1] - a[1]), grades: [...gr.entries()].sort((a, b) => b[1] - a[1]) };
  }, [rows]);

  const filtered = useMemo(() => {
    const list = rows.filter((r) => {
      if (stock === "live" && !isListingLive(r)) return false;
      if (stock === "zero" && (r.quantity ?? 0) > 0) return false;
      if (stateFilter !== "" && (r.state ?? "") !== (stateFilter === "—" ? "" : stateFilter)) return false;
      if (gradeFilter !== "" && (r.grade ?? "") !== (gradeFilter === "—" ? "" : gradeFilter)) return false;
      if (search) {
        const hay = `${r.sku ?? ""} ${r.title ?? ""} ${r.external_id} ${r.listing_ref ?? ""} ${r.product_id ?? ""}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    const key = sort.key;
    const val = (r: Listing): string | number => {
      if (key === "sku") return (r.sku ?? "").toLowerCase();
      if (key === "title") return (r.title ?? "").toLowerCase();
      if (key === "quantity") return r.quantity ?? -1;
      if (key === "price") return r.price ?? -1;
      return listingStateLabel(r.marketplace, r.state).toLowerCase();
    };
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "pl", { numeric: true });
      return (c || (a.sku ?? "").localeCompare(b.sku ?? "", "pl", { numeric: true })) * sort.dir;
    });
  }, [rows, stock, stateFilter, gradeFilter, search, sort]);

  // Sumy całej listy marketplace'u (kafelki) i bieżącego wyniku filtrów (pasek pod tabelą).
  const summarize = (list: Listing[]) => {
    let qty = 0;
    let live = 0;
    const value = new Map<string, number>();
    for (const r of list) {
      const q = r.quantity ?? 0;
      qty += q;
      if (isListingLive(r)) live += 1;
      if (r.price !== null && q > 0) value.set(r.currency ?? "?", (value.get(r.currency ?? "?") ?? 0) + r.price * q);
    }
    return { offers: list.length, live, qty, value: [...value.entries()] };
  };
  const all = useMemo(() => summarize(rows), [rows]);
  const part = useMemo(() => summarize(filtered), [filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.min(page, totalPages);
  const visible = filtered.slice((curPage - 1) * pageSize, curPage * pageSize);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "quantity" || key === "price" ? -1 : 1 }));
    setPage(1);
  }
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "");

  function exportCsv() {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["SKU", "Produkt", "Ilość", "Cena", "Waluta", "Cena min", "Cena max", "Stan oferty", "Klasa", "Gwarancja (mies.)", "ID oferty", "ID produktu"];
    const lines = filtered.map((r) =>
      [r.sku, r.title, r.quantity, r.price ?? "", r.currency, r.min_price ?? "", r.max_price ?? "", listingStateLabel(r.marketplace, r.state), gradeLabel(r), r.warranty_months ?? "", r.external_id, r.product_id].map(q).join(";")
    );
    const csv = "﻿" + [head.map(q).join(";"), ...lines].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `listingi-${mp}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const mpLabel = LISTING_MARKETPLACES.find((m) => m.key === mp)!.label;
  const th = "p-3 text-left text-xs font-semibold text-inksoft whitespace-nowrap";
  const thBtn = `${th} cursor-pointer select-none hover:text-ink`;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {LISTING_MARKETPLACES.map((m) => (
          <button key={m.key} onClick={() => setMp(m.key)} className={pill(mp === m.key)}>
            {m.label}
            {counts[m.key] !== undefined && <span className="ml-1.5 text-xs font-normal opacity-70">{fmtInt(counts[m.key]!)}</span>}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-inksoft lowercase">
            {meta?.last_synced_at ? `ostatnia pełna synchronizacja: ${fmtWarsawDateTime(Date.parse(meta.last_synced_at))}` : "brak jeszcze pełnej synchronizacji"}
            {meta?.scan_cursor ? " · trwa pobieranie kolejnych porcji" : ""}
          </span>
          <button onClick={refresh} disabled={syncing} className="bg-white border border-line px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">
            {syncing ? "Synchronizowanie…" : "Odśwież"}
          </button>
        </div>
      </div>

      {error && <p className="text-rust text-sm mb-3">{error}</p>}
      {!error && meta?.last_error && <p className="text-amber text-xs mb-3">Ostatnia synchronizacja zakończyła się błędem: {meta.last_error}</p>}
      {note && <p className="text-inksoft text-xs mb-3">{note}</p>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Tile label={`Oferty ${mpLabel}`} value={fmtInt(all.offers)} hint="Wszystkie listingi zwrócone przez marketplace (także offline)" />
        <Tile label="Aktywne (online, ilość > 0)" value={fmtInt(all.live)} hint={all.offers ? `${Math.round((all.live / all.offers) * 100)}% ofert` : undefined} />
        <Tile label="Ilość łącznie (szt.)" value={fmtInt(all.qty)} hint="Suma ilości ze wszystkich ofert" />
        <Tile label="Wartość ofert" value={all.value.length ? all.value.map(([c, v]) => fmtMoney(v, c)).join(" · ") : "—"} hint="Suma cena × ilość (waluta oferty)" small />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Szukaj: SKU, produkt, ID oferty" className="border border-line bg-white px-3 py-1.5 rounded text-sm w-64" />
        <div className="flex gap-1.5">
          <button onClick={() => { setStock("all"); setPage(1); }} className={smallPill(stock === "all")}>Wszystkie</button>
          <button onClick={() => { setStock("live"); setPage(1); }} className={smallPill(stock === "live")}>Aktywne</button>
          <button onClick={() => { setStock("zero"); setPage(1); }} className={smallPill(stock === "zero")}>Ilość 0</button>
        </div>
        <select value={stateFilter} onChange={(e) => { setStateFilter(e.target.value); setPage(1); }} className="border border-line bg-white px-2 py-1.5 rounded text-sm">
          <option value="">Stan oferty: wszystkie</option>
          {facets.states.map(([s, n]) => (
            <option key={s || "—"} value={s || "—"}>{listingStateLabel(mp, s || null)} ({fmtInt(n)})</option>
          ))}
        </select>
        <select value={gradeFilter} onChange={(e) => { setGradeFilter(e.target.value); setPage(1); }} className="border border-line bg-white px-2 py-1.5 rounded text-sm">
          <option value="">Klasa: wszystkie</option>
          {facets.grades.map(([g, n]) => (
            <option key={g || "—"} value={g || "—"}>{g ? (mp === "backmarket" ? BM_GRADE_LABEL[g] ?? g : g) : "Bez klasy"} ({fmtInt(n)})</option>
          ))}
        </select>
        <button onClick={exportCsv} disabled={filtered.length === 0} className="ml-auto bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-50">Pobierz CSV</button>
      </div>

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className={`${thBtn}`} onClick={() => toggleSort("sku")}>SKU{arrow("sku")}</th>
              <th className={thBtn} onClick={() => toggleSort("title")}>Produkt{arrow("title")}</th>
              <th className={`${thBtn} text-right`} onClick={() => toggleSort("quantity")}>Ilość{arrow("quantity")}</th>
              <th className={`${thBtn} text-right`} onClick={() => toggleSort("price")}>Cena{arrow("price")}</th>
              <th className={`${th} text-right`}>Min / max</th>
              <th className={thBtn} onClick={() => toggleSort("state")}>Stan oferty{arrow("state")}</th>
              <th className={th}>Klasa</th>
              <th className={`${th} text-right`}>Gwarancja</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="p-6 text-center text-inksoft text-sm">Wczytywanie…</td></tr>}
            {!loading && visible.length === 0 && !error && (
              <tr>
                <td colSpan={9} className="p-6 text-center text-inksoft text-sm">
                  {rows.length === 0 ? `Brak ofert ${mpLabel} w bazie — kliknij „Odśwież”, żeby pobrać je z marketplace’u.` : "Brak ofert spełniających filtry."}
                </td>
              </tr>
            )}
            {!loading &&
              visible.map((r) => {
                const isOpen = open === r.external_id;
                return (
                  <Fragment key={r.external_id}>
                    <tr className="border-b border-line last:border-b-0 hover:bg-paper align-top">
                      <td className="p-3 font-mono text-xs font-semibold whitespace-nowrap">{r.sku || <span className="text-inksoft font-normal">brak SKU</span>}</td>
                      <td className="p-3 text-xs max-w-md">{r.title || "—"}</td>
                      <td className={`p-3 text-right font-mono text-xs whitespace-nowrap ${(r.quantity ?? 0) <= 0 ? "text-inksoft" : "font-semibold"}`}>{r.quantity ?? "—"}</td>
                      <td className="p-3 text-right font-mono text-xs whitespace-nowrap">{fmtMoney(r.price, r.currency)}</td>
                      <td className="p-3 text-right font-mono text-[11px] text-inksoft whitespace-nowrap">
                        {r.min_price !== null || r.max_price !== null ? `${r.min_price !== null ? fmtMoney(r.min_price, null) : "—"} / ${r.max_price !== null ? fmtMoney(r.max_price, null) : "—"}` : "—"}
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        <span className={`text-xs font-semibold px-2 py-1 rounded ${stateStyle(r)}`} title={r.state !== null ? `Surowa wartość: ${r.state}` : undefined}>{listingStateLabel(r.marketplace, r.state)}</span>
                      </td>
                      <td className="p-3 text-xs whitespace-nowrap">{gradeLabel(r)}</td>
                      <td className="p-3 text-right text-xs whitespace-nowrap">{r.warranty_months ? `${r.warranty_months} mies.` : "—"}</td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <button onClick={() => setOpen(isOpen ? null : r.external_id)} className="text-xs font-semibold text-teal hover:underline">{isOpen ? "Zwiń ▴" : "Szczegóły ▾"}</button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-line bg-paper">
                        <td colSpan={9} className="p-4"><Details l={r} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm border border-line bg-white px-4 py-3">
        <span className="font-semibold text-inksoft text-xs">WYNIK FILTRÓW</span>
        <span>Ofert: <span className="font-semibold">{fmtInt(part.offers)}</span></span>
        <span>Ilość: <span className="font-semibold">{fmtInt(part.qty)}</span> szt.</span>
        {part.value.length > 0 && <span>Wartość: <span className="font-semibold">{part.value.map(([c, v]) => fmtMoney(v, c)).join(" · ")}</span></span>}
        <span className="ml-auto flex items-center gap-2 text-xs text-inksoft">
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} className="border border-line bg-white px-2 py-1 rounded text-xs">
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} na stronie</option>)}
          </select>
          strona {curPage} z {totalPages}
          <button onClick={() => setPage(Math.max(1, curPage - 1))} disabled={curPage <= 1} className="bg-white border border-line px-3 py-1 rounded font-semibold text-ink disabled:opacity-40">‹ Poprzednia</button>
          <button onClick={() => setPage(Math.min(totalPages, curPage + 1))} disabled={curPage >= totalPages} className="bg-white border border-line px-3 py-1 rounded font-semibold text-ink disabled:opacity-40">Następna ›</button>
        </span>
      </div>

      <p className="text-[11px] text-inksoft mt-3 max-w-3xl">
        Dane z API marketplace’ów, odświeżane co 30 minut (albo przyciskiem „Odśwież”). <b>Back Market:</b> cena i waluta dotyczą rynku z ustawienia <code>BACKMARKET_LANG</code> (domyślnie fr-fr); „Aktywne” = publikacja Online
        i ilość &gt; 0. <b>refurbed:</b> cena to cena referencyjna brutto (ceny na rynkach i BuyBox w szczegółach); „Aktywne” = stan Aktywna i ilość &gt; 0. Oferta, której marketplace już nie zwraca, znika z listy po
        ukończeniu pełnej synchronizacji. To podgląd — niczego nie zmienia na marketplace’ach.
      </p>
    </div>
  );
}

function Tile({ label, value, hint, small }: { label: string; value: string; hint?: string; small?: boolean }) {
  return (
    <div className="border border-line bg-white p-4" title={hint}>
      <div className="text-xs font-semibold text-inksoft mb-1">{label}</div>
      <div className={`font-semibold ${small ? "text-base" : "text-2xl"}`}>{value}</div>
      {hint && <div className="text-[11px] text-inksoft mt-1">{hint}</div>}
    </div>
  );
}

function Details({ l }: { l: Listing }) {
  const d = l.details ?? {};
  const row = (label: string, value: React.ReactNode) =>
    value === null || value === undefined || value === "" ? null : (
      <div className="flex gap-3 py-0.5"><span className="text-inksoft w-40 shrink-0">{label}</span><span className="break-words min-w-0">{value}</span></div>
    );
  const markets: MarketPriceBrief[] = Array.isArray(d.markets) ? d.markets : [];
  const ships: { c: string | null; s: string | null; d: number | null; p: number | null }[] = Array.isArray(d.shippings) ? d.shippings : [];
  const BUYBOX: Record<string, string> = { WON: "Wygrany", SHOULD_WIN: "Powinien wygrać", ELIGIBLE: "Kwalifikuje się", WON_ELSEWHERE: "Wygrany gdzie indziej", INELIGIBLE: "Nie kwalifikuje się" };
  const VIS: Record<string, string> = { FULL: "Pełna", LIMITED: "Ograniczona", NONE: "Brak", HIDDEN: "Ukryta" };
  const won = markets.filter((m) => m.b === "WON").length;
  return (
    <div className="grid md:grid-cols-2 gap-x-8 gap-y-3 text-xs">
      <div>
        {row("ID oferty", <span className="font-mono">{l.external_id}</span>)}
        {row("Nr listingu (BM)", l.listing_ref ? <span className="font-mono">{l.listing_ref}</span> : null)}
        {row(l.marketplace === "backmarket" ? "ID produktu" : "ID wariantu produktu", l.product_id ? <span className="font-mono">{l.product_id}</span> : null)}
        {row("Utworzona", l.listed_at ? fmtWarsawDateTime(Date.parse(l.listed_at)) : null)}
        {row("Ostatnio widziana", fmtWarsawDateTime(Date.parse(l.snapshot_at)))}
        {row("Komentarz", d.comment)}
        {row("Nowa bateria", d.new_battery ? "tak" : null)}
        {row("Outlet", d.outlet ? "tak" : null)}
        {row("Bateria", d.battery)}
        {row("Opodatkowanie", d.taxation === "MARGINAL" ? "VAT marża" : d.taxation === "GROSS" ? "Brutto (VAT)" : d.taxation)}
        {row("Profil wysyłki", d.shipping_profile)}
        {row("Drugi profil wysyłki", d.secondary_shipping_profile)}
      </div>
      <div>
        {ships.length > 0 && (
          <div className="mb-3">
            <div className="font-semibold text-inksoft mb-1">WYSYŁKA (poziom oferty)</div>
            {ships.map((s, i) => (
              <div key={i} className="py-0.5">{s.c ?? "—"}: {s.s ?? "—"}, {s.d !== null ? `${s.d} h` : "—"}, {s.p !== null ? fmtMoney(s.p, l.currency) : "—"}</div>
            ))}
          </div>
        )}
        {markets.length > 0 && (
          <div>
            <div className="font-semibold text-inksoft mb-1">CENY NA RYNKACH{won > 0 ? ` · BuyBox wygrany na ${won} z ${markets.length}` : ""}</div>
            <table className="w-full">
              <thead><tr className="text-left text-inksoft"><th className="py-0.5 pr-3 font-semibold">Rynek</th><th className="py-0.5 pr-3 font-semibold text-right">Cena</th><th className="py-0.5 pr-3 font-semibold">Widoczność</th><th className="py-0.5 font-semibold">BuyBox</th></tr></thead>
              <tbody>
                {markets.map((m) => (
                  <tr key={m.m}>
                    <td className="py-0.5 pr-3 font-mono">{m.m}{m.calc ? <span className="text-inksoft" title="Cena wyliczona przez refurbed"> *</span> : ""}</td>
                    <td className="py-0.5 pr-3 text-right font-mono">{fmtMoney(m.p, m.c)}</td>
                    <td className="py-0.5 pr-3">{m.v ? VIS[m.v] ?? m.v : "—"}</td>
                    <td className="py-0.5">{m.b ? BUYBOX[m.b] ?? m.b : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-inksoft mt-1">* cena wyliczona automatycznie z ceny referencyjnej</div>
          </div>
        )}
        {ships.length === 0 && markets.length === 0 && <div className="text-inksoft">Brak dodatkowych danych o wysyłce i cenach na rynkach.</div>}
      </div>
    </div>
  );
}
