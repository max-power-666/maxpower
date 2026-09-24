"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

// Podgląd zamówień BuyBack zsynchronizowanych z Back Marketu (patrz
// app/api/tradein/orders-sync/route.ts). Na razie tylko odczyt — bez akcji na
// zamówieniach, czekamy na opis docelowego workflow przetwarzania.

type Order = {
  order_public_id: string;
  status: string;
  market: string | null;
  product_title: string | null;
  sku: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  original_price: number | null;
  original_price_currency: string | null;
  creation_date: string;
  modification_date: string;
};

const PAGE_SIZES = [10, 20, 50];

function fmtPrice(n: number | null, currency: string | null) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + (currency || "");
}

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function TradeInOrdersView({ session }: { session: Session }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [limit, setLimit] = useState(20);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    load();
    const channel = supabase
      .channel("tradein-orders-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "buyback_orders" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "buyback_orders_sync_meta" }, () => loadMeta())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  async function loadMeta() {
    const { data } = await supabase.from("buyback_orders_sync_meta").select("last_synced_at").eq("id", 1).maybeSingle();
    setLastSynced((data?.last_synced_at as string) ?? null);
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [{ data, error: err, count }, meta] = await Promise.all([
        supabase
          .from("buyback_orders")
          .select(
            "order_public_id, status, market, product_title, sku, customer_first_name, customer_last_name, original_price, original_price_currency, creation_date, modification_date",
            { count: "exact" }
          )
          .order("modification_date", { ascending: false })
          .limit(limit),
        supabase.from("buyback_orders_sync_meta").select("last_synced_at").eq("id", 1).maybeSingle(),
      ]);
      if (err) throw err;
      setOrders((data as Order[]) || []);
      setTotalCount(count ?? null);
      setLastSynced((meta.data?.last_synced_at as string) ?? null);
    } catch (e: any) {
      setError(`Nie udało się wczytać zamówień: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    setError("");
    try {
      const res = await fetch("/api/tradein/orders-sync", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Błąd synchronizacji.");
      await load();
    } catch (e: any) {
      setError(e.message || "Błąd synchronizacji.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <label className="text-xs text-inksoft">Pokaż</label>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="border border-line bg-white px-2 py-1.5 rounded text-sm font-semibold"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span className="text-xs text-inksoft">
            {totalCount !== null ? `z ${totalCount} zamówień łącznie` : ""}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={syncNow}
            disabled={syncing}
            className="bg-white border border-line px-4 py-2 rounded text-sm font-semibold disabled:opacity-50"
          >
            {syncing ? "Synchronizowanie…" : "Odśwież"}
          </button>
          <span className="text-xs text-inksoft lowercase">
            {lastSynced ? `ostatnia synchronizacja: ${fmtDateTime(lastSynced)}` : "brak jeszcze synchronizacji"}
          </span>
        </div>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Zamówienie</th>
              <th className="p-3">Status</th>
              <th className="p-3">Rynek</th>
              <th className="p-3">Produkt</th>
              <th className="p-3">Klient</th>
              <th className="p-3 text-right">Cena</th>
              <th className="p-3">Utworzono</th>
              <th className="p-3">Zmieniono</th>
            </tr>
          </thead>
          <tbody>
            {!loading && orders.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-inksoft text-sm">Brak zsynchronizowanych zamówień.</td></tr>
            )}
            {orders.map((o) => (
              <tr key={o.order_public_id} className="border-b border-line last:border-b-0 hover:bg-paper">
                <td className="p-3 font-mono font-semibold whitespace-nowrap">{o.order_public_id}</td>
                <td className="p-3">
                  <span className="text-xs font-semibold px-2 py-1 rounded-full bg-tealsoft text-teal">{o.status}</span>
                </td>
                <td className="p-3">{o.market || "—"}</td>
                <td className="p-3">
                  <div className="font-semibold">{o.product_title || "—"}</div>
                  {o.sku && <div className="text-xs text-inksoft font-mono">{o.sku}</div>}
                </td>
                <td className="p-3">{[o.customer_first_name, o.customer_last_name].filter(Boolean).join(" ") || "—"}</td>
                <td className="p-3 text-right font-mono">{fmtPrice(o.original_price, o.original_price_currency)}</td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(o.creation_date)}</td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(o.modification_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
