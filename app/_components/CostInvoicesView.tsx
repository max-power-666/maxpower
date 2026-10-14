"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

// Finanse -> Faktury kosztowe (14.10.2026): lista faktur kosztowych (wydatków) pobranych z Fakturowni, także z KSeF (app/api/costs/sync, supabase/cost-invoices.sql).
// Całą listę (kilkaset do kilku tysięcy lekkich wierszy) wczytujemy raz i filtrujemy w przeglądarce, więc sumy zawsze zgadzają się z widokiem.

type Row = {
  fakturownia_id: number;
  number: string | null;
  kind: string | null;
  issue_date: string | null;
  sell_date: string | null;
  payment_to: string | null;
  paid_date: string | null;
  paid: boolean;
  status: string | null;
  supplier_name: string | null;
  supplier_tax_no: string | null;
  price_net: number | null;
  price_tax: number | null;
  price_gross: number | null;
  currency: string | null;
  accounting_kind: string | null;
  ksef_number: string | null;
  from_ksef: boolean;
  description: string | null;
  url: string | null;
};

const COLS =
  "fakturownia_id, number, kind, issue_date, sell_date, payment_to, paid_date, paid, status, supplier_name, supplier_tax_no, price_net, price_tax, price_gross, currency, accounting_kind, ksef_number, from_ksef, description, url";
const PAGE_SIZES = [50, 100, 200];
const selectCls = "border border-line bg-white px-3 py-2 rounded text-sm";
const fmt = (n: number | null) => (n === null || n === undefined ? "—" : n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtDate = (d: string | null) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "—");
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("pl-PL", { month: "long", year: "numeric" });
};
const ACCOUNTING_KIND: Record<string, string> = {
  purchases: "Zakup towarów",
  expenses: "Koszty",
  media: "Media",
  salary: "Wynagrodzenia",
  fixed_assets: "Środki trwałe",
  no_vat_deduction: "Bez odliczenia VAT",
};

