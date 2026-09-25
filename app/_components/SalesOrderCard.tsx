"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { MARKETPLACES, OUR_STATUSES, salesStatusLabel } from "@/lib/salesOrders";
import { MAX_PADS } from "./PadSerialsCell";

// Karta zamówienia sprzedaży (panel boczny po kliknięciu numeru zamówienia): dane z API marketplace'u,
// dane wpisane przez pracowników (numer seryjny, pady) i numerowany log zmian — jak karta zamówienia
// w Trade-in. Dane z API czytamy z surowej tabeli kanału (dziś bm_orders), dane pracownicze
// i log z wspólnej sales_orders.

export type FieldChange = { field: string; from: string | null; to: string | null };
export type SalesHistoryEntry = { action: "edited"; by_email: string | null; at: string; changes?: FieldChange[] };

// Jedna sztuka z zamówienia (sales_order_items): SKU z API, numer seryjny i pady wpisuje pracownik.
export type SalesItem = {
  item_key: string;
  position: number;
  sku: string | null;
  serial_number: string | null;
  pads: number | null;
  pad_serials: string[] | null;
};

type WorkerData = {
  marketplace: string;
  external_id: string;
  order_date: string | null;
  status: string;
  sku: string | null;
  our_status: string;
  history: SalesHistoryEntry[];
};

// Zapis danych jednej pozycji razem z wpisem do logu (funkcja sales_item_update w bazie — jedna transakcja).
export function updateSalesItem(p: {
  marketplace: string;
  externalId: string;
  itemKey: string;
  serial: string | null;
  pads: number | null;
  padSerials: string[] | null;
  entry: SalesHistoryEntry;
}) {
  return supabase.rpc("sales_item_update", {
    p_marketplace: p.marketplace,
    p_external_id: p.externalId,
    p_item_key: p.itemKey,
    p_serial: p.serial,
    p_pads: p.pads,
    p_pad_serials: p.padSerials,
    p_entry: p.entry,
  });
}

// Etykieta pola w logu; przy zamówieniu z kilkoma pozycjami wskazuje, której dotyczy zmiana.
export const itemFieldLabel = (field: string, item: Pick<SalesItem, "position" | "sku">, multiple: boolean) =>
  multiple ? `Poz. ${item.position} (${item.sku ?? "—"}) · ${field}` : field;

type ItemDraft = { serial: string; pads: string; padSerials: string[] };

type Address = {
  firstName?: string;
  lastName?: string;
  company?: string;
  phoneNumber?: string;
  street?: string;
  street2?: string;
  postalCode?: string;
  city?: string;
  state?: string;
  country?: string;
};
type OrderLine = {
  id?: number;
  listing?: string;
  product?: string;
  brand?: string;
  quantity?: number;
  price?: string;
  currency?: string;
  imei?: string;
  serial_number?: string;
};
type BmOrder = {
  order_id: number;
  state: number;
  country_code: string | null;
  date_creation: string | null;
  date_modification: string | null;
  date_payment: string | null;
  date_shipping: string | null;
  expected_dispatch_date: string | null;
  price: number | null;
  shipping_price: number | null;
  currency: string | null;
  sales_taxes: number | null;
  payment_method: string | null;
  delivery_mode: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipper_display: string | null;
  is_backship: boolean | null;
  orderlines: OrderLine[] | null;
  shipping_address: Address | null;
  billing_address: Address | null;
};

// Lista zamówień w panelu sprzedawcy Back Market, przefiltrowana do jednego zamówienia. endDate to dzisiejsza data
// (górna granica zakresu), żeby filtr nie ucinał zamówienia; panel jest na domenie .fr dla wszystkich rynków.
function backMarketOrderUrl(orderId: string) {
  const d = new Date();
  const endDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `https://www.backmarket.fr/bo-seller/orders/all?page=1&pageSize=10&endDate=${endDate}&orderId=${encodeURIComponent(orderId)}`;
}

