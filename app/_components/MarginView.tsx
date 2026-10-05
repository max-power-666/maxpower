"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { MARKETPLACES } from "@/lib/salesOrders";
import type { MemberLite } from "@/lib/displayName";
import SalesOrderCard from "./SalesOrderCard";
import type { BmRates, MarginResult } from "@/lib/margin";

// Zakładka Marża (03.10.2026, Admin i Manager): lista sprzedanych sztuk z numerem seryjnym i marżą po kosztach. Układ jak lista Zamówień,
// ale kolumny finansowe. Całość liczy serwer (app/api/margin/list, lib/margin.ts); tu tylko wyświetlamy, filtrujemy i wgrywamy faktury BM.

type Totals = { count: number; withMargin: number; sale: number; purchase: number; vat: number; shipping: number; extra: number; commission: number; netMargin: number; margin: number; incomplete: number };
const PAGE_SIZES = [25, 50, 100];
// Filtr okresu: miesiące kalendarzowe wg czasu polskiego (granice liczy serwer); w podpowiedzi nazwy miesięcy.
const monthName = (offset: number) => {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return d.toLocaleDateString("pl-PL", { month: "long", year: "numeric" });
};
const PERIODS: { key: "all" | "current" | "previous"; label: string; hint: string }[] = [
  { key: "all", label: "Cały okres", hint: "Wszystkie sprzedane sztuki" },
  { key: "current", label: "Bieżący miesiąc", hint: monthName(0) },
  { key: "previous", label: "Ubiegły miesiąc", hint: monthName(-1) },
];
const FILTERS = [
  { key: "", label: "Wszystkie" },
  { key: "backmarket", label: "Back Market" },
  { key: "refurbed", label: "Refurbed" },
  { key: "octopia", label: "Octopia" },
];

