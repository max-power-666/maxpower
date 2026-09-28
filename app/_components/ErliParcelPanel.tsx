"use client";

// Nadawanie przesyłki Erli — Paczkomaty InPost 24/7 — wprost z karty zamówienia Erli (SalesOrderCard.tsx), bez
// pełnego formularza Wysyłki: adres odbiorcy nie jest potrzebny (Erli bierze go z zamówienia, klient wybrał
// paczkomat przy składaniu zamówienia w Erli), więc wystarczy waga/wymiary. Patrz lib/erliShipping.ts i
// app/api/shipping/erli/{create,label,cancel} — ten sam wzorzec (etykieta niegotowa od razu, można anulować) co
// DHL Parcel w ShippingView.tsx, tylko osadzony bezpośrednio na karcie zamiast w osobnej zakładce.

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { base64ToBlobUrl } from "@/lib/shipping";

type Template = { id: number; name: string; weight_kg: number; length_cm: number; width_cm: number; height_cm: number };
type ShipmentRow = { id: number; tracking_number: string; cancelled_at: string | null; label_format: string | null };
const EMPTY_FORM = { template: "", weight: "", length: "", width: "", height: "" };
const field = "w-full border border-line bg-white px-2 py-1.5 rounded text-xs";

export default function ErliParcelPanel({ externalId, session }: { externalId: string; session: Session }) {
  const auth = { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
  const [shipment, setShipment] = useState<ShipmentRow | null | undefined>(undefined); // undefined = jeszcze się ładuje
  const [templates, setTemplates] = useState<Template[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    load();
    supabase
      .from("shipping_templates")
      .select("id, name, weight_kg, length_cm, width_cm, height_cm")
      .order("name")
      .then(({ data }) => setTemplates((data as Template[]) || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalId]);

  async function load() {
    const { data } = await supabase
      .from("shipments")
      .select("id, tracking_number, cancelled_at, label_format")
      .eq("marketplace", "erli")
      .eq("order_external_id", externalId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setShipment((data as ShipmentRow) ?? null);
  }

  function applyTemplate(id: string) {
    const t = templates.find((x) => String(x.id) === id);
    setForm(t ? { template: id, weight: String(t.weight_kg), length: String(t.length_cm), width: String(t.width_cm), height: String(t.height_cm) } : { ...form, template: "" });
  }

  async function create() {
    setError("");
    const weightKg = Number(form.weight.replace(",", "."));
    const lengthCm = Number(form.length.replace(",", "."));
    const widthCm = Number(form.width.replace(",", "."));
    const heightCm = Number(form.height.replace(",", "."));
    if (![weightKg, lengthCm, widthCm, heightCm].every((n) => n > 0)) return setError("Podaj wagę i wymiary paczki (liczby większe od zera).");
    if (!confirm("Nadać przesyłkę przez Erli (Paczkomaty InPost 24/7)?\n\nErli nie ma środowiska testowego — to prawdziwa, płatna przesyłka. Można ją anulować, dopóki nie trafi do sieci InPost."))
      return;
    setCreating(true);
    try {
      const res = await fetch("/api/shipping/erli/create", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ confirm: true, externalId, clientRequestId: requestId.current, weightKg, lengthCm, widthCm, heightCm }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Nie udało się nadać przesyłki.");
      requestId.current = crypto.randomUUID();
      setForm(EMPTY_FORM);
      setOpen(false);
      await load();
    } catch (e: any) {
      setError(e.message || "Nie udało się nadać przesyłki.");
    } finally {
      setCreating(false);
    }
  }

  async function openLabel() {
    if (!shipment) return;
    setError("");
    const { data: row } = await supabase.from("shipments").select("label_data").eq("id", shipment.id).maybeSingle();
    let data = (row?.label_data as string | null) ?? null;
    if (!data) {
      setChecking(true);
      try {
        const res = await fetch("/api/shipping/erli/label", { method: "POST", headers: auth, body: JSON.stringify({ id: shipment.id }) });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || "Nie udało się pobrać etykiety.");
        if (!j.ready) {
          setError("Erli jeszcze nie przygotowało etykiety — spróbuj ponownie za chwilę.");
          return;
        }
        data = j.labelBase64 ?? null;
        await load();
      } catch (e: any) {
        setError(e.message || "Nie udało się pobrać etykiety.");
        return;
      } finally {
        setChecking(false);
      }
    }
    if (data) window.open(base64ToBlobUrl(data), "_blank");
  }

  async function cancel() {
    if (!shipment) return;
    if (!confirm(`Anulować przesyłkę ${shipment.tracking_number}?\n\nErli pozwala na to tylko wtedy, gdy nie trafiła jeszcze do sieci InPost.`)) return;
    setError("");
    const res = await fetch("/api/shipping/erli/cancel", { method: "POST", headers: auth, body: JSON.stringify({ id: shipment.id, confirm: true }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data?.error || "Nie udało się anulować przesyłki.");
    await load();
  }

  if (shipment === undefined) return null; // jeszcze się ładuje

  if (shipment) {
    return (
      <div className="text-xs mt-1">
        {error && <p className="text-rust font-semibold mb-1">{error}</p>}
        <span className="font-semibold">Erli Paczkomat:</span> <span className="font-mono">{shipment.tracking_number}</span>
        {shipment.cancelled_at ? (
          <span className="text-rust font-semibold ml-2">ANULOWANA</span>
        ) : (
          <>
            <button onClick={openLabel} disabled={checking} className="ml-2 text-teal font-semibold hover:underline disabled:opacity-50">
              {checking ? "Sprawdzanie…" : shipment.label_format ? "Etykieta" : "Sprawdź / pobierz etykietę"}
            </button>
            <button onClick={cancel} className="ml-2 text-rust font-semibold hover:underline">Anuluj</button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="text-xs mt-1">
      {!open ? (
        <button onClick={() => setOpen(true)} className="text-teal font-semibold hover:underline">Nadaj przez Erli (Paczkomat) →</button>
      ) : (
        <div className="border border-line bg-white p-3 mt-1 grid grid-cols-2 gap-2 max-w-sm">
          {error && <p className="text-rust font-semibold col-span-2">{error}</p>}
          <div className="col-span-2">
            <label className="block text-inksoft mb-1">Szablon</label>
            <select value={form.template} onChange={(e) => applyTemplate(e.target.value)} className={field}>
              <option value="">— ręcznie —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-inksoft mb-1">Waga (kg)</label>
            <input value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value, template: "" })} className={field} />
          </div>
          <div>
            <label className="block text-inksoft mb-1">Dł. (cm)</label>
            <input value={form.length} onChange={(e) => setForm({ ...form, length: e.target.value, template: "" })} className={field} />
          </div>
          <div>
            <label className="block text-inksoft mb-1">Szer. (cm)</label>
            <input value={form.width} onChange={(e) => setForm({ ...form, width: e.target.value, template: "" })} className={field} />
          </div>
          <div>
            <label className="block text-inksoft mb-1">Wys. (cm)</label>
            <input value={form.height} onChange={(e) => setForm({ ...form, height: e.target.value, template: "" })} className={field} />
          </div>
          <div className="col-span-2 flex gap-2 mt-1">
            <button onClick={create} disabled={creating} className="bg-ink text-paper px-3 py-1.5 rounded font-semibold disabled:opacity-50">
              {creating ? "Nadawanie…" : "Nadaj"}
            </button>
            <button onClick={() => setOpen(false)} className="bg-white border border-line px-3 py-1.5 rounded font-semibold">Anuluj</button>
          </div>
        </div>
      )}
    </div>
  );
}
