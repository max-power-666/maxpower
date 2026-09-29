"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

// Podgląd zamówień BuyBack zsynchronizowanych z Back Marketu (patrz
// app/api/tradein/orders-sync/route.ts). Na razie tylko odczyt — bez akcji na
// zamówieniach, czekamy na opis docelowego workflow przetwarzania.

type Order = {
  order_public_id: string;
  creation_date: string;
  payment_date: string | null;
  status: string;
  market: string | null;
  sku: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  original_price: number | null;
  original_price_currency: string | null;
  counter_offer_price: number | null;
};

const PAGE_SIZES = [10, 20, 50];

function fmtNumber(n: number | null) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/* ---------------- podsumowanie: zamówienia dziś i wczoraj (wg rynku) ---------------- */

type MarketDayCount = { total: number; byMarket: Record<string, number> };

const startOfYesterdayIso = (now: Date = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();

// Liczy zamówienia z dzisiejszej i wczorajszej doby (czas lokalny) wg daty utworzenia, z podziałem na rynek.
function summarizeMarketDays(
  rows: { market: string | null; creation_date: string }[],
  now: Date = new Date()
): { today: MarketDayCount; yesterday: MarketDayCount } {
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const out = { today: { total: 0, byMarket: {} as Record<string, number> }, yesterday: { total: 0, byMarket: {} as Record<string, number> } };
  for (const r of rows) {
    const t = Date.parse(r.creation_date);
    const bucket = t >= startToday ? out.today : t >= startYesterday ? out.yesterday : null;
    if (!bucket || t >= startToday + 24 * 3600 * 1000 + 3600 * 1000) continue; // przyszłe daty (błędne dane) pomijamy
    bucket.total += 1;
    const key = r.market || "—";
    bucket.byMarket[key] = (bucket.byMarket[key] ?? 0) + 1;
  }
  return out;
}

function TradeInDaySummary() {
  const [days, setDays] = useState<{ today: MarketDayCount; yesterday: MarketDayCount } | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    load();
    // Synchronizacja zmienia setki wierszy naraz — odświeżamy z opóźnieniem, jednym zapytaniem.
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 3000);
    };
    const channel = supabase
      .channel("tradein-day-summary")
      .on("postgres_changes", { event: "*", schema: "public", table: "buyback_orders" }, schedule)
      .subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, []);

  async function load() {
    try {
      const since = startOfYesterdayIso();
      const rows: { market: string | null; creation_date: string }[] = [];
      // PostgREST oddaje max 1000 wierszy na zapytanie — czytamy stronami.
      for (let from = 0; ; from += 1000) {
        const { data, error: err } = await supabase
          .from("buyback_orders")
          .select("market, creation_date")
          .gte("creation_date", since)
          .order("creation_date", { ascending: false })
          .range(from, from + 999);
        if (err) throw new Error(err.message);
        rows.push(...((data as typeof rows) || []));
        if (!data || data.length < 1000) break;
      }
      setDays(summarizeMarketDays(rows));
      setError("");
    } catch (e: any) {
      setError(`Nie udało się policzyć zamówień: ${e.message || e}`);
    }
  }

  const tile = (label: string, d: MarketDayCount | undefined) => (
    <div className="border border-line bg-white px-4 py-3 min-w-[13rem]">
      <div className="text-xs font-semibold text-inksoft">{label}</div>
      <div className="text-3xl font-semibold font-mono">{d ? d.total : "—"}</div>
      <div className="flex flex-wrap gap-1 mt-1 min-h-[1.5rem]">
        {d &&
          Object.entries(d.byMarket)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([market, n]) => (
              <span key={market} className="text-xs font-semibold px-2 py-0.5 rounded-full bg-paper text-inksoft border border-line">
                {market} {n}
              </span>
            ))}
      </div>
    </div>
  );

  return (
    <div className="mb-5">
      <div className="flex flex-wrap gap-3">
        {tile("Zamówienia dzisiaj", days?.today)}
        {tile("Zamówienia wczoraj", days?.yesterday)}
      </div>
      {error && <p className="text-rust text-xs mt-2">{error}</p>}
    </div>
  );
}

