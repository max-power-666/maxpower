"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

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
};

const PAGE_SIZES = [25, 50, 100];

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtPLN(n: number) {
  return Number(n).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " zł";
}
// % i \ wycinamy, _ zamieniamy na literalne — w LIKE to znaki specjalne.
function escapeLike(v: string) {
  return v.replace(/[\\%]/g, "").replace(/_/g, "\\_");
}

// reloadKey rośnie po ręcznym "Odśwież" w nagłówku Magazynu — wymusza ponowne wczytanie listy.
export default function InventoryRawView({ reloadKey = 0 }: { reloadKey?: number }) {
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      const from = (page - 1) * pageSize;
      let q = supabase
        .from("fakturownia_stock_cache")
        .select("id, name, category_name, description, purchase_price_gross, product_created_at", { count: "exact" });
      if (search) q = q.ilike("name", `%${escapeLike(search)}%`);
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
  }, [page, pageSize, search, reloadTick, reloadKey]);

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
            {total.toLocaleString("pl-PL")} {search ? "wyników" : "produktów"} · strona {Math.min(page, totalPages)} z {totalPages}
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
              <th className="p-3">Kategoria</th>
              <th className="p-3">Zamówienie</th>
              <th className="p-3 text-right">Cena zakupu brutto</th>
              <th className="p-3">Dodano</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-inksoft text-sm">
                  {search ? "Nic nie znaleziono dla tego numeru." : "Brak produktów — kliknij „Odśwież”, żeby pobrać dane z Fakturowni."}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-paper">
                <td className="p-3 font-mono font-semibold">{r.name || "—"}</td>
                <td className="p-3">{r.category_name}</td>
                <td className="p-3 font-mono text-xs">{r.description || "—"}</td>
                <td className="p-3 text-right font-mono">{fmtPLN(r.purchase_price_gross)}</td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDate(r.product_created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
