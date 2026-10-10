"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import InlineEditCell from "./InlineEditCell";
import ConsoleSkuPrices from "./ConsoleSkuPrices";

// Magazyn -> Katalog konsol (06.10.2026, na prośbę właściciela): katalog modeli konsol z SKU wg stanu (zadowalający / dobry / bardzo dobry).
// Dane z arkusza właściciela (supabase/console-catalog.sql). Czytają wszyscy zalogowani; EDYTUJE tylko Admin (komórki, dodawanie, duplikowanie i usuwanie wierszy — RLS pilnuje też w bazie). SKU w katalogu kończy się liczbą kontrolerów (-0M/-1M/-2M);
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

export default function ConsoleCatalogView({ isAdmin = false, canSeePrices = false }: { isAdmin?: boolean; canSeePrices?: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [maker, setMaker] = useState("all");
  const [mode, setMode] = useState<"models" | "prices">("models"); // "SKU i ceny" tylko dla Admina i Managera (ceny skupu z Biddera)

  async function load() {
    const { data, error: err } = await supabase.from("console_catalog").select("*").order("position").order("id").limit(1000);
    if (err) setError(err.code === "42P01" ? "Brak tabeli katalogu — uruchom supabase/console-catalog.sql w Supabase (SQL Editor)." : `Nie udało się wczytać katalogu: ${err.message}`);
    else {
      setError("");
      setRows((data as Row[]) || []);
    }
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  const fail = (e: { code?: string; message: string }) =>
    setError(e.code === "23505" ? "Pozycja o takiej nazwie już istnieje — nazwy w katalogu są unikalne." : e.code === "42501" || /row-level security/i.test(e.message) ? "Brak uprawnień — katalog edytuje tylko Admin." : `Nie udało się zapisać: ${e.message}`);

  async function saveField(id: number, field: keyof Row, value: string | null) {
    setError("");
    if (field === "name" && !value) return setError("Nazwa nie może być pusta.");
    if (field === "manufacturer" && !value) return setError("Producent nie może być pusty.");
    const { data, error: err } = await supabase.from("console_catalog").update({ [field]: value }).eq("id", id).select("id");
    if (err) return fail(err);
    if (!data?.length) return setError("Nie zapisano — brak uprawnień (tylko Admin).");
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  // Nowy wiersz ląduje na końcu (position = max + 1) z nazwą tymczasową, którą Admin od razu poprawia w komórce.
  async function insertRow(base?: Row) {
    setError("");
    const position = rows.reduce((m, r) => Math.max(m, r.position), 0) + 1;
    const names = new Set(rows.map((r) => r.name));
    const stem = base ? `${base.name} (kopia)` : "Nowa pozycja";
    let name = stem;
    for (let n = 2; names.has(name); n++) name = `${stem} ${n}`;
    const row: Record<string, string | number | null> = base
      ? { position, manufacturer: base.manufacturer, name, accessories: base.accessories, color: base.color, storage: base.storage, sku_satisfactory: base.sku_satisfactory, sku_good: base.sku_good, sku_very_good: base.sku_very_good }
      : { position, manufacturer: maker !== "all" ? maker : rows[rows.length - 1]?.manufacturer || "Sony Playstation", name };
    const { error: err } = await supabase.from("console_catalog").insert(row);
    if (err) return fail(err);
    setSearch("");
    await load();
  }

  async function deleteRow(r: Row) {
    if (!confirm(`Usunąć z katalogu „${r.name}”? Wpis trafi do dziennika usunięć.`)) return;
    setError("");
    const { data, error: err } = await supabase.from("console_catalog").delete().eq("id", r.id).select("id");
    if (err) return fail(err);
    if (!data?.length) return setError("Nie usunięto — brak uprawnień (tylko Admin).");
    setRows((rs) => rs.filter((x) => x.id !== r.id));
  }

  const cell = (r: Row, field: keyof Row, className: string, placeholder = "—") =>
    isAdmin ? (
      <InlineEditCell value={(r[field] as string | null) ?? null} placeholder={placeholder} className={className} onSave={(v) => saveField(r.id, field, v)} />
    ) : (
      <span className={field.startsWith("sku_") ? "font-mono text-xs whitespace-nowrap" : ""}>{(r[field] as string | null) || <span className="text-inksoft">—</span>}</span>
    );

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
      {canSeePrices && (
        <div className="flex gap-2 mb-3">
          <button onClick={() => setMode("models")} className={pill(mode === "models")}>Modele</button>
          <button onClick={() => setMode("prices")} className={pill(mode === "prices")}>SKU i ceny</button>
        </div>
      )}
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
        {isAdmin && mode === "models" && <button onClick={() => insertRow()} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold">+ Dodaj wiersz</button>}
        <span className="text-xs text-inksoft ml-auto">{shown.length} z {rows.length} pozycji</span>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      {mode === "prices" && canSeePrices ? (
        <ConsoleSkuPrices rows={shown} />
      ) : (
      <>
      <div className="bg-white border border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Producent</th>
              <th className="p-3">Nazwa</th>
              <th className="p-3">Akcesoria</th>
              <th className="p-3">Kolor</th>
              <th className="p-3">Pamięć</th>
              <th className="p-3 border-l border-line">SKU <span className="font-normal">(klasa · z kontrolerami · bez info o kontrolerach)</span></th>
              {isAdmin && <th className="p-3"></th>}
            </tr>
          </thead>
          <tbody>
            {!loading && shown.length === 0 && !error && (
              <tr><td colSpan={isAdmin ? 7 : 6} className="p-6 text-center text-inksoft text-sm">{rows.length === 0 ? "Katalog jest pusty." : "Brak wyników."}</td></tr>
            )}
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 align-top">
                <td className="p-3 text-xs whitespace-nowrap">{cell(r, "manufacturer", "w-32 text-xs")}</td>
                <td className="p-3">{cell(r, "name", "w-80")}</td>
                <td className="p-3 text-xs whitespace-nowrap">{cell(r, "accessories", "w-24 text-xs")}</td>
                <td className="p-3 text-xs whitespace-nowrap">{cell(r, "color", "w-20 text-xs")}</td>
                <td className="p-3 text-xs whitespace-nowrap">{cell(r, "storage", "w-20 text-xs")}</td>
                <td className="p-3 border-l border-line">
                  {/* wszystkie SKU modelu w jednej kolumnie: klasa A (bardzo dobry), B (dobry), C (zadowalający) */}
                  <div className="space-y-1">
                    {(
                      [
                        ["A", "sku_very_good"],
                        ["B", "sku_good"],
                        ["C", "sku_satisfactory"],
                      ] as const
                    ).map(([cls, field]) => (
                      <div key={field} className="flex items-center gap-2">
                        <span className="w-4 shrink-0 text-xs font-semibold text-inksoft" title={cls === "A" ? "bardzo dobry" : cls === "B" ? "dobry" : "zadowalający"}>{cls}</span>
                        {cell(r, field, "w-44 font-mono text-xs")}
                        <span className="text-inksoft">·</span>
                        <span className="font-mono text-xs text-inksoft whitespace-nowrap">{skuWithoutControllers(r[field]) ?? "—"}</span>
                      </div>
                    ))}
                  </div>
                </td>
                {isAdmin && (
                  <td className="p-3 whitespace-nowrap text-xs">
                    <button onClick={() => insertRow(r)} title="Powiel wiersz (np. inny kolor lub liczba padów)" className="text-teal font-semibold hover:underline mr-3">Duplikuj</button>
                    <button onClick={() => deleteRow(r)} className="text-rust font-semibold hover:underline">Usuń</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-inksoft mt-3 max-w-4xl">
        Wszystkie SKU modelu są w jednej kolumnie: klasa A = bardzo dobry, B = dobry, C = zadowalający (ostatni człon SKU); po kropce SKU bez info o kontrolerach — bez końcówki -0M / -1M / -2M, tak samo wyglądają SKU sztuk w Magazynie. Pusty wiersz oznacza model bez przypisanych SKU.{isAdmin && " Admin edytuje komórki wprost (Enter lub wyjście z pola zapisuje, Esc anuluje), dodaje wiersze przyciskiem „+ Dodaj wiersz” albo „Duplikuj” (kopia wiersza z nową nazwą do poprawienia). SKU bez info o kontrolerach (po kropce) liczy się samo z SKU obok."}
      </p>
      </>
      )}
    </div>
  );
}
