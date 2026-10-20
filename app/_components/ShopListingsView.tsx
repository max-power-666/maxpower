"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { fmtWarsawDateTime } from "@/lib/warsawDate";
import { SHOP_CATEGORIES, shopCategory, type ShopCategory } from "@/lib/shopListings";

// Listingi -> pigułka "Sklep" (21.10.2026): aktualnie dostępne oferty Back Market (online, ilość > 0) z kategorii sklepu — konsole do gier, aparaty fotograficzne, smartwatche Samsung.
// Kolumny: SKU, produkt, ilość, cena. Dane z migawki ofert (marketplace_listings, odświeżana co godzinę), rozpoznanie kategorii: lib/shopListings.ts.
type Row = { external_id: string; sku: string | null; title: string | null; quantity: number | null; price: number | null; currency: string | null; snapshot_at: string; category: ShopCategory };
type SortKey = "sku" | "title" | "quantity" | "price";

const fmtInt = (n: number) => n.toLocaleString("pl-PL");
const fmtPrice = (p: number | null, cur: string | null) => (p === null ? "—" : `${p.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur || ""}`.trim());
const chip = (active: boolean) => `px-3 py-1 rounded-full text-xs font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

export default function ShopListingsView() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [cat, setCat] = useState<ShopCategory | "">("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "title", dir: 1 });

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const all: Row[] = [];
        // tylko oferty "żywe" na Back Market: publikacja Online (state = 2) i ilość > 0 (ta sama zasada co isListingLive w lib/listings.ts); PostgREST oddaje max 1000 wierszy — czytamy stronami
        for (let from = 0; ; from += 1000) {
          const { data, error: err } = await supabase
            .from("marketplace_listings")
            .select("external_id, sku, title, quantity, price, currency, snapshot_at")
            .eq("marketplace", "backmarket")
            .eq("state", "2")
            .gt("quantity", 0)
            .order("external_id")
            .range(from, from + 999);
          if (err) throw new Error(err.message);
          for (const r of (data as any[]) || []) {
            const c = shopCategory(r.title, r.sku);
            if (c) all.push({ ...r, quantity: r.quantity === null ? null : Number(r.quantity), price: r.price === null ? null : Number(r.price), category: c });
          }
          if (!data || data.length < 1000) break;
        }
        setRows(all);
        const { data: m } = await supabase.from("listings_sync_meta").select("last_synced_at").eq("marketplace", "backmarket").maybeSingle();
        setSyncedAt((m as any)?.last_synced_at ?? null);
      } catch (e: any) {
        setError(`Nie udało się wczytać ofert: ${e.message || e}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, { offers: number; qty: number }> = {};
    for (const r of rows) {
      const e = (c[r.category] ??= { offers: 0, qty: 0 });
      e.offers += 1;
      e.qty += r.quantity ?? 0;
    }
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const list = rows.filter((r) => (!cat || r.category === cat) && (!search || (r.sku || "").toLowerCase().includes(search) || (r.title || "").toLowerCase().includes(search)));
    const { key, dir } = sort;
    return list.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "pl", { numeric: true })) * dir;
    });
  }, [rows, cat, search, sort]);

  const totalQty = shown.reduce((s, r) => s + (r.quantity ?? 0), 0);
  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (-s.dir as 1 | -1) } : { key, dir: 1 }));
  const th = "p-3 text-xs font-semibold text-inksoft whitespace-nowrap cursor-pointer select-none hover:text-ink";
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "");

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button onClick={() => setCat("")} className={chip(cat === "")}>
          Wszystkie <span className="font-normal opacity-70">{fmtInt(rows.length)}</span>
        </button>
        {SHOP_CATEGORIES.map((c) => (
          <button key={c.key} onClick={() => setCat(c.key)} className={chip(cat === c.key)}>
            {c.label} <span className="font-normal opacity-70">{fmtInt(counts[c.key]?.offers ?? 0)}</span>
          </button>
        ))}
        <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Szukaj po SKU lub produkcie…" className="ml-auto border border-line bg-white px-3 py-1.5 rounded text-sm w-64" />
      </div>
      <div className="text-xs text-inksoft mb-3">
        Aktualnie dostępne oferty Back Market (online, ilość &gt; 0) z kategorii: konsole do gier, aparaty fotograficzne i smartwatche Samsung. Akcesoria, gry i inne marki są pominięte.
        {syncedAt ? ` Ostatnia pełna synchronizacja ofert: ${fmtWarsawDateTime(Date.parse(syncedAt))}.` : ""}
      </div>
      {error && <div className="mb-3 border border-rust bg-rustsoft text-rust text-sm px-3 py-2">{error}</div>}
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-line">
              <th className={th} onClick={() => toggle("sku")}>SKU{arrow("sku")}</th>
              <th className={th} onClick={() => toggle("title")}>Produkt{arrow("title")}</th>
              <th className={`${th} text-right`} onClick={() => toggle("quantity")}>Ilość{arrow("quantity")}</th>
              <th className={`${th} text-right`} onClick={() => toggle("price")}>Cena{arrow("price")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={4} className="p-6 text-center text-inksoft text-sm">Wczytywanie…</td></tr>
            )}
            {!loading && shown.length === 0 && (
              <tr><td colSpan={4} className="p-6 text-center text-inksoft text-sm">{rows.length === 0 ? "Brak dostępnych ofert w tych kategoriach." : "Brak wyników."}</td></tr>
            )}
            {shown.map((r) => (
              <tr key={r.external_id} className="border-b border-line last:border-b-0">
                <td className="p-3 font-mono text-xs">{r.sku || "—"}</td>
                <td className="p-3">{r.title || "—"}</td>
                <td className="p-3 text-right tabular-nums">{r.quantity ?? "—"}</td>
                <td className="p-3 text-right tabular-nums">{fmtPrice(r.price, r.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && shown.length > 0 && (
        <div className="mt-2 text-xs text-inksoft">{fmtInt(shown.length)} ofert · {fmtInt(totalQty)} szt. łącznie</div>
      )}
    </div>
  );
}
