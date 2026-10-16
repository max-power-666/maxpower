"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { FeeRateResult } from "@/lib/feeRates";

// Marża -> pigułka "Prowizje" (16.10.2026): średnia prowizja Allegro i Erli policzona z faktur kosztowych (Finanse -> Faktury kosztowe) z 3 ostatnich kompletnych miesięcy. To ta stawka jest używana
// w Marży do szacowania prowizji zamówień Allegro i Erli. Metoda i założenia: lib/feeRates.ts.
const LABEL: Record<string, string> = { allegro: "Allegro", erli: "Erli" };
const money = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);
const monthLabel = (ym: string) => new Date(`${ym}-01T12:00:00`).toLocaleDateString("pl-PL", { month: "long", year: "numeric" });

export default function MarketplaceFeesView({ session }: { session: Session }) {
  const [rates, setRates] = useState<Record<string, FeeRateResult> | null>(null);
  const [error, setError] = useState("");
  const [warn, setWarn] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/margin/fee-rates", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Błąd serwera (${res.status}).`);
      setRates(data.rates);
      setWarn(data.error || "");
    } catch (e: any) {
      setError(e.message || "Nie udało się wczytać stawek.");
    } finally {
      setLoading(false);
    }
  }, [session.access_token]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="max-w-5xl">
      <p className="text-sm text-inksoft mb-4">
        Marża zamówień Allegro i Erli używa <b>średniej stawki prowizji (opłat platformy) z faktur kosztowych</b> (pobieranych z KSeF w Finanse → Faktury kosztowe) z 3 ostatnich kompletnych miesięcy: suma faktur netto ÷ suma sprzedaży brutto (zamówienia liczone jako sprzedaż,
        w PLN) z tych samych miesięcy. Stawka jest mnożnikiem ceny sprzedaży brutto. To szacunek — nie zależy od kategorii produktu ani opcji sprzedaży konkretnego zamówienia.
      </p>
      {loading && <p className="text-inksoft text-sm">Liczenie…</p>}
      {error && <p className="text-rust text-sm mb-3">{error}</p>}
      {warn && <p className="text-amber text-sm mb-3">{warn}</p>}
      {rates &&
        Object.values(rates).map((r) => (
          <div key={r.marketplace} className="border border-line bg-white mb-5">
            <div className="p-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-line">
              <h3 className="font-semibold text-base">{LABEL[r.marketplace] ?? r.marketplace}</h3>
              <span className="text-2xl font-bold font-mono">{pct(r.pct)}</span>
              <span className="text-xs text-inksoft">
                {r.window.length > 0 ? `średnia z: ${r.window.map(monthLabel).join(", ")} — faktury ${money(r.windowNet)} zł ÷ sprzedaż ${money(r.windowGmv)} zł` : "brak kompletnych miesięcy do średniej"}
              </span>
              {r.note && <span className="text-xs text-amber">{r.note}</span>}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-inksoft border-b border-line">
                  <th className="p-3">Miesiąc</th>
                  <th className="p-3">Faktury (netto)</th>
                  <th className="p-3 text-right">Faktury razem</th>
                  {Object.values(rates ?? {}).some((x) => x.marketplace === r.marketplace && x.months.some((m) => m.adsNet > 0)) && <th className="p-3 text-right" title="Erli Campaigns (reklama) — poza prowizją">Reklama</th>}
                  <th className="p-3 text-right">Sprzedaż brutto</th>
                  <th className="p-3 text-right">Zamówień</th>
                  <th className="p-3 text-right">Stawka</th>
                  <th className="p-3">W średniej</th>
                </tr>
              </thead>
              <tbody>
                {r.months.map((m) => (
                  <tr key={m.ym} className="border-b border-line last:border-0 align-top">
                    <td className="p-3 whitespace-nowrap">{monthLabel(m.ym)}</td>
                    <td className="p-3 text-xs font-mono">
                      {m.invoices.length === 0 ? <span className="text-inksoft">—</span> : m.invoices.map((i) => <div key={i.number} title={i.number}>{r.marketplace === "erli" ? "FV-P (opłaty platformy)" : "opłaty"}: {money(i.net)} zł</div>)}
                    </td>
                    <td className="p-3 text-right font-mono">{money(m.net)}</td>
                    {r.months.some((x) => x.adsNet > 0) && <td className="p-3 text-right font-mono text-inksoft">{m.adsNet ? money(m.adsNet) : "—"}</td>}
                    <td className="p-3 text-right font-mono">{m.gmv ? money(m.gmv) : "—"}</td>
                    <td className="p-3 text-right font-mono">{m.orders || "—"}</td>
                    <td className="p-3 text-right font-mono font-semibold">{pct(m.pct)}</td>
                    <td className="p-3 text-xs">{r.window.includes(m.ym) ? <span className="text-teal font-semibold">tak</span> : m.complete ? <span className="text-inksoft">starszy</span> : <span className="text-amber">{m.missing}</span>}</td>
                  </tr>
                ))}
                {r.months.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-inksoft text-sm">Brak faktur i sprzedaży do policzenia.</td></tr>}
              </tbody>
            </table>
            {r.excluded.length > 0 && (
              <details className="p-3 border-t border-line text-xs">
                <summary className="cursor-pointer text-inksoft">Faktury pominięte w średniej ({r.excluded.length})</summary>
                <table className="mt-2 w-full">
                  <tbody>
                    {r.excluded.map((e) => (
                      <tr key={e.number + e.issueDate} className="align-top">
                        <td className="py-0.5 pr-3 font-mono whitespace-nowrap">{e.number}</td>
                        <td className="py-0.5 pr-3 whitespace-nowrap">{e.issueDate ?? "—"}</td>
                        <td className="py-0.5 pr-3 text-right font-mono whitespace-nowrap">{money(e.net)} {e.currency}</td>
                        <td className="py-0.5 text-inksoft">{e.why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </div>
        ))}
      <p className="text-[11px] text-inksoft">
        Co jest na fakturze, rozpoznajemy po nazwie pozycji z Fakturowni. <b>Allegro:</b> tylko sprzedaż do Polski i miesięczna faktura „Zapewnienie funkcjonalności i usług… (allegro.pl)” w PLN (seria „/PL/N/PLN/”); pomijamy faktury w HUF/CZK/EUR
        (tam już nie sprzedajemy), drobne faktury zaliczkowe/korygujące, usługę zwrotu oraz faktury „FV26-…”, które są <b>zakupami towaru od Allegro</b> (gra Mario Kart 8 Deluxe), a nie kosztem prowizji. <b>Erli:</b> tylko faktura FV-P
        („Zapewnienie funkcjonalności i usług… ERLI.pl”); faktura FV-A to <b>Erli Campaigns — reklama</b>, pokazana osobno w kolumnie „Reklama” i niewliczana do prowizji. Miesiąc faktury to miesiąc rozliczenia z numeru faktury.
      </p>
    </div>
  );
}
