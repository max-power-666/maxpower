"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import type { BmRates } from "@/lib/margin";

// Zakładka Marża -> "Faktury BM" (08.10.2026): wgrywanie tygodniowych faktur Back Market (CSV) i lista już zaimportowanych. Z tych faktur liczymy DOKŁADNĄ prowizję BM
// per zamówienie oraz średnie stawki (opłata płatnicza, CCBM) — patrz lib/margin.ts i app/api/margin/bm-invoice.

type Invoice = { invoiceRef: string; lines: number; orders: number; firstDate: string | null; lastDate: string | null; uploadedAt: string; uploadedBy: string | null; currency: string | null; sums: Record<string, number> };

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtAmount = (n: number | undefined, cur: string | null) => (n === undefined ? "—" : `${n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur || ""}`.trim());
// numer faktury z daty w nazwie: 20260915-EU-H-10047685 -> 15.09.2026
const invoiceDate = (ref: string) => (/^(\d{4})(\d{2})(\d{2})/.test(ref) ? ref.replace(/^(\d{4})(\d{2})(\d{2}).*/, "$3.$2.$1") : "—");
// rodzaje wierszy znane z faktur; pozostałe (korekty, refundy, dopasowania dynamicznych cen) lecą do "Pozostałe"
const KNOWN = ["sales", "sales_fees", "payment_fees", "ccbm_fees"];

export default function BmInvoicesView({ session, members, bmRates, invoiceCount, onUploaded }: { session: Session; members: MemberLite[]; bmRates: BmRates | null; invoiceCount: number; onUploaded: () => void }) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploadMsg, setUploadMsg] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const auth = { Authorization: `Bearer ${session.access_token}` };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/margin/bm-invoices", { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Błąd serwera (${res.status}).`);
      setInvoices(data.invoices || []);
      setError("");
    } catch (e: any) {
      setError(e.message || "Nie udało się wczytać listy faktur.");
    } finally {
      setLoading(false);
    }
  }, [session.access_token]);
  useEffect(() => {
    load();
  }, [load]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
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
    setUploading(false);
    load();
    onUploaded();
  }

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
            Prowizja szacowana wg reguł (sprawdzone na zamówieniach z faktur): <span className="font-semibold">konsole do FR/DE/ES/IT — 6%</span> (program Accelerator, −5 pkt proc., 15.08–31.12.2026),{" "}
            <span className="font-semibold">smartwatche (nie Apple) do FR/DE/ES/IT — 0%</span> (1.09–30.11.2026), konsole do pozostałych krajów 11%, akcesoria (pady) 20%, pozostałe produkty (w tym Apple Watch) 11%. refurbed i Octopia — prowizja wprost z danych zamówienia. Średnie z ostatnich 8 tygodni faktur; wgrywaj kolejne co tydzień.
          </div>
        </div>
        <div className="shrink-0">
          <input ref={fileRef} type="file" accept=".csv,text/csv" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">{uploading ? "Wgrywanie…" : "Wgraj fakturę BM (CSV)"}</button>
        </div>
      </div>
      {uploadMsg && <p className="text-xs text-teal font-semibold mb-3">{uploadMsg}</p>}
      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <h2 className="text-xs font-semibold text-inksoft mb-2">ZAIMPORTOWANE FAKTURY ({invoices.length})</h2>
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Faktura</th>
              <th className="p-3">Data faktury</th>
              <th className="p-3">Okres (daty wierszy)</th>
              <th className="p-3 text-right">Wiersze</th>
              <th className="p-3 text-right">Zamówienia</th>
              <th className="p-3 text-right" title="Wartość sprzedaży objętej fakturą">Sprzedaż</th>
              <th className="p-3 text-right">Prowizja</th>
              <th className="p-3 text-right">Opłata płatnicza</th>
              <th className="p-3 text-right">CCBM</th>
              <th className="p-3 text-right" title="Korekty, zwroty, dopasowania cen — suma pozostałych rodzajów wierszy">Pozostałe</th>
              <th className="p-3">Wgrano</th>
            </tr>
          </thead>
          <tbody>
            {!loading && invoices.length === 0 && !error && <tr><td colSpan={11} className="p-6 text-center text-inksoft text-sm">Nie wgrano jeszcze żadnej faktury Back Market.</td></tr>}
            {invoices.map((i) => {
              const other = Object.entries(i.sums).filter(([k]) => !KNOWN.includes(k)).reduce((n, [, v]) => n + v, 0);
              const hasOther = Object.keys(i.sums).some((k) => !KNOWN.includes(k));
              return (
                <tr key={i.invoiceRef} className="border-b border-line last:border-b-0 hover:bg-paper">
                  <td className="p-3 font-mono text-xs font-semibold whitespace-nowrap">{i.invoiceRef}</td>
                  <td className="p-3 whitespace-nowrap">{invoiceDate(i.invoiceRef)}</td>
                  <td className="p-3 text-xs whitespace-nowrap">{i.firstDate ? `${fmtDate(i.firstDate)} – ${fmtDate(i.lastDate)}` : "—"}</td>
                  <td className="p-3 text-right font-mono">{i.lines.toLocaleString("pl-PL")}</td>
                  <td className="p-3 text-right font-mono">{i.orders.toLocaleString("pl-PL")}</td>
                  <td className="p-3 text-right font-mono whitespace-nowrap">{fmtAmount(i.sums.sales, i.currency)}</td>
                  <td className="p-3 text-right font-mono whitespace-nowrap">{fmtAmount(i.sums.sales_fees, i.currency)}</td>
                  <td className="p-3 text-right font-mono whitespace-nowrap">{fmtAmount(i.sums.payment_fees, i.currency)}</td>
                  <td className="p-3 text-right font-mono whitespace-nowrap">{fmtAmount(i.sums.ccbm_fees, i.currency)}</td>
                  <td className="p-3 text-right font-mono whitespace-nowrap">{hasOther ? fmtAmount(other, i.currency) : "—"}</td>
                  <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(i.uploadedAt)}{i.uploadedBy ? ` · ${displayNameForEmail(i.uploadedBy, members)}` : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-inksoft mt-3 max-w-4xl">
        Jedna faktura = jeden plik CSV (numer z nazwy pliku, np. invoice_20260915-EU-H-10047685.csv). Ponowne wgranie tego samego pliku nie dubluje wierszy. Kwoty to sumy wierszy z pliku w walucie faktury (znak jak w pliku);
        miesięczny abonament i korekty (credit notes) nie są rozdzielane na zamówienia.
      </p>
    </div>
  );
}
