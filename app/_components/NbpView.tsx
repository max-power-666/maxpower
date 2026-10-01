"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { NBP_CURRENCIES } from "@/lib/nbp";

// Zakładka NBP (01.10.2026): kursy średnie NBP (tabela A), tylko EUR i DKK na razie (jedyne obce waluty w
// zamówieniach — patrz lib/salesOrders.ts). Dziś używane do przeliczania wartości zamówień na PLN na Przeglądzie
// (OverviewSalesDashboard.tsx), ale to osobna, reużywalna zakładka — przydadzą się gdzie indziej. Synchronizacja:
// cron raz dziennie (vercel.json) + przycisk "Odśwież" tutaj. Zapis tylko przez serwer (service_role).

type RateRow = { currency: string; rate_date: string; mid: number };

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("pl-PL");
}

export default function NbpView({ session }: { session: Session }) {
  const [rows, setRows] = useState<RateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const { data, error: err } = await supabase
        .from("nbp_rates")
        .select("currency, rate_date, mid")
        .order("rate_date", { ascending: false })
        .limit(200);
      if (err) throw err;
      setRows((data as RateRow[]) || []);
    } catch (e: any) {
      setError(`Nie udało się wczytać kursów: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sync() {
    setSyncing(true);
    setError("");
    setNote("");
    try {
      const res = await fetch("/api/nbp/sync", { headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || "Nie udało się odświeżyć kursów.");
      setNote("Odświeżono.");
      await load();
    } catch (e: any) {
      setError(e.message || "Błąd odświeżania.");
    } finally {
      setSyncing(false);
    }
  }

  const latestByCurrency = NBP_CURRENCIES.map((c) => rows.find((r) => r.currency === c)).filter(Boolean) as RateRow[];
  const recent = rows.slice(0, 40);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-semibold text-inksoft">KURSY NBP (TABELA A, ŚREDNIE)</h2>
        <button onClick={sync} disabled={syncing} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">
          {syncing ? "Odświeżanie…" : "Odśwież"}
        </button>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}
      {note && <p className="text-teal text-xs mb-3">{note}</p>}

      <div className="grid grid-cols-2 gap-px bg-line border border-line mb-6 max-w-md">
        {NBP_CURRENCIES.map((c) => {
          const r = latestByCurrency.find((x) => x.currency === c);
          return (
            <div key={c} className="bg-white p-5">
              <div className="text-xs text-inksoft mb-2">{c} / PLN</div>
              <div className="text-2xl font-bold font-mono">{r ? r.mid.toFixed(4) : "—"}</div>
              <div className="text-xs text-inksoft mt-1">{r ? `na ${fmtDate(r.rate_date)}` : "brak danych"}</div>
            </div>
          );
        })}
      </div>

      <h2 className="text-xs font-semibold text-inksoft mb-2">OSTATNIE KURSY</h2>
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Waluta</th>
              <th className="p-3">Data</th>
              <th className="p-3 text-right">Kurs średni</th>
            </tr>
          </thead>
          <tbody>
            {!loading && recent.length === 0 && (
              <tr><td colSpan={3} className="p-6 text-center text-inksoft text-sm">Brak zsynchronizowanych kursów — kliknij "Odśwież".</td></tr>
            )}
            {recent.map((r) => (
              <tr key={`${r.currency}-${r.rate_date}`} className="border-b border-line last:border-b-0">
                <td className="p-3 font-semibold">{r.currency}</td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDate(r.rate_date)}</td>
                <td className="p-3 text-right font-mono">{r.mid.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
