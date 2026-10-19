"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { fmtWarsawDateTime } from "@/lib/warsawDate";
import { bidderProposal, ourDeliveryCost, type AutoMode, type BidderProposal } from "@/lib/octopiaBidder";
import OctopiaBidderCell, { type PriceRule } from "./OctopiaBidderCell";
import {
  isListingLive,
  LISTING_MARKETPLACES,
  listingLinks,
  listingStateLabel,
  type ListingMarketplace,
  type MarketPriceBrief,
  type OctopiaBrief,
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
  product_id: string | null;
  listing_ref: string | null;
  details: Record<string, any> | null;
  listed_at: string | null;
  snapshot_at: string;
};
type Meta = { last_synced_at: string | null; last_count: number | null; scan_cursor: string | null; scan_started_at: string | null; last_attempt_at: string | null; last_error: string | null };
type SortKey = "sku" | "title" | "quantity" | "price" | "state";
type StockFilter = "all" | "live" | "zero";
type BbFilter = "all" | "won" | "lost";

const COLS = "marketplace, external_id, sku, title, quantity, price, currency, min_price, max_price, state, product_id, listing_ref, details, listed_at, snapshot_at";
const PAGE_SIZES = [50, 100, 200];
const MISSING_TABLE = "Brak tabel listingów — uruchom supabase/listings.sql w Supabase.";

