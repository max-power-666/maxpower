"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { SHOP_URL, formatPln, gradeLabel, type ShopCategory, type ShopGrade } from "@/lib/shop";

// Recoo Sklep → Magazyn: ręczny stan wariantów (decyzja właściciela — bez numerów seryjnych).
// Każda zmiana idzie przez funkcję bazy shop_stock_change (supabase/shop.sql): blokada wiersza, pilnowanie zera
// i zapis ruchu w shop_stock_moves w jednej transakcji. Bezpośredni UPDATE stanu baza odrzuca.

type Row = {
  id: string;
  sku: string;
  option_value: string | null;
  grade: ShopGrade;
  price: number;
  stock: number;
  active: boolean;
  sort: number;
  model: { id: string; name: string; slug: string; published: boolean; category_slug: string; option_label: string | null; sort: number };
};

type Move = {
  id: number;
  variant_id: string | null;
  sku: string;
  model_name: string | null;
  kind: "przyjecie" | "wydanie" | "korekta";
  delta: number;
  stock_before: number;
  stock_after: number;
  note: string | null;
  by_email: string | null;
  at: string;
};

type Kind = Move["kind"];
const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "przyjecie", label: "Przyjęcie (+)", hint: "np. sztuki po teście/serwisie gotowe do sprzedaży" },
  { value: "wydanie", label: "Wydanie (−)", hint: "np. sprzedaż w innym kanale, uszkodzenie, zwrot do serwisu" },
  { value: "korekta", label: "Korekta (=)", hint: "ustaw dokładną liczbę, np. po inwentaryzacji" },
];
const kindLabel = (k: Kind) => ({ przyjecie: "Przyjęcie", wydanie: "Wydanie", korekta: "Korekta" })[k];

const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

type Filter = "all" | "zero" | "instock";