export default function CostInvoicesView({ session }: { session: Session }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [month, setMonth] = useState("all");
  const [search, setSearch] = useState("");
  const [payment, setPayment] = useState<"all" | "unpaid" | "paid">("all");
  const [source, setSource] = useState<"all" | "ksef" | "other">("all");
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const out: Row[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: err } = await supabase.from("cost_invoices").select(COLS).order("issue_date", { ascending: false }).order("fakturownia_id", { ascending: false }).range(from, from + 999);
        if (err) throw new Error(err.code === "42P01" || err.code === "PGRST205" ? "Brak tabeli faktur kosztowych — uruchom supabase/cost-invoices.sql w Supabase." : err.message);
        out.push(...((data as Row[]) || []));
        if (!data || data.length < 1000) break;
      }
      setRows(out);
      const { data: meta } = await supabase.from("cost_invoices_sync_meta").select("last_synced_at, last_error").eq("id", 1).maybeSingle();
      setLastSynced((meta?.last_synced_at as string) ?? null);
      setLastError((meta?.last_error as string) ?? null);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function syncNow() {
    setSyncing(true);
    setError("");
    setNote("");
    try {
      const res = await fetch("/api/costs/sync", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Błąd pobierania z Fakturowni.");
      setNote(`Pobrano ${data.fetched} dokumentów od ${data.from}, zapisano ${data.saved} (z KSeF: ${data.ksef}).`);
      await load();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setSyncing(false);
    }
  }

  const months = useMemo(() => Array.from(new Set(rows.map((r) => (r.issue_date || "").slice(0, 7)).filter(Boolean))).sort().reverse(), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (month !== "all" && (r.issue_date || "").slice(0, 7) !== month) return false;
      if (payment === "paid" && !r.paid) return false;
      if (payment === "unpaid" && r.paid) return false;
      if (source === "ksef" && !r.from_ksef) return false;
      if (source === "other" && r.from_ksef) return false;
      if (q) {
        const hay = `${r.number ?? ""} ${r.supplier_name ?? ""} ${r.supplier_tax_no ?? ""} ${r.ksef_number ?? ""} ${r.description ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, month, search, payment, source]);

  useEffect(() => setPage(1), [month, search, payment, source, pageSize]);

  const totals = useMemo(() => {
    const m = new Map<string, { n: number; net: number; tax: number; gross: number; unpaid: number }>();
    for (const r of filtered) {
      const c = r.currency || "PLN";
      const t = m.get(c) || { n: 0, net: 0, tax: 0, gross: 0, unpaid: 0 };
      t.n += 1;
      t.net += r.price_net ?? 0;
      t.tax += r.price_tax ?? 0;
      t.gross += r.price_gross ?? 0;
      if (!r.paid) t.unpaid += r.price_gross ?? 0;
      m.set(c, t);
    }
    return Array.from(m.entries());
  }, [filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
  const ksefCount = useMemo(() => rows.filter((r) => r.from_ksef).length, [rows]);

  function exportCsv() {
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const num = (n: number | null) => (n === null ? "" : String(n).replace(".", ","));
    const head = ["Numer", "Sprzedawca", "NIP", "Data wystawienia", "Data sprzedaży", "Termin płatności", "Netto", "VAT", "Brutto", "Waluta", "Opłacona", "Data płatności", "Numer KSeF", "Rodzaj wydatku", "Fakturownia (id)"];
    const lines = filtered.map((r) =>
      [r.number, r.supplier_name, r.supplier_tax_no, r.issue_date, r.sell_date, r.payment_to, num(r.price_net), num(r.price_tax), num(r.price_gross), r.currency, r.paid ? "tak" : "nie", r.paid_date, r.ksef_number, ACCOUNTING_KIND[r.accounting_kind || ""] || r.accounting_kind || "", r.fakturownia_id].map(q).join(";")
    );
    const csv = "﻿" + [head.map(q).join(";"), ...lines].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `faktury-kosztowe-${month === "all" ? "wszystkie" : month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const th = "p-2 text-left text-xs font-semibold text-inksoft whitespace-nowrap";
  const anyFilter = !!(search || month !== "all" || payment !== "all" || source !== "all");

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select value={month} onChange={(e) => setMonth(e.target.value)} className={selectCls}>
          <option value="all">Wszystkie miesiące (data wystawienia)</option>
          {months.map((m) => (
            <option key={m} value={m}>{monthLabel(m)}</option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Szukaj: numer, sprzedawca, NIP, numer KSeF"
          className="border border-line bg-white px-3 py-2 rounded text-sm w-80 max-w-full"
        />
        <select value={payment} onChange={(e) => setPayment(e.target.value as "all" | "unpaid" | "paid")} className={selectCls}>
          <option value="all">Płatność: wszystkie</option>
          <option value="unpaid">Do zapłaty</option>
          <option value="paid">Opłacone</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value as "all" | "ksef" | "other")} className={selectCls}>
          <option value="all">Źródło: wszystkie</option>
          <option value="ksef">KSeF ({ksefCount})</option>
          <option value="other">Pozostałe</option>
        </select>
        {anyFilter && (
          <button onClick={() => { setSearch(""); setMonth("all"); setPayment("all"); setSource("all"); }} className="text-xs font-semibold text-teal hover:underline">
            Wyczyść filtry
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={exportCsv} disabled={!filtered.length} className="border border-line bg-white px-3 py-2 rounded text-sm font-semibold disabled:opacity-40">Pobierz CSV</button>
          <button onClick={syncNow} disabled={syncing} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">
            {syncing ? "Pobieranie…" : "Odśwież z Fakturowni"}
          </button>
        </div>
      </div>

      <div className="text-xs text-inksoft mb-3">
        {lastSynced ? `Ostatnie pobranie z Fakturowni: ${new Date(lastSynced).toLocaleString("pl-PL")}` : "Jeszcze nie pobierano z Fakturowni — kliknij „Odśwież z Fakturowni”."}
        {lastError && <span className="text-rust"> · ostatni błąd: {lastError}</span>}
      </div>
      {error && <div className="mb-3 p-3 rounded bg-rustsoft text-rust text-sm">{error}</div>}
      {note && <div className="mb-3 text-xs text-teal">{note}</div>}

      <div className="flex items-center gap-2 mb-3 text-sm">
        <label className="text-xs text-inksoft">Pokaż</label>
        <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="border border-line bg-white px-2 py-1.5 rounded text-sm font-semibold">
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="text-xs text-inksoft">z {filtered.length} faktur · strona {Math.min(page, totalPages)} z {totalPages}</span>
        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-40">‹ Poprzednia</button>
        <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-40">Następna ›</button>
      </div>

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line">
              <th className={th}>Numer</th>
              <th className={th}>Sprzedawca</th>
              <th className={th}>Data wystawienia</th>
              <th className={th}>Termin płatności</th>
              <th className={`${th} text-right`}>Netto</th>
              <th className={`${th} text-right`}>VAT</th>
              <th className={`${th} text-right`}>Brutto</th>
              <th className={th}>Waluta</th>
              <th className={th}>Płatność</th>
              <th className={th}>Źródło</th>
              <th className={th}>Rodzaj</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={11} className="p-6 text-center text-inksoft text-sm">Wczytywanie…</td></tr>}
            {!loading && pageRows.length === 0 && (
              <tr><td colSpan={11} className="p-6 text-center text-inksoft text-sm">{rows.length ? "Nic nie pasuje do filtrów." : "Brak faktur kosztowych — kliknij „Odśwież z Fakturowni”."}</td></tr>
            )}
            {pageRows.map((r) => (
              <tr key={r.fakturownia_id} className="border-b border-line last:border-b-0 hover:bg-paper align-top">
                <td className="p-2 whitespace-nowrap font-mono">
                  {r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="text-teal hover:underline">{r.number || r.fakturownia_id}</a> : r.number || r.fakturownia_id}
                </td>
                <td className="p-2 min-w-[14rem]">
                  <div className="font-semibold">{r.supplier_name || "—"}</div>
                  {r.supplier_tax_no && <div className="text-[11px] text-inksoft font-mono">NIP {r.supplier_tax_no}</div>}
                </td>
                <td className="p-2 whitespace-nowrap">{fmtDate(r.issue_date)}</td>
                <td className="p-2 whitespace-nowrap">{fmtDate(r.payment_to)}</td>
                <td className="p-2 whitespace-nowrap text-right font-mono">{fmt(r.price_net)}</td>
                <td className="p-2 whitespace-nowrap text-right font-mono">{fmt(r.price_tax)}</td>
                <td className="p-2 whitespace-nowrap text-right font-mono font-semibold">{fmt(r.price_gross)}</td>
                <td className="p-2 whitespace-nowrap">{r.currency || "—"}</td>
                <td className="p-2 whitespace-nowrap">
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${r.paid ? "bg-tealsoft text-teal" : "bg-ambersoft text-amber"}`} title={r.paid_date ? `opłacona ${fmtDate(r.paid_date)}` : undefined}>
                    {r.paid ? "Opłacona" : "Do zapłaty"}
                  </span>
                </td>
                <td className="p-2 whitespace-nowrap">
                  {r.from_ksef ? (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-tealsoft text-teal" title={r.ksef_number ?? undefined}>KSeF</span>
                  ) : (
                    <span className="text-inksoft" title={r.ksef_number ? `numer: ${r.ksef_number}` : undefined}>{r.ksef_number ? "numer KSeF?" : "—"}</span>
                  )}
                </td>
                <td className="p-2 whitespace-nowrap">{ACCOUNTING_KIND[r.accounting_kind || ""] || r.accounting_kind || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!loading && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm border border-line bg-white px-4 py-3">
          <span className="font-semibold text-inksoft text-xs self-center">PODSUMOWANIE WYNIKU</span>
          <span>Faktur: <span className="font-semibold">{filtered.length}</span></span>
          {totals.map(([cur, t]) => (
            <span key={cur} className="flex flex-wrap gap-x-4">
              <span>Netto: <span className="font-semibold font-mono">{fmt(t.net)} {cur}</span></span>
              <span>VAT: <span className="font-semibold font-mono">{fmt(t.tax)} {cur}</span></span>
              <span>Brutto: <span className="font-semibold font-mono">{fmt(t.gross)} {cur}</span></span>
              {t.unpaid > 0 && <span>Do zapłaty: <span className="font-semibold font-mono text-amber">{fmt(t.unpaid)} {cur}</span></span>}
            </span>
          ))}
        </div>
      )}
      <p className="text-[11px] text-inksoft mt-2 max-w-3xl">
        Faktury kosztowe (wydatki) z Fakturowni, w tym pobrane tam automatycznie z KSeF; odświeżane co 3 godziny albo przyciskiem. „Opłacona” wg statusu płatności w Fakturowni.
        Kwoty w walucie dokumentu (bez przeliczenia na PLN).
      </p>
    </div>
  );
}
