"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { COUNTRY_NAMES, DHL_EU_COUNTRIES, isEconomySelect, type DhlMoney, type DhlProduct } from "@/lib/dhlExpress";
import { base64ToBlobUrl, defaultShippingDate, dhlCharge, parcelQuoteTotal, stripPhoneSpaces, type ShipPrefill } from "@/lib/shipping";
import { MARKETPLACES } from "@/lib/salesOrders";
import { escapeLike } from "@/lib/search";
import { printRawToZebra, printPdf, listPrinters, printerNeedsImageLabel, PrintAgentError } from "@/lib/printAgent";
import { testLabelZpl, testDeliveryNotePdfBase64 } from "@/lib/printTest";
import type { MemberLite } from "@/lib/displayName";
import SalesOrderCard from "./SalesOrderCard";

// Zakładka Wysyłka: nadawanie przesyłek DHL Express (MyDHL API) — formularz z wyceną, szablony paczek, ustawienia nadawcy i lista nadanych
// przesyłek z etykietami (PDF 10x15 na Zebrę). Dostęp: Admin i Manager. Klucze i numer konta są tylko na serwerze
// (route'y /api/shipping/dhl-express/*). Na środowisku produkcyjnym nadanie to PRAWDZIWA przesyłka (koszt), a DHL Express nie pozwala
// jej anulować przez API.

const fmtMoney = (m: DhlMoney | null | undefined) =>
  m ? `${m.price.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${m.currency}` : "—";
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
  zebra_printer_name: string | null;
  a4_printer_name: string | null;
};
type Template = { id: number; name: string; weight_kg: number; length_cm: number; width_cm: number; height_cm: number; description: string | null };
type Carrier = "parcel" | "express" | "ups";
const CARRIER_LABEL: Record<Carrier, string> = { parcel: "DHL Parcel", express: "DHL Express", ups: "UPS" };
const CARRIER_API: Record<Carrier, string> = { parcel: "dhl-parcel", express: "dhl-express", ups: "ups" };

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
  label_format?: string | null;
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
  package: unknown; // UPS: { pieces, cod } — znacznik pobrania na liście; inni przewoźnicy: tablica paczek
  charges: unknown; // tablica {currencyType,priceCurrency,price} dla DHL; dla Erli inny kształt (id paczki) — patrz dhlCharge()
  marketplace_synced_at: string | null;
  marketplace_sync_error: string | null;
};

const EMPTY_FORM = { name: "", company: "", street: "", houseNumber: "", apartment: "", postalCode: "", city: "", countryCode: "DE", phone: "", email: "", template: "", weight: "", length: "", width: "", height: "", description: "", reference: "" };
const SHIP_PAGE_SIZE = 20;

