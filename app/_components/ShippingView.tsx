"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { COUNTRY_NAMES, DHL_EU_COUNTRIES, isEconomySelect, type DhlMoney, type DhlProduct } from "@/lib/dhlExpress";
import { base64ToBlobUrl, defaultShippingDate, type ShipPrefill } from "@/lib/shipping";
import { MARKETPLACES } from "@/lib/salesOrders";

// Zakładka Wysyłka: nadawanie przesyłek DHL Express (MyDHL API) — formularz z wyceną, szablony paczek, ustawienia nadawcy i lista nadanych
// przesyłek z etykietami (PDF 10x15 na Zebrę). Dostęp: Admin i Manager. Klucze i numer konta są tylko na serwerze
// (route'y /api/shipping/dhl-express/*). Na środowisku produkcyjnym nadanie to PRAWDZIWA przesyłka (koszt), a DHL Express nie pozwala
// jej anulować przez API — dlatego przed nadaniem jest ostrzeżenie z potwierdzeniem.

const fmtMoney = (m: DhlMoney | null | undefined) =>
  m ? `${m.price.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${m.currency}` : "—";
// shipments.charges ma kształt DHL (tablica) tylko dla dhl_express/dhl_parcel — dla erli_paczkomat to co innego
// (id paczki Erli, potrzebny do anulowania), więc nigdy nie zakładamy tablicy bez sprawdzenia.
const dhlCharge = (charges: unknown): { currencyType: string; priceCurrency: string; price: number } | null =>
  Array.isArray(charges) ? charges.find((c: any) => c?.currencyType === "BILLC") ?? charges[0] ?? null : null;
const inputCls = "w-full border border-line bg-white px-2 py-2 rounded text-sm";
const btnPrimary = "bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50";
const btnGhost = "bg-white border border-line px-3 py-2 rounded text-sm font-semibold disabled:opacity-50";
const label = "text-xs font-semibold text-inksoft block mb-1";

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

type Settings = {
  shipper_company: string;
  shipper_name: string;
  street: string;
  postal_code: string;
  city: string;
  country_code: string;
  phone: string;
  email: string | null;
  default_description: string;
};
type Template = { id: number; name: string; weight_kg: number; length_cm: number; width_cm: number; height_cm: number; description: string | null };
type Carrier = "parcel" | "express";
const CARRIER_LABEL: Record<Carrier, string> = { parcel: "DHL Parcel", express: "DHL Express" };

// Wspólny kształt wiersza wyceny dla obu przewoźników (tabela wyboru produktu).
type QuoteRow = {
  code: string;
  name: string;
  billing: DhlMoney | null;
  local: DhlMoney | null;
  chargeableWeight: number | null;
  transitDays: number | null;
  estimatedDelivery: string | null;
  breakdown: { name: string; price: number }[];
  unavailable?: string; // powód, dla którego produktu nie da się wybrać (np. niedostępny na trasie)
  economy?: boolean;
};

type ShipmentRow = {
  id: number;
  carrier: string;
  cancelled_at: string | null;
  has_label?: boolean;
  created_at: string;
  created_by_email: string | null;
  environment: string;
  marketplace: string | null;
  order_external_id: string | null;
  product_code: string;
  product_name: string | null;
  tracking_number: string;
  tracking_url: string | null;
  receiver: { name?: string; company?: string; city?: string; countryCode?: string };
  charges: unknown; // tablica {currencyType,priceCurrency,price} dla DHL; dla Erli inny kształt (id paczki) — patrz dhlCharge()
  marketplace_synced_at: string | null;
  marketplace_sync_error: string | null;
};

const EMPTY_FORM = { name: "", company: "", street: "", houseNumber: "", apartment: "", postalCode: "", city: "", countryCode: "DE", phone: "", email: "", template: "", weight: "", length: "", width: "", height: "", description: "", reference: "" };

