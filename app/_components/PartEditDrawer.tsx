"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { fmtWarsawDateTime } from "@/lib/warsawDate";

// Serwis -> Części: edycja całego rekordu części (16.10.2026, na prośbę właściciela — "kierownik serwisu może edytować rekordy"). Dostępna dla Kierownika serwisu i Admina
// (trigger service_parts_guard w bazie pilnuje tego niezależnie od UI). Każda zmiana trafia do historii rekordu (service_parts.history), widocznej na dole panelu.

type Full = {
  id: number;
  received_at: string | null;
  invoice_no: string | null;
  invoice_date: string | null;
  supplier: string | null;
  status: string | null;
  notes: string | null;
  name: string | null;
  part_code: string | null;
  price_net: number | null;
  currency: string | null;
  nbp_rate: number | null;
  price_pln: number | null;
  device_ref: string | null;
  usage_notes: string | null;
  history?: { action: string; by_email: string; at: string; changes: { field: string; from: unknown; to: unknown }[] }[] | null;
};

const FIELD_LABEL: Record<string, string> = {
  received_at: "Data przyjęcia", invoice_no: "Faktura", invoice_date: "Data faktury", supplier: "Dostawca", status: "Status", notes: "Notatka", name: "Nazwa", part_code: "Kod",
  batch_qty: "Ilość partii", price_net: "Cena netto", currency: "Waluta", nbp_rate: "Kurs NBP", price_pln: "Cena netto PLN", device_ref: "Numer seryjny / IMEI", usage_notes: "Uwagi o użyciu",
};
const STATUSES = ["Dotarło", "Reklamacja", "Zareklamowane", "Uszkodzony", "Demontaż"];
const CURRENCIES = ["PLN", "EUR", "USD"];
const inp = "border border-line bg-white px-2 py-1.5 rounded text-sm w-full";
const lab = "text-xs font-semibold text-inksoft block mb-1";

