"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { escapeLike } from "@/lib/search";
import type { MemberLite } from "@/lib/displayName";
import type { Session } from "@supabase/supabase-js";
import ProductCardDrawer from "./ProductCardDrawer";
import GoodsAddForm from "./GoodsAddForm";

// Zakładka Towar (10.10.2026, na prośbę właściciela): rejestr zakupionego towaru z arkusza Towar.numbers, dwie pigułki jak arkusze:
// "VM/V23" (zakupy od firm i z Allegro) i "Trade-in" (zakupy ze skupu Back Market). Dane w tabeli goods_register (supabase/goods.sql),
// tylko do odczytu; kwoty ("cena PLN + koszty", "Cena PLN", "prowizja + PCC") to wartości z arkusza, niczego tu nie przeliczamy.

type Kind = "vm_v23" | "trade_in";

type Row = {
  id: number;
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
};

type Totals = { price_pln: number; costs: number; total_pln: number; pcc: number; commission_pcc: number };

const KINDS: { key: Kind; label: string }[] = [
  { key: "vm_v23", label: "VM/V23" },
  { key: "trade_in", label: "Trade-in" },
];
const PAGE_SIZES = [50, 100, 200];
const NONE = "__brak__"; // w filtrach: wiersze z pustą wartością
const COLUMNS = "id, serial, name, supplier, purchased_on, delivered_on, order_no, invoice_no, category, price, vat, currency, nbp_rate, costs, total_pln, price_pln, pcc, country, commission_pcc";

const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const selectCls = "border border-line bg-white px-2 py-2 rounded text-sm";

