"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { MARKETPLACES } from "@/lib/salesOrders";
import { dailySeries, marketplaceShares, rangeStats, todayStats, type OrderValueRow } from "@/lib/overview";

// Dashboard sprzedaży na Przeglądzie (01.10.2026) — wzorowany na zrzucie ekranu dashboardu Apilo od
// właściciela: 4 kafelki (ilość/wartość dzisiaj, ilość/wartość z 30 dni), wykres dzienny (słupki = wartość,
// linia = ilość) i udział kanałów. Właściciel poprosił o wykres SŁUPKOWY z procentem zamiast kołowego z
// oryginalnego zrzutu — stąd poziome słupki zamiast donuta. Wartości z różnych kanałów (EUR/DKK/PLN — sprawdzone
// na żywych danych) są przeliczone na PLN po stronie serwera (app/api/overview/sales-stats, kursy z nbp_rates/
// zakładka NBP) — przeglądarka dostaje już gotowe wartości w PLN i tylko liczy wiadra dni/kanałów (lib/overview.ts),
// żeby "dzisiaj"/"ostatnie 30 dni" zawsze zgadzało się z lokalnym zegarem osoby patrzącej na ekran.

const MARKETPLACE_COLORS: Record<string, string> = {
  backmarket: "#e4572e", refurbed: "#1baf7a", erli: "#2a78d6", allegro: "#eda100", octopia: "#8a4fff", amazon: "#eb6834", apilo: "#9aa0a6",
};
const DEFAULT_COLOR = "#9aa0a6";

function marketplaceLabel(key: string) {
  return MARKETPLACES.find((m) => m.key === key)?.label ?? key;
}
function fmtPln(n: number) {
  return `${n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} PLN`;
}
function fmtDay(key: string) {
  const [, m, d] = key.split("-");
  return `${d}.${m}`;
}

export default function OverviewSalesDashboard({ session }: { session: Session }) {
  const [rows, setRows] = useState<OrderValueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch("/api/overview/sales-stats", { headers: { Authorization: `Bearer ${session.access_token}` } });
        const data = await res.json();
        if (!res.ok || data?.error) throw new Error(data?.error || "Nie udało się wczytać statystyk.");
        setRows(data.rows || []);
      } catch (e: any) {
        setError(e.message || "Błąd wczytywania.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const now = useMemo(() => new Date(), []);
  const today = useMemo(() => todayStats(rows, now), [rows, now]);
  const range30 = useMemo(() => rangeStats(rows, now, 30), [rows, now]);
  const daily = useMemo(() => dailySeries(rows, now, 30), [rows, now]);
  const shares = useMemo(() => marketplaceShares(rows, now, 30), [rows, now]);

  if (loading) return <p className="text-inksoft text-sm mb-6">Wczytywanie statystyk sprzedaży…</p>;
  if (error) return <p className="text-rust text-xs mb-6">{error}</p>;

  return (
    <div className="mb-8">
      <div className="grid grid-cols-4 gap-px bg-line border border-line mb-px">
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">ILOŚĆ ZAMÓWIEŃ DZISIAJ</div>
          <div className="text-2xl font-bold font-mono">{today.count}</div>
        </div>
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">WARTOŚĆ ZAMÓWIEŃ DZISIAJ</div>
          <div className="text-2xl font-bold font-mono text-teal">{fmtPln(today.value)}</div>
        </div>
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">ILOŚĆ ZAMÓWIEŃ Z 30 DNI</div>
          <div className="text-2xl font-bold font-mono">{range30.count}</div>
        </div>
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">WARTOŚĆ ZAMÓWIEŃ Z 30 DNI</div>
          <div className="text-2xl font-bold font-mono text-teal">{fmtPln(range30.value)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px bg-line border border-line border-t-0">
        <div className="bg-white p-5">
          <h3 className="text-xs font-semibold text-inksoft mb-3">ZAMÓWIENIA Z OSTATNICH 30 DNI WEDŁUG ILOŚCI I KWOT</h3>
          <DailyChart data={daily} />
        </div>
        <div className="bg-white p-5">
          <h3 className="text-xs font-semibold text-inksoft mb-3">WARTOŚĆ ZAMÓWIEŃ Z OSTATNICH 30 DNI WEDŁUG KANAŁÓW</h3>
          <MarketplaceBarChart shares={shares} />
        </div>
      </div>
    </div>
  );
}

function DailyChart({ data }: { data: { date: string; value: number; count: number }[] }) {
  if (data.every((d) => d.value === 0 && d.count === 0)) {
    return <div className="h-48 flex items-center justify-center text-sm text-inksoft">Brak zamówień w tym okresie.</div>;
  }
  const W = 560, H = 230, L = 50, R = 36, T = 10, B = 26;
  const plotW = W - L - R, plotH = H - T - B;
  const maxValue = Math.max(...data.map((d) => d.value), 1) * 1.15;
  const maxCount = Math.max(...data.map((d) => d.count), 1) * 1.15;
  const slot = plotW / data.length;
  const barW = slot * 0.55;
  const xCenter = (i: number) => L + slot * i + slot / 2;
  const yValue = (v: number) => T + plotH - (v / maxValue) * plotH;
  const yCount = (c: number) => T + plotH - (c / maxCount) * plotH;
  const linePts = data.map((d, i) => `${xCenter(i)},${yCount(d.count)}`).join(" ");
  const labelEvery = Math.ceil(data.length / 7);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <line x1={L} x2={W - R} y1={T + plotH} y2={T + plotH} stroke="var(--color-line)" strokeWidth={1} />
      {data.map((d, i) => (
        <rect key={d.date} x={xCenter(i) - barW / 2} y={yValue(d.value)} width={barW} height={Math.max(plotH - (yValue(d.value) - T), 0)} fill="var(--color-teal)" opacity={0.75} />
      ))}
      <polyline points={linePts} fill="none" stroke="var(--color-amber)" strokeWidth={2} />
      {data.map((d, i) => (
        <circle key={d.date} cx={xCenter(i)} cy={yCount(d.count)} r={2.5} fill="var(--color-amber)" />
      ))}
      {data.map((d, i) =>
        i % labelEvery === 0 ? (
          <text key={d.date} x={xCenter(i)} y={H - 6} textAnchor="middle" className="fill-inksoft" style={{ fontSize: 9 }}>
            {fmtDay(d.date)}
          </text>
        ) : null
      )}
      <text x={L} y={T + 10} className="fill-inksoft" style={{ fontSize: 9 }}>wartość (PLN)</text>
      <text x={W - R} y={T + 10} textAnchor="end" className="fill-inksoft" style={{ fontSize: 9 }}>ilość</text>
    </svg>
  );
}

function MarketplaceBarChart({ shares }: { shares: { marketplace: string; value: number; pct: number }[] }) {
  if (shares.length === 0) {
    return <div className="h-48 flex items-center justify-center text-sm text-inksoft">Brak zamówień w tym okresie.</div>;
  }
  const maxPct = Math.max(...shares.map((s) => s.pct), 1);
  return (
    <div className="flex flex-col gap-2.5 justify-center" style={{ minHeight: 230 }}>
      {shares.map((s) => (
        <div key={s.marketplace} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 font-semibold truncate">{marketplaceLabel(s.marketplace)}</span>
          <div className="flex-1 bg-paper rounded h-5 relative overflow-hidden">
            <div
              className="h-full rounded"
              style={{ width: `${(s.pct / maxPct) * 100}%`, background: MARKETPLACE_COLORS[s.marketplace] || DEFAULT_COLOR }}
            />
          </div>
          <span className="w-12 shrink-0 text-right font-mono">{s.pct.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}