export default function TradeInOrdersView({ session, onOpenOrder }: { session: Session; onOpenOrder?: (id: string) => void }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [limit, setLimit] = useState(20);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

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
  }, [limit, page]);

  async function loadMeta() {
    const { data } = await supabase.from("buyback_orders_sync_meta").select("last_synced_at").eq("id", 1).maybeSingle();
    setLastSynced((data?.last_synced_at as string) ?? null);
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      const from = (page - 1) * limit;
      const [{ data, error: err, count }, meta] = await Promise.all([
        supabase
          .from("buyback_orders")
          .select(
            "order_public_id, creation_date, payment_date, status, market, sku, customer_first_name, customer_last_name, original_price, original_price_currency, counter_offer_price",
            { count: "exact" }
          )
          .order("creation_date", { ascending: false })
          .range(from, from + limit - 1),
        supabase.from("buyback_orders_sync_meta").select("last_synced_at").eq("id", 1).maybeSingle(),
      ]);
      if (err) {
        // strona poza zakresem (np. po synchronizacji ubyło wierszy) — wróć na początek
        if (err.code === "PGRST103" && page > 1) {
          setPage(1);
          return;
        }
        throw err;
      }
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
    setNote("");
    try {
      const res = await fetch("/api/tradein/orders-sync", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Błąd synchronizacji.");
      // Pełny skan historii idzie w porcjach — niedokończony nie jest błędem, ale trzeba to powiedzieć.
      if (data.finished === false) {
        setNote(
          `Pobrano kolejną porcję (${data.processed} zamówień, ${data.mode === "full" ? "pełny skan historii" : "synchronizacja"} w toku` +
            (data.apiCount ? `, Back Market zgłasza ${data.apiCount} łącznie` : "") +
            `). Reszta dociągnie się automatycznie co 15 minut — możesz też kliknąć Odśwież ponownie.`
        );
      }
      await load();
    } catch (e: any) {
      setError(e.message || "Błąd synchronizacji.");
    } finally {
      setSyncing(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil((totalCount ?? 0) / limit));

  return (
    <div>
      <TradeInDaySummary />

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <label className="text-xs text-inksoft">Pokaż</label>
          <select
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              setPage(1);
            }}
            className="border border-line bg-white px-2 py-1.5 rounded text-sm font-semibold"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span className="text-xs text-inksoft">
            {totalCount !== null ? `z ${totalCount} zamówień łącznie · strona ${Math.min(page, totalPages)} z ${totalPages}` : ""}
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
      {note && <p className="text-inksoft text-xs mb-3">{note}</p>}

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Zamówienie</th>
              <th className="p-3">Utworzono</th>
              <th className="p-3">Data płatności</th>
              <th className="p-3">Status</th>
              <th className="p-3">Rynek</th>
              <th className="p-3">SKU</th>
              <th className="p-3">Imię</th>
              <th className="p-3">Nazwisko</th>
              <th className="p-3 text-right">Cena pocz.</th>
              <th className="p-3">Waluta</th>
              <th className="p-3 text-right">Kontroferta</th>
            </tr>
          </thead>
          <tbody>
            {!loading && orders.length === 0 && (
              <tr><td colSpan={11} className="p-6 text-center text-inksoft text-sm">Brak zsynchronizowanych zamówień.</td></tr>
            )}
            {orders.map((o) => (
              <tr key={o.order_public_id} className="border-b border-line last:border-b-0 hover:bg-paper">
                <td className="p-3 font-mono font-semibold whitespace-nowrap">
                  {onOpenOrder ? (
                    <button onClick={() => onOpenOrder(o.order_public_id)} className="text-teal hover:underline">{o.order_public_id}</button>
                  ) : (
                    o.order_public_id
                  )}
                </td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(o.creation_date)}</td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(o.payment_date)}</td>
                <td className="p-3">
                  <span className="text-xs font-semibold px-2 py-1 rounded-full bg-tealsoft text-teal">{o.status}</span>
                </td>
                <td className="p-3">{o.market || "—"}</td>
                <td className="p-3 font-mono">{o.sku || "—"}</td>
                <td className="p-3">{o.customer_first_name || "—"}</td>
                <td className="p-3">{o.customer_last_name || "—"}</td>
                <td className="p-3 text-right font-mono">{fmtNumber(o.original_price)}</td>
                <td className="p-3">{o.original_price_currency || "—"}</td>
                <td className="p-3 text-right font-mono">{fmtNumber(o.counter_offer_price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
