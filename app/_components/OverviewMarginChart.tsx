"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { MARKETPLACES } from "@/lib/salesOrders";

// Wykres marży na Przeglądzie (03.10.2026): marża per marketplace (na razie Back Market i refurbed — jedyne kanały, dla których
// zakładka Marża zna prowizje) oraz łączna marża i średnia marża za wybrany okres. Dane z /api/margin/summary (te same liczby co
// zakładka Marża). Okres: bieżący / ubiegły miesiąc (czas polski) / cały okres. Pozycje bez policzonej marży (brak ceny sprzedaży
// albo zakupu) nie wchodzą do sum; liczba pozycji z ostrzeżeniami (niepełne koszty) jest pokazana osobno.

type Agg = { count: number; withMargin: number; sale: number; margin: number; incomplete: number };
type Summary = Record<string, { total: Agg; byMarketplace: Record<string, Agg> }>;
type PeriodKey = "current" | "previous" | "all";

const COLORS: Record<string, string> = { backmarket: "#e4572e", refurbed: "#1baf7a" };
const monthName = (offset: number) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + offset, 1).toLocaleDateString("pl-PL", { month: "long", year: "numeric" });
};
const PERIODS: { key: PeriodKey; label: string; hint: string }[] = [
  { key: "current", label: "Bieżący miesiąc", hint: monthName(0) },
  { key: "previous", label: "Ubiegły miesiąc", hint: monthName(-1) },
  { key: "all", label: "Cały okres", hint: "Wszystkie sprzedane sztuki" },
];

const label = (key: string) => MARKETPLACES.find((m) => m.key === key)?.label ?? key;
const fmt = (n: number) => `${n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} PLN`;
const pct = (margin: number, sale: number) => (sale > 0 ? `${((margin / sale) * 100).toFixed(1)}%` : "—");
const pill = (active: boolean) => `px-3 py-1 rounded-full text-xs font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

export default function OverviewMarginChart({ session }: { session: Session }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [period, setPeriod] = useState<PeriodKey>("current");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/margin/summary", { headers: { Authorization: `Bearer ${session.access_token}` } });
        if (res.status === 403) return setForbidden(true); // marża tylko dla Admina i Managera — dla innych sekcja się nie pokazuje
        const data = await res.json();
        if (!res.ok || data?.error) throw new Error(data?.error || "Nie udało się policzyć marży.");
        setSummary(data.periods);
      } catch (e: any) {
        setError(e.message || "Błąd wczytywania marży.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (forbidden) return null;
  if (error) return <p className="text-rust text-xs mb-6">{error}</p>;
  if (!summary) return <p className="text-inksoft text-sm mb-6">Liczenie marży…</p>;

  const cur = summary[period];
  const t = cur.total;
  const entries = Object.entries(cur.byMarketplace);
  const maxAbs = Math.max(...entries.map(([, a]) => Math.abs(a.margin)), 1);
  const avgPerItem = t.withMargin > 0 ? t.margin / t.withMargin : 0;

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <h3 className="text-xs font-semibold text-inksoft mr-2">MARŻA WEDŁUG MARKETPLACE'ÓW</h3>
        {PERIODS.map((p) => (
          <button key={p.key} onClick={() => setPeriod(p.key)} title={p.hint} className={pill(period === p.key)}>
            {p.label}
          </button>
        ))}
        <span className="text-xs text-inksoft">{PERIODS.find((p) => p.key === period)?.hint}</span>
      </div>

      <div className="grid grid-cols-4 gap-px bg-line border border-line mb-px">
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">ŁĄCZNA MARŻA</div>
          <div className={`text-2xl font-bold font-mono ${t.margin < 0 ? "text-rust" : "text-teal"}`}>{fmt(t.margin)}</div>
        </div>
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">ŚREDNIA MARŻA (% SPRZEDAŻY)</div>
          <div className="text-2xl font-bold font-mono">{pct(t.margin, t.sale)}</div>
        </div>
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">ŚREDNIA MARŻA NA SZTUKĘ</div>
          <div className="text-2xl font-bold font-mono">{t.withMargin > 0 ? fmt(avgPerItem) : "—"}</div>
        </div>
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">SPRZEDANE SZTUKI Z MARŻĄ</div>
          <div className="text-2xl font-bold font-mono">{t.withMargin}<span className="text-sm text-inksoft"> / {t.count}</span></div>
          {t.incomplete > 0 && <div className="text-xs text-amber mt-1">⚠ {t.incomplete} z niepełnymi kosztami</div>}
        </div>
      </div>

      <div className="bg-white border border-line border-t-0 p-5">
        {t.count === 0 ? (
          <div className="text-sm text-inksoft py-6 text-center">Brak sprzedaży w tym okresie.</div>
        ) : (
          <div className="flex flex-col gap-3">
            {entries.map(([mp, a]) => (
              <div key={mp} className="flex items-center gap-3 text-xs">
                <span className="w-20 shrink-0 font-semibold">{label(mp)}</span>
                <div className="flex-1 bg-paper rounded h-6 relative overflow-hidden">
                  <div
                    className="h-full rounded"
                    style={{ width: `${(Math.abs(a.margin) / maxAbs) * 100}%`, background: a.margin < 0 ? "var(--color-rust)" : COLORS[mp] || "#9aa0a6" }}
                  />
                </div>
                <span className={`w-32 shrink-0 text-right font-mono ${a.margin < 0 ? "text-rust" : ""}`}>{fmt(a.margin)}</span>
                <span className="w-44 shrink-0 text-inksoft">
                  śr. {pct(a.margin, a.sale)} · {a.withMargin} szt.{a.incomplete > 0 ? ` · ⚠ ${a.incomplete}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-inksoft mt-4">
          Marża po VAT od marży, kosztach wysyłki i dodatkowych oraz prowizji marketplace'u; bez kosztów serwisu. Tylko zamówienia z numerem seryjnym i znaną ceną zakupu. Szczegóły w zakładce Marża.
        </p>
      </div>
    </div>
  );
}