export default function ShippingView({
  session,
  isAdmin,
  prefill,
  onPrefillUsed,
}: {
  session: Session;
  isAdmin: boolean;
  prefill: ShipPrefill | null;
  onPrefillUsed: () => void;
}) {
  const auth = { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
  const [express, setExpress] = useState<{ configured: boolean; env: string | null } | null>(null);
  const [parcel, setParcel] = useState<{ configured: boolean; sandbox: boolean; version: string | null } | null>(null);
  const [carrier, setCarrier] = useState<Carrier>("parcel");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [shipments, setShipments] = useState<ShipmentRow[]>([]);
  const [error, setError] = useState("");
  const [prefillNote, setPrefillNote] = useState(""); // ostrzeżenie: marketplace nie przekazał (jeszcze) pełnych danych odbiorcy

  const [form, setForm] = useState(EMPTY_FORM);
  const [order, setOrder] = useState<{ marketplace: string; externalId: string } | null>(null);
  const [plannedDate, setPlannedDate] = useState(defaultShippingDate());
  const [quoting, setQuoting] = useState(false);
  const [quote, setQuote] = useState<{ carrier: Carrier; products: QuoteRow[]; warnings: string[] } | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState<{ trackingNumber: string; trackingUrl: string | null; price: string; env: string; saved: boolean; labelBase64?: string | null; id?: number; error?: string; carrier: Carrier; marketplaceSyncError?: string | null; ourStatusError?: string | null } | null>(null);
  const requestId = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    fetch("/api/shipping/dhl-express/check", { headers: auth })
      .then((r) => r.json())
      .then((d) => setExpress({ configured: !!d.configured, env: d.env ?? null }))
      .catch(() => setExpress({ configured: false, env: null }));
    fetch("/api/shipping/dhl-parcel/check", { headers: auth })
      .then((r) => r.json())
      .then((d) => setParcel({ configured: !!d.configured, sandbox: !!d.sandbox, version: d.version ?? null }))
      .catch(() => setParcel({ configured: false, sandbox: false, version: null }));
    loadSettings();
    loadTemplates();
    loadShipments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wejście z karty zamówienia: adres odbiorcy i numer zamówienia wypełniają formularz.
  useEffect(() => {
    if (!prefill) return;
    setForm({ ...EMPTY_FORM, name: prefill.name, company: prefill.company, street: prefill.street, houseNumber: prefill.houseNumber, apartment: prefill.apartment, postalCode: prefill.postalCode, city: prefill.city, countryCode: prefill.countryCode, phone: prefill.phone, email: prefill.email, reference: prefill.externalId });
    setOrder({ marketplace: prefill.marketplace, externalId: prefill.externalId });
    setQuote(null);
    setChosen(null);
    setDone(null);
    // Marketplace czasem naprawdę nie ma jeszcze pełnych danych odbiorcy (np. bardzo świeże zamówienie) —
    // zamiast ciszy przy pustych wymaganych polach, mówimy to wprost zamiast zostawiać zespół w niepewności.
    // (Wcześniej podejrzewaliśmy, że to typowo kwestia stanu zamówienia w Back Market — to był błędny trop:
    // prawdziwą przyczyną większości przypadków był bug w nazwach pól, poprawiony 28.09.2026, patrz CLAUDE.md.)
    const missingLabels = [
      !prefill.name.trim() && "imię i nazwisko",
      !prefill.street.trim() && "ulica",
      !prefill.houseNumber.trim() && "numer domu",
      !prefill.postalCode.trim() && "kod pocztowy",
      !prefill.city.trim() && "miasto",
      !prefill.phone.trim() && "telefon",
    ].filter((x): x is string => !!x);
    const marketplaceLabel = MARKETPLACES.find((m) => m.key === prefill.marketplace)?.label ?? prefill.marketplace;
    setPrefillNote(
      missingLabels.length > 0
        ? `${marketplaceLabel} nie przekazał (jeszcze) pełnych danych odbiorcy dla tego zamówienia — brakuje: ${missingLabels.join(", ")}. Uzupełnij ręcznie albo sprawdź zamówienie w ${marketplaceLabel}.`
        : ""
    );
    requestId.current = crypto.randomUUID();
    onPrefillUsed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  async function loadSettings() {
    const { data } = await supabase.from("shipping_settings").select("*").eq("id", 1).maybeSingle();
    setSettings((data as Settings) ?? null);
  }
  async function loadTemplates() {
    const { data } = await supabase.from("shipping_templates").select("*").order("name");
    setTemplates((data as Template[]) || []);
  }
  async function loadShipments() {
    const { data, error: err } = await supabase
      .from("shipments")
      .select("id, created_at, carrier, cancelled_at, label_format, created_by_email, environment, marketplace, order_external_id, product_code, product_name, tracking_number, tracking_url, receiver, charges, marketplace_synced_at, marketplace_sync_error")
      .order("created_at", { ascending: false })
      .limit(50);
    if (err) setError(`Nie udało się wczytać przesyłek: ${err.message}`);
    else setShipments(((data as (ShipmentRow & { label_format: string | null })[]) || []).map((r) => ({ ...r, has_label: !!r.label_format })));
  }

  function setField(k: keyof typeof EMPTY_FORM, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
    setQuote(null); // zmiana danych unieważnia wycenę
    setChosen(null);
  }

  function applyTemplate(id: string) {
    const t = templates.find((x) => String(x.id) === id);
    setQuote(null);
    setChosen(null);
    if (!t) return setForm((f) => ({ ...f, template: "" }));
    setForm((f) => ({
      ...f,
      template: String(t.id),
      weight: String(t.weight_kg),
      length: String(t.length_cm),
      width: String(t.width_cm),
      height: String(t.height_cm),
      description: t.description || settings?.default_description || "",
    }));
  }

  const packagePayload = () => ({
    weight: Number(form.weight.replace(",", ".")),
    length: Number(form.length.replace(",", ".")),
    width: Number(form.width.replace(",", ".")),
    height: Number(form.height.replace(",", ".")),
    description: form.description.trim() || settings?.default_description || "",
    template: templates.find((t) => String(t.id) === form.template)?.name ?? null,
  });

  const receiverPayload = () => ({
    name: form.name,
    company: form.company,
    street: form.street,
    houseNumber: form.houseNumber,
    apartment: form.apartment,
    postalCode: form.postalCode,
    city: form.city,
    countryCode: form.countryCode,
    phone: form.phone,
    email: form.email,
  });

  async function getQuote() {
    setError("");
    setQuote(null);
    setChosen(null);
    setDone(null);
    setQuoting(true);
    try {
      const p = packagePayload();
      const res = await fetch(`/api/shipping/${carrier === "parcel" ? "dhl-parcel" : "dhl-express"}/check`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          receiver: receiverPayload(),
          package: p,
          plannedDate,
          // pola płaskie dla wyceny DHL Express (route sprawdza połączenie po tej trasie)
          destinationCountryCode: form.countryCode,
          destinationCityName: form.city,
          destinationPostalCode: form.postalCode,
          weight: p.weight,
          length: p.length,
          width: p.width,
          height: p.height,
          isCustomsDeclarable: false,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Nie udało się wycenić przesyłki.");
      let rows: QuoteRow[];
      let warnings: string[] = [];
      if (carrier === "parcel") {
        rows = (data.quotes as { product: string; name: string; ok: boolean; price: number | null; fuelSurcharge: number | null; error?: string }[]).map((q) => ({
          code: q.product,
          name: `${q.name} (${q.product})`,
          billing: q.price !== null ? { price: q.price, currency: "PLN" } : null,
          local: q.price !== null ? { price: q.price, currency: "PLN" } : null,
          chargeableWeight: null,
          transitDays: null,
          estimatedDelivery: null,
          breakdown: q.fuelSurcharge ? [{ name: "w tym dopłata paliwowa", price: q.fuelSurcharge }] : [],
          unavailable: q.ok ? undefined : q.error || "niedostępny na tej trasie",
        }));
      } else {
        rows = (data.products as DhlProduct[]).map((p2) => ({ ...p2, economy: isEconomySelect(p2) }));
        warnings = data.warnings || [];
      }
      setQuote({ carrier, products: rows, warnings });
      // Domyślny wybór: Economy Select (Express) albo najtańszy dostępny produkt (Parcel)
      const eco = rows.find((r) => r.economy);
      const cheapest = rows.filter((r) => !r.unavailable && r.billing).sort((x, y) => (x.billing!.price - y.billing!.price))[0];
      setChosen(eco?.code ?? cheapest?.code ?? null);
    } catch (e: any) {
      setError(e.message || "Nie udało się wycenić przesyłki.");
    } finally {
      setQuoting(false);
    }
  }

  async function create() {
    const product = quote?.products.find((p) => p.code === chosen);
    if (!product || !quote) return;
    const isParcel = quote.carrier === "parcel";
    const prod = isParcel && parcel?.sandbox === false;
    const env = isParcel ? (parcel?.sandbox ? "TESTOWE" : "PRODUKCYJNE") : express?.env === "production" ? "PRODUKCYJNE" : "TESTOWE";
    const ok = confirm(
      `NADANIE PRZESYŁKI ${CARRIER_LABEL[quote.carrier].toUpperCase()} (środowisko ${env})\n\n` +
        `Produkt: ${product.name}\nCena wg cennika: ${fmtMoney(product.billing)}\n` +
        `Odbiorca: ${form.name}, ${form.street} ${form.houseNumber}${form.apartment ? "/" + form.apartment : ""}, ${form.postalCode} ${form.city}, ${form.countryCode}\n` +
        `Paczka: ${form.weight} kg, ${form.length}×${form.width}×${form.height} cm\n\n` +
        (isParcel
          ? prod
            ? "To PRAWDZIWA przesyłka (DHL Parcel nie ma środowiska testowego) — obciąży konto DHL. Możesz ją anulować na liście przesyłek, dopóki nie zamówisz po nią kuriera.\n\n"
            : "Środowisko testowe: przesyłka nie jest prawdziwa.\n\n"
          : express?.env === "production"
            ? "To PRAWDZIWA przesyłka — obciąży konto DHL. DHL Express nie pozwala jej anulować przez API (tylko w panelu DHL).\n\n"
            : "Środowisko testowe: przesyłka nie jest prawdziwa i nie obciąża konta.\n\n") +
        "Nadać przesyłkę i wygenerować etykietę?"
    );
    if (!ok) return;

    setError("");
    setCreating(true);
    try {
      const res = await fetch(`/api/shipping/${isParcel ? "dhl-parcel" : "dhl-express"}/create`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          confirm: true,
          clientRequestId: requestId.current,
          productCode: product.code,
          productName: product.name,
          plannedDate,
          receiver: receiverPayload(),
          package: packagePayload(),
          reference: form.reference,
          order,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Nie udało się nadać przesyłki.");
      setDone({
        trackingNumber: data.trackingNumber,
        trackingUrl: data.trackingUrl ?? null,
        price: fmtMoney(product.billing),
        env: data.environment ?? "test",
        saved: data.saved !== false,
        labelBase64: data.labelBase64 ?? null,
        id: data.id,
        error: data.saved === false ? data.error : data.labelError ? `Przesyłka nadana, ale nie udało się pobrać etykiety: ${data.labelError}. Kliknij „Otwórz etykietę”, aby spróbować ponownie.` : undefined,
        carrier: quote.carrier,
        marketplaceSyncError: data.marketplaceSyncError ?? null,
        ourStatusError: data.ourStatusError ?? null,
      });
      requestId.current = crypto.randomUUID(); // kolejna przesyłka = nowy klucz
      setQuote(null);
      setChosen(null);
      await loadShipments();
    } catch (e: any) {
      setError(e.message || "Nie udało się nadać przesyłki.");
    } finally {
      setCreating(false);
    }
  }

  // Anulowanie przesyłki DHL Parcel (DHL Express nie udostępnia tego w API).
  async function cancelShipment(s: ShipmentRow) {
    const carrierName = s.carrier === "erli_paczkomat" ? "Erli" : "DHL";
    if (!confirm(`Anulować przesyłkę ${s.tracking_number}?\n\n${carrierName} pozwala na to tylko wtedy, gdy nie zamówiono po nią kuriera / nie trafiła do sieci.`)) return;
    setError("");
    const endpoint = s.carrier === "erli_paczkomat" ? "/api/shipping/erli/cancel" : "/api/shipping/dhl-parcel/cancel";
    const res = await fetch(endpoint, { method: "POST", headers: auth, body: JSON.stringify({ id: s.id, confirm: true }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data?.error || "Nie udało się anulować przesyłki.");
    await loadShipments();
  }

  // Ponawia zgłoszenie numeru przesyłki do marketplace'u (Back Market / refurbed), gdy pierwsza próba przy nadaniu się nie udała.
  async function retryMarketplaceSync(s: ShipmentRow) {
    setError("");
    const res = await fetch("/api/shipping/sync-marketplace", { method: "POST", headers: auth, body: JSON.stringify({ id: s.id }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data?.error) return setError("Nie udało się zgłosić numeru przesyłki do marketplace'u.");
    await loadShipments();
    if (!data?.synced) setError(data?.error || "Nie udało się zgłosić numeru przesyłki do marketplace'u.");
  }

  async function openLabel(id: number | undefined, base64?: string | null) {
    setError("");
    let data = base64 ?? null;
    if (!data && id !== undefined) {
      const { data: row, error: err } = await supabase.from("shipments").select("label_data, carrier").eq("id", id).maybeSingle();
      if (err) return setError(`Nie udało się wczytać etykiety: ${err.message}`);
      data = (row?.label_data as string | null) ?? null;
      // DHL Parcel: gdy etykiety nie udało się pobrać przy nadaniu, pobieramy ją teraz od DHL i zapisujemy.
      if (!data && row?.carrier === "dhl_parcel") {
        const res = await fetch("/api/shipping/dhl-parcel/label", { method: "POST", headers: auth, body: JSON.stringify({ id }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) return setError(j?.error || "Nie udało się pobrać etykiety.");
        data = j.labelBase64 ?? null;
        await loadShipments();
      }
      // Erli: etykieta praktycznie nigdy nie jest gotowa od razu przy nadaniu — dopytujemy, a jeśli jeszcze jej
      // nie ma, mówimy to wprost zamiast ogólnego "brak etykiety".
      if (!data && row?.carrier === "erli_paczkomat") {
        const res = await fetch("/api/shipping/erli/label", { method: "POST", headers: auth, body: JSON.stringify({ id }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) return setError(j?.error || "Nie udało się pobrać etykiety.");
        if (!j.ready) return setError("Erli jeszcze nie przygotowało etykiety — spróbuj ponownie za chwilę.");
        data = j.labelBase64 ?? null;
        await loadShipments();
      }
    }
    if (!data) return setError("Brak etykiety dla tej przesyłki.");
    window.open(base64ToBlobUrl(data), "_blank"); // PDF 10x15 — drukuj (Ctrl+P) na Zebrze, rozmiar strony 100×150 mm
  }

  function reset() {
    setForm(EMPTY_FORM);
    setOrder(null);
    setQuote(null);
    setChosen(null);
    setDone(null);
    setPrefillNote("");
    setPlannedDate(defaultShippingDate());
    requestId.current = crypto.randomUUID();
  }

  const formReady =
    form.name.trim() && form.street.trim() && form.houseNumber.trim() && form.postalCode.trim() && form.city.trim() && form.phone.trim() && Number(form.weight.replace(",", ".")) > 0 && form.length && form.width && form.height;

  return (
    <div>
      {/* połączenie */}
      <div className="border border-line bg-white p-4 mb-6">
        <h2 className="text-xs font-semibold text-inksoft mb-2">PRZEWOŹNICY</h2>
        {(express === null || parcel === null) && <p className="text-xs text-inksoft">Sprawdzanie konfiguracji…</p>}
        {parcel && (
          <p className="text-xs mb-1">
            <span className="font-semibold">DHL Parcel:</span>{" "}
            {parcel.configured ? (
              <span className="text-inksoft">
                skonfigurowany{parcel.version ? ` (usługa odpowiada, wersja ${parcel.version})` : " (usługa DHL chwilowo nie odpowiedziała)"}.{" "}
                <span className={`font-semibold ${parcel.sandbox ? "text-teal" : "text-rust"}`}>{parcel.sandbox ? "Środowisko testowe." : "Środowisko PRODUKCYJNE — przesyłki są prawdziwe i płatne (można je anulować)."}</span>
              </span>
            ) : (
              <span className="text-rust">nie skonfigurowany — ustaw w Vercel DHL_PARCEL_USERNAME, DHL_PARCEL_PASSWORD i DHL_PARCEL_SAP, potem Redeploy.</span>
            )}
          </p>
        )}
        {express && (
          <p className="text-xs">
            <span className="font-semibold">DHL Express:</span>{" "}
            {express.configured ? (
              <span className="text-inksoft">
                skonfigurowany,{" "}
                <span className={`font-semibold ${express.env === "production" ? "text-rust" : "text-teal"}`}>{express.env === "production" ? "środowisko PRODUKCYJNE — przesyłki są prawdziwe i płatne (nie da się ich anulować przez API)" : "środowisko testowe — przesyłki nie są prawdziwe"}</span>.
              </span>
            ) : (
              <span className="text-rust">nie skonfigurowany — ustaw DHL_EXPRESS_API_KEY, DHL_EXPRESS_API_SECRET, DHL_EXPRESS_ACCOUNT i DHL_EXPRESS_ENV.</span>
            )}
          </p>
        )}
        {settings && <p className="text-xs text-inksoft mt-1">Nadawca: {settings.shipper_company}, {settings.street}, {settings.postal_code} {settings.city}.</p>}
        {!settings && (parcel?.configured || express?.configured) && <p className="text-xs text-rust mt-1">Brak danych nadawcy — uruchom supabase/shipping.sql.</p>}
      </div>

      {error && <p className="text-rust text-xs mb-4">{error}</p>}

      {(parcel?.configured || express?.configured) && settings && (
        <>
          {/* wynik nadania */}
          {done && (
            <div className={`border p-4 mb-6 ${done.saved ? "border-teal bg-tealsoft" : "border-rust bg-rustsoft"}`}>
              <div className="font-semibold mb-1">
                Przesyłka nadana{done.env !== "production" && " (TEST — nieprawdziwa)"}: {done.trackingUrl ? <a href={done.trackingUrl} target="_blank" rel="noreferrer" className="underline font-mono">{done.trackingNumber}</a> : <span className="font-mono">{done.trackingNumber}</span>}
              </div>
              <div className="text-sm mb-2">Cena wg cennika: {done.price}</div>
              {done.error && <p className="text-rust text-sm font-semibold mb-2">{done.error}</p>}
              {done.marketplaceSyncError && (
                <p className="text-rust text-sm font-semibold mb-2">Problem ze zgłoszeniem do marketplace'u: {done.marketplaceSyncError} (można ponowić niżej, w liście nadanych przesyłek).</p>
              )}
              {done.ourStatusError && (
                <p className="text-rust text-sm font-semibold mb-2">Nie udało się ustawić "Nasz status" na Wysłane: {done.ourStatusError} — zmień go ręcznie w Zamówieniach.</p>
              )}
              <div className="flex gap-2">
                <button onClick={() => openLabel(done.id, done.labelBase64)} className={btnPrimary}>Otwórz etykietę (PDF)</button>
                <button onClick={reset} className={btnGhost}>Nowa przesyłka</button>
              </div>
              <p className="text-xs text-inksoft mt-2">Wydrukuj etykietę na Zebrze: w oknie druku wybierz drukarkę i rozmiar strony 100 × 150 mm, skala 100%.</p>
            </div>
          )}

          {/* formularz */}
          <div className="border border-line bg-white p-4 mb-6">
            {prefillNote && <p className="text-amber text-xs font-semibold bg-ambersoft rounded px-3 py-2 mb-3">{prefillNote}</p>}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-inksoft">NOWA PRZESYŁKA{order ? ` — zamówienie ${order.externalId}` : ""}</h2>
              <button onClick={reset} className="text-xs font-semibold text-teal hover:underline">Wyczyść formularz</button>
            </div>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xs font-semibold text-inksoft mr-1">Przewoźnik:</span>
              {(["parcel", "express"] as Carrier[]).map((c) => {
                const on = c === "parcel" ? parcel?.configured : express?.configured;
                return (
                  <button
                    key={c}
                    onClick={() => { setCarrier(c); setQuote(null); setChosen(null); }}
                    disabled={!on}
                    title={on ? undefined : "Nie skonfigurowany"}
                    className={`px-3 py-1.5 rounded-full text-sm font-semibold border disabled:opacity-40 ${carrier === c ? "bg-ink text-paper border-ink" : "bg-white border-line"}`}
                  >
                    {CARRIER_LABEL[c]}
                  </button>
                );
              })}
            </div>
            <h3 className="text-xs font-semibold text-inksoft mb-2">Odbiorca</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
              <div><label className={label}>Imię i nazwisko *</label><input value={form.name} onChange={(e) => setField("name", e.target.value)} className={inputCls} /></div>
              <div><label className={label}>Firma (opcjonalnie)</label><input value={form.company} onChange={(e) => setField("company", e.target.value)} className={inputCls} /></div>
              <div><label className={label}>Ulica *</label><input value={form.street} onChange={(e) => setField("street", e.target.value)} className={inputCls} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div><label className={label}>Nr domu *</label><input value={form.houseNumber} onChange={(e) => setField("houseNumber", e.target.value)} className={inputCls} /></div>
                <div><label className={label}>Nr lokalu</label><input value={form.apartment} onChange={(e) => setField("apartment", e.target.value)} className={inputCls} /></div>
              </div>
              <div><label className={label}>Kod pocztowy *</label><input value={form.postalCode} onChange={(e) => setField("postalCode", e.target.value)} className={inputCls} /></div>
              <div><label className={label}>Miasto *</label><input value={form.city} onChange={(e) => setField("city", e.target.value)} className={inputCls} /></div>
              <div>
                <label className={label}>Kraj (UE) *</label>
                <select value={form.countryCode} onChange={(e) => setField("countryCode", e.target.value)} className={inputCls}>
                  {DHL_EU_COUNTRIES.map((c) => <option key={c} value={c}>{COUNTRY_NAMES[c]} ({c})</option>)}
                </select>
              </div>
              <div><label className={label}>Telefon odbiorcy *</label><input value={form.phone} onChange={(e) => setField("phone", e.target.value)} className={inputCls} /></div>
              <div className="md:col-span-2"><label className={label}>E-mail odbiorcy (opcjonalnie)</label><input value={form.email} onChange={(e) => setField("email", e.target.value)} className={inputCls} /></div>
              <div><label className={label}>Numer zamówienia (referencja)</label><input value={form.reference} onChange={(e) => setField("reference", e.target.value)} className={inputCls} /></div>
            </div>

            <h3 className="text-xs font-semibold text-inksoft mb-2">Paczka</h3>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-3">
              <div>
                <label className={label}>Szablon</label>
                <select value={form.template} onChange={(e) => applyTemplate(e.target.value)} className={inputCls}>
                  <option value="">— ręcznie —</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div><label className={label}>Waga (kg) *</label><input value={form.weight} onChange={(e) => setField("weight", e.target.value)} inputMode="decimal" className={inputCls} /></div>
              <div><label className={label}>Długość (cm) *</label><input value={form.length} onChange={(e) => setField("length", e.target.value)} inputMode="decimal" className={inputCls} /></div>
              <div><label className={label}>Szerokość (cm) *</label><input value={form.width} onChange={(e) => setField("width", e.target.value)} inputMode="decimal" className={inputCls} /></div>
              <div><label className={label}>Wysokość (cm) *</label><input value={form.height} onChange={(e) => setField("height", e.target.value)} inputMode="decimal" className={inputCls} /></div>
              <div><label className={label}>Data nadania</label><input type="date" value={plannedDate} onChange={(e) => { setPlannedDate(e.target.value); setQuote(null); setChosen(null); }} className={inputCls} /></div>
              <div className="col-span-2 md:col-span-6"><label className={label}>Opis zawartości</label><input value={form.description} onChange={(e) => setField("description", e.target.value)} placeholder={settings.default_description} className={inputCls} /></div>
            </div>
            <button onClick={getQuote} disabled={quoting || !formReady || !(carrier === "parcel" ? parcel?.configured : express?.configured)} className={btnPrimary}>{quoting ? "Pytanie DHL…" : `Wyceń (${CARRIER_LABEL[carrier]})`}</button>
          </div>

          {/* wycena i wybór produktu */}
          {quote && (
            <div className="mb-6">
              <div className="border border-line bg-white overflow-x-auto mb-3">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-inksoft border-b border-line">
                      <th className="p-3"></th>
                      <th className="p-3">Kod</th>
                      <th className="p-3">Produkt</th>
                      <th className="p-3 text-right">Cena</th>
                      <th className="p-3 text-right">Cena (PLN)</th>
                      <th className="p-3 text-right">Waga taryfowa</th>
                      <th className="p-3 text-right">Dni</th>
                      <th className="p-3">Szacowana dostawa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quote.products.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-inksoft text-sm">DHL nie zwrócił produktów dla tej trasy.</td></tr>}
                    {quote.products.map((p) => (
                      <Fragment key={p.code + p.name}>
                        <tr
                          className={`border-b border-line last:border-b-0 ${p.unavailable ? "text-inksoft" : "cursor-pointer"} ${chosen === p.code ? "bg-tealsoft" : p.unavailable ? "" : "hover:bg-paper"} ${p.economy ? "font-semibold" : ""}`}
                          onClick={() => !p.unavailable && setChosen(p.code)}
                        >
                          <td className="p-3"><input type="radio" checked={chosen === p.code} disabled={!!p.unavailable} onChange={() => setChosen(p.code)} /></td>
                          <td className="p-3 font-mono">{p.code}</td>
                          <td className="p-3">
                            {p.name}
                            {p.breakdown.length > 0 && (
                              <button onClick={(e) => { e.stopPropagation(); setExpanded(expanded === p.code ? null : p.code); }} className="ml-2 text-xs font-semibold text-teal hover:underline">
                                {expanded === p.code ? "ukryj składniki" : "składniki ceny"}
                              </button>
                            )}
                          </td>
                          {p.unavailable ? (
                            <td colSpan={4} className="p-3 text-xs">niedostępny: {p.unavailable}</td>
                          ) : (
                            <>
                              <td className="p-3 text-right font-mono whitespace-nowrap">{fmtMoney(p.billing)}</td>
                              <td className="p-3 text-right font-mono whitespace-nowrap">{fmtMoney(p.local)}</td>
                              <td className="p-3 text-right font-mono whitespace-nowrap">{p.chargeableWeight !== null ? `${p.chargeableWeight} kg` : "—"}</td>
                              <td className="p-3 text-right font-mono">{p.transitDays ?? "—"}</td>
                            </>
                          )}
                          <td className="p-3 text-xs whitespace-nowrap">{fmtDateTime(p.estimatedDelivery)}</td>
                        </tr>
                        {expanded === p.code && (
                          <tr className="border-b border-line bg-paper">
                            <td colSpan={8} className="p-3 text-xs">
                              <ul className="space-y-0.5 max-w-md">
                                {p.breakdown.map((b, i) => (
                                  <li key={i} className="flex justify-between"><span>{b.name}</span><span className="font-mono">{b.price.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              {quote.warnings.length > 0 && <p className="text-xs text-inksoft mb-2">Ostrzeżenia DHL: {quote.warnings.join("; ")}</p>}
              <button onClick={create} disabled={creating || !chosen} className={btnPrimary}>{creating ? "Nadawanie…" : `Nadaj przesyłkę (${CARRIER_LABEL[quote.carrier]}) i wygeneruj etykietę`}</button>
              <p className="text-xs text-inksoft mt-2">
                Cena to wycena wg cennika konta (DHL Parcel: w PLN, sprawdź czy netto, czy brutto); ostateczną kwotę (opłaty dodatkowe, VAT) potwierdza faktura DHL.
                {quote.carrier === "parcel"
                  ? parcel?.sandbox
                    ? " Środowisko testowe: nadanie nie jest prawdziwe."
                    : " Nadanie jest prawdziwe i płatne — możesz je anulować na liście przesyłek, dopóki nie zamówisz kuriera."
                  : express?.env === "production"
                    ? " Nadanie jest prawdziwe i płatne — DHL Express nie pozwala anulować przesyłki przez API."
                    : " Środowisko testowe: nadanie nie jest prawdziwe."}
              </p>
            </div>
          )}

          {/* nadane przesyłki */}
          <h2 className="text-xs font-semibold text-inksoft mb-2">NADANE PRZESYŁKI</h2>
          <div className="border border-line bg-white overflow-x-auto mb-8">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-inksoft border-b border-line">
                  <th className="p-3">Nadano</th>
                  <th className="p-3">Przewoźnik</th>
                  <th className="p-3">Numer przesyłki</th>
                  <th className="p-3">Odbiorca</th>
                  <th className="p-3">Produkt</th>
                  <th className="p-3 text-right">Cena</th>
                  <th className="p-3">Zamówienie</th>
                  <th className="p-3">Nadał</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {shipments.length === 0 && <tr><td colSpan={9} className="p-6 text-center text-inksoft text-sm">Brak nadanych przesyłek.</td></tr>}
                {shipments.map((s) => {
                  const charge = dhlCharge(s.charges);
                  return (
                    <tr key={s.id} className={`border-b border-line last:border-b-0 hover:bg-paper align-top ${s.cancelled_at ? "text-inksoft line-through" : ""}`}>
                      <td className="p-3 text-xs text-inksoft whitespace-nowrap">
                        {fmtDateTime(s.created_at)}
                        {s.environment !== "production" && <div className="text-amber font-semibold">TEST</div>}
                      </td>
                      <td className="p-3 text-xs whitespace-nowrap">{s.carrier === "dhl_parcel" ? "DHL Parcel" : s.carrier === "erli_paczkomat" ? "Erli Paczkomat" : "DHL Express"}{s.cancelled_at && <div className="text-rust font-semibold no-underline">ANULOWANA</div>}</td>
                      <td className="p-3 font-mono whitespace-nowrap">
                        {s.tracking_url ? <a href={s.tracking_url} target="_blank" rel="noreferrer" className="text-teal hover:underline">{s.tracking_number}</a> : s.tracking_number}
                      </td>
                      <td className="p-3 text-xs">{s.receiver?.name}<div className="text-inksoft">{s.receiver?.city}, {s.receiver?.countryCode}</div></td>
                      <td className="p-3 text-xs whitespace-nowrap">{s.product_name || s.product_code}</td>
                      <td className="p-3 text-right font-mono text-xs whitespace-nowrap">{charge ? fmtMoney({ price: charge.price, currency: charge.priceCurrency }) : "—"}</td>
                      <td className="p-3 text-xs font-mono">
                        {s.order_external_id || "—"}
                        {s.order_external_id && s.marketplace_sync_error && (
                          <div className="mt-1">
                            <span className="text-rust font-sans font-semibold no-underline" title={s.marketplace_sync_error}>problem ze zgłoszeniem do marketplace'u</span>
                            {!s.cancelled_at && (
                              <button onClick={() => retryMarketplaceSync(s)} className="ml-2 text-teal font-sans font-semibold no-underline hover:underline">Ponów</button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-xs">{s.created_by_email || "—"}</td>
                      <td className="p-3 whitespace-nowrap text-right">
                        {!s.cancelled_at && <button onClick={() => openLabel(s.id)} className="text-xs font-semibold text-teal hover:underline">{s.has_label === false ? "Pobierz etykietę" : "Etykieta"}</button>}
                        {!s.cancelled_at && (s.carrier === "dhl_parcel" || s.carrier === "erli_paczkomat") && (
                          <button onClick={() => cancelShipment(s)} className="ml-3 text-xs font-semibold text-rust hover:underline">Anuluj</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <TemplatesPanel templates={templates} isAdmin={isAdmin} session={session} settings={settings} onChanged={loadTemplates} onError={setError} />
          {isAdmin && <SenderPanel settings={settings} onSaved={loadSettings} onError={setError} />}
        </>
      )}
    </div>
  );
}

/* ---------------- szablony paczek ---------------- */

function TemplatesPanel({
  templates,
  isAdmin,
  session,
  settings,
  onChanged,
  onError,
}: {
  templates: Template[];
  isAdmin: boolean;
  session: Session;
  settings: Settings;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [f, setF] = useState({ name: "", weight: "", length: "", width: "", height: "", description: "" });
  const [saving, setSaving] = useState(false);

  async function add() {
    onError("");
    const nums = [f.weight, f.length, f.width, f.height].map((v) => Number(v.replace(",", ".")));
    if (!f.name.trim() || nums.some((n) => !(n > 0))) return onError("Szablon: podaj nazwę oraz wagę i wymiary (liczby większe od zera).");
    setSaving(true);
    const { error } = await supabase.from("shipping_templates").insert({
      name: f.name.trim(),
      weight_kg: nums[0],
      length_cm: nums[1],
      width_cm: nums[2],
      height_cm: nums[3],
      description: f.description.trim() || null,
      created_by_email: session.user.email,
    });
    setSaving(false);
    if (error) return onError(error.code === "23505" ? `Szablon „${f.name.trim()}” już istnieje.` : `Nie udało się zapisać szablonu: ${error.message}`);
    setF({ name: "", weight: "", length: "", width: "", height: "", description: "" });
    await onChanged();
  }

  async function remove(t: Template) {
    if (!confirm(`Usunąć szablon „${t.name}”?`)) return;
    const { data, error } = await supabase.from("shipping_templates").delete().eq("id", t.id).select("id");
    if (error) onError(`Nie udało się usunąć: ${error.message}`);
    else if (!data?.length) onError("Nie usunięto — szablony może usuwać tylko Admin.");
    else await onChanged();
  }

  return (
    <div className="mb-8">
      <h2 className="text-xs font-semibold text-inksoft mb-2">SZABLONY PACZEK</h2>
      <div className="border border-line bg-white overflow-x-auto mb-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Nazwa</th><th className="p-3 text-right">Waga</th><th className="p-3">Wymiary (cm)</th><th className="p-3">Opis zawartości</th><th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {templates.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-inksoft text-sm">Brak szablonów — dodaj pierwszy poniżej.</td></tr>}
            {templates.map((t) => (
              <tr key={t.id} className="border-b border-line last:border-b-0">
                <td className="p-3 font-semibold">{t.name}</td>
                <td className="p-3 text-right font-mono">{t.weight_kg} kg</td>
                <td className="p-3 font-mono">{t.length_cm} × {t.width_cm} × {t.height_cm}</td>
                <td className="p-3 text-xs text-inksoft">{t.description || `(domyślny: ${settings.default_description})`}</td>
                <td className="p-3 text-right">{isAdmin && <button onClick={() => remove(t)} className="text-xs font-semibold text-rust hover:underline">Usuń</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-7 gap-2 items-end">
        <div><label className={label}>Nazwa</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="np. xbox" className={inputCls} /></div>
        <div><label className={label}>Waga (kg)</label><input value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} inputMode="decimal" className={inputCls} /></div>
        <div><label className={label}>Dł. (cm)</label><input value={f.length} onChange={(e) => setF({ ...f, length: e.target.value })} inputMode="decimal" className={inputCls} /></div>
        <div><label className={label}>Szer. (cm)</label><input value={f.width} onChange={(e) => setF({ ...f, width: e.target.value })} inputMode="decimal" className={inputCls} /></div>
        <div><label className={label}>Wys. (cm)</label><input value={f.height} onChange={(e) => setF({ ...f, height: e.target.value })} inputMode="decimal" className={inputCls} /></div>
        <div><label className={label}>Opis zawartości</label><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Used game console" className={inputCls} /></div>
        <button onClick={add} disabled={saving} className={btnPrimary}>{saving ? "Zapisywanie…" : "Dodaj szablon"}</button>
      </div>
    </div>
  );
}

/* ---------------- dane nadawcy (Admin) ---------------- */

function SenderPanel({ settings, onSaved, onError }: { settings: Settings; onSaved: () => Promise<void>; onError: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(settings);
  const [saving, setSaving] = useState(false);

  async function save() {
    onError("");
    if (!f.shipper_company.trim() || !f.shipper_name.trim() || !f.street.trim() || !f.postal_code.trim() || !f.city.trim() || !f.phone.trim()) {
      return onError("Dane nadawcy: uzupełnij firmę, imię i nazwisko, adres i telefon.");
    }
    setSaving(true);
    const { error, data } = await supabase
      .from("shipping_settings")
      .update({
        shipper_company: f.shipper_company.trim(),
        shipper_name: f.shipper_name.trim(),
        street: f.street.trim(),
        postal_code: f.postal_code.trim(),
        city: f.city.trim(),
        phone: f.phone.trim(),
        email: f.email?.trim() || null,
        default_description: f.default_description.trim() || "Used electronics",
      })
      .eq("id", 1)
      .select("id");
    setSaving(false);
    if (error) return onError(`Nie udało się zapisać: ${error.message}`);
    if (!data?.length) return onError("Nie zapisano — dane nadawcy może zmieniać tylko Admin.");
    setOpen(false);
    await onSaved();
  }

  return (
    <div className="mb-8">
      <button onClick={() => { setF(settings); setOpen((o) => !o); }} className="text-xs font-semibold text-teal hover:underline">{open ? "Zamknij dane nadawcy" : "Zmień dane nadawcy (Admin)"}</button>
      {open && (
        <div className="border border-line bg-white p-4 mt-2">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
            <div><label className={label}>Firma</label><input value={f.shipper_company} onChange={(e) => setF({ ...f, shipper_company: e.target.value })} className={inputCls} /></div>
            <div><label className={label}>Osoba kontaktowa</label><input value={f.shipper_name} onChange={(e) => setF({ ...f, shipper_name: e.target.value })} className={inputCls} /></div>
            <div className="md:col-span-2"><label className={label}>Ulica i numer</label><input value={f.street} onChange={(e) => setF({ ...f, street: e.target.value })} className={inputCls} /></div>
            <div><label className={label}>Kod pocztowy</label><input value={f.postal_code} onChange={(e) => setF({ ...f, postal_code: e.target.value })} className={inputCls} /></div>
            <div><label className={label}>Miasto</label><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} className={inputCls} /></div>
            <div><label className={label}>Telefon</label><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className={inputCls} /></div>
            <div><label className={label}>E-mail</label><input value={f.email ?? ""} onChange={(e) => setF({ ...f, email: e.target.value })} className={inputCls} /></div>
            <div className="md:col-span-4"><label className={label}>Domyślny opis zawartości</label><input value={f.default_description} onChange={(e) => setF({ ...f, default_description: e.target.value })} className={inputCls} /></div>
          </div>
          <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? "Zapisywanie…" : "Zapisz dane nadawcy"}</button>
        </div>
      )}
    </div>
  );
}
