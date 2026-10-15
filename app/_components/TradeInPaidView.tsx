"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { computeTradeInCosts, TRADEIN_CATEGORY_LABELS } from "@/lib/buybackCosts";
import { TRADEIN_PAID_STATUSES } from "@/lib/stockCosts";
import { monthKeyOf } from "@/lib/points";
import { fmtWarsawDateTime } from "@/lib/warsawDate";

// Trade-in -> BB_DW (14.10.2026, na prośbę właściciela): lista OPŁACONYCH zamówień Buyback (VALIDATED / PAID / MONEY_TRANSFERED) do dokumentów
// wewnętrznych — numer zamówienia, data płatności, numer seryjny przypisany przez pracownika (Wprowadzanie), cena zakupu (po kontrofercie, jeśli była),
// koszty (prowizja BM 10% + opłata logistyczna wg regulaminu, lib/buybackCosts.ts) i suma = cena + koszty. Kwoty w walucie zamówienia (praktycznie EUR).
// PCC celowo NIE wchodzi do kosztów (właściciel wymienił tylko prowizję i logistykę). Całą listę (kilka tysięcy lekkich wierszy) wczytujemy raz i
// filtrujemy w przeglądarce, więc sumy zawsze zgadzają się z tym, co widać.

type Order = {
  order_public_id: string;
  status: string;
  market: string | null;
  payment_date: string | null;
  creation_date: string;
  sku: string | null;
  product_title: string | null;
  original_price: number | null;
  original_price_currency: string | null;
  counter_offer_price: number | null;
};

type Row = {
  id: string;
  at: string; // data płatności (a gdy BM jej nie podał — data utworzenia zamówienia)
  atIsFallback: boolean;
  month: string | null;
  serial: string;
  price: number | null;
  currency: string;
  commission: number | null;
  logistics: number | null;
  category: string | null;
  costs: number | null; // prowizja + logistyka (null, gdy nie da się policzyć logistyki)
  total: number | null;
  countered: boolean;
};

const PAGE_SIZES = [50, 100, 200];
const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number | null, cur?: string) =>
  n === null ? "—" : n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (cur ? ` ${cur}` : "");
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("pl-PL", { month: "long", year: "numeric" });
};
const pageBtn = "px-3 py-1.5 rounded border border-line text-sm bg-white disabled:opacity-40";

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    // chwilowe "statement timeout" (obciążona baza) nie przerywa całej listy — każdą stronę próbujemy do 3 razy z krótką przerwą
    let res = await build(from, from + 999);
    for (let attempt = 1; res.error && attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      res = await build(from, from + 999);
    }
    const { data, error } = res;
    if (error) throw new Error(error.message);
    const chunk = (data as T[]) || [];
    out.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return out;
}

