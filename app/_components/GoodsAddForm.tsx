"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { escapeLike } from "@/lib/search";
import { warsawYmd } from "@/lib/warsawDate";
import { countryFromOrderNo, goodsPricePln, goodsTotalPln, suggestTradeInFees } from "@/lib/goods";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";

// Formularz "Dodaj towar" (10.10.2026): jeden wiersz rejestru goods_register dla bieżącej pigułki (VM, V23 albo Skup).
// Ten sam formularz służy Adminowi do EDYCJI istniejącego wiersza (prop `edit`): pola z zapisaną wartością są wtedy traktowane jak wpisane ręcznie
// (zmiana ceny/waluty/daty NIE przelicza po cichu kursu ani kwot — jest link "przelicz ponownie"), jest pole Grupa (VM / V23 / Skup) i historia zmian.
// Pola liczone — kurs NBP (ostatni dzień roboczy PRZED datą zakupu), Cena PLN, PCC, prowizja + PCC, cena PLN + koszty — są PODPOWIEDZIĄ:
// wypełniają się same, a każde można poprawić ręcznie (wtedy przestaje się przeliczać). Zapis idzie wprost do bazy (RLS: Admin i Manager).

type Kind = "vm_v23" | "trade_in";
type Group = "VM" | "V23" | "Skup";

export type GoodsEditRow = {
  id: number;
  kind: Kind;
  serial: string | null;
  name: string | null;
  supplier: string | null;
  purchased_on: string | null;
  delivered_on: string | null;
  order_no: string | null;
  invoice_no: string | null;
  category: string | null;
  price: number | null;
  vat: string | null;
  currency: string | null;
  nbp_rate: number | null;
  costs: number | null;
  total_pln: number | null;
  price_pln: number | null;
  pcc: number | null;
  country: string | null;
  commission_pcc: number | null;
  history?: { at: string; by: string | null; changes: { field: string; from: unknown; to: unknown }[] }[];
};

const groupOfRow = (r: { vat: string | null; kind: Kind }): Group => (r.vat === "V23" ? "V23" : r.kind === "trade_in" ? "Skup" : "VM");
const FIELD_LABEL: Record<string, string> = {
  kind: "Rodzaj", serial: "Numer seryjny", name: "Nazwa", supplier: "Dostawca", purchased_on: "Data zakupu", delivered_on: "Data dostawy", order_no: "Nr zamówienia",
  invoice_no: "Nr faktury/DW", category: "Kategoria", price: "Cena zakupu", vat: "VAT", currency: "Waluta", nbp_rate: "Kurs NBP", costs: "Koszty",
  total_pln: "Cena PLN + koszty", price_pln: "Cena PLN", pcc: "PCC", country: "Kraj", commission_pcc: "Prowizja + PCC",
};
const fmtVal = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

const CURRENCIES = ["PLN", "EUR", "GBP"];
const COUNTRIES = ["FR", "DE", "ES", "IT"];
const inputCls = "w-full border border-line bg-white px-2 py-1.5 rounded text-sm";
const labelCls = "text-xs font-semibold text-inksoft block mb-1";

