"use client";

import { useState } from "react";
import { buildConsolePriceRows, type BidderSkuLite, type CatalogRowLite } from "@/lib/consolePrices";

// Magazyn -> Katalog konsol -> "SKU i ceny" (10.10.2026, na prośbę właściciela; odpowiednik pliku ceny-konsol-z-biddera.xlsx): każdy SKU z katalogu w jednej kolumnie,
// obok cena skupu wyliczona z ceny max w Bidderze i sugerowana cena sprzedaży (narzut domyślnie 50%). Liczone NA ŻYWO z buyback_skus i najświeższego kursu EUR z NBP,
// więc zmiana ceny max w Bidderze od razu zmienia ceny tutaj. Dane (Bidder, kurs, narzut) wczytuje i trzyma widok katalogu (ConsoleCatalogView) — wspólne dla pigułek
// Modele i SKU i ceny. Tylko do odczytu.

const fmtPln = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`);
const fmtEur = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`);
const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

export default function ConsoleSkuPrices({
  rows,
  bidder,
  eurRate,
  markup,
}: {
  rows: CatalogRowLite[];
  bidder: Map<string, BidderSkuLite> | null;
  eurRate: number | null;
  markup: number;
}) {
  const [onlyPriced, setOnlyPriced] = useState(false);
  const all = bidder ? buildConsolePriceRows(rows, bidder, eurRate, markup) : [];
  const shown = onlyPriced ? all.filter((r) => r.buyPln !== null) : all;
  const pricedCount = all.filter((r) => r.buyPln !== null).length;

  // Eksport do CSV (średniki + BOM, jak w RCP) — dla tego, co jest teraz na ekranie.
  function exportCsv() {
    const esc = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["SKU", "Cena skupu (PLN)", "Sugerowana cena (PLN)", "Nazwa w katalogu", "Klasa", "SKU w Bidderze", "Cena max w Bidderze (EUR)", "Uwagi"];
    const lines = shown.map((r) => [r.sku, r.buyPln?.toFixed(2).replace(".", ",") ?? "", r.suggestedPln?.toFixed(2).replace(".", ",") ?? "", r.name, r.cls, r.bidderSku ?? "", r.maxEur ?? "", r.notes.join("; ")].map(esc).join(";"));
    const blob = new Blob(["﻿" + [head.map(esc).join(";"), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ceny-konsol.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <button onClick={() => setOnlyPriced((v) => !v)} className={pill(onlyPriced)}>Tylko z ceną</button>
        <button onClick={exportCsv} className="px-3 py-1.5 rounded-full text-sm font-semibold border border-line bg-white">Pobierz CSV</button>
        <span className="text-xs text-inksoft ml-auto">{shown.length} SKU · z ceną {pricedCount}</span>
      </div>

      <div className="bg-white border border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">SKU</th>
              <th className="p-3 text-right">Cena skupu (PLN)</th>
              <th className="p-3 text-right">Sugerowana cena (PLN)</th>
              <th className="p-3">Nazwa w katalogu</th>
              <th className="p-3">Klasa</th>
              <th className="p-3">SKU w Bidderze</th>
              <th className="p-3 text-right">Cena max w Bidderze</th>
              <th className="p-3">Uwagi</th>
            </tr>
          </thead>
          <tbody>
            {!bidder && <tr><td colSpan={8} className="p-6 text-center text-inksoft text-sm">Wczytywanie cen z Biddera…</td></tr>}
            {bidder && shown.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-inksoft text-sm">Brak SKU do pokazania.</td></tr>}
            {shown.map((r) => (
              <tr key={r.key} className="border-b border-line last:border-0 align-top">
                <td className="p-3 font-mono text-xs whitespace-nowrap">{r.sku}</td>
                <td className="p-3 text-right whitespace-nowrap">{fmtPln(r.buyPln)}</td>
                <td className="p-3 text-right whitespace-nowrap font-semibold">{fmtPln(r.suggestedPln)}</td>
                <td className="p-3 text-xs">{r.name}</td>
                <td className="p-3 text-xs">{r.cls}</td>
                <td className="p-3 font-mono text-xs whitespace-nowrap">{r.bidderSku ?? "—"}</td>
                <td className="p-3 text-right whitespace-nowrap text-xs">{fmtEur(r.maxEur)}</td>
                <td className={`p-3 text-xs ${r.notes.length ? "text-amber" : ""}`}>{r.notes.join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-inksoft mt-3 max-w-4xl">
        Cena skupu = (cena max w Bidderze × (1 + prowizja) + opłata stała) × kurs EUR — ten sam wzór co kolumna „Cena PLN” w Bidderze. Sugerowana cena = cena skupu × (1 + narzut). SKU katalogu łączymy z SKU Biddera bez koloru (PS5S-1TB-WE-A-1M → PS5S-1TB-A-1M);
        zakładamy, że klasy A/B/C w Bidderze to te same klasy co w katalogu. To cena MAX, czyli górna granica — Bidder często kupuje taniej. Cena max 0 € albo 10 € oznacza „nie skupujemy”, więc ceny nie liczymy.
      </p>
    </div>
  );
}