// Zamówienie refurbed (pola z API, patrz swagger Order/OrderItem) — czytamy z kolumny raw tabeli refurbed_orders.
type RefurbedAddress = {
  first_name?: string;
  family_name?: string;
  company_name?: string;
  country_code?: string;
  post_code?: string;
  town?: string;
  street_name?: string;
  house_no?: string;
  supplement?: string;
  phone_number?: string;
};
type RefurbedItem = {
  id?: string;
  name?: string;
  sku?: string;
  state?: string;
  total_charged?: string;
  currency_code?: string;
  parcel_tracking_url?: string;
  item_identifier?: string;
  item_identifiers?: { identifier_type?: string; value?: string }[];
};
type RefurbedOrder = {
  id: string;
  state: string;
  released_at: string | null;
  customer_email: string | null;
  currency_code: string | null;
  total_charged: number | null;
  payment_method: string | null;
  raw: {
    shipping_address?: RefurbedAddress;
    invoice_address?: RefurbedAddress;
    items?: RefurbedItem[];
    total_refunded?: string;
    total_vat_charged?: string;
    settlement_currency_code?: string;
    settlement_total_commission?: string;
  };
};
const refurbedAddress = (a?: RefurbedAddress) =>
  a ? [[a.street_name, a.house_no].filter(Boolean).join(" "), a.supplement, [a.post_code, a.town].filter(Boolean).join(" "), a.country_code].filter(Boolean).join(", ") : null;

