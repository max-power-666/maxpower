"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Row = { id: number; period: string; person_name: string; contract: string; hours: number; payout: number; bonus: number; employer_costs: number; note: string | null };
const CONTRACT_LABEL: Record<string, string> = { UZ: "Umowy zlecenie", UO: "Umowy o pracę" };

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

  const groups = Array.from(new Set((rows ?? []).map((r) => `${r.period}|${r.contract}`)));

  return (
    <div className="border border-line bg-white">
      <div className="p-3 border-b border-line">
        <div className="text-sm font-semibold">Stawki godzinowe i premie</div>
        <div className="text-xs text-inksoft">Widoczne tylko dla Admina, Managera i Księgowej.</div>
      </div>
      {error && <div className="p-4 text-sm text-rust">{error}</div>}
      {!error && rows === null && <div className="p-4 text-sm text-inksoft">Wczytywanie…</div>}
      {groups.map((g) => {
        const [p, contract] = g.split("|");
        const list = (rows ?? []).filter((r) => r.period === p && r.contract === contract);
        const hasEmployer = list.some((r) => Number(r.employer_costs) > 0);
        return (
          <div key={g} className="border-b border-line last:border-b-0">
            <div className="px-3 pt-3 text-xs font-semibold text-inksoft uppercase tracking-wide">{CONTRACT_LABEL[contract] ?? contract} — płace za {periodLabel(p)}</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-inksoft border-b border-line">
                  <th className="p-3">Osoba</th>
                  <th className="p-3 text-right">Godziny</th>
                  <th className="p-3 text-right">{contract === "UO" ? "Brutto (zł)" : "Kwota z umowy (zł)"}</th>
                  <th className="p-3 text-right">Premia (zł)</th>
                  <th className="p-3 text-right">Stawka godzinowa</th>
                  <th className="p-3 text-right">Premia na godzinę</th>
                  <th className="p-3 text-right">Razem na godzinę</th>
                  {hasEmployer && <th className="p-3 text-right">Składki pracodawcy (zł)</th>}
                  {hasEmployer && <th className="p-3 text-right">Koszt dla firmy na godzinę</th>}
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const hours = Number(r.hours), payout = Number(r.payout), bonus = Number(r.bonus), employer = Number(r.employer_costs);
                  return (
                    <tr key={r.id} className="border-b border-line last:border-b-0">
                      <td className="p-3 font-semibold">
                        {r.person_name}
                        {r.note && <div className="text-xs font-normal text-inksoft">{r.note}</div>}
                      </td>
                      <td className="p-3 text-right tabular-nums">{fmt(hours)}{contract === "UO" ? " *" : ""}</td>
                      <td className="p-3 text-right tabular-nums">{fmt(payout)}</td>
                      <td className="p-3 text-right tabular-nums">{bonus ? fmt(bonus) : "—"}</td>
                      <td className="p-3 text-right tabular-nums font-semibold">{fmt((payout - bonus) / hours)} zł</td>
                      <td className="p-3 text-right tabular-nums">{bonus ? `${fmt(bonus / hours)} zł` : "—"}</td>
                      <td className="p-3 text-right tabular-nums font-semibold">{fmt(payout / hours)} zł</td>
                      {hasEmployer && <td className="p-3 text-right tabular-nums">{employer ? fmt(employer) : "—"}</td>}
                      {hasEmployer && <td className="p-3 text-right tabular-nums font-semibold">{fmt((payout + employer) / hours)} zł</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="px-3 pb-3 text-xs text-inksoft">
              Dane na podstawie płac wrześniowych 2026 (wypłata 10.10.2026), nie z RCP. Stawka godzinowa = (kwota − premia) ÷ godziny; premia na godzinę = premia ÷ godziny; razem na godzinę = kwota ÷ godziny.
              {contract === "UO" && " * Dla umów o pracę godziny to przyjęta średnia (167 h na miesiąc), nie rzeczywiste; kwota to brutto z listy płac (z premią, urlopowym i dodatkami)."}
              {hasEmployer ? " Koszt dla firmy na godzinę = (kwota + składki pracodawcy) ÷ godziny; to stawka używana w Marży (Koszty pracy)." : ""}
            </div>
          </div>
        );
      })}
      {!error && rows !== null && rows.length === 0 && <div className="p-4 text-sm text-inksoft">Brak danych.</div>}
    </div>
  );
}
