"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { escapeLike } from "@/lib/search";
import { skuCategoryOf } from "@/lib/skuParts";
import { summarizeShippingCosts, type ShipmentCostRow } from "@/lib/shippingCosts";
import { warsawYmd } from "@/lib/warsawDate";
import { DEFAULT_ASSUMPTIONS, bmRules, refurbedRules, suggestPrice, type Assumptions, type PriceInputs, type Suggestion, type VatMode } from "@/lib/listingPrice";
import ProductCardDrawer from "./ProductCardDrawer";

// Magazyn -> "Do wystawienia" (16.10.2026, na prośbę właściciela): urządzenia gotowe do wystawienia na sprzedaż wprowadzane skanerem (numer seryjny + SKU). Cena zakupu i koszty
// dodatkowe (serwis, prowizja + PCC) idą z Towaru, a sugerowana cena sprzedaży na Back Market i refurbed jest liczona tak, żeby zysk netto po wszystkich kosztach wynosił ~20% ceny
// (wzór i założenia: lib/listingPrice.ts, ta sama definicja marży co zakładka Marża). Ceny widzą tylko osoby z dostępem do Towaru (RLS) — pozostali widzą samą listę.

type Entry = { id: number; serial_number: string; sku: string; notes: string | null; created_by_email: string | null; created_at: string; listed_at: string | null; listed_by_email: string | null };
type Goods = { serial: string | null; name: string | null; kind: string | null; vat: string | null; price_pln: number | string | null; total_pln: number | string | null; costs: number | string | null; commission_pcc: number | string | null; purchased_on: string | null };
type Filter = "todo" | "done" | "all";