// Zamówienie Erli (pola z API, patrz swagger Order) — czytamy z kolumny raw tabeli erli_orders. Kwoty w API są w groszach.
type ErliOrder = {
  id: string;
  status: string;
  seller_status: string | null;
  market: string | null;
  currency: string | null;
  total_price: number | null;
  created: string | null;
  updated: string | null;
  purchased_at: string | null;
  raw: {
    user?: {
      email?: string;
      deliveryAddress?: { firstName?: string; lastName?: string; companyName?: string; street?: string; buildingNumber?: string; flatNumber?: string; zip?: string; city?: string; country?: string; phone?: string };
    };
    items?: { id?: number; name?: string; sku?: string; externalId?: string; ean?: string; quantity?: number; unitPrice?: number }[];
    delivery?: { name?: string; price?: number; cod?: boolean; pickupPlace?: { name?: string; address?: string; city?: string; zip?: string } };
    deliveryTracking?: { status?: string; trackingUrl?: string; vendor?: string; trackingNumber?: string };
    comment?: string;
  };
};
const grosze = (v: number | null | undefined, currency: string | null | undefined) => (v === null || v === undefined ? null : fmtMoney(v / 100, currency));
const erliAddress = (a?: NonNullable<ErliOrder["raw"]["user"]>["deliveryAddress"]) =>
  a ? [[a.street, [a.buildingNumber, a.flatNumber].filter(Boolean).join("/")].filter(Boolean).join(" "), [a.zip, a.city].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ") : null;

// Zamówienie Allegro (checkout form, patrz swagger CheckoutForm) — czytamy z kolumny raw tabeli allegro_orders.
type AllegroOrder = {
  id: string;
  status: string;
  fulfillment_status: string | null;
  payment_type: string | null;
  marketplace_id: string | null;
  buyer_login: string | null;
  total_to_pay: number | null;
  currency: string | null;
  updated_at: string | null;
  raw: {
    messageToSeller?: string;
    buyer?: { email?: string; login?: string; firstName?: string; lastName?: string; companyName?: string; phoneNumber?: string };
    payment?: { type?: string; provider?: string; finishedAt?: string; paidAmount?: { amount?: string; currency?: string } };
    delivery?: {
      method?: { name?: string };
      cost?: { amount?: string; currency?: string };
      address?: { firstName?: string; lastName?: string; companyName?: string; street?: string; zipCode?: string; city?: string; countryCode?: string; phoneNumber?: string };
      pickupPoint?: { name?: string; description?: string; address?: { street?: string; zipCode?: string; city?: string } };
    };
    invoice?: { required?: boolean };
    lineItems?: { id?: string; boughtAt?: string; quantity?: number; offer?: { id?: string; name?: string; external?: { id?: string } }; price?: { amount?: string; currency?: string } }[];
    _shipments?: { waybill?: string; carrierId?: string }[];
  };
};
const allegroAddress = (a?: NonNullable<AllegroOrder["raw"]["delivery"]>["address"]) =>
  a ? [a.street, [a.zipCode, a.city].filter(Boolean).join(" "), a.countryCode].filter(Boolean).join(", ") : null;

function fmtDateTime(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtMoney(n: number | string | null | undefined, currency: string | null | undefined) {
  if (n === null || n === undefined || n === "") return null;
  return Number(n).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + (currency || "");
}
const formatAddress = (a: Address | null) =>
  a ? [a.street, a.street2, [a.postalCode, a.city].filter(Boolean).join(" "), a.state, a.country].filter(Boolean).join(", ") : null;
const fullName = (a: Address | null) => (a ? [a.firstName, a.lastName].filter(Boolean).join(" ") : null);

function Row({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 px-3 py-2 border-b border-line last:border-b-0 text-sm">
      <span className="text-inksoft">{label}</span>
      <span className={`font-semibold text-right ${mono ? "font-mono" : ""}`}>{value || "—"}</span>
    </div>
  );
}

export default function SalesOrderCard({
  marketplace,
  externalId,
  session,
  members,
  onClose,
}: {
  marketplace: string;
  externalId: string;
  session: Session;
  members: MemberLite[];
  onClose: () => void;
}) {
  const [worker, setWorker] = useState<WorkerData | null>(null);
  const [items, setItems] = useState<SalesItem[]>([]);
  const [bm, setBm] = useState<BmOrder | null>(null);
  const [rf, setRf] = useState<RefurbedOrder | null>(null);
  const [er, setEr] = useState<ErliOrder | null>(null);
  const [al, setAl] = useState<AllegroOrder | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketplace, externalId]);

  async function load() {
    const [{ data: w, error: wErr }, itemsRes, bmRes, rfRes, erRes, alRes] = await Promise.all([
      supabase.from("sales_orders").select("*").eq("marketplace", marketplace).eq("external_id", externalId).maybeSingle(),
      supabase
        .from("sales_order_items")
        .select("item_key, position, sku, serial_number, pads, pad_serials")
        .eq("marketplace", marketplace)
        .eq("external_id", externalId)
        .order("position"),
      marketplace === "backmarket"
        ? supabase.from("bm_orders").select("*").eq("order_id", Number(externalId)).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      marketplace === "refurbed"
        ? supabase.from("refurbed_orders").select("*").eq("id", externalId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      marketplace === "erli"
        ? supabase.from("erli_orders").select("*").eq("id", externalId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      marketplace === "allegro"
        ? supabase.from("allegro_orders").select("*").eq("id", externalId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    const firstError = wErr || itemsRes.error || bmRes.error || rfRes.error || erRes.error || alRes.error;
    if (firstError) setError(firstError.message);
    setWorker((w as WorkerData) ?? null);
    setItems((itemsRes.data as SalesItem[]) || []);
    setBm((bmRes.data as BmOrder) ?? null);
    setRf((rfRes.data as RefurbedOrder) ?? null);
    setEr((erRes.data as ErliOrder) ?? null);
    setAl((alRes.data as AllegroOrder) ?? null);
    setLoaded(true);
  }

  function startEdit() {
    setDrafts(
      Object.fromEntries(
        items.map((it) => [
          it.item_key,
          { serial: it.serial_number || "", pads: it.pads === null ? "" : String(it.pads), padSerials: it.pad_serials ?? [] },
        ])
      )
    );
    setEditing(true);
  }

  function setDraft(key: string, patch: Partial<ItemDraft>) {
    setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
  }

  async function saveEdit() {
    if (!worker) return;
    const multiple = items.length > 1;
    const jobs: { item: SalesItem; next: { serial: string | null; pads: number | null; padSerials: string[] | null }; changes: FieldChange[] }[] = [];

    for (const item of items) {
      const d = drafts[item.item_key];
      if (!d) continue;
      const padsText = d.pads.trim();
      if (padsText && (!/^\d{1,2}$/.test(padsText) || Number(padsText) > MAX_PADS)) {
        setError(`Pady: podaj liczbę całkowitą od 0 do ${MAX_PADS}.`);
        return;
      }
      const padCount = padsText ? Number(padsText) : 0;
      const list = Array.from({ length: Math.max(padCount, d.padSerials.length) }, (_, i) => (d.padSerials[i] ?? "").trim());
      const next = {
        serial: d.serial.trim() || null,
        pads: padsText ? Number(padsText) : null,
        padSerials: list.every((x) => !x) ? null : list,
      };
      const changes: FieldChange[] = [];
      const diff = (field: string, from: string | number | null, to: string | number | null) => {
        if ((from ?? "") !== (to ?? "")) {
          changes.push({ field: itemFieldLabel(field, item, multiple), from: from === null ? null : String(from), to: to === null ? null : String(to) });
        }
      };
      diff("Numer seryjny", item.serial_number, next.serial);
      diff("Pady", item.pads, next.pads);
      for (let i = 0; i < Math.max(item.pad_serials?.length ?? 0, next.padSerials?.length ?? 0); i++) {
        diff(`Nr seryjny pada ${i + 1}`, item.pad_serials?.[i] || null, next.padSerials?.[i] || null);
      }
      if (changes.length > 0) jobs.push({ item, next, changes });
    }

    if (jobs.length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setError("");
    try {
      for (const job of jobs) {
        const entry: SalesHistoryEntry = { action: "edited", by_email: session.user.email ?? null, at: new Date().toISOString(), changes: job.changes };
        const { error: err } = await updateSalesItem({ marketplace, externalId, itemKey: job.item.item_key, ...job.next, entry });
        if (err) throw err;
      }
      setEditing(false);
      await load();
    } catch (e: any) {
      setError(e.message || "Błąd zapisu.");
      await load(); // część pozycji mogła się zapisać — pokaż aktualny stan
    } finally {
      setSaving(false);
    }
  }

  const marketplaceLabel = MARKETPLACES.find((m) => m.key === marketplace)?.label ?? marketplace;

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg bg-paper h-full overflow-y-auto p-6 border-l border-line">
        <div className="flex justify-between items-start mb-1">
          <div>
            <div className="text-xs text-inksoft">ZAMÓWIENIE · {marketplaceLabel.toUpperCase()}</div>
            <h2 className="text-lg font-semibold font-mono">{externalId}</h2>
          </div>
          <button onClick={onClose} className="text-inksoft text-lg">✕</button>
        </div>

        {error && <p className="text-rust text-xs mb-4">{error}</p>}
        {!loaded && <p className="text-inksoft text-sm">Wczytywanie…</p>}
        {loaded && !worker && !error && <p className="text-inksoft text-sm">Nie znaleziono zamówienia.</p>}

        {worker && (
          <>
            <div className="flex items-center gap-3 mb-6">
              <span className="inline-block text-xs font-semibold px-2 py-1 rounded-full bg-tealsoft text-teal">
                {salesStatusLabel(marketplace, worker.status)}
              </span>
              {marketplace === "backmarket" && (
                <a href={backMarketOrderUrl(externalId)} target="_blank" rel="noreferrer" className="text-xs font-semibold text-teal hover:underline">
                  Otwórz w Back Market ↗
                </a>
              )}
            </div>

            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-inksoft">DANE WPROWADZONE PRZEZ PRACOWNIKA</h3>
              {!editing && items.length > 0 && <button onClick={startEdit} className="text-xs font-semibold text-teal hover:underline">Edytuj</button>}
            </div>
            {items.length === 0 && (
              <div className="border border-line bg-white mb-6 p-3 text-sm text-inksoft">
                Brak pozycji dla tego zamówienia — pojawią się po synchronizacji (Odśwież).
              </div>
            )}
            {items.map((it) => {
              const d = drafts[it.item_key];
              const title = items.length > 1 ? `Pozycja ${it.position} · ${it.sku ?? "—"}` : it.sku ? `SKU ${it.sku}` : null;
              return (
                <div key={it.item_key} className="border border-line bg-white mb-3">
                  {title && <div className="px-3 py-2 text-xs font-semibold text-inksoft border-b border-line font-mono">{title}</div>}
                  {!editing && (
                    <>
                      <Row label="Numer seryjny" value={it.serial_number} mono />
                      <Row label="Pady" value={it.pads === null ? null : String(it.pads)} mono />
                      {Array.from({ length: Math.min(it.pads ?? 0, MAX_PADS) }, (_, i) => (
                        <Row key={i} label={`Nr seryjny pada ${i + 1}`} value={it.pad_serials?.[i]} mono />
                      ))}
                    </>
                  )}
                  {editing && d && (
                    <div className="p-3 space-y-2">
                      <div>
                        <label className="text-xs font-semibold text-inksoft block mb-1">Numer seryjny</label>
                        <input value={d.serial} onChange={(e) => setDraft(it.item_key, { serial: e.target.value })} className="w-full border border-line bg-white px-2 py-1.5 rounded text-sm font-mono" />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-inksoft block mb-1">Pady (liczba w zestawie)</label>
                        <input value={d.pads} onChange={(e) => setDraft(it.item_key, { pads: e.target.value })} inputMode="numeric" className="w-full border border-line bg-white px-2 py-1.5 rounded text-sm font-mono" />
                      </div>
                      {Array.from({ length: Math.min(Number(d.pads) || 0, MAX_PADS) }, (_, i) => (
                        <div key={i}>
                          <label className="text-xs font-semibold text-inksoft block mb-1">Nr seryjny pada {i + 1}</label>
                          <input
                            value={d.padSerials[i] ?? ""}
                            onChange={(e) => {
                              const next = [...d.padSerials];
                              while (next.length <= i) next.push("");
                              next[i] = e.target.value;
                              setDraft(it.item_key, { padSerials: next });
                            }}
                            className="w-full border border-line bg-white px-2 py-1.5 rounded text-sm font-mono"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {editing && (
              <div className="flex gap-2 mb-6">
                <button onClick={saveEdit} disabled={saving} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">
                  {saving ? "Zapisywanie…" : "Zapisz"}
                </button>
                <button onClick={() => setEditing(false)} className="px-4 py-2 border border-line rounded text-sm font-semibold">Anuluj</button>
              </div>
            )}
            <div className="mb-3" />

            <h3 className="text-xs font-semibold text-inksoft mb-2">ZAMÓWIENIE</h3>
            <div className="border border-line bg-white mb-6">
              <Row label="Nasz status" value={OUR_STATUSES.find((o) => o.key === worker.our_status)?.label ?? worker.our_status} />
              <Row label="Data zamówienia" value={fmtDateTime(worker.order_date)} />
              <Row label="SKU" value={worker.sku} mono />
              {marketplace === "backmarket" && (
                <>
                  <Row label="Kraj" value={bm?.country_code} />
                  <Row label="Płatność" value={bm?.payment_method} />
                  <Row label="Suma (z podatkami, bez wysyłki)" value={fmtMoney(bm?.price, bm?.currency)} />
                  <Row label="Wysyłka" value={fmtMoney(bm?.shipping_price, bm?.currency)} />
                  <Row label="Podatki" value={fmtMoney(bm?.sales_taxes, bm?.currency)} />
                </>
              )}
              {marketplace === "allegro" && (
                <>
                  <Row label="Rynek" value={al?.marketplace_id} />
                  <Row label="Status realizacji (Allegro)" value={al?.fulfillment_status} />
                  <Row
                    label="Płatność"
                    value={!al ? null : al.payment_type === "CASH_ON_DELIVERY" ? "za pobraniem" : al.payment_type === "ONLINE" ? "online" : al.payment_type}
                  />
                  <Row label="Suma (z dostawą)" value={fmtMoney(al?.total_to_pay, al?.currency)} />
                  <Row label="Kupujący (login)" value={al?.buyer_login} />
                  <Row label="Faktura" value={al?.raw.invoice?.required === undefined ? null : al.raw.invoice.required ? "wymagana" : "nie"} />
                </>
              )}
              {marketplace === "erli" && (
                <>
                  <Row label="Rynek" value={er?.market?.toUpperCase()} />
                  <Row label="Status zamówienia w systemie sprzedawcy" value={er?.seller_status} />
                  <Row
                    label="Płatność"
                    value={!er ? null : er.raw.delivery?.cod ? "za pobraniem" : er.status === "pending" ? "oczekuje na płatność" : er.status === "purchased" ? "opłacone" : null}
                  />
                  <Row label="Suma (z dostawą)" value={grosze(er?.total_price, er?.currency)} />
                  <Row label="E-mail klienta" value={er?.raw.user?.email} />
                </>
              )}
              {marketplace === "refurbed" && (
                <>
                  <Row label="Kraj" value={rf?.raw.shipping_address?.country_code} />
                  <Row label="Płatność" value={rf?.payment_method} />
                  <Row label="Suma (zapłacona przez klienta)" value={fmtMoney(rf?.total_charged, rf?.currency_code)} />
                  <Row label="Zwroty" value={fmtMoney(rf?.raw.total_refunded, rf?.currency_code)} />
                  <Row label="Podatek VAT" value={fmtMoney(rf?.raw.total_vat_charged, rf?.currency_code)} />
                  <Row label="Prowizja" value={fmtMoney(rf?.raw.settlement_total_commission, rf?.raw.settlement_currency_code)} />
                  <Row label="E-mail klienta" value={rf?.customer_email} />
                </>
              )}
            </div>

            {((marketplace === "backmarket" && !bm) || (marketplace === "refurbed" && !rf) || (marketplace === "erli" && !er) || (marketplace === "allegro" && !al)) && (
              <p className="text-inksoft text-xs mb-6">Brak surowych danych z API dla tego zamówienia.</p>
            )}

            {al && (
              <>
                {!!al.raw.lineItems?.length && (
                  <>
                    <h3 className="text-xs font-semibold text-inksoft mb-2">POZYCJE</h3>
                    {al.raw.lineItems.map((l, i) => (
                      <div key={l.id ?? i} className="border border-line bg-white mb-2">
                        <Row label="Oferta" value={l.offer?.name} />
                        <Row label="SKU (id w naszym systemie)" value={l.offer?.external?.id} mono />
                        <Row label="Id oferty Allegro" value={l.offer?.id} mono />
                        <Row label="Ilość" value={l.quantity === undefined ? null : String(l.quantity)} />
                        <Row label="Cena" value={fmtMoney(l.price?.amount, l.price?.currency)} />
                      </div>
                    ))}
                    <div className="mb-4" />
                  </>
                )}

                <h3 className="text-xs font-semibold text-inksoft mb-2">DATY</h3>
                <div className="border border-line bg-white mb-6">
                  <Row label="Kupiono" value={fmtDateTime(al.raw.lineItems?.[0]?.boughtAt ?? null)} />
                  <Row label="Opłacono" value={fmtDateTime(al.raw.payment?.finishedAt ?? null)} />
                  <Row label="Zmieniono" value={fmtDateTime(al.updated_at)} />
                </div>

                <h3 className="text-xs font-semibold text-inksoft mb-2">DOSTAWA</h3>
                <div className="border border-line bg-white mb-6">
                  <Row label="Sposób dostawy" value={al.raw.delivery?.method?.name} />
                  <Row label="Koszt dostawy" value={fmtMoney(al.raw.delivery?.cost?.amount, al.raw.delivery?.cost?.currency)} />
                  <Row
                    label="Punkt odbioru"
                    value={al.raw.delivery?.pickupPoint ? [al.raw.delivery.pickupPoint.name, al.raw.delivery.pickupPoint.address?.street, al.raw.delivery.pickupPoint.address?.city].filter(Boolean).join(", ") : null}
                  />
                  <Row label="Numer przesyłki" value={(al.raw._shipments || []).map((x) => x.waybill).filter(Boolean).join(", ")} mono />
                </div>

                <h3 className="text-xs font-semibold text-inksoft mb-2">KLIENT (ADRES DOSTAWY)</h3>
                <div className="border border-line bg-white mb-6">
                  <Row
                    label="Imię i nazwisko"
                    value={[al.raw.delivery?.address?.firstName, al.raw.delivery?.address?.lastName].filter(Boolean).join(" ") || al.raw.delivery?.address?.companyName}
                  />
                  <Row label="Telefon" value={al.raw.delivery?.address?.phoneNumber || al.raw.buyer?.phoneNumber} />
                  <Row label="Adres" value={allegroAddress(al.raw.delivery?.address)} />
                  <Row label="E-mail" value={al.raw.buyer?.email} />
                  <Row label="Wiadomość do sprzedawcy" value={al.raw.messageToSeller} />
                </div>
              </>
            )}

            {er && (
              <>
                {!!er.raw.items?.length && (
                  <>
                    <h3 className="text-xs font-semibold text-inksoft mb-2">POZYCJE</h3>
                    {er.raw.items.map((l, i) => (
                      <div key={l.id ?? i} className="border border-line bg-white mb-2">
                        <Row label="Produkt" value={l.name} />
                        <Row label="SKU" value={l.sku || l.externalId} mono />
                        <Row label="EAN" value={l.ean} mono />
                        <Row label="Ilość" value={l.quantity === undefined ? null : String(l.quantity)} />
                        <Row label="Cena jednostkowa" value={grosze(l.unitPrice, er.currency)} />
                      </div>
                    ))}
                    <div className="mb-4" />
                  </>
                )}

                <h3 className="text-xs font-semibold text-inksoft mb-2">DATY</h3>
                <div className="border border-line bg-white mb-6">
                  <Row label="Utworzono" value={fmtDateTime(er.created)} />
                  <Row label="Opłacono" value={fmtDateTime(er.purchased_at)} />
                  <Row label="Zmieniono" value={fmtDateTime(er.updated)} />
                </div>

                <h3 className="text-xs font-semibold text-inksoft mb-2">DOSTAWA</h3>
                <div className="border border-line bg-white mb-6">
                  <Row label="Sposób dostawy" value={er.raw.delivery?.name} />
                  <Row label="Koszt dostawy" value={grosze(er.raw.delivery?.price, er.currency)} />
                  <Row
                    label="Punkt odbioru"
                    value={er.raw.delivery?.pickupPlace ? [er.raw.delivery.pickupPlace.name, er.raw.delivery.pickupPlace.address, er.raw.delivery.pickupPlace.city].filter(Boolean).join(", ") : null}
                  />
                  <Row label="Przewoźnik" value={er.raw.deliveryTracking?.vendor} />
                  <Row label="Status przesyłki" value={er.raw.deliveryTracking?.status} />
                  <Row label="Numer przesyłki" value={er.raw.deliveryTracking?.trackingNumber} mono />
                  {er.raw.deliveryTracking?.trackingUrl && (
                    <div className="flex justify-between px-3 py-2 text-sm border-t border-line">
                      <span className="text-inksoft">Śledzenie</span>
                      <a href={er.raw.deliveryTracking.trackingUrl} target="_blank" rel="noreferrer" className="text-teal hover:underline">otwórz</a>
                    </div>
                  )}
                </div>

                <h3 className="text-xs font-semibold text-inksoft mb-2">KLIENT (ADRES DOSTAWY)</h3>
                <div className="border border-line bg-white mb-6">
                  <Row
                    label="Imię i nazwisko"
                    value={[er.raw.user?.deliveryAddress?.firstName, er.raw.user?.deliveryAddress?.lastName].filter(Boolean).join(" ") || er.raw.user?.deliveryAddress?.companyName}
                  />
                  <Row label="Telefon" value={er.raw.user?.deliveryAddress?.phone} />
                  <Row label="Adres" value={erliAddress(er.raw.user?.deliveryAddress)} />
                  <Row label="Uwaga kupującego" value={er.raw.comment} />
                </div>
              </>
            )}

            {rf && (
              <>
                {!!rf.raw.items?.length && (
                  <>
                    <h3 className="text-xs font-semibold text-inksoft mb-2">POZYCJE</h3>
                    {rf.raw.items.map((l, i) => (
                      <div key={l.id ?? i} className="border border-line bg-white mb-2">
                        <Row label="Produkt" value={l.name} />
                        <Row label="SKU" value={l.sku} mono />
                        <Row label="Stan pozycji" value={l.state} />
                        <Row label="Cena" value={fmtMoney(l.total_charged, l.currency_code)} />
                        <Row
                          label="Identyfikatory (refurbed)"
                          value={(l.item_identifiers || []).map((x) => `${x.identifier_type ?? ""} ${x.value ?? ""}`.trim()).join(", ") || l.item_identifier}
                          mono
                        />
                        {l.parcel_tracking_url && (
                          <div className="flex justify-between px-3 py-2 text-sm border-t border-line">
                            <span className="text-inksoft">Śledzenie paczki</span>
                            <a href={l.parcel_tracking_url} target="_blank" rel="noreferrer" className="text-teal hover:underline">otwórz</a>
                          </div>
                        )}
                      </div>
                    ))}
                    <div className="mb-4" />
                  </>
                )}

                <h3 className="text-xs font-semibold text-inksoft mb-2">DATY</h3>
                <div className="border border-line bg-white mb-6">
                  <Row label="Zamówienie trafiło do sprzedawcy" value={fmtDateTime(rf.released_at)} />
                </div>

                <h3 className="text-xs font-semibold text-inksoft mb-2">KLIENT (ADRES DOSTAWY)</h3>
                <div className="border border-line bg-white mb-6">
                  <Row
                    label="Imię i nazwisko"
                    value={[rf.raw.shipping_address?.first_name, rf.raw.shipping_address?.family_name].filter(Boolean).join(" ") || rf.raw.shipping_address?.company_name}
                  />
                  <Row label="Telefon" value={rf.raw.shipping_address?.phone_number} />
                  <Row label="Adres" value={refurbedAddress(rf.raw.shipping_address)} />
                </div>
              </>
            )}

            {bm && (
              <>
                {!!bm.orderlines?.length && (
                  <>
                    <h3 className="text-xs font-semibold text-inksoft mb-2">POZYCJE</h3>
                    {bm.orderlines.map((l, i) => (
                      <div key={l.id ?? i} className="border border-line bg-white mb-2">
                        <Row label="Produkt" value={l.product} />
                        <Row label="SKU" value={l.listing} mono />
                        <Row label="Ilość" value={l.quantity === undefined ? null : String(l.quantity)} />
                        <Row label="Cena" value={fmtMoney(l.price, l.currency)} />
                        <Row label="IMEI (Back Market)" value={l.imei} mono />
                        <Row label="Numer seryjny (Back Market)" value={l.serial_number} mono />
                      </div>
                    ))}
                    <div className="mb-4" />
                  </>
                )}

                <h3 className="text-xs font-semibold text-inksoft mb-2">DATY</h3>
                <div className="border border-line bg-white mb-6">
                  <Row label="Utworzono" value={fmtDateTime(bm.date_creation)} />
                  <Row label="Zmieniono" value={fmtDateTime(bm.date_modification)} />
                  <Row label="Opłacono" value={fmtDateTime(bm.date_payment)} />
                  <Row label="Wysłano" value={fmtDateTime(bm.date_shipping)} />
                  <Row label="Planowana wysyłka" value={fmtDateTime(bm.expected_dispatch_date)} />
                </div>

                <h3 className="text-xs font-semibold text-inksoft mb-2">DOSTAWA</h3>
                <div className="border border-line bg-white mb-6">
                  <Row label="Sposób dostawy" value={bm.delivery_mode} />
                  <Row label="Przewoźnik" value={bm.shipper_display} />
                  <Row label="Numer przesyłki" value={bm.tracking_number} mono />
                  {bm.tracking_url && (
                    <div className="flex justify-between px-3 py-2 text-sm border-t border-line">
                      <span className="text-inksoft">Śledzenie</span>
                      <a href={bm.tracking_url} target="_blank" rel="noreferrer" className="text-teal hover:underline">otwórz</a>
                    </div>
                  )}
                </div>

                <h3 className="text-xs font-semibold text-inksoft mb-2">KLIENT (ADRES DOSTAWY)</h3>
                <div className="border border-line bg-white mb-6">
                  <Row label="Imię i nazwisko" value={fullName(bm.shipping_address)} />
                  <Row label="Telefon" value={bm.shipping_address?.phoneNumber} />
                  <Row label="Adres" value={formatAddress(bm.shipping_address)} />
                </div>
              </>
            )}

            <h3 className="text-xs font-semibold text-inksoft mb-2">LOG ZMIAN</h3>
            <div className="border border-line bg-white mb-6 p-3 text-sm">
              {!worker.history?.length && <div className="text-inksoft">Brak jeszcze wpisów.</div>}
              {worker.history?.map((h, i) => (
                <div key={i} className="mb-2">
                  <div>
                    <span className="font-mono text-inksoft mr-1">{i + 1}.</span>
                    Edytowano przez <span className="font-semibold">{displayNameForEmail(h.by_email, members)}</span>, {fmtDateTime(h.at)}
                  </div>
                  {!!h.changes?.length && (
                    <ul className="ml-6 list-disc text-xs text-inksoft">
                      {h.changes.map((c, j) => (
                        <li key={j}>{c.field}: „{c.from || "—"}” → „{c.to || "—"}”</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