const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const smallPill = (active: boolean) => `px-3 py-1 rounded-full text-xs font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const fmtMoney = (v: number | null, cur: string | null) => (v === null ? "—" : `${v.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur ? " " + cur : ""}`);
const fmtInt = (v: number) => v.toLocaleString("pl-PL");

function stateStyle(l: Listing): string {
  if (isListingLive(l)) return "bg-tealsoft text-teal";
  if (l.marketplace === "octopia") return "bg-ambersoft text-amber";
  if (l.marketplace === "backmarket" ? l.state === "4" || l.state === "0" : l.state === "REJECTED") return "bg-rustsoft text-rust";
  return "bg-ambersoft text-amber";
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
  const [bbFilter, setBbFilter] = useState<BbFilter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "sku", dir: 1 });
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  // Bidder Cdiscount (19.10.2026): reguły cen min/max per oferta i zmiana cen po potwierdzeniu — tylko Admin/Manager/Księgowa
  const [rules, setRules] = useState<Record<string, PriceRule>>({});
  const [canBid, setCanBid] = useState(false);
  const [bidBusy, setBidBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("members").select("role").eq("user_id", session.user.id).maybeSingle();
      setCanBid(["Admin", "Manager", "Księgowa"].includes(String((data as any)?.role || "")));
    })();
  }, [session.user.id]);

  const loadRules = useCallback(async () => {
    const out: Record<string, PriceRule> = {};
    for (let from = 0; ; from += 1000) {
      let data: any[] | null = null;
      let err: { message: string } | null = null;
      ({ data, error: err } = await supabase.from("listing_price_rules").select("external_id, min_price, max_price, auto_mode").eq("marketplace", "octopia").range(from, from + 999));
      if (err) ({ data, error: err } = await supabase.from("listing_price_rules").select("external_id, min_price, max_price").eq("marketplace", "octopia").range(from, from + 999)); // przed uruchomieniem nowej wersji listing-price-rules.sql (bez trybu automatu)
      if (err) break; // brak tabeli (nieuruchomiony listing-price-rules.sql) albo brak uprawnień — bidder po prostu nic nie proponuje
      for (const r of (data as any[]) || []) out[r.external_id] = { min: r.min_price === null ? null : Number(r.min_price), max: r.max_price === null ? null : Number(r.max_price), autoMode: (r.auto_mode as AutoMode | undefined) ?? "off" };
      if (!data || data.length < 1000) break;
    }
    setRules(out);
  }, []);
  useEffect(() => {
    if (mp === "octopia") loadRules();
  }, [mp, loadRules]);

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
    setBbFilter("all");
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
    for (const r of rows) st.set(r.state ?? "", (st.get(r.state ?? "") ?? 0) + 1);
    return { states: [...st.entries()].sort((a, b) => b[1] - a[1]) };
  }, [rows]);

  const filtered = useMemo(() => {
    const list = rows.filter((r) => {
      if (stock === "live" && !isListingLive(r)) return false;
      if (stock === "zero" && (r.quantity ?? 0) > 0) return false;
      if (stateFilter !== "" && (r.state ?? "") !== (stateFilter === "—" ? "" : stateFilter)) return false;
      if (bbFilter !== "all") {
        const bb = (r.details as any)?.octopia?.bb;
        if (bbFilter === "won" && bb !== true) return false;
        if (bbFilter === "lost" && bb !== false) return false;
      }
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
  }, [rows, stock, stateFilter, bbFilter, search, sort]);

  // Sumy całej listy marketplace'u (kafelki) i bieżącego wyniku filtrów (pasek pod tabelą).
  const summarize = (list: Listing[]) => {
    let qty = 0;
    let live = 0;
    for (const r of list) {
      qty += r.quantity ?? 0;
      if (isListingLive(r)) live += 1;
    }
    return { offers: list.length, live, qty };
  };
  const all = useMemo(() => summarize(rows), [rows]);
  // Cdiscount: BuyBox wśród ofert aktywnych (z danych kanału; stan może się odświeżać z opóźnieniem)
  const bbStats = useMemo(() => {
    if (mp !== "octopia") return null;
    let won = 0;
    let lost = 0;
    let unknown = 0;
    for (const r of rows) {
      if (!isListingLive(r)) continue;
      const bb = (r.details as any)?.octopia?.bb;
      if (bb === true) won++;
      else if (bb === false) lost++;
      else unknown++;
    }
    return { won, lost, unknown };
  }, [rows, mp]);
  const part = useMemo(() => summarize(filtered), [filtered]);
  // Propozycje cen bidderu Cdiscount (tylko oferty z ustawioną ceną minimalną)
  const proposals = useMemo(() => {
    const m = new Map<string, BidderProposal>();
    if (mp !== "octopia") return m;
    for (const r of rows) {
      const ob = (r.details as any)?.octopia;
      if (!ob) continue;
      const rule = rules[r.external_id];
      m.set(
        r.external_id,
        bidderProposal({ state: r.state, quantity: r.quantity, price: r.price, ourDelivery: ourDeliveryCost(r.details), bb: ob.bb ?? null, online: ob.online ?? null, offlineReason: ob.offlineReason ?? null, competing: ob.competing || [], bestPrice: ob.bestPrice ?? null, bestDelivery: ob.bestDelivery ?? null, min: rule?.min ?? null, max: rule?.max ?? null })
      );
    }
    return m;
  }, [rows, rules, mp]);
  const actionable = useMemo(() => rows.filter((r) => proposals.get(r.external_id)?.action === "set"), [rows, proposals]);

  async function saveRule(externalId: string, min: string, max: string, autoMode?: AutoMode) {
    setBidBusy(true);
    setError("");
    try {
      const res = await fetch("/api/listings/price-rule", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ marketplace: "octopia", externalId, minPrice: min, maxPrice: max, ...(autoMode ? { autoMode } : {}) }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Nie udało się zapisać ceny min/max.");
      else setRules((rs) => ({ ...rs, [externalId]: { min: data.minPrice ?? null, max: data.maxPrice ?? null, autoMode: (data.autoMode as AutoMode | undefined) ?? "off" } }));
    } finally {
      setBidBusy(false);
    }
  }

  async function applyPrices(list: { listing: Listing; proposal: BidderProposal }[]) {
    if (list.length === 0) return;
    const lines = list.slice(0, 15).map(({ listing, proposal }) => `${listing.sku || listing.external_id}: ${fmtMoney(listing.price, null)} → ${fmtMoney(proposal.price, null)} €`).join("\n");
    const msg = `Zmienić ceny ${list.length} ofert Cdiscount?\n\n${lines}${list.length > 15 ? `\n… i ${list.length - 15} kolejnych` : ""}\n\nTo zmienia prawdziwe ceny na żywym marketplace’ie (paczka ofert Cdiscount — przetwarzanie może potrwać kilkanaście sekund).`;
    if (!window.confirm(msg)) return;
    setBidBusy(true);
    setError("");
    setNote("");
    try {
      const res = await fetch("/api/listings/octopia-price", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ confirm: true, changes: list.slice(0, 50).map(({ listing, proposal }) => ({ externalId: listing.external_id, price: proposal.price, reason: `bidder: ${proposal.reason}` })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !data.results) {
        setError(data.error || "Nie udało się zmienić cen.");
        return;
      }
      const failed = (data.results || []).filter((r: any) => !r.ok);
      setNote(`Cdiscount: zmieniono ${data.okCount ?? 0} z ${(data.results || []).length} cen${data.packageId ? ` (paczka ${data.packageId}, stan: ${data.packageState ?? "?"})` : ""}.${failed.length ? ` Błędy: ${failed.slice(0, 5).map((r: any) => r.message).join(" | ")}` : ""}`);
      await load("octopia");
    } finally {
      setBidBusy(false);
    }
  }

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
    const head = ["SKU", "Produkt", "Ilość", "Cena", "Waluta", "Cena min", "Cena max", "Stan oferty", "ID oferty", "ID produktu"];
    const lines = filtered.map((r) =>
      [r.sku, r.title, r.quantity, r.price ?? "", r.currency, r.min_price ?? "", r.max_price ?? "", listingStateLabel(r.marketplace, r.state), r.external_id, r.product_id].map(q).join(";")
    );
    const csv = "﻿" + [head.map(q).join(";"), ...lines].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `listingi-${mp}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const mpLabel = LISTING_MARKETPLACES.find((m) => m.key === mp)!.label;
  const ncols = mp === "octopia" ? 10 : 8;
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

      <div className={`grid grid-cols-1 gap-3 mb-5 ${bbStats ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
        <Tile label={`Oferty ${mpLabel}`} value={fmtInt(all.offers)} hint="Wszystkie listingi zwrócone przez marketplace (także offline)" />
        <Tile label="Aktywne (online, ilość > 0)" value={fmtInt(all.live)} hint={all.offers ? `${Math.round((all.live / all.offers) * 100)}% ofert` : undefined} />
        <Tile label="Ilość łącznie (szt.)" value={fmtInt(all.qty)} hint="Suma ilości ze wszystkich ofert" />
        {bbStats && <Tile label="BuyBox (oferty aktywne)" value={`${fmtInt(bbStats.won)} z ${fmtInt(bbStats.won + bbStats.lost)}`} hint={`mamy BuyBox${bbStats.unknown ? ` · ${fmtInt(bbStats.unknown)} bez danych` : ""}`} />}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Szukaj: SKU, produkt, ID oferty" className="border border-line bg-white px-3 py-1.5 rounded text-sm w-64" />
        <div className="flex gap-1.5">
          <button onClick={() => { setStock("all"); setPage(1); }} className={smallPill(stock === "all")}>Wszystkie</button>
          <button onClick={() => { setStock("live"); setPage(1); }} className={smallPill(stock === "live")}>Aktywne</button>
          <button onClick={() => { setStock("zero"); setPage(1); }} className={smallPill(stock === "zero")}>Ilość 0</button>
        </div>
        {mp === "octopia" && (
          <div className="flex gap-1.5">
            <button onClick={() => { setBbFilter("all"); setPage(1); }} className={smallPill(bbFilter === "all")}>BuyBox: wszystkie</button>
            <button onClick={() => { setBbFilter("won"); setPage(1); }} className={smallPill(bbFilter === "won")}>Mamy</button>
            <button onClick={() => { setBbFilter("lost"); setPage(1); }} className={smallPill(bbFilter === "lost")}>Nie mamy</button>
          </div>
        )}
        <select value={stateFilter} onChange={(e) => { setStateFilter(e.target.value); setPage(1); }} className="border border-line bg-white px-2 py-1.5 rounded text-sm">
          <option value="">Stan oferty: wszystkie</option>
          {facets.states.map(([s, n]) => (
            <option key={s || "—"} value={s || "—"}>{listingStateLabel(mp, s || null)} ({fmtInt(n)})</option>
          ))}
        </select>
        <button onClick={exportCsv} disabled={filtered.length === 0} className="ml-auto bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-50">Pobierz CSV</button>
      </div>

      {mp === "octopia" && canBid && (
        <div className="flex flex-wrap items-center gap-3 mb-3 text-xs">
          <button
            onClick={() => applyPrices(actionable.map((r) => ({ listing: r, proposal: proposals.get(r.external_id)! })))}
            disabled={bidBusy || actionable.length === 0}
            className="bg-ink text-paper px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-50"
          >
            Zastosuj propozycje ({actionable.length})
          </button>
          <span className="text-inksoft">Bidder Cdiscount proponuje ceny tylko dla ofert z ustawioną ceną minimalną; zmiana idzie po potwierdzeniu, każda zapisuje się w dzienniku zmian cen.</span>
        </div>
      )}

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className={`${thBtn}`} onClick={() => toggleSort("sku")}>SKU{arrow("sku")}</th>
              <th className={thBtn} onClick={() => toggleSort("title")}>Produkt{arrow("title")}</th>
              <th className={`${thBtn} text-right`} onClick={() => toggleSort("quantity")}>Ilość{arrow("quantity")}</th>
              <th className={`${thBtn} text-right`} onClick={() => toggleSort("price")}>Cena{arrow("price")}</th>
              <th className={`${th} text-right`} title={mp === "octopia" ? "Cena minimalna automatu Cdiscount (offer competition)" : undefined}>Min / max</th>
              {mp === "octopia" && <th className={th} title="Czy oferta ma BuyBox na Cdiscount i cena oferty, która go ma">BuyBox</th>}
              {mp === "octopia" && <th className={th} title="Bidder: nasza cena minimalna/maksymalna oferty i propozycja ceny (0,01 € poniżej najtańszego konkurenta, nie niżej niż min). Nic nie zmienia samo — zmianę zatwierdzasz.">Bidder</th>}
              <th className={thBtn} onClick={() => toggleSort("state")}>Stan oferty{arrow("state")}</th>
              <th className={th}>Oferta</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={ncols} className="p-6 text-center text-inksoft text-sm">Wczytywanie…</td></tr>}
            {!loading && visible.length === 0 && !error && (
              <tr>
                <td colSpan={ncols} className="p-6 text-center text-inksoft text-sm">
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
                      {mp === "octopia" && (() => {
                        const ob = (r.details as any)?.octopia as OctopiaBrief | undefined;
                        return (
                          <td className="p-3 whitespace-nowrap text-xs">
                            {ob && ob.bb !== null ? (
                              <>
                                <span className={`font-semibold ${ob.bb ? "text-teal" : "text-rust"}`}>{ob.bb ? "mamy" : "nie mamy"}</span>
                                {ob.bestPrice !== null && <div className="font-mono text-[11px] text-inksoft" title="Cena oferty z BuyBox">{ob.bb ? "" : "BuyBox: "}{fmtMoney(ob.bestPrice, r.currency)}</div>}
                              </>
                            ) : <span className="text-inksoft">—</span>}
                            {ob && ob.comp !== null && <div className={`text-[11px] ${ob.comp ? "text-teal" : "text-inksoft"}`} title="Wbudowany automat Cdiscount (offer competition)">automat {ob.comp ? "wł." : "wył."}</div>}
                          </td>
                        );
                      })()}
                      {mp === "octopia" && (
                        <OctopiaBidderCell
                          rule={rules[r.external_id]}
                          canEdit={canBid}
                          proposal={isListingLive(r) ? proposals.get(r.external_id) ?? null : null}
                          busy={bidBusy}
                          onSaveRule={(min, max) => saveRule(r.external_id, min, max)}
                          onSaveAuto={(mode) => {
                            const rl = rules[r.external_id];
                            const range = `${rl?.min ?? "—"} – ${rl?.max ?? "brak max"} €`;
                            if (mode !== "off" && !window.confirm(`Włączyć automat cen dla ${r.sku || r.external_id}?\n\nCo 15 min aplikacja sama zmieni prawdziwą cenę tej oferty na Cdiscount (${mode === "both" ? "podwyżki i obniżki" : "tylko podwyżki"}) w granicach ${range}. Każda zmiana zapisze się w dzienniku zmian cen.`)) return;
                            saveRule(r.external_id, rl?.min == null ? "" : String(rl.min), rl?.max == null ? "" : String(rl.max), mode);
                          }}
                          onApply={(p) => applyPrices([{ listing: r, proposal: p }])}
                        />
                      )}
                      <td className="p-3 whitespace-nowrap">
                        <span className={`text-xs font-semibold px-2 py-1 rounded ${stateStyle(r)}`} title={r.state !== null ? `Surowa wartość: ${r.state}` : undefined}>{listingStateLabel(r.marketplace, r.state)}</span>
                      </td>
                      <td className="p-3 text-xs whitespace-nowrap">
                        {listingLinks(r).map((lk) => (
                          <div key={lk.label}>
                            <a href={lk.url} target="_blank" rel="noreferrer" title={lk.hint} className="text-teal font-semibold hover:underline">{lk.label} ↗</a>
                          </div>
                        ))}
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <button onClick={() => setOpen(isOpen ? null : r.external_id)} className="text-xs font-semibold text-teal hover:underline">{isOpen ? "Zwiń ▴" : "Szczegóły ▾"}</button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-line bg-paper">
                        <td colSpan={ncols} className="p-4"><Details l={r} /></td>
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
        ukończeniu pełnej synchronizacji. <b>Cdiscount (Octopia):</b> oferty kanału CDISFR z <code>GET /offers</code>; ilość to suma ilości ofert dostawy (stan wspólny dla kanałów), „Min / max” to cena minimalna wbudowanego
        automatu Cdiscount („offer competition” — sam obniża cenę do 0,01 € poniżej najtańszego konkurenta, ale nie poniżej minimum; ustawia się go w panelu sprzedawcy, API tylko go odczytuje), a BuyBox i konkurencja pochodzą z danych
        kanału (mogą być opóźnione). To podgląd — niczego nie zmienia na marketplace’ach.
      </p>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-line bg-white p-4" title={hint}>
      <div className="text-xs font-semibold text-inksoft mb-1">{label}</div>
      <div className="font-semibold text-2xl">{value}</div>
      {hint && <div className="text-[11px] text-inksoft mt-1">{hint}</div>}
    </div>
  );
}

function OctopiaDetails({ l }: { l: Listing }) {
  const d = l.details ?? {};
  const ob = d.octopia as OctopiaBrief | undefined;
  const row = (label: string, value: React.ReactNode) =>
    value === null || value === undefined || value === "" ? null : (
      <div className="flex gap-3 py-0.5"><span className="text-inksoft w-44 shrink-0">{label}</span><span className="break-words min-w-0">{value}</span></div>
    );
  const gap = ob && ob.bestPrice !== null && l.price !== null ? l.price - ob.bestPrice : null;
  return (
    <div className="grid md:grid-cols-2 gap-x-8 gap-y-3 text-xs">
      <div>
        {row("ID oferty", <span className="font-mono">{l.external_id}</span>)}
        {row("Produkt (referencja)", l.product_id ? <span className="font-mono">{l.product_id}</span> : null)}
        {row("GTIN / EAN", l.listing_ref ? <span className="font-mono">{l.listing_ref}</span> : null)}
        {row("Utworzona", l.listed_at ? fmtWarsawDateTime(Date.parse(l.listed_at)) : null)}
        {row("Ostatnio widziana", fmtWarsawDateTime(Date.parse(l.snapshot_at)))}
        {row("Czas przygotowania", d.preparation_days !== undefined ? `${d.preparation_days} dni` : null)}
        {row("Komentarz", d.comment)}
        {ob && row("Online na Cdiscount", ob.online === null ? null : ob.online ? "tak" : "nie")}
        {ob && row("Powód offline", ob.offlineReason)}
        {ob && row("Qualiscore", ob.score)}
        {ob && ob.scoreReasons && ob.scoreReasons.length > 0 && row("Powody oceny (Qualiscore)", ob.scoreReasons.map((x) => x.reason || x.code).filter(Boolean).join("; "))}
        {ob && ob.loyalty !== undefined && ob.loyalty !== null && row("Program lojalnościowy (CDAV)", ob.loyalty ? "tak" : "nie")}
        {ob && row("Liczba ofert produktu", ob.offersCount)}
        {Array.isArray(d.delivery_modes) && d.delivery_modes.length > 0 && row("Dostawa", d.delivery_modes.map((m: any) => `${m.c ?? "—"} ${m.p !== null ? fmtMoney(m.p, l.currency) : ""}${m.d !== null ? ` (do ${m.d} dni)` : ""}`).join("; "))}
      </div>
      <div>
        {!ob ? (
          <div className="text-inksoft">Brak danych kanału (BuyBox, konkurencja) — odśwież listingi.</div>
        ) : (
          <>
            <div className="font-semibold text-inksoft mb-1">BUYBOX I KONKURENCJA</div>
            {row("BuyBox", ob.bb === null ? "brak danych" : ob.bb ? <b className="text-teal">mamy</b> : <b className="text-rust">nie mamy</b>)}
            {row("Cena oferty z BuyBox", ob.bestPrice !== null ? `${fmtMoney(ob.bestPrice, l.currency)}${ob.bestDelivery ? ` + dostawa ${fmtMoney(ob.bestDelivery, l.currency)}` : ""}` : null)}
            {row("Nasza cena", l.price !== null ? fmtMoney(l.price, l.currency) : null)}
            {gap !== null && !ob.bb && row("Różnica do BuyBox", <span className={gap > 0 ? "text-rust" : "text-teal"}>{gap > 0 ? "+" : ""}{fmtMoney(gap, l.currency)}</span>)}
            {row("Automat (offer competition)", ob.comp === null ? "nie włączany" : ob.comp ? <span className="text-teal">włączony</span> : "wyłączony")}
            {row("Cena minimalna automatu", ob.compMin !== null ? fmtMoney(ob.compMin, l.currency) : null)}
            {ob.ext && row(`Najlepsza oferta ${ob.ext.name ?? "zewnętrzna"}`, `${ob.ext.total !== null ? fmtMoney(ob.ext.total, l.currency) : "—"}${ob.ext.idx !== null ? ` (nasz wskaźnik cenowy ${ob.ext.idx}%)` : ""}`)}
            {ob.competing.length > 0 && (
              <div className="mt-2">
                <div className="font-semibold text-inksoft mb-1">OFERTY KONKURENTÓW</div>
                <table className="w-full">
                  <thead><tr className="text-left text-inksoft"><th className="py-0.5 pr-3 font-semibold">Sprzedawca</th><th className="py-0.5 pr-3 font-semibold text-right">Cena</th><th className="py-0.5 pr-3 font-semibold text-right">Dostawa</th><th className="py-0.5 pr-3 font-semibold text-right" title="Ocena sprzedawcy">Ocena</th><th className="py-0.5 pr-3 font-semibold" title="Program lojalnościowy (CDAV)">CDAV</th><th className="py-0.5 font-semibold">BuyBox</th></tr></thead>
                  <tbody>
                    {ob.competing.map((c, i) => (
                      <tr key={i}><td className="py-0.5 pr-3">{c.n ?? "—"}</td><td className="py-0.5 pr-3 text-right font-mono">{fmtMoney(c.p, null)}</td><td className="py-0.5 pr-3 text-right font-mono">{fmtMoney(c.d, null)}</td><td className="py-0.5 pr-3 text-right font-mono">{c.r !== undefined && c.r !== null ? c.r : "—"}</td><td className="py-0.5 pr-3">{c.l ? "tak" : c.l === false ? "nie" : "—"}</td><td className="py-0.5">{c.b ? "tak" : ""}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {ob.bbAt && <div className="text-inksoft mt-1">Dane BuyBox z kanału: {fmtWarsawDateTime(Date.parse(ob.bbAt))} (kanał odświeża je z opóźnieniem)</div>}
          </>
        )}
      </div>
    </div>
  );
}

function Details({ l }: { l: Listing }) {
  if (l.marketplace === "octopia") return <OctopiaDetails l={l} />;
  const d = l.details ?? {};
  const row = (label: string, value: React.ReactNode) =>
    value === null || value === undefined || value === "" ? null : (
      <div className="flex gap-3 py-0.5"><span className="text-inksoft w-40 shrink-0">{label}</span><span className="break-words min-w-0">{value}</span></div>
    );
  const markets: MarketPriceBrief[] = Array.isArray(d.markets) ? d.markets : [];
  const ships: { c: string | null; s: string | null; d: number | null; p: number | null }[] = Array.isArray(d.shippings) ? d.shippings : [];
  const BUYBOX: Record<string, string> = { WON: "Wygrany", SHOULD_WIN: "Powinien wygrać", ELIGIBLE: "Kwalifikuje się", WON_ELSEWHERE: "Wygrany gdzie indziej", INELIGIBLE: "Nie kwalifikuje się" };
  const INELIGIBLE_HINT = "Oferta nie może w tej chwili zdobyć BuyBox. Wg dokumentacji refurbed bywa tak m.in. gdy dla produktu włączona jest „ochrona BuyBox” i stan oferty jest zbyt niski; API nie podaje dokładnego powodu.";
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
                    <td className="py-0.5" title={m.b === "INELIGIBLE" ? INELIGIBLE_HINT : undefined}>{m.b ? BUYBOX[m.b] ?? m.b : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-inksoft mt-1">* cena wyliczona automatycznie z ceny referencyjnej</div>
            {markets.some((m) => m.b === "INELIGIBLE") && <div className="text-amber mt-1">{INELIGIBLE_HINT}</div>}
          </div>
        )}
        {ships.length === 0 && markets.length === 0 && <div className="text-inksoft">Brak dodatkowych danych o wysyłce i cenach na rynkach.</div>}
      </div>
    </div>
  );
}
