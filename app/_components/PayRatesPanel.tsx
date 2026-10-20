"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Row = { id: number; period: string; person_name: string; contract: string; hours: number; payout: number; bonus: number; note: string | null };

const fmt = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
const periodLabel = (p: string) => {
  const [y, m] = p.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
};

// Zespół -> stawki godzinowe i premie (20.10.2026): dane z płac (tabela payroll_rates, RLS: Admin/Manager/Księgowa). Renderowane tylko dla tych ról.
export default function PayRatesPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("payroll_rates").select("*").order("period", { ascending: false }).order("person_name");
      if (error) {
        setError(/payroll_rates/.test(error.message) ? "Brak tabeli płac — uruchom supabase/payroll-rates.sql w Supabase (SQL Editor)." : error.message);
        return;
      }
      setRows((data as Row[]) ?? []);
    })();
  }, []);

  const periods = Array.from(new Set((rows ?? []).map((r) => r.period)));

  return (
    <div className="mt-6 border border-line bg-white">
      <div className="p-3 border-b border-line">
        <div className="text-sm font-semibold">Stawki godzinowe i premie</div>
        <div className="text-xs text-inksoft">Widoczne tylko dla Admina, Managera i Księgowej.</div>
      </div>
      {error && <div className="p-4 text-sm text-rust">{error}</div>}
      {!error && rows === null && <div className="p-4 text-sm text-inksoft">Wczytywanie…</div>}
      {periods.map((p) => {
        const list = (rows ?? []).filter((r) => r.period === p);
        return (
          <div key={p} className="border-b border-line last:border-b-0">
            <div className="px-3 pt-3 text-xs font-semibold text-inksoft uppercase tracking-wide">Umowy zlecenie — płace za {periodLabel(p)}</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-inksoft border-b border-line">
                  <th className="p-3">Osoba</th>
                  <th className="p-3 text-right">Godziny</th>
                  <th className="p-3 text-right">Wypłata (zł)</th>
                  <th className="p-3 text-right">Premia (zł)</th>
                  <th className="p-3 text-right">Stawka godzinowa</th>
                  <th className="p-3 text-right">Premia na godzinę</th>
                  <th className="p-3 text-right">Razem na godzinę</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const hours = Number(r.hours), payout = Number(r.payout), bonus = Number(r.bonus);
                  return (
                    <tr key={r.id} className="border-b border-line last:border-b-0">
                      <td className="p-3 font-semibold">
                        {r.person_name}
                        {r.note && <div className="text-xs font-normal text-amber">⚠ {r.note}</div>}
                      </td>
                      <td className="p-3 text-right tabular-nums">{fmt(hours)}</td>
                      <td className="p-3 text-right tabular-nums">{fmt(payout)}</td>
                      <td className="p-3 text-right tabular-nums">{bonus ? fmt(bonus) : "—"}</td>
                      <td className="p-3 text-right tabular-nums font-semibold">{fmt((payout - bonus) / hours)} zł{r.note ? " (?)" : ""}</td>
                      <td className="p-3 text-right tabular-nums">{bonus ? `${fmt(bonus / hours)} zł` : "—"}</td>
                      <td className="p-3 text-right tabular-nums font-semibold">{fmt(payout / hours)} zł</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="px-3 pb-3 text-xs text-inksoft">
              Dane na podstawie płac wrześniowych 2026 (wypłata 10.10.2026), nie z RCP. Stawka godzinowa = (wypłata − premia) ÷ godziny; premia na godzinę = premia ÷ godziny; razem na godzinę = wypłata ÷ godziny. Zlecenie bez składek (netto = brutto).
            </div>
          </div>
        );
      })}
      {!error && rows !== null && rows.length === 0 && <div className="p-4 text-sm text-inksoft">Brak danych.</div>}
    </div>
  );
}
