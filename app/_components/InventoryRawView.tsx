"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { escapeLike } from "@/lib/search";
import type { MemberLite } from "@/lib/displayName";
import ProductCardDrawer from "./ProductCardDrawer";

// Lista sztuk ze stanem = 1 z cache Fakturowni (fakturownia_stock_cache), strona po stronie,
// z wyszukiwaniem po numerze seryjnym. W Fakturowni numer seryjny to nazwa produktu, a opis
// to numer zamówienia Back Market, z którego sztuka pochodzi.

type Row = {
  id: number;
  name: string | null;
  category_name: string;
  description: string | null;
  purchase_price_gross: number;
  product_created_at: string | null;
  vat: string | null;
  sku: string | null;
  sku_category: string | null;
  sku_class: string | null;
};

const PAGE_SIZES = [25, 50, 100];
const NO_SKU = "__bez_sku__"; // w filtrze kategorii: sztuki bez SKU (brak kategorii z SKU)
const NO_CLASS = "__bez_klasy__"; // w filtrze klasy: sztuki bez klasy

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtPLN(n: number) {
  return Number(n).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " zł";
}
// reloadKey rośnie po ręcznym "Odśwież" w nagłówku Magazynu — wymusza ponowne wczytanie listy.
export default function InventoryRawView({ reloadKey = 0, members }: { reloadKey?: number; members: MemberLite[] }) {
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  // Filtr "Kategoria z SKU" (lista rozwijana): "" = wszystkie, NO_SKU = sztuki bez SKU, inaczej konkretna kategoria.
  const [skuCategory, setSkuCategory] = useState("");
  // Filtr "Klasa" (lista rozwijana), łączny z kategorią: oba działają jednocześnie (AND), a liczniki w każdej liście
  // uwzględniają wybór w drugiej (np. po wybraniu kategorii NS lista klas pokazuje tylko klasy sztuk z NS).
  const [skuClass, setSkuClass] = useState("");
  // Podsumowanie CAŁEGO wyniku filtra (nie tylko bieżącej strony): liczba sztuk, suma i średnia cena zakupu.
  const [summary, setSummary] = useState<{ count: number; sum: number } | null>(null);
  const [skuPairs, setSkuPairs] = useState<{ c: string | null; k: string | null }[]>([]);
  const [openSerial, setOpenSerial] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const channel = supabase
      .channel("inventory-raw-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "fakturownia_sync_meta" }, () => setReloadTick((n) => n + 1))
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Pary (kategoria z SKU, klasa) wszystkich sztuk — do rozwijanych list z licznikami; odświeżane razem z listą.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const PAGE = 1000;
      const pairs: { c: string | null; k: string | null }[] = [];
      let from = 0;
      while (true) {
        const { data, error: err } = await supabase.from("fakturownia_stock_with_sku").select("sku_category, sku_class").range(from, from + PAGE - 1);
        if (err) return; // brak widoku itp. — filtry po prostu bez opcji, lista działa dalej
        for (const r of (data as { sku_category: string | null; sku_class: string | null }[]) || []) pairs.push({ c: r.sku_category, k: r.sku_class });
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }
      if (!cancelled) setSkuPairs(pairs);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick, reloadKey]);

  const matchesClass = (k: string | null) => (skuClass === "" ? true : skuClass === NO_CLASS ? k === null : k === skuClass);
  const matchesCategory = (c: string | null) => (skuCategory === "" ? true : skuCategory === NO_SKU ? c === null : c === skuCategory);
  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let none = 0;
    for (const p of skuPairs) {
      if (!matchesClass(p.k)) continue;
      if (p.c === null) none++;
      else counts.set(p.c, (counts.get(p.c) || 0) + 1);
    }
    if (skuCategory && skuCategory !== NO_SKU && !counts.has(skuCategory)) counts.set(skuCategory, 0); // wybrana wartość zostaje na liście nawet bez wyników
    return { none, list: Array.from(counts, ([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, "pl")) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skuPairs, skuClass, skuCategory]);
  const classOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let none = 0;
    for (const p of skuPairs) {
      if (!matchesCategory(p.c)) continue;
      if (p.k === null) none++;
      else counts.set(p.k, (counts.get(p.k) || 0) + 1);
    }
    if (skuClass && skuClass !== NO_CLASS && !counts.has(skuClass)) counts.set(skuClass, 0);
    return { none, list: Array.from(counts, ([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, "pl")) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skuPairs, skuCategory, skuClass]);

  // Podsumowanie wyniku filtra: ceny wszystkich pasujących sztuk (paginowane po 1000, bo PostgREST tnie wynik) i liczone
  // w przeglądarce — bez zależności od agregatów PostgREST. Niezależne od strony/rozmiaru strony, więc zmiana strony go nie przelicza.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const PAGE = 1000;
      let count = 0;
      let sum = 0;
      for (let from = 0; ; from += PAGE) {
        let q = supabase.from("fakturownia_stock_with_sku").select("purchase_price_gross");
        if (search) q = q.ilike("name", `%${escapeLike(search)}%`);
        if (skuCategory === NO_SKU) q = q.is("sku_category", null);
        else if (skuCategory) q = q.eq("sku_category", skuCategory);
        if (skuClass === NO_CLASS) q = q.is("sku_class", null);
        else if (skuClass) q = q.eq("sku_class", skuClass);
        const { data, error: err } = await q.order("id").range(from, from + PAGE - 1);
        if (err) {
          if (!cancelled) setSummary(null);
          return;
        }
        for (const r of (data as { purchase_price_gross: number | string }[]) || []) {
          count += 1;
          sum += Number(r.purchase_price_gross) || 0;
        }
        if (!data || data.length < PAGE) break;
      }
      if (!cancelled) setSummary({ count, sum });
    })();
    return () => {
      cancelled = true;
    };
  }, [search, skuCategory, skuClass, reloadTick, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      const from = (page - 1) * pageSize;
      let q = supabase
        .from("fakturownia_stock_with_sku")
        .select("id, name, category_name, description, purchase_price_gross, product_created_at, vat, sku, sku_category, sku_class", { count: "exact" });
      if (search) q = q.ilike("name", `%${escapeLike(search)}%`);
      if (skuCategory === NO_SKU) q = q.is("sku_category", null);
      else if (skuCategory) q = q.eq("sku_category", skuCategory);
      if (skuClass === NO_CLASS) q = q.is("sku_class", null);
      else if (skuClass) q = q.eq("sku_class", skuClass);
      const { data, error: err, count } = await q
        .order("product_created_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .range(from, from + pageSize - 1);
      if (cancelled) return;
      if (err) {
        // strona poza zakresem (np. po synchronizacji ubyło wierszy) — wróć na początek
        if (err.code === "PGRST103" && page > 1) setPage(1);
        else setError(`Nie udało się wczytać listy: ${err.message}`);
      } else {
        setRows((data as Row[]) || []);
        setTotal(count ?? 0);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [page, pageSize, search, skuCategory, skuClass, reloadTick, reloadKey]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const needsBackfill = !search && rows.length > 0 && rows.every((r) => r.name === null);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Szukaj po numerze seryjnym"
            className="w-72 border border-line bg-white px-3 py-2 rounded text-sm font-mono"
          />
          <label className="text-xs text-inksoft">Kategoria z SKU</label>
          <select
            value={skuCategory}
            onChange={(e) => {
              setSkuCategory(e.target.value);
              setPage(1);
            }}
            className="border border-line bg-white px-2 py-1.5 rounded text-sm font-semibold font-mono"
          >
            <option value="">Wszystkie</option>
            <option value={NO_SKU}>Bez SKU ({categoryOptions.none})</option>
            {categoryOptions.list.map((o) => (
              <option key={o.name} value={o.name}>{o.name} ({o.count})</option>
            ))}
          </select>
          <label className="text-xs text-inksoft">Klasa</label>
          <select
            value={skuClass}
            onChange={(e) => {
              setSkuClass(e.target.value);
              setPage(1);
            }}
            className="border border-line bg-white px-2 py-1.5 rounded text-sm font-semibold font-mono"
          >
            <option value="">Wszystkie</option>
            <option value={NO_CLASS}>Bez klasy ({classOptions.none})</option>
            {classOptions.list.map((o) => (
              <option key={o.name} value={o.name}>{o.name} ({o.count})</option>
            ))}
          </select>
          <label className="text-xs text-inksoft">Pokaż</label>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            className="border border-line bg-white px-2 py-1.5 rounded text-sm font-semibold"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-3 text-xs text-inksoft">
          <span>
            {total.toLocaleString("pl-PL")} {search || skuCategory || skuClass ? "wyników" : "produktów"} · strona {Math.min(page, totalPages)} z {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold text-ink disabled:opacity-40"
          >
            ‹ Poprzednia
          </button>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold text-ink disabled:opacity-40"
          >
            Następna ›
          </button>
        </div>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}
      {needsBackfill && (
        <p className="text-inksoft text-xs mb-3">
          Numery seryjne uzupełnią się po następnym kliknięciu „Odśwież” (jednorazowa pełna synchronizacja, ok. minuty).
        </p>
      )}

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Numer seryjny</th>
              <th className="p-3">SKU</th>
              <th className="p-3">Kategoria z SKU</th>
              <th className="p-3">Klasa</th>
              <th className="p-3">Kategoria</th>
              <th className="p-3">Zamówienie</th>
              <th className="p-3 text-right">Cena zakupu</th>
              <th className="p-3">VAT</th>
              <th className="p-3">Dodano</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="p-6 text-center text-inksoft text-sm">
                  {search || skuCategory || skuClass ? "Nic nie znaleziono dla tych kryteriów." : "Brak produktów — kliknij „Odśwież”, żeby pobrać dane z Fakturowni."}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-paper">
                <td className="p-3">
                  {r.name ? (
                    <button onClick={() => setOpenSerial(r.name)} className="font-mono font-semibold text-teal hover:underline">{r.name}</button>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="p-3 font-mono text-xs">{r.sku || "—"}</td>
                <td className="p-3 font-mono text-xs font-semibold">{r.sku_category || "—"}</td>
                <td className="p-3 font-mono text-xs font-semibold">{r.sku_class || "—"}</td>
                <td className="p-3">{r.category_name}</td>
                <td className="p-3 font-mono text-xs">{r.description || "—"}</td>
                <td className="p-3 text-right font-mono">{fmtPLN(r.purchase_price_gross)}</td>
                <td className="p-3 text-xs">{r.vat || "—"}</td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDate(r.product_created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {summary && (
        <div className="border border-line border-t-0 bg-white px-4 py-3 flex flex-wrap items-center gap-x-8 gap-y-1 text-sm">
          <span className="text-xs font-semibold text-inksoft">PODSUMOWANIE WYNIKU{search || skuCategory || skuClass ? " (wg filtrów)" : ""} — wszystkie strony</span>
          <span>Sztuk: <span className="font-mono font-semibold">{summary.count.toLocaleString("pl-PL")}</span></span>
          <span>Suma cen zakupu: <span className="font-mono font-semibold">{fmtPLN(summary.sum)}</span></span>
          <span>
            Średnia cena zakupu:{" "}
            <span className="font-mono font-semibold">{summary.count > 0 ? fmtPLN(summary.sum / summary.count) : "—"}</span>
          </span>
        </div>
      )}

      {openSerial && <ProductCardDrawer serial={openSerial} members={members} onClose={() => setOpenSerial(null)} />}
    </div>
  );
}