// Liczba z pola tekstowego (przecinek lub kropka): null = puste, NaN = niepoprawne.
function parseNum(s: string): number | null {
  const t = s.trim().replace(/\s/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
const show = (n: number | null) => (n === null || Number.isNaN(n) ? "" : String(n));
const fmtDate = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

type Form = {
  serial: string;
  name: string;
  supplier: string;
  purchased_on: string;
  delivered_on: string;
  order_no: string;
  invoice_no: string;
  category: string;
  price: string;
  vat: string;
  currency: string;
  nbp_rate: string;
  costs: string;
  price_pln: string;
  pcc: string;
  country: string;
  commission_pcc: string;
  total_pln: string;
};
type Computed = "nbp_rate" | "price_pln" | "pcc" | "commission_pcc" | "total_pln" | "country";

const initial = (kind: Kind, vat: string): Form => {
  const today = warsawYmd(Date.now());
  return {
    serial: "",
    name: "",
    supplier: kind === "trade_in" ? "BB" : "",
    purchased_on: today,
    delivered_on: today,
    order_no: "",
    invoice_no: "",
    category: kind === "trade_in" ? "Konsola" : "",
    price: "",
    vat,
    currency: kind === "trade_in" ? "EUR" : "PLN",
    nbp_rate: "",
    costs: "",
    price_pln: "",
    pcc: "",
    country: "",
    commission_pcc: "",
    total_pln: "",
  };
};

const fromEdit = (e: GoodsEditRow): Form => ({
  serial: e.serial ?? "",
  name: e.name ?? "",
  supplier: e.supplier ?? "",
  purchased_on: e.purchased_on ?? "",
  delivered_on: e.delivered_on ?? "",
  order_no: e.order_no ?? "",
  invoice_no: e.invoice_no ?? "",
  category: e.category ?? "",
  price: show(e.price),
  vat: e.vat ?? "",
  currency: e.currency ?? "",
  nbp_rate: show(e.nbp_rate),
  costs: show(e.costs),
  price_pln: show(e.price_pln),
  pcc: show(e.pcc),
  country: e.country ?? "",
  commission_pcc: show(e.commission_pcc),
  total_pln: show(e.total_pln),
});
// Pola liczone, które mają zapisaną wartość — przy edycji zostają "ręczne", żeby zapis nie przeliczył ich po cichu innym kursem.
const manualFromEdit = (e: GoodsEditRow): Set<Computed> => {
  const m = new Set<Computed>();
  if (e.nbp_rate !== null) m.add("nbp_rate");
  if (e.price_pln !== null) m.add("price_pln");
  if (e.pcc !== null) m.add("pcc");
  if (e.commission_pcc !== null) m.add("commission_pcc");
  if (e.total_pln !== null) m.add("total_pln");
  if (e.country) m.add("country");
  return m;
};

export default function GoodsAddForm({
  kind,
  vatFixed,
  session,
  categories,
  suppliers,
  onAdded,
  onClose,
  edit = null,
  members = [],
}: {
  kind: Kind;
  vatFixed: "VM" | "V23"; // VAT wynika z pigułki (VM / V23 / Skup = VM) — formularz go nie zmienia
  session: Session;
  categories: string[];
  suppliers: string[];
  onAdded: () => void;
  onClose: () => void;
  edit?: GoodsEditRow | null; // tryb edycji (Admin): zapis to UPDATE tego wiersza
  members?: MemberLite[];
}) {
  const isEdit = !!edit;
  const initialGroup: Group = edit ? groupOfRow(edit) : vatFixed === "V23" ? "V23" : kind === "trade_in" ? "Skup" : "VM";
  const [group, setGroup] = useState<Group>(initialGroup);
  const groupChanged = isEdit && group !== initialGroup;
  // Rodzaj i VAT: przy dodawaniu wynikają z pigułki; przy edycji — z pola Grupa (bez zmiany grupy zostają dokładnie takie, jakie były, np. pusty VAT).
  const effKind: Kind = isEdit ? (groupChanged ? (group === "Skup" ? "trade_in" : "vm_v23") : edit!.kind) : kind;
  const effVat: string | null = isEdit ? (groupChanged ? (group === "V23" ? "V23" : "VM") : edit!.vat) : vatFixed;
  const isTradeIn = effKind === "trade_in";
  const [f, setF] = useState<Form>(() => (edit ? fromEdit(edit) : initial(kind, vatFixed)));
  const [manual, setManual] = useState<Set<Computed>>(() => (edit ? manualFromEdit(edit) : new Set()));
  const [autoRate, setAutoRate] = useState<{ mid: number; date: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const set = (k: keyof Form, v: string) => setF((prev) => ({ ...prev, [k]: v }));
  const setComputed = (k: Computed, v: string) => {
    setManual((prev) => new Set(prev).add(k));
    set(k, v);
  };
  const resetComputed = (k: Computed) =>
    setManual((prev) => {
      const next = new Set(prev);
      next.delete(k);
      return next;
    });

  // Kurs NBP z ostatniego dnia roboczego PRZED datą zakupu (zasada księgowa jak w całej aplikacji) — tabela nbp_rates ma EUR i DKK; dla innych walut wpisujesz ręcznie.
  useEffect(() => {
    let cancelled = false;
    setAutoRate(null);
    if (!f.currency || f.currency === "PLN" || !/^\d{4}-\d{2}-\d{2}$/.test(f.purchased_on)) return;
    (async () => {
      const { data } = await supabase.from("nbp_rates").select("mid, rate_date").eq("currency", f.currency).lt("rate_date", f.purchased_on).order("rate_date", { ascending: false }).limit(1);
      const row = (data as { mid: number; rate_date: string }[] | null)?.[0];
      if (!cancelled && row) setAutoRate({ mid: Number(row.mid), date: row.rate_date });
    })();
    return () => {
      cancelled = true;
    };
  }, [f.currency, f.purchased_on]);

  // Wartości wyliczone (używane, dopóki pole nie zostało ręcznie poprawione).
  const price = parseNum(f.price);
  const nbp = !f.currency || f.currency === "PLN" ? null : manual.has("nbp_rate") ? parseNum(f.nbp_rate) : autoRate?.mid ?? null;
  const pricePln = manual.has("price_pln") ? parseNum(f.price_pln) : goodsPricePln(price !== null && !Number.isNaN(price) ? price : null, f.currency, nbp !== null && !Number.isNaN(nbp) ? nbp : null);
  const fees = isTradeIn ? suggestTradeInFees({ price: price !== null && !Number.isNaN(price) ? price : null, pricePln: pricePln !== null && !Number.isNaN(pricePln) ? pricePln : null, nbp: nbp !== null && !Number.isNaN(nbp) ? nbp : null, category: f.category }) : null;
  const pcc = manual.has("pcc") ? parseNum(f.pcc) : fees?.pcc ?? null;
  const commissionPcc = manual.has("commission_pcc") ? parseNum(f.commission_pcc) : fees?.commissionPcc ?? null;
  const costs = parseNum(f.costs);
  const clean = (n: number | null) => (n === null || Number.isNaN(n) ? null : n);
  const total = manual.has("total_pln") ? parseNum(f.total_pln) : goodsTotalPln({ pricePln: clean(pricePln), costs: clean(costs), commissionPcc: isTradeIn ? clean(commissionPcc) : null });
  const country = manual.has("country") ? f.country : countryFromOrderNo(f.order_no) ?? "";

  async function submit() {
    setError("");
    setInfo("");
    // Przy edycji niezmieniony numer (z dokładnością do wielkości liter) zostaje dokładnie taki, jaki był.
    const upper = f.serial.trim().toUpperCase();
    const serial = edit && edit.serial && edit.serial.trim().toUpperCase() === upper ? edit.serial : upper;
    if (!serial) return setError("Podaj numer seryjny.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.purchased_on)) return setError("Podaj datę zakupu.");
    if (price === null || Number.isNaN(price) || price < 0) return setError("Podaj poprawną cenę zakupu.");
    if (costs !== null && Number.isNaN(costs)) return setError("Koszty muszą być liczbą.");
    if (f.currency && f.currency !== "PLN" && !manual.has("price_pln") && (nbp === null || Number.isNaN(nbp) || nbp <= 0)) return setError(`Brak kursu NBP dla ${f.currency} — wpisz kurs albo ręcznie Cenę PLN.`);
    if (pricePln === null || Number.isNaN(pricePln)) return setError("Cena PLN musi być liczbą.");
    for (const [label, v] of [["PCC", pcc], ["Prowizja + PCC", commissionPcc], ["Cena PLN + koszty", total]] as const) {
      if (v !== null && Number.isNaN(v)) return setError(`${label} musi być liczbą.`);
    }

    setSaving(true);
    // Ostrzeżenie o duplikacie numeru seryjnego (w całym rejestrze) — dopuszczamy, ale po potwierdzeniu.
    const serialChanged = !edit || (edit.serial ?? "").trim().toUpperCase() !== upper;
    let dupQuery = supabase.from("goods_register").select("id, kind, vat").ilike("serial", escapeLike(serial)).limit(1);
    if (edit) dupQuery = dupQuery.neq("id", edit.id);
    const dup = serialChanged ? await dupQuery : { data: null };
    if (dup.data && dup.data.length > 0) {
      const d = dup.data[0] as { kind: string; vat: string | null };
      const where = d.vat === "V23" ? "V23" : d.kind === "trade_in" ? "Skup" : "VM";
      if (!confirm(`Numer seryjny ${serial} jest już w rejestrze Towar (${where}). ${isEdit ? "Zapisać mimo to?" : "Dodać mimo to?"}`)) {
        setSaving(false);
        return;
      }
    }
    const row: Record<string, unknown> = {
      kind: effKind,
      serial,
      name: f.name.trim() || null,
      supplier: f.supplier.trim() || null,
      purchased_on: f.purchased_on,
      delivered_on: /^\d{4}-\d{2}-\d{2}$/.test(f.delivered_on) ? f.delivered_on : null,
      order_no: f.order_no.trim() || null,
      invoice_no: f.invoice_no.trim() || null,
      category: f.category.trim() || null,
      price,
      vat: effVat,
      currency: f.currency || null,
      nbp_rate: !f.currency || f.currency === "PLN" ? null : clean(nbp),
      costs: clean(costs),
      total_pln: clean(total),
      price_pln: pricePln,
    };
    if (!isEdit) row.created_by_email = session.user.email ?? null;
    if (isTradeIn) {
      row.pcc = clean(pcc);
      row.country = country.trim().toUpperCase() || null;
      row.commission_pcc = clean(commissionPcc);
    } else if (isEdit) {
      // zmiana grupy ze Skupu na VM/V23: pola tylko-Skupowe wyczyszczone (jak przy przenoszeniu "recykling" wcześniej)
      row.pcc = null;
      row.country = null;
      row.commission_pcc = null;
    }
    if (edit) {
      const { data: upd, error: updErr } = await supabase.from("goods_register").update(row).eq("id", edit.id).select("id");
      setSaving(false);
      if (updErr) return setError(updErr.code === "PGRST204" || updErr.code === "42703" ? "Baza nie ma jeszcze kolumn edycji — uruchom ponownie supabase/goods.sql w Supabase." : `Nie udało się zapisać: ${updErr.message}`);
      if (!upd || upd.length === 0) return setError("Nie zapisano — edytować może tylko Admin (albo wiersz już nie istnieje).");
      onAdded();
      onClose();
      return;
    }
    const { error: err } = await supabase.from("goods_register").insert(row);
    setSaving(false);
    if (err) {
      setError(err.code === "42501" ? "Brak uprawnień do dodawania towaru (tylko Admin i Manager)." : err.code === "PGRST204" || err.code === "42703" ? "Baza nie ma jeszcze nowych kolumn — uruchom ponownie supabase/goods.sql w Supabase." : `Nie udało się dodać: ${err.message}`);
      return;
    }
    // Zostawiamy datę, dostawcę, kategorię, walutę i VAT — przy dodawaniu kilku sztuk z jednej dostawy to oszczędza pisanie.
    setF((prev) => ({ ...initial(kind, vatFixed), purchased_on: prev.purchased_on, delivered_on: prev.delivered_on, supplier: prev.supplier, category: prev.category, currency: prev.currency, invoice_no: prev.invoice_no, order_no: "" }));
    setManual(new Set());
    setInfo(`Dodano: ${serial}.`);
    onAdded();
  }

  const computedInput = (field: Computed, value: number | null | string, hint?: string) => (
    <div>
      <label className={labelCls}>
        {{ nbp_rate: "Kurs NBP", price_pln: "Cena PLN", pcc: "PCC", commission_pcc: "Prowizja + PCC", total_pln: "Cena PLN + koszty", country: "Kraj" }[field]}
        {manual.has(field) ? (
          <button type="button" onClick={() => resetComputed(field)} className="ml-2 font-normal text-teal hover:underline">przelicz ponownie</button>
        ) : (
          <span className="ml-2 font-normal text-inksoft">{hint ?? "podpowiedź"}</span>
        )}
      </label>
      <input
        value={manual.has(field) ? f[field] : typeof value === "string" ? value : show(value)}
        onChange={(e) => setComputed(field, e.target.value)}
        inputMode={field === "country" ? "text" : "decimal"}
        maxLength={field === "country" ? 2 : undefined}
        list={field === "country" ? "goods-countries" : undefined}
        className={inputCls}
      />
    </div>
  );

  return (
    <div className="border border-line bg-white p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold text-inksoft">{isEdit ? `EDYTUJ TOWAR — ${edit!.serial ?? edit!.id}` : `DODAJ TOWAR — ${isTradeIn ? "SKUP" : vatFixed}`}</h2>
        <button onClick={onClose} className="text-inksoft text-sm">✕</button>
      </div>
      <datalist id="goods-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="goods-suppliers">{suppliers.map((c) => <option key={c} value={c} />)}</datalist>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className={labelCls}>Numer seryjny *</label>
          <input value={f.serial} onChange={(e) => set("serial", e.target.value)} className={`${inputCls} font-mono`} autoFocus={!isEdit} />
        </div>
        <div className="md:col-span-2">
          <label className={labelCls}>Nazwa</label>
          <input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder={isTradeIn ? "np. XSS-512-WE-A" : "np. Canon 2000D z obiektywem 18-55"} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Kategoria</label>
          <input value={f.category} onChange={(e) => set("category", e.target.value)} list="goods-categories" className={inputCls} />
        </div>

        <div>
          <label className={labelCls}>Dostawca</label>
          <input value={f.supplier} onChange={(e) => set("supplier", e.target.value)} list="goods-suppliers" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Data zakupu *</label>
          <input type="date" value={f.purchased_on} onChange={(e) => set("purchased_on", e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Data dostawy</label>
          <input type="date" value={f.delivered_on} onChange={(e) => set("delivered_on", e.target.value)} className={inputCls} />
        </div>
        <div>
          {isEdit ? (
            <>
              <label className={labelCls}>Grupa (VAT)</label>
              <select value={group} onChange={(e) => setGroup(e.target.value as Group)} className={inputCls} title="Zmiana grupy przenosi pozycję do innej pigułki (VM → VAT VM, V23 → VAT V23, Skup → rodzaj Skup)">
                <option value="VM">VM</option>
                <option value="V23">V23</option>
                <option value="Skup">Skup</option>
              </select>
            </>
          ) : (
            <>
              <label className={labelCls}>VAT</label>
              <input value={vatFixed} disabled readOnly className={`${inputCls} bg-paper text-inksoft`} title="Wynika z pigułki, w której dodajesz towar" />
            </>
          )}
        </div>

        <div>
          <label className={labelCls}>Nr zamówienia{isTradeIn ? " (Back Market)" : ""}</label>
          <input value={f.order_no} onChange={(e) => set("order_no", e.target.value)} placeholder={isTradeIn ? "np. FR-26412-WXUBA" : ""} className={`${inputCls} font-mono`} />
        </div>
        <div>
          <label className={labelCls}>Nr faktury / DW</label>
          <input value={f.invoice_no} onChange={(e) => set("invoice_no", e.target.value)} placeholder={isTradeIn ? "np. DW 3-04/10/2026" : "np. FM/04/10/2026"} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Cena zakupu *</label>
          <input value={f.price} onChange={(e) => set("price", e.target.value)} inputMode="decimal" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Waluta</label>
          <select value={f.currency} onChange={(e) => set("currency", e.target.value)} className={inputCls}>
            {isEdit && !f.currency && <option value="">—</option>}
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {f.currency && f.currency !== "PLN" && computedInput("nbp_rate", nbp, autoRate ? `z ${fmtDate(autoRate.date)}` : "brak kursu — wpisz")}
        {computedInput("price_pln", pricePln)}
        <div>
          <label className={labelCls}>Koszty (PLN)</label>
          <input value={f.costs} onChange={(e) => set("costs", e.target.value)} inputMode="decimal" className={inputCls} />
        </div>
        {isTradeIn && computedInput("pcc", pcc, "2% powyżej 1000 zł")}
        {isTradeIn && computedInput("commission_pcc", commissionPcc, "10% + logistyka + PCC")}
        {isTradeIn && computedInput("country", country, "z nr zamówienia")}
        {computedInput("total_pln", total)}
      </div>
      {isTradeIn && <datalist id="goods-countries">{COUNTRIES.map((c) => <option key={c} value={c} />)}</datalist>}

      {isEdit && (price !== edit!.price || (f.currency || null) !== edit!.currency || f.purchased_on !== (edit!.purchased_on ?? "")) && (
        <p className="text-amber text-xs mt-3">Zmieniłeś cenę, walutę lub datę zakupu — kurs NBP, Cena PLN, PCC, prowizja i Cena PLN + koszty zostają bez zmian, dopóki nie klikniesz „przelicz ponownie” przy danym polu.</p>
      )}
      {error && <p className="text-rust text-xs mt-3">{error}</p>}
      {info && <p className="text-teal text-xs mt-3">{info}</p>}
      <div className="flex gap-2 mt-4">
        <button onClick={submit} disabled={saving} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">{saving ? "Zapisywanie…" : isEdit ? "Zapisz zmiany" : "Dodaj"}</button>
        <button
          onClick={() => {
            if (edit) {
              setF(fromEdit(edit));
              setManual(manualFromEdit(edit));
              setGroup(initialGroup);
            } else {
              setF(initial(kind, vatFixed));
              setManual(new Set());
            }
            setError("");
            setInfo("");
          }}
          disabled={saving}
          className="px-4 py-2 border border-line rounded text-sm font-semibold disabled:opacity-50"
        >
          {isEdit ? "Przywróć" : "Wyczyść"}
        </button>
      </div>

      {isEdit && (
        <div className="mt-5 border-t border-line pt-3">
          <h3 className="text-xs font-semibold text-inksoft mb-2">HISTORIA ZMIAN</h3>
          {!edit!.history?.length ? (
            <p className="text-xs text-inksoft">Brak zmian od importu z arkusza.</p>
          ) : (
            <ul className="text-xs space-y-1">
              {[...edit!.history!].reverse().map((h, i) => (
                <li key={i}>
                  <span className="font-mono text-inksoft">{new Date(h.at).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span>{" "}
                  <span className="font-semibold">{displayNameForEmail(h.by, members)}</span>:{" "}
                  {h.changes.map((c) => `${FIELD_LABEL[c.field] ?? c.field}: ${fmtVal(c.from)} → ${fmtVal(c.to)}`).join("; ")}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
