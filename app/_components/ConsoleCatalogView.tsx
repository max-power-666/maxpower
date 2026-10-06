"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

// Magazyn -> Katalog konsol (06.10.2026, na prośbę właściciela): katalog modeli konsol z SKU wg stanu (zadowalający / dobry / bardzo dobry).
// Dane z arkusza właściciela (supabase/console-catalog.sql), tylko do odczytu. SKU w katalogu kończy się liczbą kontrolerów (-0M/-1M/-2M);
// obok są kolumny z SKU BEZ info o kontrolerach (sku_base z lib: obcięcie końcówki -nM — ta sama wartość, co w ai.order_items.sku_base).

type Row = {
  id: number;
  position: number;
  manufacturer: string;
  name: string;
  accessories: string | null;
  color: string | null;
  storage: string | null;
  sku_satisfactory: string | null;
  sku_good: string | null;
  sku_very_good: string | null;
};

export const skuWithoutControllers = (sku: string | null | undefined) => (sku ? sku.replace(/-\d+M$/i, "") : null);

const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const Sku = ({ v }: { v: string | null }) => (v ? <span className="font-mono text-xs whitespace-nowrap">{v}</span> : <span className="text-inksoft">—</span>);

export default function ConsoleCatalogView() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [maker, setMaker] = useState("all");

  useEffect(() => {
    (async () => {
      const { data, error: err } = await supabase.from("console_catalog").select("*").order("position").limit(1000);
      if (err) setError(err.code === "42P01" ? "Brak tabeli katalogu — uruchom supabase/console-catalog.sql w Supabase (SQL Editor)." : `Nie udało się wczytać katalogu: ${err.message}`);
      else setRows((data as Row[]) || []);
      setLoading(false);
    })();
  }, []);

  const makers = useMemo(() => Array.from(new Set(rows.map((r) => r.manufacturer))), [rows]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (maker !== "all" && r.manufacturer !== maker) return false;
      if (!q) return true;
      return [r.name, r.color, r.storage, r.accessories, r.sku_satisfactory, r.sku_good, r.sku_very_good].some((x) => (x || "").toLowerCase().includes(q));
    });
  }, [rows, search, maker]);

  return (
    <div>
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Szukaj: nazwa, kolor, pamięć, SKU"
          className="w-80 border border-line bg-white px-3 py-2 rounded text-sm"
        />
        <button onClick={() => setMaker("all")} className={pill(maker === "all")}>Wszystkie</button>
        {makers.map((m) => (
          <button key={m} onClick={() => setMaker(m)} className={pill(maker === m)}>{m}</button>
        ))}
        <span className="text-xs text-inksoft ml-auto">{shown.length} z {rows.length} pozycji</span>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <div className="bg-white border border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-inksoft border-b border-line">
              <th colSpan={5} className="p-2"></th>
              <th colSpan={3} className="p-2 text-center border-l border-line">SKU (z kontrolerami)</th>
              <th colSpan={3} className="p-2 text-center border-l border-line">SKU bez info o kontrolerach</th>
            </tr>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Producent</th>
              <th className="p-3">Nazwa</th>
              <th className="p-3">Akcesoria</th>
              <th className="p-3">Kolor</th>
              <th className="p-3">Pamięć</th>
              <th className="p-3 border-l border-line">Zadowalający</th>
              <th className="p-3">Dobry</th>
              <th className="p-3">Bardzo dobry</th>
              <th className="p-3 border-l border-line">Zadowalający</th>
              <th className="p-3">Dobry</th>
              <th className="p-3">Bardzo dobry</th>
            </tr>
          </thead>
          <tbody>
            {!loading && shown.length === 0 && !error && (
              <tr><td colSpan={11} className="p-6 text-center text-inksoft text-sm">{rows.length === 0 ? "Katalog jest pusty." : "Brak wyników."}</td></tr>
            )}
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="p-3 text-xs whitespace-nowrap">{r.manufacturer}</td>
                <td className="p-3">{r.name}</td>
                <td className="p-3 text-xs whitespace-nowrap">{r.accessories || "—"}</td>
                <td className="p-3 text-xs whitespace-nowrap">{r.color || "—"}</td>
                <td className="p-3 text-xs whitespace-nowrap">{r.storage || "—"}</td>
                <td className="p-3 border-l border-line"><Sku v={r.sku_satisfactory} /></td>
                <td className="p-3"><Sku v={r.sku_good} /></td>
                <td className="p-3"><Sku v={r.sku_very_good} /></td>
                <td className="p-3 border-l border-line"><Sku v={skuWithoutControllers(r.sku_satisfactory)} /></td>
                <td className="p-3"><Sku v={skuWithoutControllers(r.sku_good)} /></td>
                <td className="p-3"><Sku v={skuWithoutControllers(r.sku_very_good)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-inksoft mt-3 max-w-4xl">
        Stany: zadowalający = klasa C, dobry = B, bardzo dobry = A (ostatni człon SKU). SKU bez info o kontrolerach to SKU bez końcówki -0M / -1M / -2M — tak samo wyglądają SKU sztuk w Magazynie. Pusty wiersz oznacza model bez przypisanych SKU w arkuszu.
      </p>
    </div>
  );
}