export default function TradeInPaidView({ onOpenOrder }: { onOpenOrder: (id: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [month, setMonth] = useState("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);
  const [page, setPage] = useState(1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const orders = await fetchAll<Order>((a, b) =>
          supabase
            .from("buyback_orders")
            .select("order_public_id, status, market, payment_date, creation_date, sku, product_title, original_price, original_price_currency, counter_offer_price")
            .in("status", TRADEIN_PAID_STATUSES)
            .order("order_public_id")
            .range(a, b)
        );
        // numer seryjny wpisany przez pracownika w Trade-in -> Wprowadzanie (jeden wpis na zamówienie)
        const intake = await fetchAll<{ order_public_id: string; serial_number: string | null }>((a, b) =>
          supabase.from("buyback_order_intake").select("order_public_id, serial_number").not("serial_number", "is", null).order("id").range(a, b)
        );
        const serialBy = new Map(intake.map((i) => [i.order_public_id, (i.serial_number || "").trim()]));
        const built: Row[] = orders.map((o) => {
          const at = o.payment_date || o.creation_date;
          const c = computeTradeInCosts({
            originalPrice: o.original_price,
            counterOfferPrice: o.counter_offer_price,
            currency: o.original_price_currency,
            title: o.product_title,
            sku: o.sku,
          });
          const price = c ? c.base : null;
          const costs = c && c.logistics !== null ? r2(c.commission + c.logistics) : null;
          return {
            id: o.order_public_id,
            at,
            atIsFallback: !o.payment_date,
            month: monthKeyOf(at),
            serial: serialBy.get(o.order_public_id) || "",
            price,
            currency: (o.original_price_currency || "EUR").toUpperCase(),
            commission: c ? c.commission : null,
            logistics: c ? c.logistics : null,
            category: c?.category ? TRADEIN_CATEGORY_LABELS[c.category] : null,
            costs,
            total: price !== null && costs !== null ? r2(price + costs) : null,
            countered: o.counter_offer_price !== null && o.counter_offer_price !== undefined,
          };
        });
        built.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        if (!cancelled) setRows(built);
      } catch (e: any) {
        if (!cancelled) setError(`Nie udało się wczytać zamówień: ${e.message || e}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const months = useMemo(() => Array.from(new Set(rows.map((r) => r.month).filter(Boolean) as string[])).sort().reverse(), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => (month === "all" || r.month === month) && (!q || r.id.toLowerCase().includes(q) || r.serial.toLowerCase().includes(q)));
  }, [rows, month, search]);

  useEffect(() => setPage(1), [month, search, limit]);

  // Sumy całego wyniku filtra, osobno dla każdej waluty (zwykle tylko EUR).
  const totals = useMemo(() => {
    const byCur = new Map<string, { n: number; price: number; costs: number; total: number }>();
    let incomplete = 0;
    let noSerial = 0;
    for (const r of filtered) {
      if (!r.serial) noSerial++;
      if (r.total === null || r.price === null || r.costs === null) {
        incomplete++;
        continue;
      }
      const t = byCur.get(r.currency) || { n: 0, price: 0, costs: 0, total: 0 };
      t.n++;
      t.price = r2(t.price + r.price);
      t.costs = r2(t.costs + r.costs);
      t.total = r2(t.total + r.total);
      byCur.set(r.currency, t);
    }
    return { byCur: Array.from(byCur.entries()), incomplete, noSerial };
  }, [filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / limit));
  const pageRows = filtered.slice((page - 1) * limit, page * limit);

  function exportCsv() {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const num = (n: number | null) => (n === null ? "" : String(n).replace(".", ","));
    const head = ["Numer zamówienia", "Data płatności", "Numer seryjny", "Cena zakupu", "Waluta", "Prowizja 10%", "Logistyka", "Koszty", "Suma"];
    const lines = filtered.map((r) =>
      [r.id, fmtWarsawDateTime(Date.parse(r.at)).slice(0, 10), r.serial, num(r.price), r.currency, num(r.commission), num(r.logistics), num(r.costs), num(r.total)].map(q).join(";")
    );
    const csv = "﻿" + [head.map(q).join(";"), ...lines].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `bb-dw-${month === "all" ? "wszystkie" : month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const th = "p-3 text-left text-xs font-semibold text-inksoft whitespace-nowrap";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select value={month} onChange={(e) => setMonth(e.target.value)} className="border border-line rounded px-2 py-1.5 text-sm bg-white">
          <option value="all">Wszystkie miesiące (płatność)</option>
          {months.map((m) => (
            <option key={m} value={m}>{monthLabel(m)}</option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Szukaj: numer zamówienia lub numer seryjny"
          className="border border-line rounded px-3 py-1.5 text-sm bg-white w-72 max-w-full"
        />
        <label className="text-xs text-inksoft flex items-center gap-1">
          Pokaż
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="border border-line rounded px-2 py-1 text-sm bg-white">
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <button onClick={exportCsv} disabled={!filtered.length} className="border border-line rounded px-3 py-1.5 text-sm bg-white font-semibold disabled:opacity-40 ml-auto">
          Pobierz CSV
        </button>
      </div>

      {error && <div className="mb-3 p-3 rounded bg-rustsoft text-rust text-sm">{error}</div>}

      <div className="bg-white border border-line rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-paper">
            <tr>
              <th className={th}>Numer zamówienia</th>
              <th className={th}>Data płatności</th>
              <th className={th}>Numer seryjny</th>
              <th className={`${th} text-right`}>Cena zakupu</th>
              <th className={`${th} text-right`}>Koszty (prowizja 10% + logistyka)</th>
              <th className={`${th} text-right`}>Suma</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="p-6 text-center text-inksoft">Wczytywanie…</td></tr>
            )}
            {!loading && pageRows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-inksoft">{rows.length ? "Brak wyników." : "Brak opłaconych zamówień."}</td></tr>
            )}
            {pageRows.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="p-3 whitespace-nowrap">
                  <button onClick={() => onOpenOrder(r.id)} className="font-mono text-xs underline decoration-dotted hover:text-teal">{r.id}</button>
                </td>
                <td className="p-3 text-xs whitespace-nowrap" title={r.atIsFallback ? "Back Market nie podał daty płatności — pokazana data utworzenia zamówienia" : undefined}>
                  {fmtWarsawDateTime(Date.parse(r.at)).slice(0, 10)}
                  {r.atIsFallback && <span className="text-amber"> *</span>}
                </td>
                <td className="p-3 font-mono text-xs whitespace-nowrap">{r.serial || <span className="text-inksoft">—</span>}</td>
                <td className="p-3 text-right font-mono whitespace-nowrap">
                  {money(r.price, r.currency)}
                  {r.countered && <div className="text-[10px] text-inksoft font-sans">po kontrofercie</div>}
                </td>
                <td className="p-3 text-right font-mono whitespace-nowrap" title={r.category ? `Kategoria: ${r.category}` : "Nie rozpoznano kategorii produktu albo waluta inna niż EUR — logistyki nie liczymy"}>
                  {money(r.costs, r.currency)}
                  {r.commission !== null && (
                    <div className="text-[10px] text-inksoft font-sans">
                      {money(r.commission)} + {r.logistics !== null ? money(r.logistics) : "brak logistyki"}
                    </div>
                  )}
                </td>
                <td className="p-3 text-right font-mono font-semibold whitespace-nowrap">{money(r.total, r.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!loading && (
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm bg-white border border-line rounded-lg p-3">
          <span><span className="text-inksoft text-xs">Zamówień:</span> <b>{filtered.length}</b></span>
          {totals.byCur.map(([cur, t]) => (
            <span key={cur} className="flex flex-wrap items-center gap-x-4">
              <span><span className="text-inksoft text-xs">Cena zakupu:</span> <b className="font-mono">{money(t.price, cur)}</b></span>
              <span><span className="text-inksoft text-xs">Koszty:</span> <b className="font-mono">{money(t.costs, cur)}</b></span>
              <span><span className="text-inksoft text-xs">Suma:</span> <b className="font-mono">{money(t.total, cur)}</b></span>
            </span>
          ))}
          {totals.incomplete > 0 && (
            <span className="text-xs text-amber">{totals.incomplete} bez policzonych kosztów (nieznana kategoria / waluta) — poza sumami</span>
          )}
          {totals.noSerial > 0 && <span className="text-xs text-inksoft">{totals.noSerial} bez numeru seryjnego</span>}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 text-sm">
        <button className={pageBtn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Poprzednia</button>
        <span className="text-inksoft text-xs">strona {page} z {totalPages}</span>
        <button className={pageBtn} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Następna</button>
      </div>

      <p className="text-[11px] text-inksoft mt-3 max-w-3xl">
        Tylko zamówienia opłacone (Zwalidowane / Opłacone / Wypłacone). Cena zakupu to cena po kontrofercie, a gdy jej nie było — cena początkowa. Koszty to prowizja Back Market
        10% ceny + opłata logistyczna Trade-in wg regulaminu i kategorii produktu (szacunek z regulaminu, nie faktura BM); PCC nie jest wliczone. Numer seryjny pochodzi z wpisu
        pracownika w Trade-in → Wprowadzanie. „*” przy dacie = Back Market nie podał daty płatności, pokazana jest data utworzenia zamówienia.
      </p>
    </div>
  );
}