export default function ShopStockView({ members }: { members: MemberLite[] }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [moves, setMoves] = useState<Move[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [missingSchema, setMissingSchema] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [onlyPublished, setOnlyPublished] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [historySku, setHistorySku] = useState<string | null>(null);
  const loadSeq = useRef(0);

  async function load() {
    const seq = ++loadSeq.current;
    const [v, c, m] = await Promise.all([
      supabase
        .from("shop_variants")
        .select("id, sku, option_value, grade, price, stock, active, sort, model:shop_models(id, name, slug, published, category_slug, option_label, sort)"),
      supabase.from("shop_categories").select("*").order("sort"),
      supabase.from("shop_stock_moves").select("*").order("at", { ascending: false }).limit(200),
    ]);
    if (seq !== loadSeq.current) return;
    setLoading(false);
    const err = v.error || c.error || m.error;
    if (err) {
      setMissingSchema(err.code === "42P01" || /does not exist|schema cache/i.test(err.message));
      return setError(err.message);
    }
    setError("");
    setMissingSchema(false);
    const list = ((v.data as unknown as Row[]) ?? []).filter((r) => r.model);
    list.sort((a, b) => a.model.sort - b.model.sort || a.model.name.localeCompare(b.model.name, "pl") || a.sort - b.sort);
    setRows(list);
    setCategories((c.data as ShopCategory[]) ?? []);
    setMoves((m.data as Move[]) ?? []);
  }

  useEffect(() => {
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 600);
    };
    const channel = supabase
      .channel("shop-stock")
      .on("postgres_changes", { event: "*", schema: "public", table: "shop_variants" }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "shop_stock_moves" }, reload)
      .subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function change(row: Row, kind: Kind, qty: number, note: string) {
    setBusyId(row.id);
    setError("");
    const { data, error } = await supabase.rpc("shop_stock_change", { p_variant_id: row.id, p_kind: kind, p_qty: qty, p_note: note || null });
    setBusyId(null);
    if (error) {
      setError(`${row.sku}: ${error.message}`);
      return false;
    }
    // od razu pokazujemy nowy stan; pełne odświeżenie (z ruchem w historii) przyjdzie z realtime
    setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, stock: data as number } : r)));
    load();
    return true;
  }

  const catName = (slug: string) => categories.find((c) => c.slug === slug)?.name ?? slug;

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!category || r.model.category_slug === category) &&
        (!onlyPublished || (r.model.published && r.active)) &&
        (filter === "all" || (filter === "zero" ? r.stock === 0 : r.stock > 0)) &&
        (!q || `${r.model.name} ${r.sku} ${r.option_value ?? ""}`.toLowerCase().includes(q)),
    );
  }, [rows, search, category, filter, onlyPublished]);

  const totals = useMemo(() => {
    const sellable = rows.filter((r) => r.active && r.model.published);
    return {
      units: sellable.reduce((s, r) => s + r.stock, 0),
      value: sellable.reduce((s, r) => s + r.stock * Number(r.price), 0),
      zero: sellable.filter((r) => r.stock === 0).length,
      variants: sellable.length,
    };
  }, [rows]);

  const shownMoves = historySku ? moves.filter((m) => m.sku === historySku) : moves.slice(0, 30);

  if (missingSchema || /shop_stock_moves/.test(error)) {
    return (
      <div className="border border-line bg-white p-6 max-w-2xl">
        <h2 className="text-sm font-semibold mb-2">Magazyn sklepu wymaga aktualizacji bazy</h2>
        <p className="text-sm text-inksoft">
          Uruchom ponownie plik <b>supabase/shop.sql</b> w Supabase → SQL Editor (dodaje historię ruchów magazynowych). Plik jest
          bezpieczny do ponownego uruchomienia — nie nadpisze zmian w produktach.
        </p>
        <p className="text-xs text-inksoft mt-3">Szczegóły: {error}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-4 border border-line bg-white mb-4">
        <Tile label="SZTUK NA STANIE" value={String(totals.units)} note="opublikowane, aktywne warianty" />
        <Tile label="WARTOŚĆ (CENY SPRZEDAŻY)" value={formatPln(totals.value)} note="suma: stan × cena w sklepie" />
        <Tile label="WARIANTY W SPRZEDAŻY" value={String(totals.variants)} note="widoczne w sklepie" />
        <Tile label="BRAK NA STANIE" value={String(totals.zero)} note="widoczne, ale nie do kupienia" warn={totals.zero > 0} />
      </div>

      {error && <div className="mb-4 border border-rust bg-rustsoft text-rust px-3 py-2 text-sm">{error}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Szukaj: produkt, SKU, opcja" className="w-64 border border-line bg-white px-3 py-2 rounded text-sm" />
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="border border-line bg-white px-2 py-2 rounded text-sm">
          <option value="">Wszystkie kategorie</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
              {c.hidden ? " (ukryta)" : ""}
            </option>
          ))}
        </select>
        {(["all", "zero", "instock"] as Filter[]).map((f) => (
          <button key={f} className={pill(filter === f)} onClick={() => setFilter(f)}>
            {f === "all" ? "Wszystkie" : f === "zero" ? "Brak na stanie" : "Na stanie"}
          </button>
        ))}
        <label className="flex items-center gap-2 text-sm ml-2 cursor-pointer">
          <input type="checkbox" checked={onlyPublished} onChange={(e) => setOnlyPublished(e.target.checked)} />
          tylko widoczne w sklepie
        </label>
      </div>

      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Produkt</th>
              <th className="p-3">Wariant</th>
              <th className="p-3">SKU</th>
              <th className="p-3">Cena</th>
              <th className="p-3 text-center">Stan</th>
              <th className="p-3">Zmień stan</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="p-6 text-center text-inksoft">Ładowanie…</td></tr>}
            {!loading && list.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-inksoft">Brak wariantów dla wybranych filtrów.</td></tr>}
            {list.map((r) => {
              const sellable = r.active && r.model.published;
              return (
                <tr key={r.id} className={`border-b border-line last:border-b-0 align-middle ${sellable ? "" : "text-inksoft"}`}>
                  <td className="p-3">
                    <div className="font-semibold">{r.model.name}</div>
                    <div className="text-xs text-inksoft">
                      {catName(r.model.category_slug)}
                      {!r.model.published && " · szkic"}
                      {r.model.published && !r.active && " · wariant nieaktywny"}
                    </div>
                  </td>
                  <td className="p-3 whitespace-nowrap">
                    {r.option_value ? `${r.option_value} · ` : ""}
                    {gradeLabel(r.grade)}
                  </td>
                  <td className="p-3 font-mono text-xs">{r.sku}</td>
                  <td className="p-3 whitespace-nowrap">{formatPln(Number(r.price))}</td>
                  <td className={`p-3 text-center text-lg font-semibold tabular-nums ${r.stock === 0 ? "text-rust" : ""}`}>{r.stock}</td>
                  <td className="p-3">
                    {editId === r.id ? (
                      <ChangeForm
                        row={r}
                        busy={busyId === r.id}
                        onCancel={() => setEditId(null)}
                        onSubmit={async (kind, qty, note) => {
                          if (await change(r, kind, qty, note)) setEditId(null);
                        }}
                      />
                    ) : (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => change(r, "wydanie", 1, "")}
                          disabled={busyId === r.id || r.stock === 0}
                          title="Wydanie 1 szt."
                          aria-label={`Wydaj 1 szt. ${r.sku}`}
                          className="h-8 w-8 border border-line bg-white rounded font-semibold disabled:opacity-30"
                        >
                          −
                        </button>
                        <button
                          onClick={() => change(r, "przyjecie", 1, "")}
                          disabled={busyId === r.id}
                          title="Przyjęcie 1 szt."
                          aria-label={`Przyjmij 1 szt. ${r.sku}`}
                          className="h-8 w-8 border border-line bg-white rounded font-semibold disabled:opacity-30"
                        >
                          +
                        </button>
                        <button onClick={() => setEditId(r.id)} className="ml-2 text-xs font-semibold text-teal hover:underline whitespace-nowrap">
                          Więcej…
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <button onClick={() => setHistorySku(historySku === r.sku ? null : r.sku)} className="text-xs font-semibold text-teal hover:underline">
                      {historySku === r.sku ? "Cała historia" : "Historia"}
                    </button>
                    {r.model.published && (
                      <a href={`${SHOP_URL}/produkt/${r.model.slug}`} target="_blank" rel="noreferrer" className="ml-3 text-xs font-semibold text-teal hover:underline">
                        W sklepie ↗
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-inksoft">
        {list.length} z {rows.length} wariantów. Przyciski − / + to szybkie wydanie / przyjęcie 1 szt.; „Więcej…” pozwala podać ilość,
        korektę do konkretnej liczby i notatkę. Sklep pokazuje nowy stan w ciągu minuty.
      </p>

      <section className="mt-8">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-inksoft">
            {historySku ? `HISTORIA RUCHÓW: ${historySku}` : "OSTATNIE RUCHY MAGAZYNOWE"}
          </h3>
          {historySku && (
            <button onClick={() => setHistorySku(null)} className="text-xs font-semibold text-teal hover:underline">Pokaż wszystkie</button>
          )}
        </div>
        <div className="border border-line bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-inksoft border-b border-line">
                <th className="p-3">Kiedy</th>
                <th className="p-3">Kto</th>
                <th className="p-3">Produkt / SKU</th>
                <th className="p-3">Rodzaj</th>
                <th className="p-3 text-right">Zmiana</th>
                <th className="p-3 text-right">Stan</th>
                <th className="p-3">Notatka</th>
              </tr>
            </thead>
            <tbody>
              {shownMoves.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-inksoft">Brak ruchów.</td></tr>}
              {shownMoves.map((m) => (
                <tr key={m.id} className="border-b border-line last:border-b-0">
                  <td className="p-3 whitespace-nowrap text-xs">{new Date(m.at).toLocaleString("pl-PL")}</td>
                  <td className="p-3 whitespace-nowrap">{displayNameForEmail(m.by_email, members)}</td>
                  <td className="p-3">
                    <div>{m.model_name ?? "—"}</div>
                    <div className="font-mono text-xs text-inksoft">{m.sku}</div>
                  </td>
                  <td className="p-3">{kindLabel(m.kind)}</td>
                  <td className={`p-3 text-right font-semibold tabular-nums ${m.delta > 0 ? "text-teal" : "text-rust"}`}>
                    {m.delta > 0 ? `+${m.delta}` : m.delta}
                  </td>
                  <td className="p-3 text-right tabular-nums text-inksoft whitespace-nowrap">
                    {m.stock_before} → <span className="text-ink font-semibold">{m.stock_after}</span>
                  </td>
                  <td className="p-3 text-inksoft">{m.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Tile({ label, value, note, warn = false }: { label: string; value: string; note: string; warn?: boolean }) {
  return (
    <div className="p-4 border-r border-line last:border-r-0">
      <div className="text-xs text-inksoft">{label}</div>
      <div className={`text-2xl font-semibold mt-1 tabular-nums ${warn ? "text-rust" : ""}`}>{value}</div>
      <div className="text-xs text-inksoft mt-0.5">{note}</div>
    </div>
  );
}

function ChangeForm({
  row,
  busy,
  onCancel,
  onSubmit,
}: {
  row: Row;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (kind: Kind, qty: number, note: string) => void;
}) {
  const [kind, setKind] = useState<Kind>("przyjecie");
  const [qty, setQty] = useState(kind === "korekta" ? String(row.stock) : "1");
  const [note, setNote] = useState("");
  const n = Number(qty);
  const valid = Number.isInteger(n) && n >= 0 && (kind === "korekta" || n > 0) && (kind !== "wydanie" || n <= row.stock);
  const after = kind === "przyjecie" ? row.stock + n : kind === "wydanie" ? row.stock - n : n;

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(kind, n, note);
      }}
    >
      <select
        value={kind}
        onChange={(e) => {
          const k = e.target.value as Kind;
          setKind(k);
          setQty(k === "korekta" ? String(row.stock) : "1");
        }}
        title={KINDS.find((k) => k.value === kind)?.hint}
        className="border border-line bg-white px-2 py-1 rounded text-sm"
      >
        {KINDS.map((k) => (
          <option key={k.value} value={k.value}>{k.label}</option>
        ))}
      </select>
      <input
        autoFocus
        value={qty}
        onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))}
        inputMode="numeric"
        aria-label={kind === "korekta" ? "Nowy stan" : "Ilość"}
        className="w-16 border border-line bg-white px-2 py-1 rounded text-sm text-right"
      />
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Notatka (np. sprzedaż na Allegro)"
        className="w-52 border border-line bg-white px-2 py-1 rounded text-sm"
      />
      <span className="text-xs text-inksoft whitespace-nowrap">
        {valid ? `stan: ${row.stock} → ${after}` : kind === "wydanie" && n > row.stock ? `na stanie tylko ${row.stock}` : ""}
      </span>
      <button type="submit" disabled={!valid || busy} className="px-3 py-1 rounded bg-ink text-paper text-sm font-semibold disabled:opacity-40">
        {busy ? "…" : "Zapisz"}
      </button>
      <button type="button" onClick={onCancel} className="text-xs text-inksoft hover:underline">Anuluj</button>
    </form>
  );
}
