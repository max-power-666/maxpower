"use client";

import { useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { COUNTRY_NAMES } from "@/lib/dhlExpress";
import {
  CARRIER_NAME,
  CARRIER_PRODUCTS,
  SKU_OP_LABEL,
  describeRule,
  evaluateRules,
  productName,
  type ShippingCarrier,
  type ShippingRule,
  type SkuOp,
} from "@/lib/shippingRules";

// Wysyłka -> Reguły (12.10.2026, na prośbę właściciela): domyślny szablon paczki, przewoźnik i produkt ustawiane automatycznie na podstawie SKU, kraju odbiorcy
// i metody przesyłki. Reguły są sprawdzane od góry; każde ustawienie (szablon / przewoźnik) bierze się z pierwszej pasującej reguły, która je podaje.
// Stosuje je formularz Wysyłki po otwarciu z karty zamówienia — to tylko wartości domyślne, można je zmienić. Edytują Admin i Manager; Zamówienia widzi reguły.

const inputCls = "w-full border border-line bg-white px-2 py-2 rounded text-sm";
const labelCls = "text-xs font-semibold text-inksoft block mb-1";
const COUNTRIES = Object.entries(COUNTRY_NAMES).sort((a, b) => a[1].localeCompare(b[1], "pl"));
const countryName = (code: string) => COUNTRY_NAMES[code] ?? code;

type Draft = {
  name: string;
  skuOp: SkuOp;
  skuValue: string;
  country: string;
  method: "" | "Express" | "Standard";
  templateId: string;
  carrier: "" | ShippingCarrier;
  product: string;
  signature: boolean;
};
const EMPTY: Draft = { name: "", skuOp: "starts_with", skuValue: "", country: "", method: "", templateId: "", carrier: "", product: "", signature: false };

export default function ShippingRulesView({
  session,
  rules,
  templates,
  canEdit,
  onChanged,
}: {
  session: Session;
  rules: ShippingRule[];
  templates: { id: number; name: string }[];
  canEdit: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Sprawdzanie reguł na przykładzie (nic nie zapisuje)
  const [test, setTest] = useState({ sku: "", country: "DE", method: "" });

  const sorted = useMemo(() => [...rules].sort((a, b) => a.position - b.position || a.id - b.id), [rules]);
  const templateName = (id: number) => templates.find((t) => t.id === id)?.name ?? null;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  function startEdit(r: ShippingRule | null) {
    setError("");
    setFormOpen(true);
    setEditingId(r?.id ?? null);
    setDraft(
      r
        ? { name: r.name ?? "", skuOp: r.sku_op ?? "starts_with", skuValue: r.sku_value ?? "", country: r.country_code ?? "", method: r.shipping_method ?? "", templateId: r.template_id ? String(r.template_id) : "", carrier: r.carrier ?? "", product: r.product_code ?? "", signature: !!r.signature }
        : EMPTY
    );
  }

  async function save() {
    setError("");
    const skuValue = draft.skuValue.trim();
    if (!draft.templateId && !draft.carrier && !draft.signature) return setError("Wybierz, co reguła ma ustawić: szablon paczki, przewoźnika i/lub podpis przy doręczeniu.");
    setBusy(true);
    const row = {
      name: draft.name.trim() || null,
      sku_op: skuValue ? draft.skuOp : null,
      sku_value: skuValue || null,
      country_code: draft.country || null,
      shipping_method: draft.method || null,
      template_id: draft.templateId ? Number(draft.templateId) : null,
      carrier: draft.carrier || null,
      product_code: draft.carrier && draft.product ? draft.product : null,
      signature: draft.signature,
    };
    const { error: err } = editingId
      ? await supabase.from("shipping_rules").update(row).eq("id", editingId)
      : await supabase.from("shipping_rules").insert({ ...row, position: (sorted[sorted.length - 1]?.position ?? 0) + 1, created_by_email: session.user.email ?? null });
    setBusy(false);
    if (err) return setError(err.code === "42P01" || err.code === "PGRST205" ? "Brak tabeli reguł — uruchom supabase/shipping.sql w Supabase." : err.code === "42501" ? "Brak uprawnień — reguły edytuje Admin i Manager." : `Nie udało się zapisać: ${err.message}`);
    setFormOpen(false);
    setEditingId(null);
    setDraft(EMPTY);
    await onChanged();
  }

  async function toggle(r: ShippingRule) {
    const { error: err } = await supabase.from("shipping_rules").update({ active: !r.active }).eq("id", r.id);
    if (err) return setError(`Nie udało się zmienić reguły: ${err.message}`);
    await onChanged();
  }

  async function remove(r: ShippingRule) {
    if (!confirm(`Usunąć regułę?\n\n${describeRule(r, templateName, countryName)}`)) return;
    const { error: err } = await supabase.from("shipping_rules").delete().eq("id", r.id);
    if (err) return setError(`Nie udało się usunąć: ${err.message}`);
    await onChanged();
  }

  // Zamiana miejscami z sąsiadem (position obu reguł); gdy mają tę samą wartość position, przenumerowujemy całą listę.
  async function move(r: ShippingRule, dir: -1 | 1) {
    const i = sorted.findIndex((x) => x.id === r.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= sorted.length) return;
    const order = [...sorted];
    [order[i], order[j]] = [order[j], order[i]];
    setBusy(true);
    const results = await Promise.all(order.map((x, idx) => (x.position === idx + 1 ? null : supabase.from("shipping_rules").update({ position: idx + 1 }).eq("id", x.id))));
    setBusy(false);
    const fail = results.find((res) => res && res.error);
    if (fail?.error) setError(`Nie udało się zmienić kolejności: ${fail.error.message}`);
    await onChanged();
  }

  const testResult = useMemo(() => {
    const skus = test.sku.split(/[,;\s]+/).filter(Boolean);
    if (skus.length === 0) return null;
    return evaluateRules(rules, { skus, countryCode: test.country, shippingMethod: test.method || null });
  }, [rules, test]);

  return (
    <div className="max-w-5xl">
      <p className="text-xs text-inksoft mb-4 max-w-3xl">
        Reguły ustawiają <span className="font-semibold">domyślny szablon paczki, przewoźnika i produkt</span>, gdy otwierasz formularz nadania z karty zamówienia (przycisk „Nadaj przesyłkę”). To tylko wartości początkowe — w formularzu można je zmienić.
        Reguły są sprawdzane od góry; szablon i przewoźnik biorą się z pierwszej pasującej reguły, która je ustawia. Pusty warunek = nie sprawdzamy go. Zamówienie za pobraniem zawsze idzie przez UPS (tylko on obsługuje pobranie), niezależnie od reguł.
      </p>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      {canEdit && !formOpen && (
        <button onClick={() => startEdit(null)} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold mb-4">+ Dodaj regułę</button>
      )}

      {canEdit && formOpen && (
        <div className="border border-line bg-white p-4 mb-5">
          <div className="text-xs font-semibold text-inksoft mb-3">{editingId ? "EDYCJA REGUŁY" : "NOWA REGUŁA"}</div>
          <div className="mb-3">
            <label className={labelCls}>Nazwa (opcjonalnie, dla porządku)</label>
            <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="np. Konsole PS4 → szablon PS4" className={inputCls} />
          </div>
          <div className="text-xs font-semibold text-inksoft mb-2">JEŻELI (puste pole = bez warunku)</div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
            <div>
              <label className={labelCls}>SKU</label>
              <select value={draft.skuOp} onChange={(e) => set({ skuOp: e.target.value as SkuOp })} className={inputCls}>
                {(Object.keys(SKU_OP_LABEL) as SkuOp[]).map((o) => <option key={o} value={o}>{SKU_OP_LABEL[o]}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Wartość SKU</label>
              <input value={draft.skuValue} onChange={(e) => set({ skuValue: e.target.value })} placeholder="np. PS4" className={`${inputCls} font-mono`} />
            </div>
            <div>
              <label className={labelCls}>Kraj odbiorcy</label>
              <select value={draft.country} onChange={(e) => set({ country: e.target.value })} className={inputCls}>
                <option value="">dowolny</option>
                {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Metoda przesyłki (z marketplace'u)</label>
              <select value={draft.method} onChange={(e) => set({ method: e.target.value as Draft["method"] })} className={inputCls}>
                <option value="">dowolna</option>
                <option value="Express">Express</option>
                <option value="Standard">Standard</option>
              </select>
            </div>
          </div>
          <div className="text-xs font-semibold text-inksoft mb-2">WTEDY USTAW (przynajmniej jedno)</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <div>
              <label className={labelCls}>Szablon paczki</label>
              <select value={draft.templateId} onChange={(e) => set({ templateId: e.target.value })} className={inputCls}>
                <option value="">— bez zmiany —</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Przewoźnik</label>
              <select value={draft.carrier} onChange={(e) => set({ carrier: e.target.value as Draft["carrier"], product: "" })} className={inputCls}>
                <option value="">— bez zmiany —</option>
                {(Object.keys(CARRIER_NAME) as ShippingCarrier[]).map((c) => <option key={c} value={c}>{CARRIER_NAME[c]}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Produkt / usługa</label>
              <select value={draft.product} onChange={(e) => set({ product: e.target.value })} disabled={!draft.carrier} className={inputCls}>
                <option value="">— domyślny dla przewoźnika —</option>
                {draft.carrier && CARRIER_PRODUCTS[draft.carrier].map((p) => <option key={p.code} value={p.code}>{p.name} ({p.code})</option>)}
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold mb-4">
            <input type="checkbox" checked={draft.signature} onChange={(e) => set({ signature: e.target.checked })} />
            Podpis przy doręczeniu (UPS)
            <span className="text-xs font-normal text-inksoft">— włącza usługę dodatkową, gdy wysyłka idzie przez UPS (nie łączy się z pobraniem; zagranicą UPS dolicza opłatę)</span>
          </label>
          <div className="flex gap-2">
            <button onClick={save} disabled={busy} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">{busy ? "Zapisywanie…" : editingId ? "Zapisz zmiany" : "Dodaj regułę"}</button>
            <button onClick={() => { setFormOpen(false); setEditingId(null); setError(""); }} className="px-4 py-2 border border-line rounded text-sm font-semibold">Anuluj</button>
          </div>
        </div>
      )}

      <div className="border border-line bg-white mb-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3 w-10">#</th>
              <th className="p-3">Reguła</th>
              <th className="p-3">Aktywna</th>
              {canEdit && <th className="p-3"></th>}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && <tr><td colSpan={canEdit ? 4 : 3} className="p-6 text-center text-inksoft text-sm">Brak reguł — przy nadawaniu nic nie jest ustawiane automatycznie.</td></tr>}
            {sorted.map((r, i) => (
              <tr key={r.id} className={`border-b border-line last:border-0 align-top ${r.active ? "" : "text-inksoft"}`}>
                <td className="p-3 font-mono text-xs">{i + 1}</td>
                <td className="p-3">
                  {r.name && <div className="font-semibold">{r.name}</div>}
                  <div className={r.name ? "text-xs text-inksoft" : ""}>{describeRule(r, templateName, countryName)}</div>
                </td>
                <td className="p-3">
                  <input type="checkbox" checked={r.active} onChange={() => toggle(r)} disabled={!canEdit} title={r.active ? "Aktywna" : "Wyłączona"} />
                </td>
                {canEdit && (
                  <td className="p-3 whitespace-nowrap text-xs">
                    <button onClick={() => move(r, -1)} disabled={busy || i === 0} className="text-inksoft hover:text-ink disabled:opacity-30 mr-2" title="Wyżej">▲</button>
                    <button onClick={() => move(r, 1)} disabled={busy || i === sorted.length - 1} className="text-inksoft hover:text-ink disabled:opacity-30 mr-3" title="Niżej">▼</button>
                    <button onClick={() => startEdit(r)} className="text-teal font-semibold hover:underline mr-3">Edytuj</button>
                    <button onClick={() => remove(r)} className="text-rust font-semibold hover:underline">Usuń</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border border-dashed border-line bg-white p-4">
        <div className="text-xs font-semibold text-inksoft mb-3">SPRAWDŹ NA PRZYKŁADZIE (nic nie zapisuje)</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <div>
            <label className={labelCls}>SKU (kilka — po przecinku)</label>
            <input value={test.sku} onChange={(e) => setTest({ ...test, sku: e.target.value })} placeholder="np. PS4S-1TB-BK-B-1M" className={`${inputCls} font-mono`} />
          </div>
          <div>
            <label className={labelCls}>Kraj odbiorcy</label>
            <select value={test.country} onChange={(e) => setTest({ ...test, country: e.target.value })} className={inputCls}>
              {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Metoda przesyłki</label>
            <select value={test.method} onChange={(e) => setTest({ ...test, method: e.target.value })} className={inputCls}>
              <option value="">brak / inna</option>
              <option value="Express">Express</option>
              <option value="Standard">Standard</option>
            </select>
          </div>
        </div>
        {testResult && (
          <div className="text-sm">
            <div>
              Szablon: <span className="font-semibold">{testResult.templateId !== null ? templateName(testResult.templateId) ?? "(usunięty)" : "— bez zmiany —"}</span>
              {" · "}Przewoźnik: <span className="font-semibold">{testResult.carrier ? [CARRIER_NAME[testResult.carrier], productName(testResult.carrier, testResult.productCode)].filter(Boolean).join(" · ") : "— bez zmiany —"}</span>
              {" · "}Podpis przy doręczeniu: <span className="font-semibold">{testResult.signature ? "tak (UPS)" : "—"}</span>
            </div>
            <div className="text-xs text-inksoft mt-1">
              Pasujące reguły: {testResult.matched.length ? testResult.matched.map((m) => `#${sorted.findIndex((x) => x.id === m.id) + 1}`).join(", ") : "brak"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