const fmtDate = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "—");
const fmtNum = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString("pl-PL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtPln = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${fmtNum(n)} zł`);

type Facets = { category: Map<string, number>; vat: Map<string, number>; supplier: Map<string, number> };

export default function GoodsView({ session, members, isAdmin }: { session: Session; members: MemberLite[]; isAdmin: boolean }) {
  const [kind, setKind] = useState<Kind>("vm_v23");
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [vat, setVat] = useState("");
  const [supplier, setSupplier] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [kindCounts, setKindCounts] = useState<Partial<Record<Kind, number>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openSerial, setOpenSerial] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
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

  // Zmiana pigułki czyści filtry (każdy arkusz ma inne kategorie i dostawców).
  function changeKind(k: Kind) {
    if (k === kind) return;
    setKind(k);
    setCategory("");
    setVat("");
    setSupplier("");
    setPage(1);
  }

  // Wspólne filtry zapytania (wyszukiwarka i trzy listy).
  const applyFilters = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q: any) => {
      q = q.eq("kind", kind);
      if (category) q = category === NONE ? q.is("category", null) : q.eq("category", category);
      if (vat) q = vat === NONE ? q.is("vat", null) : q.eq("vat", vat);
      if (supplier) q = supplier === NONE ? q.is("supplier", null) : q.eq("supplier", supplier);
      if (search) {
        const s = escapeLike(search).replace(/[,()"]/g, " ").trim(); // przecinki i nawiasy rozbiłyby składnię .or()
        if (s) q = q.or(["serial", "name", "order_no", "invoice_no", "supplier"].map((c) => `${c}.ilike.%${s}%`).join(","));
      }
      return q;
    },
    [kind, category, vat, supplier, search]
  );

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const from = (page - 1) * pageSize;
      const { data, error: err, count: total } = await applyFilters(supabase.from("goods_register").select(COLUMNS, { count: "exact" }))
        .order("purchased_on", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .range(from, from + pageSize - 1);
      if (mine !== seq.current) return;
      if (err) {
        if (err.code === "PGRST103" && page > 1) {
          setPage(1);
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
  }, [applyFilters, page, pageSize, reloadKey]);

  useEffect(() => {
    load();
  }, [load]);

  // Sumy dla CAŁEGO wyniku filtrów (nie tylko widocznej strony): kolejne porcje po 1000 (limit PostgREST), liczone tylko przy zmianie filtrów.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const acc: Totals = { price_pln: 0, costs: 0, total_pln: 0, pcc: 0, commission_pcc: 0 };
      for (let from = 0; ; from += 1000) {
        const { data, error: err } = await applyFilters(supabase.from("goods_register").select("price_pln, costs, total_pln, pcc, commission_pcc"))
          .order("id")
          .range(from, from + 999);
        if (cancelled) return;
        if (err) return setTotals(null);
        for (const r of (data as Partial<Totals>[]) || []) {
          acc.price_pln += Number(r.price_pln ?? 0);
          acc.costs += Number(r.costs ?? 0);
          acc.total_pln += Number(r.total_pln ?? 0);
          acc.pcc += Number(r.pcc ?? 0);
          acc.commission_pcc += Number(r.commission_pcc ?? 0);
        }
        if (!data || data.length < 1000) break;
      }
      if (!cancelled) setTotals(acc);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyFilters, reloadKey]);

  // Wartości do list rozwijanych (z licznikami) i liczniki pigułek — raz na rodzaj.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const f: Facets = { category: new Map(), vat: new Map(), supplier: new Map() };
      const bump = (m: Map<string, number>, v: string | null) => m.set(v ?? NONE, (m.get(v ?? NONE) ?? 0) + 1);
      for (let from = 0; ; from += 1000) {
        const { data, error: err } = await supabase.from("goods_register").select("category, vat, supplier").eq("kind", kind).order("id").range(from, from + 999);
        if (cancelled || err) return;
        for (const r of (data as { category: string | null; vat: string | null; supplier: string | null }[]) || []) {
          bump(f.category, r.category);
          bump(f.vat, r.vat);
          bump(f.supplier, r.supplier);
        }
        if (!data || data.length < 1000) break;
      }
      if (!cancelled) setFacets(f);
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, reloadKey]);

  useEffect(() => {
    (async () => {
      const out: Partial<Record<Kind, number>> = {};
      for (const k of KINDS) {
        const { count: c } = await supabase.from("goods_register").select("id", { count: "exact", head: true }).eq("kind", k.key);
        if (c !== null) out[k.key] = c;
      }
      setKindCounts(out);
    })();
  }, [reloadKey]);

  async function removeRow(r: Row) {
    if (!confirm(`Usunąć z rejestru pozycję ${r.serial ?? r.name ?? r.id}? Tej operacji nie można cofnąć (zapis zostaje tylko w dzienniku usunięć).`)) return;
    const { data, error: err } = await supabase.from("goods_register").delete().eq("id", r.id).select("id");
    if (err) return setError(`Nie udało się usunąć: ${err.message}`);
    if (!data?.length) return setError("Nie usunięto — brak uprawnień (tylko Admin) albo pozycja już nie istnieje.");
    setReloadKey((k) => k + 1);
  }

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / pageSize));
  const isTradeIn = kind === "trade_in";
  const options = (m: Map<string, number> | undefined) =>
    Array.from(m?.entries() ?? [])
      .sort((a, b) => (a[0] === NONE ? 1 : b[0] === NONE ? -1 : a[0].localeCompare(b[0], "pl")))
      .map(([v, n]) => ({ value: v, label: `${v === NONE ? "— (brak)" : v} (${n})` }));
  const anyFilter = !!(search || category || vat || supplier);
  const colSpan = (isTradeIn ? 17 : 14) + (isAdmin ? 1 : 0);

  const headers = useMemo(
    () => [
      "Numer seryjny",
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
      ...(isAdmin ? [""] : []),
    ],
    [isTradeIn, isAdmin]
  );

  return (
    <div>
      <div className="flex gap-2 mb-4">
        {KINDS.map((k) => (
          <button key={k.key} onClick={() => changeKind(k.key)} className={pill(kind === k.key)}>
            {k.label}
            {kindCounts[k.key] !== undefined && <span className="ml-1.5 text-xs font-normal opacity-70">{kindCounts[k.key]}</span>}
          </button>
        ))}
        <button onClick={() => setAdding((a) => !a)} className="ml-auto bg-ink text-paper px-4 py-1.5 rounded text-sm font-semibold">{adding ? "Zamknij formularz" : "+ Dodaj towar"}</button>
      </div>

      {adding && (
        <GoodsAddForm
          key={kind}
          kind={kind}
          session={session}
          categories={options(facets?.category).map((o) => o.value).filter((v) => v !== NONE)}
          suppliers={options(facets?.supplier).map((o) => o.value).filter((v) => v !== NONE)}
          onAdded={() => {
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
          placeholder="Szukaj: numer seryjny, nazwa, nr zamówienia, faktura, dostawca"
          className="w-96 border border-line bg-white px-3 py-2 rounded text-sm"
        />
        <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} className={selectCls}>
          <option value="">Kategoria: wszystkie</option>
          {options(facets?.category).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={vat} onChange={(e) => { setVat(e.target.value); setPage(1); }} className={selectCls}>
          <option value="">VAT: wszystkie</option>
          {options(facets?.vat).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={supplier} onChange={(e) => { setSupplier(e.target.value); setPage(1); }} className={selectCls}>
          <option value="">Dostawca: wszyscy</option>
          {options(facets?.supplier).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {anyFilter && (
          <button
            onClick={() => {
              setSearchInput("");
              setSearch("");
              setCategory("");
              setVat("");
              setSupplier("");
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

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-inksoft border-b border-line">
              {headers.map((h) => <th key={h} className="p-2 whitespace-nowrap font-semibold">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && !error && (
              <tr><td colSpan={colSpan} className="p-6 text-center text-inksoft text-sm">{anyFilter ? "Nic nie pasuje do filtrów." : "Brak danych — wgraj plik z danymi towaru (patrz supabase/goods.sql)."}</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-paper align-top">
                <td className="p-2 font-mono whitespace-nowrap">
                  {r.serial ? <button onClick={() => setOpenSerial(r.serial)} className="text-teal hover:underline">{r.serial}</button> : "—"}
                </td>
                <td className="p-2 min-w-[12rem]">{r.name || "—"}</td>
                <td className="p-2 whitespace-nowrap">{r.supplier || "—"}</td>
                <td className="p-2 whitespace-nowrap">{fmtDate(r.purchased_on)}</td>
                <td className="p-2 whitespace-nowrap">{fmtDate(r.delivered_on)}</td>
                <td className="p-2 font-mono whitespace-nowrap">{r.order_no || "—"}</td>
                <td className="p-2 whitespace-nowrap">{r.invoice_no || "—"}</td>
                <td className="p-2 whitespace-nowrap">{r.category || "—"}</td>
                <td className="p-2 whitespace-nowrap text-right">{r.price === null ? "—" : `${fmtNum(r.price)} ${r.currency ?? ""}`.trim()}</td>
                <td className="p-2 whitespace-nowrap">{r.vat || "—"}</td>
                <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.nbp_rate, 4)}</td>
                <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.costs)}</td>
                <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.total_pln)}</td>
                <td className="p-2 whitespace-nowrap text-right font-semibold">{fmtNum(r.price_pln)}</td>
                {isTradeIn && (
                  <>
                    <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.pcc)}</td>
                    <td className="p-2 whitespace-nowrap">{r.country || "—"}</td>
                    <td className="p-2 whitespace-nowrap text-right">{fmtNum(r.commission_pcc)}</td>
                  </>
                )}
                {isAdmin && (
                  <td className="p-2 whitespace-nowrap text-right">
                    <button onClick={() => removeRow(r)} className="text-rust hover:underline">Usuń</button>
                  </td>
                )}
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
        <span>Koszty: <span className="font-semibold">{fmtPln(totals?.costs)}</span></span>
        <span>Cena PLN + koszty: <span className="font-semibold">{fmtPln(totals?.total_pln)}</span></span>
        {isTradeIn && <span>PCC: <span className="font-semibold">{fmtPln(totals?.pcc)}</span></span>}
        {isTradeIn && <span>Prowizja + PCC: <span className="font-semibold">{fmtPln(totals?.commission_pcc)}</span></span>}
      </div>
      <p className="text-[11px] text-inksoft mt-2 max-w-3xl">Dane z arkusza Towar.numbers i dopisane formularzem „Dodaj towar” (bez edycji istniejących wierszy; usuwa tylko Admin). Kwoty „Cena PLN”, „Koszty”, „Cena PLN + koszty” i „Prowizja + PCC” to wartości z arkusza, nie przeliczenia aplikacji; sumy dotyczą całego wyniku filtrów.</p>

      {openSerial && <ProductCardDrawer serial={openSerial} members={members} onClose={() => setOpenSerial(null)} />}
    </div>
  );
}