const toStr = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const parseNum = (s: string): number | null | "bad" => {
  if (s.trim() === "") return null;
  const n = Number(s.trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : "bad";
};
const fmtVal = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

export default function PartEditDrawer({ id, members, onClose, onSaved }: { id: number; members: MemberLite[]; onClose: () => void; onSaved: () => void }) {
  const [orig, setOrig] = useState<Full | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      let res = await supabase.from("service_parts").select("*").eq("id", id).maybeSingle();
      if (res.error || !res.data) return setErr(`Nie udało się wczytać części: ${res.error?.message ?? "nie istnieje"}`);
      const r = res.data as Full;
      setOrig(r);
      setF({
        received_at: toStr(r.received_at), invoice_no: toStr(r.invoice_no), invoice_date: toStr(r.invoice_date), supplier: toStr(r.supplier), name: toStr(r.name), part_code: toStr(r.part_code),
        price_net: toStr(r.price_net), currency: toStr(r.currency), nbp_rate: toStr(r.nbp_rate), price_pln: toStr(r.price_pln), status: toStr(r.status), device_ref: toStr(r.device_ref),
        usage_notes: toStr(r.usage_notes), notes: toStr(r.notes),
      });
    })();
  }, [id]);

  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const recalc = () => {
    const net = parseNum(f.price_net);
    const rate = f.currency === "PLN" || f.currency === "" ? 1 : parseNum(f.nbp_rate);
    if (typeof net !== "number" || typeof rate !== "number") return setErr("Do przeliczenia potrzebna jest cena netto i kurs NBP (dla waluty innej niż PLN).");
    setErr("");
    set("price_pln", String(Math.round(net * rate * 100) / 100));
  };

  async function save() {
    if (!orig) return;
    setErr("");
    if (!f.name.trim()) return setErr("Podaj nazwę części.");
    const patch: Record<string, unknown> = {};
    const text = (k: keyof Full) => {
      const v = f[k as string].trim() || null;
      if (v !== (orig[k] ?? null)) patch[k as string] = v;
    };
    for (const k of ["received_at", "invoice_no", "invoice_date", "supplier", "name", "part_code", "currency", "status", "usage_notes", "notes"] as const) text(k);
    const dev = f.device_ref.trim().toUpperCase() || null;
    if (dev !== (orig.device_ref ?? null)) patch.device_ref = dev;
    for (const k of ["price_net", "nbp_rate", "price_pln"] as const) {
      const n = parseNum(f[k]);
      if (n === "bad") return setErr(`Pole „${FIELD_LABEL[k]}” musi być liczbą.`);
      if (n !== (orig[k] === null || orig[k] === undefined ? null : Number(orig[k]))) patch[k] = n;
    }
    if (Object.keys(patch).length === 0) return onClose();
    setSaving(true);
    const { error } = await supabase.from("service_parts").update(patch).eq("id", orig.id);
    setSaving(false);
    if (error) return setErr(`Nie zapisano: ${error.message}`);
    onSaved();
    onClose();
  }

  const history = [...(orig?.history ?? [])].reverse();
  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-paper w-full max-w-xl h-full overflow-y-auto p-6 border-l border-line">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">Edycja części #{id}</h2>
          <button onClick={onClose} className="text-inksoft text-xl leading-none" title="Zamknij">×</button>
        </div>
        {!orig ? (
          <p className="text-sm text-inksoft">{err || "Wczytywanie…"}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2"><label className={lab}>Nazwa części *</label><input value={f.name} onChange={(e) => set("name", e.target.value)} className={inp} /></div>
              <div><label className={lab}>Kod części</label><input value={f.part_code} onChange={(e) => set("part_code", e.target.value)} className={`${inp} font-mono`} /></div>
              <div><label className={lab}>Status</label>
                <select value={f.status} onChange={(e) => set("status", e.target.value)} className={inp}>
                  <option value="">—</option>
                  {f.status && !STATUSES.includes(f.status) && <option value={f.status}>{f.status}</option>}
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div><label className={lab}>Dostawca</label><input value={f.supplier} onChange={(e) => set("supplier", e.target.value)} className={inp} /></div>
              <div><label className={lab}>Faktura / zamówienie</label><input value={f.invoice_no} onChange={(e) => set("invoice_no", e.target.value)} className={`${inp} font-mono`} /></div>
              <div><label className={lab}>Data przyjęcia</label><input type="date" value={f.received_at} onChange={(e) => set("received_at", e.target.value)} className={inp} /></div>
              <div><label className={lab}>Data faktury</label><input type="date" value={f.invoice_date} onChange={(e) => set("invoice_date", e.target.value)} className={inp} /></div>
              <div><label className={lab}>Cena netto (waluta zakupu)</label><input value={f.price_net} onChange={(e) => set("price_net", e.target.value)} inputMode="decimal" className={`${inp} font-mono`} /></div>
              <div><label className={lab}>Waluta</label>
                <select value={f.currency} onChange={(e) => set("currency", e.target.value)} className={inp}>
                  <option value="">—</option>
                  {f.currency && !CURRENCIES.includes(f.currency) && <option value={f.currency}>{f.currency}</option>}
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div><label className={lab}>Kurs NBP</label><input value={f.nbp_rate} onChange={(e) => set("nbp_rate", e.target.value)} inputMode="decimal" className={`${inp} font-mono`} /></div>
              <div>
                <label className={lab}>Cena netto PLN (jednostkowa) <button type="button" onClick={recalc} className="text-teal font-normal underline ml-1">przelicz</button></label>
                <input value={f.price_pln} onChange={(e) => set("price_pln", e.target.value)} inputMode="decimal" className={`${inp} font-mono`} />
              </div>
              <div className="col-span-2"><label className={lab}>Numer seryjny / IMEI urządzenia</label><input value={f.device_ref} onChange={(e) => set("device_ref", e.target.value)} className={`${inp} font-mono`} /></div>
              <div className="col-span-2"><label className={lab}>Uwagi o użyciu</label><textarea value={f.usage_notes} onChange={(e) => set("usage_notes", e.target.value)} rows={2} className={inp} /></div>
              <div className="col-span-2"><label className={lab}>Notatka (np. kod dostawcy)</label><textarea value={f.notes} onChange={(e) => set("notes", e.target.value)} rows={2} className={inp} /></div>
            </div>
            <p className="text-[11px] text-inksoft mt-3">Cena netto PLN to cena jednostkowa — zasila koszt serwisu w zakładce Marża. Zmiana ceny albo numeru seryjnego od razu zmienia koszt serwisu sprzedanych sztuk.</p>
            {err && <p className="text-rust text-xs mt-3">{err}</p>}
            <div className="flex gap-2 mt-4">
              <button onClick={save} disabled={saving} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">{saving ? "Zapisywanie…" : "Zapisz zmiany"}</button>
              <button onClick={onClose} className="border border-line bg-white px-4 py-2 rounded text-sm font-semibold">Anuluj</button>
            </div>

            <h3 className="text-xs font-semibold text-inksoft mt-8 mb-2">HISTORIA ZMIAN</h3>
            {history.length === 0 ? (
              <p className="text-xs text-inksoft">Brak zmian zapisanych w historii (pozycje z arkusza i z importu mają pustą historię aż do pierwszej edycji).</p>
            ) : (
              <ol className="space-y-3">
                {history.map((h, i) => (
                  <li key={i} className="text-xs border-l-2 border-line pl-3">
                    <div className="text-inksoft">{fmtWarsawDateTime(Date.parse(h.at), true)} · {displayNameForEmail(h.by_email, members)}</div>
                    {(h.changes || []).map((c, j) => (
                      <div key={j}>{FIELD_LABEL[c.field] || c.field}: <span className="text-inksoft">{fmtVal(c.from)}</span> → <span className="font-semibold">{fmtVal(c.to)}</span></div>
                    ))}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </div>
  );
}