const fmtPLN = (n: number | null) => (n === null ? "—" : n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");
const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

export default function MarginView({ session, members }: { session: Session; members: MemberLite[] }) {
  const [rows, setRows] = useState<MarginResult[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [bmRates, setBmRates] = useState<BmRates | null>(null);
  const [invoiceCount, setInvoiceCount] = useState(0);
  const [purchasesCount, setPurchasesCount] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [marketplace, setMarketplace] = useState("");
  const [period, setPeriod] = useState<"all" | "current" | "previous">("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploadMsg, setUploadMsg] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // rozwinięte wiersze (szczegółowe wyliczenie marży)
  const [openOrder, setOpenOrder] = useState<{ marketplace: string; externalId: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const auth = { Authorization: `Bearer ${session.access_token}` };

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  async function load() {
    const mySeq = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize), search, marketplace, period });
      const res = await fetch(`/api/margin/list?${qs}`, { headers: auth });
      const data = await res.json().catch(() => ({}));
      if (mySeq !== seq.current) return;
      if (!res.ok) throw new Error(data?.error || `Błąd serwera (${res.status}).`);
      setRows(data.rows);
      setTotal(data.total);
      setTotals(data.totals);
      setBmRates(data.bmRates);
      setInvoiceCount(data.invoiceCount);
      setPurchasesCount(data.purchasesCount ?? null);
    } catch (e: any) {
      if (mySeq === seq.current) setError(e.message || "Nie udało się wczytać marży.");
    } finally {
      if (mySeq === seq.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, search, marketplace, period]);

  // Pełna synchronizacja z Fakturownią (ten sam route co "Odśwież" w Magazynie): zapisuje też produkty sprzedane (stan 0), od 01.01.2025 — to z nich
  // bierze się cena zakupu w tej zakładce. Pierwszy raz trwa ok. minuty (cały katalog).
  async function syncPurchases() {
    setSyncing(true);
    setSyncMsg("");
    try {
      const res = await fetch(`/api/fakturownia/sync${purchasesCount === 0 ? "?full=1" : ""}`, { headers: auth });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Błąd serwera (${res.status}).`);
      setSyncMsg(`Pobrano z Fakturowni: ${data.processed} produktów przeanalizowano, ${data.purchasesSaved} zapisano w historii zakupów${data.incremental ? " (zmiany od ostatniej synchronizacji)" : " (pełny skan)"}.`);
    } catch (e: any) {
      setSyncMsg(`Synchronizacja nie powiodła się: ${e.message || e}`);
    } finally {
      setSyncing(false);
      load();
    }
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadMsg("");
    const results: string[] = [];
    for (const f of Array.from(files)) {
      try {
        const csv = await f.text();
        const res = await fetch("/api/margin/bm-invoice", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ filename: f.name, csv }) });
        const data = await res.json().catch(() => ({}));
        results.push(res.ok ? `${data.invoiceRef}: ${data.lines} wierszy, ${data.orders} zamówień` : `${f.name}: ${data?.error || "błąd"}`);
      } catch (e: any) {
        results.push(`${f.name}: ${e.message || "błąd"}`);
      }
    }
    setUploadMsg(results.join(" · "));
    if (fileRef.current) fileRef.current.value = "";
    load();
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const marginCls = (n: number | null) => (n === null ? "" : n < 0 ? "text-rust" : "text-teal");

  return (
    <div>
      <div className="border border-line bg-white p-4 mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <div className="text-xs font-semibold text-inksoft mb-1">PROWIZJA BACK MARKET</div>
          {bmRates ? (
            <span>
              Z faktur: średnio <span className="font-mono font-semibold">{bmRates.paymentPct.toFixed(2).replace(".", ",")}%</span> opłaty płatniczej,{" "}
              <span className="font-mono font-semibold">{bmRates.ccbmFixedEur.toFixed(2).replace(".", ",")} €</span> CCBM za pozycję (akcesoria{" "}
              <span className="font-mono font-semibold">{bmRates.ccbmAccessoryEur.toFixed(2).replace(".", ",")} €</span>) · z {bmRates.orders} zamówień, {invoiceCount} {invoiceCount === 1 ? "faktury" : "faktur"}.
              Dla zamówień objętych fakturą liczone dokładnie z niej.
            </span>
          ) : (
            <span className="text-inksoft">Brak wgranych faktur — używam stawek z regulaminu (1% opłaty płatniczej, CCBM 6,99 €). Wgraj fakturę tygodniową (CSV), żeby liczyć dokładnie i z faktycznych średnich.</span>
          )}
          <div className="text-[11px] text-inksoft mt-1">
            Prowizja szacowana wg reguł (sprawdzone na zamówieniach z faktur): <span className="font-semibold">konsole do FR/DE/ES/IT — 6%</span> (program Accelerator, −5 pkt proc., 15.08–31.12.2026),
            konsole do pozostałych krajów 11%, akcesoria (pady) 20%, pozostałe produkty 11%. refurbed i Octopia — prowizja wprost z danych zamówienia. Średnie z ostatnich 8 tygodni faktur; wgrywaj kolejne co tydzień.
          </div>
        </div>
        <div className="shrink-0">
          <input ref={fileRef} type="file" accept=".csv,text/csv" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
          <button onClick={() => fileRef.current?.click()} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold">Wgraj fakturę BM (CSV)</button>
        </div>
      </div>
      {uploadMsg && <p className="text-xs text-teal font-semibold mb-3">{uploadMsg}</p>}

      <div className="border border-line bg-white p-4 mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <div className="text-xs font-semibold text-inksoft mb-1">CENY ZAKUPU (z Fakturowni, produkty od 01.01.2025, także sprzedane)</div>
          {purchasesCount === null ? (
            <span className="text-inksoft">Wczytywanie…</span>
          ) : purchasesCount === 0 ? (
            <span className="text-rust font-semibold">Brak historii zakupów w bazie — kolumna „Cena zakupu” jest pusta. Kliknij „Pobierz z Fakturowni” (pełna synchronizacja trwa około minuty).</span>
          ) : (
            <span>W bazie: <span className="font-mono font-semibold">{purchasesCount.toLocaleString("pl-PL")}</span> produktów z Fakturowni. Nowe zakupy dochodzą przy każdej synchronizacji magazynu.</span>
          )}
          {syncMsg && <div className={`text-xs mt-1 font-semibold ${syncMsg.startsWith("Synchronizacja nie") ? "text-rust" : "text-teal"}`}>{syncMsg}</div>}
        </div>
        <button onClick={syncPurchases} disabled={syncing} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50 shrink-0">
          {syncing ? "Pobieranie… (do kilku minut)" : "Pobierz z Fakturowni"}
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => { setMarketplace(f.key); setPage(1); }} className={pill(marketplace === f.key)}>{f.label}</button>
          ))}
          <span className="w-px h-6 bg-line mx-1" />
          {PERIODS.map((p) => (
            <button key={p.key} onClick={() => { setPeriod(p.key); setPage(1); }} className={pill(period === p.key)} title={p.hint}>{p.label}</button>
          ))}
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Szukaj: numer seryjny, zamówienie, SKU"
            className="w-72 border border-line bg-white px-3 py-2 rounded text-sm ml-2"
          />
          <label className="text-xs text-inksoft ml-2">Pokaż</label>
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} className="border border-line bg-white px-2 py-1.5 rounded text-sm font-semibold">
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-3 text-xs text-inksoft">
          <span>{total.toLocaleString("pl-PL")} pozycji · strona {Math.min(page, totalPages)} z {totalPages}</span>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold text-ink disabled:opacity-40">‹ Poprzednia</button>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold text-ink disabled:opacity-40">Następna ›</button>
        </div>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Data</th>
              <th className="p-3">Marketplace</th>
              <th className="p-3">Nr zamówienia</th>
              <th className="p-3">Numer seryjny</th>
              <th className="p-3">SKU</th>
              <th className="p-3 text-right">Cena sprzedaży</th>
              <th className="p-3 text-right">Cena zakupu</th>
              <th className="p-3 text-right">VAT od marży</th>
              <th className="p-3 text-right" title="Cena sprzedaży − cena zakupu − VAT od marży">Marża netto</th>
              <th className="p-3 text-right">Wysyłka</th>
              <th className="p-3 text-right">Koszty dodatkowe</th>
              <th className="p-3 text-right">Prowizja</th>
              <th className="p-3 text-right">Serwis</th>
              <th className="p-3 text-right">Marża</th>
              <th className="p-3 text-right">Marża %</th>
              <th className="p-3 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr><td colSpan={16} className="p-6 text-center text-inksoft text-sm">{search || marketplace || period !== "all" ? "Brak wyników." : "Brak sprzedanych sztuk z numerem seryjnym (Back Market, refurbed i Octopia)."}</td></tr>
            )}
            {rows.map((r) => {
              const rowKey = `${r.marketplace}:${r.orderId}:${r.itemKey}`;
              const open = expanded.has(rowKey);
              return (
              <Fragment key={rowKey}>
              <tr className={`border-b border-line last:border-b-0 hover:bg-paper ${open ? "bg-paper" : ""}`}>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDate(r.orderDate)}</td>
                <td className="p-3 text-xs">{MARKETPLACES.find((m) => m.key === r.marketplace)?.label ?? r.marketplace}</td>
                <td className="p-3 text-xs font-mono">
                  <button onClick={() => setOpenOrder({ marketplace: r.marketplace, externalId: r.orderId })} className="text-teal hover:underline">{r.orderId}</button>
                </td>
                <td className="p-3 font-mono text-xs font-semibold">{r.serial}</td>
                <td className="p-3 font-mono text-xs">{r.sku || "—"}</td>
                <td className="p-3 text-right font-mono whitespace-nowrap">
                  {fmtPLN(r.salePln)}
                  {r.currency !== "PLN" && r.price !== null && <div className="text-[10px] text-inksoft">{r.price.toLocaleString("pl-PL")} {r.currency}</div>}
                </td>
                <td className="p-3 text-right font-mono">{fmtPLN(r.purchasePln)}</td>
                <td className="p-3 text-right font-mono text-inksoft">{fmtPLN(r.vatPln)}</td>
                <td className={`p-3 text-right font-mono ${marginCls(r.netMarginPln)}`}>{fmtPLN(r.netMarginPln)}</td>
                <td className="p-3 text-right font-mono">{fmtPLN(r.shippingPln)}</td>
                <td className="p-3 text-right font-mono">{fmtPLN(r.extraPln)}</td>
                <td className="p-3 text-right font-mono whitespace-nowrap">
                  {fmtPLN(r.commissionPln)}
                  {r.commissionSource === "szacunek" && <div className="text-[10px] text-amber font-sans" title="Zamówienie jeszcze nie jest na wgranej fakturze — prowizja ze średnich stawek">szacunek</div>}
                </td>
                <td className={`p-3 text-right font-mono ${r.servicePln === null ? "text-inksoft" : ""}`} title="Części przypisane do numeru seryjnego (Serwis → Części), cena netto">{fmtPLN(r.servicePln)}</td>
                <td className={`p-3 text-right font-mono font-semibold whitespace-nowrap ${marginCls(r.marginPln)}`}>
                  {fmtPLN(r.marginPln)}
                  {r.flags.length > 0 && <span className="text-amber ml-1 cursor-help" title={r.flags.join("; ")}>⚠</span>}
                </td>
                <td className={`p-3 text-right font-mono ${marginCls(r.marginPln)}`}>{r.marginPct === null ? "—" : `${(r.marginPct * 100).toLocaleString("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}</td>
                <td className="p-3 text-center">
                  <button
                    onClick={() => setExpanded((prev) => { const next = new Set(prev); if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey); return next; })}
                    aria-expanded={open}
                    title={open ? "Zwiń wyliczenie" : "Pokaż szczegółowe wyliczenie marży"}
                    className="text-teal font-bold w-6 h-6 rounded hover:bg-tealsoft"
                  >
                    {open ? "▾" : "▸"}
                  </button>
                </td>
              </tr>
              {open && (
                <tr className="border-b border-line bg-paper">
                  <td colSpan={16} className="px-6 py-4">
                    <div className="text-xs font-semibold text-inksoft mb-2">WYLICZENIE MARŻY — {r.productName || r.sku || r.serial} · {r.serial}</div>
                    <table className="w-full max-w-5xl text-sm bg-white border border-line">
                      <tbody>
                        {r.details.map((d) => (
                          <tr key={d.key} className={`border-b border-line last:border-b-0 ${d.sign === "=" ? "font-semibold bg-paper" : ""}`}>
                            <td className="p-2 pl-3 w-10 text-center font-mono text-inksoft">{d.sign}</td>
                            <td className="p-2 w-48 whitespace-nowrap">{d.label}</td>
                            <td className={`p-2 w-32 text-right font-mono whitespace-nowrap ${d.sign === "=" ? marginCls(d.amountPln) : ""}`}>{d.amountPln === null ? "—" : `${fmtPLN(d.amountPln)} zł`}</td>
                            <td className="p-2 pr-3 text-xs text-inksoft">{d.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {r.flags.length > 0 && (
                      <ul className="mt-2 text-xs text-amber list-disc pl-5">
                        {r.flags.map((f) => <li key={f}>{f}</li>)}
                      </ul>
                    )}
                  </td>
                </tr>
              )}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {totals && (
        <div className="border border-line border-t-0 bg-white px-4 py-3 flex flex-wrap items-center gap-x-8 gap-y-1 text-sm">
          <span className="text-xs font-semibold text-inksoft">PODSUMOWANIE WYNIKU — wszystkie strony, {totals.withMargin} z {totals.count} pozycji z policzoną marżą</span>
          <span>Marża netto łącznie: <span className={`font-mono font-semibold ${marginCls(totals.netMargin)}`}>{fmtPLN(totals.netMargin)} zł</span></span>
          <span>Marża łącznie: <span className={`font-mono font-bold ${marginCls(totals.margin)}`}>{fmtPLN(totals.margin)} zł</span></span>
          <span>Marża %: <span className="font-mono font-semibold">{totals.sale > 0 ? ((totals.margin / totals.sale) * 100).toLocaleString("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "—"}%</span></span>
          <span>Marża na produkcie (średnio): <span className={`font-mono font-bold ${marginCls(totals.margin)}`}>{totals.withMargin > 0 ? `${fmtPLN(totals.margin / totals.withMargin)} zł` : "—"}</span></span>
          {totals.incomplete > 0 && <span className="text-amber text-xs">⚠ {totals.incomplete} pozycji z niepełnymi kosztami (najedź na ⚠ w wierszu)</span>}
        </div>
      )}
      <p className="text-[11px] text-inksoft mt-3 max-w-4xl">
        Marża = cena sprzedaży (PLN, brutto) − cena zakupu − VAT od marży ({"("}sprzedaż − zakup{")"} × 23/123, bez kosztów dodatkowych) − wysyłka − koszty dodatkowe (Trade-in) − prowizja marketplace&apos;u − koszty serwisu.
        Koszty serwisu = ceny netto części przypisanych do numeru seryjnego (Serwis → Części). Koszty zamówień z wieloma pozycjami dzielone wg ceny pozycji; waluty przeliczone kursem NBP z dnia poprzedniego względem daty zamówienia.
      </p>

      {openOrder && <SalesOrderCard marketplace={openOrder.marketplace} externalId={openOrder.externalId} session={session} members={members} onClose={() => setOpenOrder(null)} />}
    </div>
  );
}