const LS_KEY = "listing-queue-assumptions";
const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const inp = "border border-line bg-white px-3 py-2 rounded text-sm";
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const pln = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct1 = (n: number) => `${(n * 100).toLocaleString("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const normSerial = (s: string | null | undefined) => (s || "").trim().toLowerCase().replace(/^0+/, "");
const fmtDT = (iso: string) => new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const looksLikeSku = (v: string | null | undefined) => /^[A-Za-z0-9][A-Za-z0-9./]*(-[A-Za-z0-9./]+)+$/.test((v || "").trim());

// Warianty zapisu numeru seryjnego (zera wiodące, wielkość liter) do zapytań .in(...)
function serialVariants(s: string): string[] {
  const t = s.trim();
  const stripped = t.replace(/^0+/, "");
  const out = new Set<string>([t, t.toUpperCase(), t.toLowerCase(), stripped, stripped.toUpperCase(), "0" + stripped, "00" + stripped, "0" + stripped.toUpperCase(), "00" + stripped.toUpperCase()]);
  return Array.from(out).filter(Boolean);
}
const inList = (vals: string[]) => `(${vals.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(",")})`;

async function fetchGoods(serials: string[]): Promise<Map<string, Goods>> {
  const out = new Map<string, Goods>();
  for (let i = 0; i < serials.length; i += 40) {
    const vars = serials.slice(i, i + 40).flatMap(serialVariants);
    const { data } = await supabase.from("goods_register_available").select("serial, name, kind, vat, price_pln, total_pln, costs, commission_pcc, purchased_on").filter("serial", "in", inList(vars));
    for (const g of (data as Goods[]) || []) {
      const k = normSerial(g.serial);
      const cur = out.get(k);
      if (!cur || (g.purchased_on || "") > (cur.purchased_on || "")) out.set(k, g); // ten sam numer kilka razy (odkup) — najnowszy zakup
    }
  }
  return out;
}

export default function ListingQueueView({ session, members }: { session: Session; members: MemberLite[] }) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [goods, setGoods] = useState<Map<string, Goods>>(new Map());
  const [filter, setFilter] = useState<Filter>("todo");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [serial, setSerial] = useState("");
  const [sku, setSku] = useState("");
  const [skuHint, setSkuHint] = useState("");
  const [adding, setAdding] = useState(false);
  const [openSerial, setOpenSerial] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [reload, setReload] = useState(0);
  const [eurRate, setEurRate] = useState<{ mid: number; date: string } | null>(null);
  const [shipAvg, setShipAvg] = useState<number | null>(null);
  const [showParams, setShowParams] = useState(false);
  const [a, setA] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);
  const serialRef = useRef<HTMLInputElement>(null);
  const skuRef = useRef<HTMLInputElement>(null);
  const today = warsawYmd(Date.now());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) setA({ ...DEFAULT_ASSUMPTIONS, ...JSON.parse(raw) });
    } catch {
      /* brak localStorage */
    }
    (async () => {
      const { data } = await supabase.from("nbp_rates").select("mid, rate_date").eq("currency", "EUR").order("rate_date", { ascending: false }).limit(1);
      if (data?.[0]) setEurRate({ mid: Number(data[0].mid), date: String(data[0].rate_date) });
      // średni koszt przesyłki z ostatnich 90 dni (tylko jako podpowiedź do założenia o wysyłce; tabela przesyłek jest dostępna dla Admina/Managera/Księgowej)
      const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
      const sh = await supabase.from("shipments").select("created_at, carrier, cancelled_at, environment, charges").gte("created_at", since).limit(2000);
      if (!sh.error && sh.data) {
        const avg = summarizeShippingCosts(sh.data as ShipmentCostRow[]).all.average;
        if (avg) setShipAvg(Math.round(avg * 100) / 100);
      }
    })();
  }, []);
  const setParam = (patch: Partial<Assumptions>) =>
    setA((p) => {
      const n = { ...p, ...patch };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(n));
      } catch {
        /* ignoruj */
      }
      return n;
    });

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let q = supabase.from("listing_queue").select("id, serial_number, sku, notes, created_by_email, created_at, listed_at, listed_by_email");
      if (filter === "todo") q = q.is("listed_at", null);
      else if (filter === "done") q = q.not("listed_at", "is", null);
      if (search) q = q.or(`serial_number.ilike.%${escapeLike(search)}%,sku.ilike.%${escapeLike(search)}%`);
      const { data, error: err } = await q.order("created_at", { ascending: false }).limit(300);
      if (cancelled) return;
      if (err) {
        setError(err.code === "42P01" || /listing_queue/.test(err.message) ? "Brak tabeli — uruchom supabase/listing-queue.sql w Supabase." : `Nie udało się wczytać listy: ${err.message}`);
        setRows([]);
      } else {
        setError("");
        const list = (data as Entry[]) || [];
        setRows(list);
        setGoods(await fetchGoods(Array.from(new Set(list.map((r) => r.serial_number)))));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, search, reload]);

  // Po zeskanowaniu numeru seryjnego podpowiadamy SKU znane z systemu (Towar -> Skup, SKU z magazynu: Testy / Trade-in / import); można je nadpisać skanem SKU.
  async function lookupSku(s: string) {
    setSkuHint("");
    const g = (await fetchGoods([s])).get(normSerial(s));
    let found = g && g.kind === "trade_in" && looksLikeSku(g.name) ? (g.name as string).trim() : "";
    if (!found) {
      const { data } = await supabase.from("fakturownia_stock_with_sku").select("sku").filter("name", "in", inList(serialVariants(s))).not("sku", "is", null).limit(1);
      found = (data?.[0] as { sku?: string } | undefined)?.sku || "";
    }
    if (found) {
      setSku(found);
      setSkuHint("SKU podpowiedziane z systemu — zatwierdź Enterem albo zeskanuj inne.");
    }
    if (!g) setSkuHint((h) => h || "Tego numeru nie ma w Towarze — cena zakupu będzie niedostępna.");
  }

  async function add() {
    const s = serial.trim().toUpperCase();
    const k = sku.trim().toUpperCase();
    if (!s) return serialRef.current?.focus();
    if (!k) return skuRef.current?.focus();
    setAdding(true);
    setError("");
    const { error: err } = await supabase.from("listing_queue").insert({ serial_number: s, sku: k, notes: note.trim() || null });
    setAdding(false);
    if (err) {
      setError(err.code === "23505" ? `Numer ${s} jest już na liście „Do wystawienia”.` : `Nie dodano: ${err.message}`);
      return;
    }
    setSerial("");
    setSku("");
    setSkuHint("");
    setNote("");
    setReload((n) => n + 1);
    serialRef.current?.focus();
  }

  async function toggleListed(r: Entry) {
    const { error: err } = await supabase.from("listing_queue").update({ listed_at: r.listed_at ? null : new Date().toISOString() }).eq("id", r.id);
    if (err) setError(err.code === "23505" ? "To urządzenie jest już ponownie na liście „Do wystawienia”." : `Nie zapisano: ${err.message}`);
    else setReload((n) => n + 1);
  }
  async function remove(r: Entry) {
    if (!confirm(`Usunąć ${r.serial_number} z listy?`)) return;
    const { data, error: err } = await supabase.from("listing_queue").delete().eq("id", r.id).select("id");
    if (err) setError(`Nie usunięto: ${err.message}`);
    else if (!data?.length) setError("Nie usunięto — usuwać może Admin albo osoba, która dodała wpis.");
    else setReload((n) => n + 1);
  }

  // Wyliczenia na wiersz
  const calc = useMemo(() => {
    const out = new Map<number, { g: Goods | null; input: PriceInputs | null; bm: Suggestion | null; rf: Suggestion | null; bmNote: string; rfNote: string; cat: string; vatMissing: boolean }>();
    for (const r of rows) {
      const g = goods.get(normSerial(r.serial_number)) ?? null;
      const purchase = num(g?.price_pln);
      const totalCosts = num(g?.total_pln);
      const extra = purchase !== null ? (totalCosts !== null ? Math.max(0, totalCosts - purchase) : (num(g?.costs) ?? 0) + (num(g?.commission_pcc) ?? 0)) : 0;
      const vat: VatMode = (g?.vat || "").toUpperCase() === "V23" ? "V23" : "VM";
      const input: PriceInputs | null = purchase !== null && purchase > 0 && eurRate ? { purchasePln: purchase, extraPln: extra, vat, shippingPln: a.shippingPln, targetPct: a.targetPct, eurRate: eurRate.mid } : null;
      const bmr = bmRules(r.sku, a, today);
      const rfr = refurbedRules(a);
      out.set(r.id, {
        g,
        input,
        bm: input ? suggestPrice(input, bmr.rules) : null,
        rf: input ? suggestPrice(input, rfr.rules) : null,
        bmNote: bmr.note,
        rfNote: rfr.note,
        cat: skuCategoryOf(r.sku),
        vatMissing: !!g && !["VM", "V23"].includes((g.vat || "").toUpperCase()),
      });
    }
    return out;
  }, [rows, goods, a, eurRate, today]);

  const SugCell = ({ s }: { s: Suggestion | null }) =>
    s ? (
      <div className="whitespace-nowrap">
        <div className="font-mono font-bold text-base">{s.eur.toLocaleString("pl-PL")} €</div>
        <div className="text-[11px] text-inksoft font-mono">{pln(s.pricePln)} zł</div>
        <div className="text-[11px] text-teal font-mono" title="Zysk netto po wszystkich kosztach przy tej cenie">zysk {pln(s.margin.marginPln)} zł · {pct1(s.margin.marginPct)}</div>
      </div>
    ) : (
      <span className="text-inksoft">—</span>
    );

  const Breakdown = ({ s, title, note, input }: { s: Suggestion | null; title: string; note: string; input: PriceInputs | null }) =>
    !s || !input ? null : (
      <div className="text-xs">
        <div className="font-semibold mb-1">{title} — {s.eur} € ({pln(s.pricePln)} zł brutto)</div>
        <div className="text-inksoft mb-1">{note}</div>
        <table className="font-mono">
          <tbody>
            <tr><td className="pr-4">Cena sprzedaży brutto</td><td className="text-right">{pln(s.margin.salePln)}</td></tr>
            <tr><td className="pr-4">− cena zakupu {input.vat === "V23" ? "(netto, V23)" : ""}</td><td className="text-right">{pln(input.purchasePln)}</td></tr>
            <tr><td className="pr-4">− {input.vat === "V23" ? "VAT należny 23% od całej ceny" : "VAT od marży 23/123"}</td><td className="text-right">{pln(s.margin.vatPln)}</td></tr>
            <tr><td className="pr-4">− wysyłka do klienta</td><td className="text-right">{pln(input.shippingPln)}</td></tr>
            <tr><td className="pr-4">− koszty dodatkowe (serwis, prowizja + PCC z Towaru)</td><td className="text-right">{pln(input.extraPln)}</td></tr>
            <tr><td className="pr-4">− prowizja i opłaty marketplace'u</td><td className="text-right">{pln(s.margin.commissionPln)}</td></tr>
            <tr className="font-bold border-t border-line"><td className="pr-4">= zysk netto</td><td className="text-right">{pln(s.margin.marginPln)} ({pct1(s.margin.marginPct)})</td></tr>
          </tbody>
        </table>
      </div>
    );

  const todoCount = rows.filter((r) => !r.listed_at).length;
  const anyGoods = goods.size > 0;

  return (
    <div>
      <div className="border border-line bg-white p-4 mb-4">
        <h2 className="text-xs font-semibold text-inksoft mb-3">DODAJ URZĄDZENIE (skaner: numer seryjny → Enter → SKU → Enter)</h2>
        <div className="flex flex-wrap gap-3 items-start">
          <div>
            <label className="text-xs font-semibold text-inksoft block mb-1">Numer seryjny *</label>
            <input
              ref={serialRef}
              autoFocus
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (!serial.trim()) return;
                  lookupSku(serial.trim()).finally(() => skuRef.current?.focus());
                }
              }}
              placeholder="zeskanuj numer seryjny"
              className={`${inp} w-64 font-mono`}
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-inksoft block mb-1">SKU *</label>
            <input
              ref={skuRef}
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="zeskanuj SKU"
              className={`${inp} w-64 font-mono`}
            />
          </div>
          <div className="flex-1 min-w-[12rem]">
            <label className="text-xs font-semibold text-inksoft block mb-1">Uwagi (opcjonalnie)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} className={`${inp} w-full`} />
          </div>
          <button onClick={add} disabled={adding || !serial.trim() || !sku.trim()} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50 self-end">{adding ? "Dodawanie…" : "Dodaj"}</button>
        </div>
        {skuHint && <p className="text-xs text-inksoft mt-2">{skuHint}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {([["todo", "Do wystawienia"], ["done", "Wystawione"], ["all", "Wszystkie"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)} className={pill(filter === k)}>{label}{filter === "todo" && k === "todo" ? <span className="ml-1.5 text-xs font-normal opacity-70">{todoCount}</span> : null}</button>
        ))}
        <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Szukaj: numer seryjny albo SKU" className={`${inp} w-64 ml-2`} />
        <button onClick={() => setShowParams((v) => !v)} className="ml-auto border border-line bg-white px-3 py-1.5 rounded text-sm font-semibold">{showParams ? "Ukryj założenia" : "Założenia cen"}</button>
      </div>

      {showParams && (
        <div className="border border-line bg-white p-4 mb-3 text-sm">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <label className="text-xs font-semibold text-inksoft">Docelowy zysk netto (% ceny)
              <input type="number" step="0.5" value={a.targetPct} onChange={(e) => setParam({ targetPct: Number(e.target.value) || 0 })} className={`${inp} w-full mt-1 font-mono`} />
            </label>
            <label className="text-xs font-semibold text-inksoft">Wysyłka do klienta (zł netto)
              <input type="number" step="1" value={a.shippingPln} onChange={(e) => setParam({ shippingPln: Number(e.target.value) || 0 })} className={`${inp} w-full mt-1 font-mono`} />
              {shipAvg !== null && <button type="button" onClick={() => setParam({ shippingPln: shipAvg })} className="text-teal font-normal underline block mt-0.5">użyj średniej z ostatnich przesyłek: {pln(shipAvg)}</button>}
            </label>
            <label className="text-xs font-semibold text-inksoft">Back Market: kraj sprzedaży
              <select value={a.bmCountry} onChange={(e) => setParam({ bmCountry: e.target.value })} className={`${inp} w-full mt-1`}>
                {["FR", "DE", "ES", "IT", "PL", "NL", "BE", "AT"].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-inksoft">Back Market: opłata płatnicza (%)
              <input type="number" step="0.1" value={a.bmPaymentPct} onChange={(e) => setParam({ bmPaymentPct: Number(e.target.value) || 0 })} className={`${inp} w-full mt-1 font-mono`} />
            </label>
            <label className="text-xs font-semibold text-inksoft">refurbed: prowizja (%)
              <input type="number" step="0.1" value={a.rfCommissionPct} onChange={(e) => setParam({ rfCommissionPct: Number(e.target.value) || 0 })} className={`${inp} w-full mt-1 font-mono`} />
            </label>
            <label className="text-xs font-semibold text-inksoft">refurbed: opłata płatnicza (%)
              <input type="number" step="0.1" value={a.rfPaymentPct} onChange={(e) => setParam({ rfPaymentPct: Number(e.target.value) || 0 })} className={`${inp} w-full mt-1 font-mono`} />
            </label>
          </div>
          <p className="text-[11px] text-inksoft mt-3 max-w-4xl">
            Założenia zapamiętuje ta przeglądarka. Kurs EUR: {eurRate ? `${eurRate.mid.toLocaleString("pl-PL", { minimumFractionDigits: 4 })} (NBP z ${eurRate.date})` : "brak kursu NBP — odśwież kursy w zakładce NBP"}.
            Marża liczona jak w zakładce Marża: cena brutto − zakup − VAT (od marży 23/123 albo 23% dla V23) − wysyłka − koszty dodatkowe z Towaru (serwis, prowizja Buyback, PCC) − prowizja i opłaty marketplace'u; % = zysk ÷ cena sprzedaży.
            Back Market: prowizja wg reguł z Marży (konsole do FR/DE/ES/IT 6% tylko do 31.12.2026, potem 11%; akcesoria 20%), płatność 1%, CCBM 6,99 € (akcesoria 1,99 €). refurbed: 12% + 1,5% wg danych naszych zamówień.
            Cena jest zaokrąglana w górę do pełnego euro. To sugestia — nie uwzględnia konkurencji na marketplace'ie.
          </p>
        </div>
      )}

      {error && <p className="text-rust text-xs mb-3">{error}</p>}
      {!loading && rows.length > 0 && !anyGoods && <p className="text-amber text-xs mb-3">Nie znaleziono tych numerów w Towarze (albo nie masz dostępu do zakładki Towar) — ceny zakupu i sugestie są niedostępne.</p>}

      <div className="bg-white border border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Dodano</th>
              <th className="p-3">Numer seryjny</th>
              <th className="p-3">SKU</th>
              <th className="p-3 text-right">Cena zakupu</th>
              <th className="p-3 text-right" title="Serwis + prowizja Buyback + PCC z Towaru">Koszty dod.</th>
              <th className="p-3">Back Market — sugerowana cena</th>
              <th className="p-3">refurbed — sugerowana cena</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && !error && <tr><td colSpan={8} className="p-6 text-center text-inksoft text-sm">{search ? "Brak wyników." : filter === "done" ? "Nic jeszcze nie oznaczono jako wystawione." : "Lista jest pusta — zeskanuj pierwsze urządzenie powyżej."}</td></tr>}
            {rows.map((r) => {
              const c = calc.get(r.id)!;
              const open = expanded.has(r.id);
              return (
                <Fragment key={r.id}>
                  <tr className={`border-b border-line align-top ${r.listed_at ? "opacity-60" : ""}`}>
                    <td className="p-3 text-xs whitespace-nowrap">
                      <div>{fmtDT(r.created_at)}</div>
                      <div className="text-inksoft">{displayNameForEmail(r.created_by_email, members)}</div>
                    </td>
                    <td className="p-3 font-mono text-xs">
                      {r.serial_number} <button onClick={() => setOpenSerial(r.serial_number)} title="Otwórz kartę produktu" className="text-teal">↗</button>
                      {r.notes && <div className="font-sans text-inksoft mt-0.5">{r.notes}</div>}
                    </td>
                    <td className="p-3 font-mono text-xs">
                      {r.sku}
                      <div className="text-inksoft font-sans">{c.cat}</div>
                    </td>
                    <td className="p-3 text-right font-mono whitespace-nowrap">
                      {c.g ? (
                        <>
                          {pln(num(c.g.price_pln))}
                          <div className="text-[11px] text-inksoft font-sans">{(c.g.vat || "").toUpperCase() === "V23" ? "V23 (netto)" : c.g.vat ? c.g.vat : "VAT?"}</div>
                        </>
                      ) : <span className="text-inksoft font-sans text-xs">brak w Towarze</span>}
                    </td>
                    <td className="p-3 text-right font-mono whitespace-nowrap">{c.input ? pln(c.input.extraPln) : "—"}</td>
                    <td className="p-3"><SugCell s={c.bm} /></td>
                    <td className="p-3"><SugCell s={c.rf} /></td>
                    <td className="p-3 whitespace-nowrap text-xs">
                      {c.input && <button onClick={() => setExpanded((p) => { const n = new Set(p); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} className="text-inksoft font-semibold mr-3" title="Pokaż wyliczenie">{open ? "▾ Wyliczenie" : "▸ Wyliczenie"}</button>}
                      <button onClick={() => toggleListed(r)} className="text-teal font-semibold mr-3">{r.listed_at ? "Cofnij" : "Wystawione ✓"}</button>
                      <button onClick={() => remove(r)} className="text-rust font-semibold">Usuń</button>
                      {r.listed_at && <div className="text-inksoft mt-1">wystawiono {fmtDT(r.listed_at)} · {displayNameForEmail(r.listed_by_email, members)}</div>}
                      {c.vatMissing && <div className="text-amber mt-1" title="W Towarze brak VAT (VM/V23) — liczone jak VM">brak VAT w Towarze</div>}
                    </td>
                  </tr>
                  {open && c.input && (
                    <tr className="border-b border-line bg-paper">
                      <td colSpan={8} className="p-4">
                        <div className="grid md:grid-cols-2 gap-6">
                          <Breakdown s={c.bm} title="Back Market" note={c.bmNote} input={c.input} />
                          <Breakdown s={c.rf} title="refurbed" note={c.rfNote} input={c.input} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {openSerial && <ProductCardDrawer serial={openSerial} members={members} onClose={() => setOpenSerial(null)} />}
    </div>
  );
}