export default function ShippingView({
  session,
  isAdmin,
  members,
  prefill,
  onPrefillUsed,
}: {
  session: Session;
  isAdmin: boolean;
  members: MemberLite[];
  prefill: ShipPrefill | null;
  onPrefillUsed: () => void;
}) {
  const [openOrder, setOpenOrder] = useState<{ marketplace: string; externalId: string } | null>(null);
  const auth = { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
  const [express, setExpress] = useState<{ configured: boolean; env: string | null } | null>(null);
  const [parcel, setParcel] = useState<{ configured: boolean; sandbox: boolean; version: string | null } | null>(null);
  const [ups, setUps] = useState<{ configured: boolean; env: string | null } | null>(null);
  const [carrier, setCarrier] = useState<Carrier>("parcel");
  const [settings, setSettings] = useState<Settings | null>(null);
  // Drukarki TEJ osoby (members.zebra_printer_name / a4_printer_name, ustawia Admin w Zespół -> Edytuj); puste = domyślne z ustawień nadawcy.
  const [myPrinters, setMyPrinters] = useState<{ zebra: string | null; a4: string | null }>({ zebra: null, a4: null });
  const [templates, setTemplates] = useState<Template[]>([]);
  const [shipments, setShipments] = useState<ShipmentRow[]>([]);
  const [shipSearchInput, setShipSearchInput] = useState("");
  const [shipSearch, setShipSearch] = useState("");
  const [shipPage, setShipPage] = useState(1);
  const [shipTotal, setShipTotal] = useState(0);
  const [error, setError] = useState("");
  const [prefillNote, setPrefillNote] = useState(""); // ostrzeżenie: marketplace nie przekazał (jeszcze) pełnych danych odbiorcy

  const [form, setForm] = useState(EMPTY_FORM);
  // Druga, trzecia... paczka tej samej przesyłki (tylko DHL Parcel — DHL24 wspiera wiele pozycji w JEDNEJ
  // przesyłce, patrz lib/dhlParcel.ts). Pierwsza paczka zostaje w `form` jak dotąd.
  const [extraPackages, setExtraPackages] = useState<{ weight: string; length: string; width: string; height: string }[]>([]);
  const [order, setOrder] = useState<{ marketplace: string; externalId: string } | null>(null);
  // Pobranie (COD) — tylko UPS i tylko przesyłki krajowe (PL → PL); kwota w PLN wpisywana ręcznie albo z zamówienia (Erli/Allegro).
  const [codOn, setCodOn] = useState(false);
  const [codAmount, setCodAmount] = useState("");
  const [plannedDate, setPlannedDate] = useState(defaultShippingDate());
  const [quoting, setQuoting] = useState(false);
  const [quote, setQuote] = useState<{ carrier: Carrier; products: QuoteRow[]; warnings: string[] } | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState<{ trackingNumber: string; trackingUrl: string | null; price: string; env: string; saved: boolean; labelBase64?: string | null; labelFormat?: string | null; id?: number; error?: string; carrier: Carrier; marketplaceSyncError?: string | null; deliveryNoteUrl?: string | null } | null>(null);
  const [directPrint, setDirectPrint] = useState(false);
  const [showTestPrint, setShowTestPrint] = useState(false); // panel "Test druku" jest domyślnie ukryty; pokazuje go pigułka obok trybów druku
  const [testPrintMsg, setTestPrintMsg] = useState("");
  const [printBusy, setPrintBusy] = useState(false);
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
    fetch("/api/shipping/ups/check", { headers: auth })
      .then((r) => r.json())
      .then((d) => setUps({ configured: !!d.configured, env: d.env ?? null }))
      .catch(() => setUps({ configured: false, env: null }));
    loadSettings();
    loadMyPrinters();
    loadTemplates();
    // Przełącznik drukowania bezpośredniego: wybór per przeglądarkę/stanowisko, nie współdzielone ustawienie.
    setDirectPrint(localStorage.getItem("shipping-direct-print") === "1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem("shipping-direct-print", directPrint ? "1" : "0");
  }, [directPrint]);

  // Wyszukiwanie po numerze przesyłki: debounce, resetuje stronę na 1 (wzorzec jak w InventoryRawView).
  useEffect(() => {
    const t = setTimeout(() => {
      setShipSearch(shipSearchInput.trim());
      setShipPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [shipSearchInput]);

  useEffect(() => {
    loadShipments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipPage, shipSearch]);

  // Wejście z karty zamówienia: adres odbiorcy i numer zamówienia wypełniają formularz.
  useEffect(() => {
    if (!prefill) return;
    setForm({ ...EMPTY_FORM, name: prefill.name, company: prefill.company, street: prefill.street, houseNumber: prefill.houseNumber, apartment: prefill.apartment, postalCode: prefill.postalCode, city: prefill.city, countryCode: prefill.countryCode, phone: stripPhoneSpaces(prefill.phone), email: prefill.email, reference: prefill.externalId });
    setExtraPackages([]);
    // Zamówienie za pobraniem (Erli/Allegro): proponujemy UPS z włączonym pobraniem na kwotę z zamówienia (można zmienić przewoźnika i wyłączyć).
    setCodOn(!!prefill.cod);
    setCodAmount(prefill.cod ? String(prefill.cod.amount).replace(".", ",") : "");
    if (prefill.cod && ups?.configured) setCarrier("ups");
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

  const printerZebra = myPrinters.zebra || settings?.zebra_printer_name || null;
  const printerA4 = myPrinters.a4 || settings?.a4_printer_name || null;

  async function loadMyPrinters() {
    const { data, error: err } = await supabase.from("members").select("zebra_printer_name, a4_printer_name").eq("user_id", session.user.id).maybeSingle();
    if (!err && data) setMyPrinters({ zebra: (data.zebra_printer_name as string | null) ?? null, a4: (data.a4_printer_name as string | null) ?? null });
  }

  async function loadSettings() {
    const { data } = await supabase.from("shipping_settings").select("*").eq("id", 1).maybeSingle();
    setSettings((data as Settings) ?? null);
  }
  async function loadTemplates() {
    const { data } = await supabase.from("shipping_templates").select("*").order("name");
    setTemplates((data as Template[]) || []);
  }
  async function loadShipments() {
    const from = (shipPage - 1) * SHIP_PAGE_SIZE;
    let q = supabase
      .from("shipments")
      .select(
        "id, created_at, carrier, cancelled_at, label_format, created_by_email, environment, marketplace, order_external_id, product_code, product_name, tracking_number, tracking_url, receiver, package, charges, marketplace_synced_at, marketplace_sync_error",
        { count: "exact" }
      );
    if (shipSearch) q = q.ilike("tracking_number", `%${escapeLike(shipSearch)}%`);
    const { data, error: err, count } = await q.order("created_at", { ascending: false }).range(from, from + SHIP_PAGE_SIZE - 1);
    if (err) {
      // strona poza zakresem (np. po anulowaniu ubyło wierszy) — wróć na początek
      if (err.code === "PGRST103" && shipPage > 1) return setShipPage(1);
      return setError(`Nie udało się wczytać przesyłek: ${err.message}`);
    }
    setShipments(((data as (ShipmentRow & { label_format: string | null })[]) || []).map((r) => ({ ...r, has_label: !!r.label_format })));
    setShipTotal(count ?? 0);
  }

  function setField(k: keyof typeof EMPTY_FORM, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
    setQuote(null); // zmiana danych unieważnia wycenę
    setChosen(null);
  }

  function addExtraPackage() {
    setExtraPackages((p) => [...p, { weight: "", length: "", width: "", height: "" }]);
    setQuote(null);
    setChosen(null);
  }
  function removeExtraPackage(i: number) {
    setExtraPackages((p) => p.filter((_, idx) => idx !== i));
    setQuote(null);
    setChosen(null);
  }
  function setExtraField(i: number, k: "weight" | "length" | "width" | "height", v: string) {
    setExtraPackages((p) => p.map((row, idx) => (idx === i ? { ...row, [k]: v } : row)));
    setQuote(null);
    setChosen(null);
  }
  const extraPackagesPayload = () =>
    extraPackages.map((p) => ({
      weight: Number(p.weight.replace(",", ".")),
      length: Number(p.length.replace(",", ".")),
      width: Number(p.width.replace(",", ".")),
      height: Number(p.height.replace(",", ".")),
    }));

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

  // Pobranie idzie do żądania tylko dla UPS i kraju odbiorcy PL (serwer i tak to sprawdza).
  const codActive = carrier === "ups" && form.countryCode === "PL" && codOn;
  const codPayload = () => (codActive ? { amount: Number(codAmount.replace(",", ".")) } : undefined);
  const codValid = !codActive || (Number(codAmount.replace(",", ".")) >= 10 && Number(codAmount.replace(",", ".")) <= 50000);

  async function getQuote() {
    setError("");
    setQuote(null);
    setChosen(null);
    setDone(null);
    setQuoting(true);
    try {
      const p = packagePayload();
      const res = await fetch(`/api/shipping/${CARRIER_API[carrier]}/check`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          receiver: receiverPayload(),
          package: p,
          extraPackages: carrier === "parcel" || carrier === "ups" ? extraPackagesPayload() : undefined,
          cod: codPayload(),
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
        // DHL24 getPrice zwraca "price" jako cenę BAZOWĄ (bez dopłaty) i "fuelSurcharge" jako PROCENT (nie kwotę w PLN!
        // np. 25.5 = 25,5%) — potwierdzone na żywo (panel DHL24 dla tej samej trasy pokazuje dokładnie "25.5%"). Wcześniej
        // traktowaliśmy tę liczbę jak złotówki i nie doliczaliśmy jej wcale do pokazywanej ceny — całość wychodziła
        // zaniżona o ~20-25%. Teraz cena na liście to już suma z dopłatą (jak "Cena netto" w panelu DHL24), a rozwinięcie
        // "składniki ceny" pokazuje bazę i dopłatę osobno, z procentem w nazwie.
        rows = (data.quotes as { product: string; name: string; ok: boolean; price: number | null; fuelSurcharge: number | null; error?: string }[]).map((q) => {
          const base = q.price;
          const pct = q.fuelSurcharge;
          const surchargeAmount = base !== null && pct ? Math.round(base * pct) / 100 : 0;
          const total = base !== null ? parcelQuoteTotal(base, pct) : null;
          return {
            code: q.product,
            name: `${q.name} (${q.product})`,
            billing: total !== null ? { price: total, currency: "PLN" } : null,
            local: total !== null ? { price: total, currency: "PLN" } : null,
            chargeableWeight: null,
            transitDays: null,
            estimatedDelivery: null,
            breakdown:
              base !== null
                ? [
                    { name: "Cena bazowa", price: base },
                    ...(pct ? [{ name: `Dopłata paliwowa (${pct.toLocaleString("pl-PL")}%)`, price: surchargeAmount }] : []),
                  ]
                : [],
            unavailable: q.ok ? undefined : q.error || "niedostępny na tej trasie",
          };
        });
      } else if (carrier === "ups") {
        // UPS (Rating API, Shop): cena z wyceny jest już kwotą do zapłaty w walucie konta (PLN, netto) — wynegocjowaną, gdy konto ją ma.
        const quotes = data.quotes as { code: string; name: string; price: number; currency: string; negotiated: boolean; chargeableWeight: number | null; breakdown: { name: string; price: number }[]; warnings: string[] }[];
        rows = quotes.map((q) => ({
          code: q.code,
          name: `${q.name} (${q.code})`,
          billing: { price: q.price, currency: q.currency },
          local: { price: q.price, currency: q.currency },
          chargeableWeight: q.chargeableWeight,
          transitDays: null,
          estimatedDelivery: null,
          breakdown: q.breakdown,
        }));
        warnings = [...new Set(quotes.flatMap((q) => q.warnings))];
        if (quotes.length > 0 && quotes.some((q) => !q.negotiated)) warnings.push("część usług pokazana wg cennika katalogowego (brak stawki wynegocjowanej)");
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
    const multiPiece = quote.carrier === "parcel" || quote.carrier === "ups"; // wiele paczek w jednej przesyłce

    setError("");
    setCreating(true);
    try {
      const res = await fetch(`/api/shipping/${CARRIER_API[quote.carrier]}/create`, {
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
          extraPackages: multiPiece ? extraPackagesPayload() : undefined,
          cod: codPayload(),
          reference: form.reference,
          order,
          billing: product.billing,
          local: product.local,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Nie udało się nadać przesyłki.");
      // Packing slip Back Marketu (delivery_note): pojawia się w ich API DOKŁADNIE w momencie akceptacji zamówienia
      // (stan "Do wysyłki" i dalej — potwierdzone na żywych danych: zero opóźnienia po stronie Back Marketu), więc
      // najpierw sprawdzamy to, co już mamy zsynchronizowane (bez zbędnego wywołania). Ale jeśli akceptacja i
      // nadanie nastąpiły w krótszym odstępie niż nasz cron (15 min), nasza kopia może być jeszcze sprzed akceptacji
      // — wtedy dociągamy zamówienie na żądanie (bm-refresh), zamiast pokazywać brak packing slipu bez potrzeby.
      let deliveryNoteUrl: string | null = null;
      if (order?.marketplace === "backmarket") {
        const { data: bm } = await supabase.from("bm_orders").select("delivery_note").eq("order_id", order.externalId).maybeSingle();
        deliveryNoteUrl = (bm?.delivery_note as string | null) ?? null;
        if (!deliveryNoteUrl) {
          try {
            const noteRes = await fetch("/api/orders/bm-refresh", { method: "POST", headers: auth, body: JSON.stringify({ orderId: order.externalId }) });
            const noteData = await noteRes.json().catch(() => ({}));
            if (noteRes.ok) deliveryNoteUrl = noteData.deliveryNote ?? null;
          } catch {
            /* brak packing slipu nie blokuje nadania — przycisk po prostu się nie pokaże */
          }
        }
      }
      setDone({
        trackingNumber: data.trackingNumber,
        trackingUrl: data.trackingUrl ?? null,
        price: fmtMoney(product.billing),
        env: data.environment ?? "test",
        saved: data.saved !== false,
        labelBase64: data.labelBase64 ?? null,
        labelFormat: data.labelFormat ?? null,
        id: data.id,
        error: data.saved === false ? data.error : data.labelError ? `Przesyłka nadana, ale nie udało się pobrać etykiety: ${data.labelError}. Kliknij „Otwórz etykietę”, aby spróbować ponownie.` : undefined,
        carrier: quote.carrier,
        marketplaceSyncError: data.marketplaceSyncError ?? null,
        deliveryNoteUrl,
      });
      // Drukowanie bezpośrednie: od razu po nadaniu, bez czekania na osobne kliknięcie "Drukuj etykietę"/"Drukuj
      // packing slip" — na wyraźną prośbę właściciela. Przyciski w panelu "Przesyłka nadana" zostają jako ręczny
      // fallback (np. gdy auto-druk się nie uda — obie funkcje same zgłaszają błąd przez setError, nie rzucają dalej).
      if (directPrint && data.saved !== false) {
        handleLabel(data.id, data.labelBase64 ?? null, data.labelFormat ?? null);
        if (deliveryNoteUrl) handlePackingSlip(deliveryNoteUrl);
      }
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
    const carrierName = s.carrier === "erli_paczkomat" ? "Erli" : s.carrier === "ups" ? "UPS" : "DHL";
    if (!confirm(`Anulować przesyłkę ${s.tracking_number}?\n\n${carrierName} pozwala na to tylko wtedy, gdy nie zamówiono po nią kuriera / nie trafiła do sieci.`)) return;
    setError("");
    const endpoint = s.carrier === "erli_paczkomat" ? "/api/shipping/erli/cancel" : s.carrier === "ups" ? "/api/shipping/ups/cancel" : "/api/shipping/dhl-parcel/cancel";
    const res = await fetch(endpoint, { method: "POST", headers: auth, body: JSON.stringify({ id: s.id, confirm: true }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data?.error || "Nie udało się anulować przesyłki.");
    await loadShipments();
  }

  // Dopisuje brakującą cenę przesyłce DHL Parcel (np. nadanej ze starej, nieodświeżonej karty przeglądarki, która nie
  // przekazała ceny z wyceny) — serwer pyta DHL o wycenę dla zapisanej trasy/paczki.
  async function backfillPrice(s: ShipmentRow) {
    setError("");
    const res = await fetch("/api/shipping/dhl-parcel/backfill-price", { method: "POST", headers: auth, body: JSON.stringify({ id: s.id }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data?.error || "Nie udało się pobrać ceny.");
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

  // Obsługa etykiety — albo otwiera PDF do ręcznego wydruku (dziś: DHL Express etykietę trzyma jako ZPL, więc
  // podgląd renderujemy z niego przez Labelary), albo (przełącznik "Drukowanie bezpośrednie") wysyła prosto na
  // etykieciarkę Zebra przez QZ Tray: surowy ZPL, gdy jest dostępny (DHL Express od razu; DHL Parcel dociąga go
  // na żądanie, ZBLP, bez zmiany trybu tworzenia przesyłki — patrz dhl-parcel/label z format="zpl"), a dla
  // formatów bez ZPL (Erli) — PDF wprost na tę samą drukarkę przez jej sterownik Windows.
  // Etykieta ZPL na drukarkę: na Zebrę wprost, na drukarki innych marek (np. HPRT w emulacji ZPL) jako obraz — patrz printerNeedsImageLabel.
  async function printZplLabel(zpl: string, printer: string) {
    if (printerNeedsImageLabel(printer)) {
      const res = await fetch("/api/shipping/zpl-to-image", { method: "POST", headers: auth, body: JSON.stringify({ zpl }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.zpl) throw new Error(j?.error || "Nie udało się przygotować etykiety do druku na tej drukarce.");
      return printRawToZebra(j.zpl, printer);
    }
    return printRawToZebra(zpl, printer);
  }

  async function handleLabel(id: number | undefined, base64?: string | null, format?: string | null) {
    setError("");
    setPrintBusy(true);
    try {
      let data = base64 ?? null;
      let fmt = format ?? null;
      let carrierType: string | undefined;
      if (!data && id !== undefined) {
        const { data: row, error: err } = await supabase.from("shipments").select("label_data, label_format, carrier").eq("id", id).maybeSingle();
        if (err) throw new Error(`Nie udało się wczytać etykiety: ${err.message}`);
        data = (row?.label_data as string | null) ?? null;
        fmt = (row?.label_format as string | null) ?? null;
        carrierType = row?.carrier as string | undefined;
        // DHL Parcel: gdy etykiety nie udało się pobrać przy nadaniu, pobieramy ją teraz od DHL i zapisujemy.
        if (!data && row?.carrier === "dhl_parcel") {
          const res = await fetch("/api/shipping/dhl-parcel/label", { method: "POST", headers: auth, body: JSON.stringify({ id }) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j?.error || "Nie udało się pobrać etykiety.");
          data = j.labelBase64 ?? null;
          fmt = "pdf";
          await loadShipments();
        }
        // Erli: etykieta praktycznie nigdy nie jest gotowa od razu przy nadaniu — dopytujemy, a jeśli jeszcze jej
        // nie ma, mówimy to wprost zamiast ogólnego "brak etykiety".
        if (!data && row?.carrier === "erli_paczkomat") {
          const res = await fetch("/api/shipping/erli/label", { method: "POST", headers: auth, body: JSON.stringify({ id }) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j?.error || "Nie udało się pobrać etykiety.");
          if (!j.ready) throw new Error("Erli jeszcze nie przygotowało etykiety — spróbuj ponownie za chwilę.");
          data = j.labelBase64 ?? null;
          fmt = "pdf";
          await loadShipments();
        }
      }
      if (!data) throw new Error("Brak etykiety dla tej przesyłki.");

      if (directPrint) {
        if (!printerZebra) throw new Error("Brak drukarki Zebra — Admin ustawia ją w Zespół → Edytuj (dla tej osoby) albo w danych nadawcy (domyślna).");
        if (fmt === "zpl") {
          await printZplLabel(atob(data), printerZebra);
        } else if (id !== undefined && carrierType === "dhl_parcel") {
          const res = await fetch("/api/shipping/dhl-parcel/label", { method: "POST", headers: auth, body: JSON.stringify({ id, format: "zpl" }) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j?.error || "Nie udało się pobrać etykiety ZPL.");
          await printZplLabel(atob(j.zplBase64), printerZebra);
        } else {
          await printPdf(data, printerZebra);
        }
      } else {
        let pdfBase64 = data;
        if (fmt === "zpl") {
          const res = await fetch("/api/shipping/render-zpl", { method: "POST", headers: auth, body: JSON.stringify({ zpl: atob(data) }) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j?.error || "Nie udało się wyrenderować podglądu etykiety.");
          pdfBase64 = j.pdfBase64;
        }
        window.open(base64ToBlobUrl(pdfBase64), "_blank"); // 10x15 — drukuj (Ctrl+P) na Zebrze, rozmiar strony 100×150 mm
      }
    } catch (e: any) {
      setError(e instanceof PrintAgentError ? e.message : e.message || "Nie udało się obsłużyć etykiety.");
    } finally {
      setPrintBusy(false);
    }
  }

  // TYMCZASOWY test druku bezpośredniego (02.10.2026): próbna etykieta ZPL na Zebrę i próbny PDF na A4 przez QZ Tray —
  // niczego nie nadaje w DHL, nic nie zapisuje w bazie i nic nie zgłasza do marketplace'u.
  async function testPrint(kind: "label" | "a4") {
    setError("");
    setTestPrintMsg("");
    const printer = kind === "label" ? printerZebra : printerA4;
    if (!printer) return setError(`Ustaw nazwę drukarki ${kind === "label" ? "Zebra" : "A4"} w danych nadawcy (Admin), żeby wykonać test.`);
    setPrintBusy(true);
    try {
      if (kind === "label") await printRawToZebra(testLabelZpl(), printer);
      else await printPdf(testDeliveryNotePdfBase64(), printer);
      setTestPrintMsg(`Wysłano na drukarkę „${printer}” — sprawdź, czy wydruk wyszedł.`);
    } catch (e: any) {
      setError(e instanceof PrintAgentError ? e.message : e.message || "Nie udało się wykonać wydruku testowego.");
    } finally {
      setPrintBusy(false);
    }
  }

  // Packing slip Back Marketu: albo otwiera link w nowej karcie (dziś), albo (przełącznik) dociąga PDF przez
  // nasz serwerowy proxy (unika CORS na S3) i drukuje wprost na drukarkę A4 przez QZ Tray.
  async function handlePackingSlip(url: string) {
    if (!directPrint) return void window.open(url, "_blank");
    setError("");
    if (!printerA4) return setError("Brak drukarki A4 — Admin ustawia ją w Zespół → Edytuj (dla tej osoby) albo w danych nadawcy (domyślna).");
    setPrintBusy(true);
    try {
      const res = await fetch("/api/shipping/fetch-remote-pdf", { method: "POST", headers: auth, body: JSON.stringify({ url }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Nie udało się pobrać packing slipu.");
      await printPdf(j.base64, printerA4);
    } catch (e: any) {
      setError(e instanceof PrintAgentError ? e.message : e.message || "Nie udało się wydrukować packing slipu.");
    } finally {
      setPrintBusy(false);
    }
  }

  function reset() {
    setCodOn(false);
    setCodAmount("");
    setForm(EMPTY_FORM);
    setExtraPackages([]);
    setOrder(null);
    setQuote(null);
    setChosen(null);
    setDone(null);
    setPrefillNote("");
    setPlannedDate(defaultShippingDate());
    requestId.current = crypto.randomUUID();
  }

  const formReady =
    form.name.trim() && form.street.trim() && form.houseNumber.trim() && form.postalCode.trim() && form.city.trim() && form.phone.trim() && Number(form.weight.replace(",", ".")) > 0 && form.length && form.width && form.height &&
    extraPackages.every((p) => Number(p.weight.replace(",", ".")) > 0 && p.length && p.width && p.height);
  const shipTotalPages = Math.max(1, Math.ceil(shipTotal / SHIP_PAGE_SIZE));

  return (
    <div>
      {/* połączenie — ukryte, dopóki wszystko działa; pokazuje się tylko, gdy jest coś do zgłoszenia */}
      {((parcel && !parcel.configured) ||
        (parcel?.configured && !parcel.version) ||
        (express && !express.configured) ||
        (ups && !ups.configured) ||
        ((parcel?.configured || express?.configured || ups?.configured) && !settings)) && (
        <div className="border border-line bg-white p-4 mb-6">
          <h2 className="text-xs font-semibold text-inksoft mb-2">PRZEWOŹNICY</h2>
          {parcel && !parcel.configured && (
            <p className="text-xs text-rust mb-1">
              <span className="font-semibold">DHL Parcel:</span> nie skonfigurowany — ustaw w Vercel DHL_PARCEL_USERNAME, DHL_PARCEL_PASSWORD i DHL_PARCEL_SAP, potem Redeploy.
            </p>
          )}
          {parcel?.configured && !parcel.version && (
            <p className="text-xs text-rust mb-1">
              <span className="font-semibold">DHL Parcel:</span> skonfigurowany, ale usługa DHL chwilowo nie odpowiedziała.
            </p>
          )}
          {express && !express.configured && (
            <p className="text-xs text-rust">
              <span className="font-semibold">DHL Express:</span> nie skonfigurowany — ustaw DHL_EXPRESS_API_KEY, DHL_EXPRESS_API_SECRET, DHL_EXPRESS_ACCOUNT i DHL_EXPRESS_ENV.
            </p>
          )}
          {ups && !ups.configured && (
            <p className="text-xs text-rust mt-1">
              <span className="font-semibold">UPS:</span> nie skonfigurowany — ustaw w Vercel UPS_CLIENT_ID, UPS_CLIENT_SECRET, UPS_ACCOUNT_NUMBER i (dla prawdziwych przesyłek) UPS_ENV=production, potem Redeploy.
            </p>
          )}
          {(parcel?.configured || express?.configured || ups?.configured) && !settings && <p className="text-xs text-rust">Brak danych nadawcy — uruchom supabase/shipping.sql.</p>}
        </div>
      )}

      {error && <p className="text-rust text-xs mb-4">{error}</p>}

      {(parcel?.configured || express?.configured || ups?.configured) && settings && (
        <>
          {/* Wybór trybu: drukowanie bezpośrednie (QZ Tray, bez okna drukowania) vs generowanie PDF (dzisiejszy
              ręczny wydruk) — "na wszelki wypadek", gdyby drukowanie bezpośrednie nie zadziałało. Wybór per
              przeglądarkę/stanowisko (localStorage), nie współdzielone ustawienie w bazie. Dwie pigułki zamiast
              suwaka (wcześniejsza wersja) — suwak bez stałego opisu obok mylił: nie było widać, który stan jest
              który, tylko tekst się zmieniał (zgłoszone przez właściciela po pierwszym teście). */}
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs font-semibold text-inksoft mr-1">Drukowanie:</span>
            <button
              onClick={() => setDirectPrint(false)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${!directPrint ? "bg-ink text-paper border-ink" : "bg-white border-line text-inksoft"}`}
            >
              Generuj PDF
            </button>
            <button
              onClick={() => setDirectPrint(true)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${directPrint ? "bg-ink text-paper border-ink" : "bg-white border-line text-inksoft"}`}
            >
              Drukowanie bezpośrednie
            </button>
            <button
              onClick={() => setShowTestPrint((v) => !v)}
              title="Pokaż/ukryj próbny wydruk na drukarki (bez nadawania przesyłki)"
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border border-dashed ${showTestPrint ? "bg-ink text-paper border-ink" : "bg-white border-line text-inksoft"}`}
            >
              Test druku
            </button>
            {printBusy && <span className="text-xs text-inksoft">drukowanie…</span>}
          </div>
          {/* Test druku (ukryty za pigułką "Test druku"). Nic nie trafia do DHL ani marketplace'u. */}
          {showTestPrint && (
          <div className="border border-dashed border-line bg-white p-3 mb-4 flex flex-wrap items-center gap-3">
            <span className="text-xs font-semibold text-inksoft">Test druku:</span>
            <button onClick={() => testPrint("label")} disabled={printBusy} className={btnGhost}>Drukuj testową etykietę (Zebra)</button>
            <button onClick={() => testPrint("a4")} disabled={printBusy} className={btnGhost}>Drukuj testowy delivery note (A4)</button>
            <span className="text-xs text-inksoft">Wysyła próbny wydruk prosto na drukarki przez QZ Tray — bez nadawania przesyłki i bez marketplace'u.</span>
            {testPrintMsg && <span className="text-xs font-semibold text-teal w-full">{testPrintMsg}</span>}
          </div>
          )}
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
              <div className="flex gap-2">
                <button onClick={() => handleLabel(done.id, done.labelBase64, done.labelFormat)} disabled={printBusy} className={btnPrimary}>
                  {directPrint ? "Drukuj etykietę (Zebra)" : "Otwórz etykietę (PDF)"}
                </button>
                {done.deliveryNoteUrl && (
                  <button onClick={() => handlePackingSlip(done.deliveryNoteUrl!)} disabled={printBusy} className={btnGhost}>
                    {directPrint ? "Drukuj packing slip (A4)" : "Otwórz packing slip (PDF)"}
                  </button>
                )}
                <button onClick={reset} className={btnGhost}>Nowa przesyłka</button>
              </div>
              {!directPrint && <p className="text-xs text-inksoft mt-2">Wydrukuj etykietę na Zebrze: w oknie druku wybierz drukarkę i rozmiar strony 100 × 150 mm, skala 100%.</p>}
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
              {(["parcel", "express", "ups"] as Carrier[]).map((c) => {
                const on = c === "parcel" ? parcel?.configured : c === "express" ? express?.configured : ups?.configured;
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
              <div><label className={label}>Telefon odbiorcy *</label><input value={form.phone} onChange={(e) => setField("phone", stripPhoneSpaces(e.target.value))} className={inputCls} /></div>
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

            {carrier === "ups" && form.countryCode === "PL" && (
              <div className="mb-3 flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-2 text-sm font-semibold">
                  <input type="checkbox" checked={codOn} onChange={(e) => { setCodOn(e.target.checked); setQuote(null); setChosen(null); }} />
                  Pobranie (COD)
                </label>
                {codOn && (
                  <>
                    <input
                      value={codAmount}
                      onChange={(e) => { setCodAmount(e.target.value); setQuote(null); setChosen(null); }}
                      inputMode="decimal"
                      placeholder="Kwota do pobrania"
                      className="w-40 border border-line bg-white px-3 py-2 rounded text-sm font-mono"
                    />
                    <span className="text-xs text-inksoft">zł — gotówka od odbiorcy; kwota 10–50 000 zł. UPS dolicza opłatę za pobranie (widoczna w wycenie).</span>
                    {!codValid && <span className="text-xs text-rust font-semibold">Podaj kwotę 10–50 000 zł.</span>}
                  </>
                )}
              </div>
            )}

            {(carrier === "parcel" || carrier === "ups") && (
              <div className="mb-3">
                {extraPackages.map((p, i) => (
                  <div key={i} className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-2 items-end">
                    <div className="md:col-span-1 text-xs font-semibold text-inksoft">Paczka {i + 2}</div>
                    <div><label className={label}>Waga (kg) *</label><input value={p.weight} onChange={(e) => setExtraField(i, "weight", e.target.value)} inputMode="decimal" className={inputCls} /></div>
                    <div><label className={label}>Długość (cm) *</label><input value={p.length} onChange={(e) => setExtraField(i, "length", e.target.value)} inputMode="decimal" className={inputCls} /></div>
                    <div><label className={label}>Szerokość (cm) *</label><input value={p.width} onChange={(e) => setExtraField(i, "width", e.target.value)} inputMode="decimal" className={inputCls} /></div>
                    <div><label className={label}>Wysokość (cm) *</label><input value={p.height} onChange={(e) => setExtraField(i, "height", e.target.value)} inputMode="decimal" className={inputCls} /></div>
                    <button onClick={() => removeExtraPackage(i)} className="text-xs font-semibold text-rust hover:underline">Usuń paczkę</button>
                  </div>
                ))}
                <button onClick={addExtraPackage} className="text-xs font-semibold text-teal hover:underline">+ Dodaj kolejną paczkę do tej przesyłki</button>
              </div>
            )}

            <button onClick={getQuote} disabled={quoting || !formReady || !codValid || !(carrier === "parcel" ? parcel?.configured : carrier === "express" ? express?.configured : ups?.configured)} className={btnPrimary}>{quoting ? `Pytanie ${carrier === "ups" ? "UPS" : "DHL"}…` : `Wyceń (${CARRIER_LABEL[carrier]})`}</button>
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
                      <th className="p-3 text-right">Cena{quote.carrier !== "express" ? " (netto)" : ""}</th>
                      <th className="p-3 text-right">Cena (PLN{quote.carrier !== "express" ? ", netto" : ""})</th>
                      <th className="p-3 text-right">Waga taryfowa</th>
                      <th className="p-3 text-right">Dni</th>
                      <th className="p-3">Szacowana dostawa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quote.products.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-inksoft text-sm">Przewoźnik nie zwrócił produktów dla tej trasy.</td></tr>}
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
              {quote.warnings.length > 0 && <p className="text-xs text-inksoft mb-2">Ostrzeżenia przewoźnika: {quote.warnings.join("; ")}</p>}
              <button onClick={create} disabled={creating || !chosen} className={btnPrimary}>{creating ? "Nadawanie…" : `Nadaj przesyłkę (${CARRIER_LABEL[quote.carrier]}) i wygeneruj etykietę`}</button>
              <p className="text-xs text-inksoft mt-2">
Cena to wycena wg cennika konta ({quote.carrier === "ups" ? "UPS: kwota NETTO w PLN, stawka wynegocjowana, już z dopłatą paliwową — bez VAT" : "DHL Parcel: kwota NETTO w PLN, już z doliczoną dopłatą paliwową — bez VAT"}); ostateczną kwotę (VAT, ewentualne opłaty dodatkowe) potwierdza faktura przewoźnika.
                {quote.carrier === "ups"
                  ? ups?.env === "production"
                    ? " Nadanie jest prawdziwe i płatne — możesz je anulować na liście przesyłek, dopóki UPS nie odbierze paczki."
                    : " Środowisko testowe UPS: nadanie nie jest prawdziwe."
                  : quote.carrier === "parcel"
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
          <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
            <h2 className="text-xs font-semibold text-inksoft">NADANE PRZESYŁKI</h2>
            <div className="flex items-center gap-3">
              <input
                value={shipSearchInput}
                onChange={(e) => setShipSearchInput(e.target.value)}
                placeholder="Szukaj po numerze przesyłki"
                className="w-56 border border-line bg-white px-3 py-1.5 rounded text-sm font-mono"
              />
              <span className="text-xs text-inksoft whitespace-nowrap">
                {shipTotal.toLocaleString("pl-PL")} {shipSearch ? "wyników" : "przesyłek"} · strona {Math.min(shipPage, shipTotalPages)} z {shipTotalPages}
              </span>
              <button
                onClick={() => setShipPage((p) => Math.max(1, p - 1))}
                disabled={shipPage <= 1}
                className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold text-ink disabled:opacity-40"
              >
                ‹ Poprzednia
              </button>
              <button
                onClick={() => setShipPage((p) => Math.min(shipTotalPages, p + 1))}
                disabled={shipPage >= shipTotalPages}
                className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold text-ink disabled:opacity-40"
              >
                Następna ›
              </button>
            </div>
          </div>
          <div className="border border-line bg-white overflow-x-auto mb-8">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-inksoft border-b border-line">
                  <th className="p-3">Nadano</th>
                  <th className="p-3">Zamówienie</th>
                  <th className="p-3">Przewoźnik</th>
                  <th className="p-3">Numer przesyłki</th>
                  <th className="p-3">Odbiorca</th>
                  <th className="p-3">Produkt</th>
                  <th className="p-3 text-right">Cena</th>
                  <th className="p-3">Nadał</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {shipments.length === 0 && <tr><td colSpan={9} className="p-6 text-center text-inksoft text-sm">{shipSearch ? "Brak wyników." : "Brak nadanych przesyłek."}</td></tr>}
                {shipments.map((s) => {
                  const charge = dhlCharge(s.charges);
                  return (
                    <tr key={s.id} className={`border-b border-line last:border-b-0 hover:bg-paper align-top ${s.cancelled_at ? "text-inksoft line-through" : ""}`}>
                      <td className="p-3 text-xs text-inksoft whitespace-nowrap">
                        {fmtDateTime(s.created_at)}
                        {s.environment !== "production" && <div className="text-amber font-semibold">TEST</div>}
                      </td>
                      <td className="p-3 text-xs font-mono">
                        {s.order_external_id && s.marketplace ? (
                          <button onClick={() => setOpenOrder({ marketplace: s.marketplace!, externalId: s.order_external_id! })} className="text-teal hover:underline">
                            {s.order_external_id}
                          </button>
                        ) : (
                          s.order_external_id || "—"
                        )}
                        {s.order_external_id && s.marketplace_sync_error && (
                          <div className="mt-1">
                            <span className="text-rust font-sans font-semibold no-underline" title={s.marketplace_sync_error}>problem ze zgłoszeniem do marketplace'u</span>
                            {!s.cancelled_at && (
                              <button onClick={() => retryMarketplaceSync(s)} className="ml-2 text-teal font-sans font-semibold no-underline hover:underline">Ponów</button>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-xs whitespace-nowrap">{s.carrier === "dhl_parcel" ? "DHL Parcel" : s.carrier === "erli_paczkomat" ? "Erli Paczkomat" : s.carrier === "ups" ? "UPS" : "DHL Express"}{s.cancelled_at && <div className="text-rust font-semibold no-underline">ANULOWANA</div>}</td>
                      <td className="p-3 font-mono whitespace-nowrap">
                        {s.tracking_url ? <a href={s.tracking_url} target="_blank" rel="noreferrer" className="text-teal hover:underline">{s.tracking_number}</a> : s.tracking_number}
                      </td>
                      <td className="p-3 text-xs">{s.receiver?.name}<div className="text-inksoft">{s.receiver?.city}, {s.receiver?.countryCode}</div></td>
                      <td className="p-3 text-xs whitespace-nowrap">
                        {s.product_name || s.product_code}
                        {(s.package as { cod?: { amount?: number } | null } | null)?.cod?.amount ? (
                          <div className="text-amber font-semibold" title="Pobranie — kwotę do odbioru od odbiorcy wpłaca UPS na konto wg umowy">COD {Number((s.package as any).cod.amount).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł</div>
                        ) : null}
                      </td>
                      <td className="p-3 text-right font-mono text-xs whitespace-nowrap">
                        {charge ? fmtMoney({ price: charge.price, currency: charge.priceCurrency }) : "—"}
                        {!charge && !s.cancelled_at && s.carrier === "dhl_parcel" && (
                          <div>
                            <button
                              onClick={() => backfillPrice(s)}
                              className="font-sans font-semibold text-teal hover:underline"
                              title="Pobiera dzisiejszą wycenę DHL dla tej trasy i paczki i zapisuje ją jako cenę przesyłki"
                            >
                              Dolicz cenę
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-xs">{s.created_by_email || "—"}</td>
                      <td className="p-3 whitespace-nowrap text-right">
                        {!s.cancelled_at && (
                          <button onClick={() => handleLabel(s.id, null, s.label_format)} disabled={printBusy} className="text-xs font-semibold text-teal hover:underline disabled:opacity-50">
                            {s.has_label === false ? "Pobierz etykietę" : directPrint ? "Drukuj" : "Etykieta"}
                          </button>
                        )}
                        {!s.cancelled_at && (s.carrier === "dhl_parcel" || s.carrier === "erli_paczkomat" || s.carrier === "ups") && (
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

      {openOrder && (
        <SalesOrderCard marketplace={openOrder.marketplace} externalId={openOrder.externalId} session={session} members={members} onClose={() => setOpenOrder(null)} />
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
  const [printers, setPrinters] = useState<string[] | null>(null);
  const [detecting, setDetecting] = useState(false);

  // Pomocniczo: lista drukarek widocznych dla QZ Tray NA TYM komputerze — żeby nie zgadywać dokładnej nazwy
  // z Windowsa. Wymaga zainstalowanego i uruchomionego QZ Tray (patrz CLAUDE.md).
  async function detectPrinters() {
    onError("");
    setDetecting(true);
    try {
      setPrinters(await listPrinters());
    } catch (e: any) {
      onError(e.message || "Nie udało się wykryć drukarek — czy QZ Tray jest uruchomiony na tym komputerze?");
    } finally {
      setDetecting(false);
    }
  }

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
        zebra_printer_name: f.zebra_printer_name?.trim() || null,
        a4_printer_name: f.a4_printer_name?.trim() || null,
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
          <div className="flex items-center justify-between mb-1 mt-2">
            <h3 className="text-xs font-semibold text-inksoft">Drukowanie bezpośrednie (QZ Tray)</h3>
            <button onClick={detectPrinters} disabled={detecting} className="text-xs font-semibold text-teal hover:underline disabled:opacity-50">
              {detecting ? "Wykrywanie…" : "Wykryj drukarki na tym komputerze"}
            </button>
          </div>
          <p className="text-xs text-inksoft mb-2">Dokładna nazwa drukarki (jak w Windowsie) — wymagane tylko, gdy przełącznik "Drukowanie bezpośrednie" jest włączony. "Wykryj" działa na komputerze, na którym jest zainstalowany i uruchomiony QZ Tray.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div>
              <label className={label}>Drukarka etykiet (Zebra)</label>
              <input value={f.zebra_printer_name ?? ""} onChange={(e) => setF({ ...f, zebra_printer_name: e.target.value })} list="zebra-printers" className={inputCls} />
            </div>
            <div>
              <label className={label}>Drukarka A4 (delivery note)</label>
              <input value={f.a4_printer_name ?? ""} onChange={(e) => setF({ ...f, a4_printer_name: e.target.value })} list="a4-printers" className={inputCls} />
            </div>
            {printers && (
              <>
                <datalist id="zebra-printers">{printers.map((p) => <option key={p} value={p} />)}</datalist>
                <datalist id="a4-printers">{printers.map((p) => <option key={p} value={p} />)}</datalist>
                {printers.length === 0 && <p className="text-xs text-rust md:col-span-2">QZ Tray nie zgłosił żadnej drukarki.</p>}
              </>
            )}
          </div>
          <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? "Zapisywanie…" : "Zapisz dane nadawcy"}</button>
        </div>
      )}
    </div>
  );
}
