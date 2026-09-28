// Klient DHL Express — MyDHL API (REST/JSON), https://developer.dhl.com/api-reference/dhl-express-mydhl-api
// (definicja OpenAPI 3.3.1). Logowanie Basic: "API Key (Username / site ID)" : "API Secret (Password)" z aplikacji MyDHL na
// developer.dhl.com — ta sama para działa na środowisku testowym i produkcyjnym, środowisko wybiera adres.
// Numer konta nadawcy (DHL_EXPRESS_ACCOUNT) idzie w zapytaniach, ale nigdy do przeglądarki ani do repozytorium.

export const DHL_EXPRESS_VERSION = "3.3.1"; // nagłówek x-version wymagany przy każdym zapytaniu
export const DHL_EXPRESS_URLS = {
  test: "https://express.api.dhl.com/mydhlapi/test",
  production: "https://express.api.dhl.com/mydhlapi",
} as const;

export type DhlExpressEnv = keyof typeof DHL_EXPRESS_URLS;
export type DhlExpressConfig = { apiKey: string; apiSecret: string; account: string; env: DhlExpressEnv; fetchImpl?: typeof fetch };

// Zwraca null, dopóki nie ma kompletu danych. Środowisko domyślnie testowe — produkcja tylko przy jawnym DHL_EXPRESS_ENV=production.
export function dhlExpressConfigFromEnv(env: Record<string, string | undefined> = process.env): DhlExpressConfig | null {
  const apiKey = env.DHL_EXPRESS_API_KEY?.trim();
  const apiSecret = env.DHL_EXPRESS_API_SECRET?.trim();
  const account = env.DHL_EXPRESS_ACCOUNT?.trim();
  if (!apiKey || !apiSecret || !account) return null;
  return { apiKey, apiSecret, account, env: env.DHL_EXPRESS_ENV?.trim().toLowerCase() === "production" ? "production" : "test" };
}

export class DhlExpressError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

// Błędy DHL mają postać {title, detail, additionalDetails[], status} — składamy z nich jedno czytelne zdanie.
function describeError(status: number, text: string): string {
  try {
    const j = JSON.parse(text);
    const parts = [j.title, j.detail, ...(Array.isArray(j.additionalDetails) ? j.additionalDetails : [])].filter(Boolean);
    if (parts.length > 0) return `DHL Express (${status}): ${parts.join(" — ")}`;
  } catch {
    /* odpowiedź nie jest JSON-em */
  }
  return `DHL Express (${status}): ${text.slice(0, 200) || "brak treści odpowiedzi"}`;
}

export type ProductQuery = {
  originCountryCode: string;
  originCityName: string;
  originPostalCode?: string;
  destinationCountryCode: string;
  destinationCityName: string;
  destinationPostalCode?: string;
  weight: number; // kg
  length: number; // cm
  width: number;
  height: number;
  plannedShippingDate: string; // YYYY-MM-DD
  isCustomsDeclarable: boolean; // true, gdy przesyłka wymaga odprawy celnej (poza UE)
};

export type DhlMoney = { price: number; currency: string };

export type DhlProduct = {
  code: string;
  name: string;
  networkType: string | null; // DD = doręczenie w określonym dniu (Day Definite), TD = w określonym czasie
  customerAgreement: boolean; // produkt dostępny tylko w ramach umowy
  transitDays: number | null;
  estimatedDelivery: string | null;
  pickupCutoff: string | null;
  // Cena całej przesyłki wg cennika naszego konta: w walucie rozliczeniowej konta (BILLC) i w walucie kraju nadania (PULCL, u nas PLN).
  billing: DhlMoney | null;
  local: DhlMoney | null;
  chargeableWeight: number | null; // waga taryfowa (większa z rzeczywistej i objętościowej), kg
  volumetricWeight: number | null;
  breakdown: { name: string; price: number }[]; // składniki ceny (opłata podstawowa, paliwowa itd.) w walucie rozliczeniowej
};

// Economy Select to produkt "H" (towary) i "W" (dokumenty); rozpoznajemy go też po nazwie, bo kody sprawdzamy na żywo z DHL.
export const isEconomySelect = (p: { code: string; name: string }) => /economy\s*select/i.test(p.name) || ["H", "W"].includes(p.code);

const priceOf = (list: any[] | undefined, type: string): DhlMoney | null => {
  const x = (list || []).find((e) => e?.currencyType === type);
  const price = Number(x?.price);
  return x && Number.isFinite(price) && x.priceCurrency ? { price, currency: String(x.priceCurrency) } : null;
};

// GET /rates — produkty DHL Express dostępne dla jednej paczki na danej trasie RAZEM z ceną wg cennika naszego konta. To zapytanie
// tylko wycenia: niczego nie tworzy i nic nie kosztuje (także na środowisku produkcyjnym).
export async function dhlRates(cfg: DhlExpressConfig, q: ProductQuery): Promise<{ products: DhlProduct[]; warnings: string[] }> {
  const params = new URLSearchParams({
    accountNumber: cfg.account,
    originCountryCode: q.originCountryCode,
    originCityName: q.originCityName,
    destinationCountryCode: q.destinationCountryCode,
    destinationCityName: q.destinationCityName,
    weight: String(q.weight),
    length: String(q.length),
    width: String(q.width),
    height: String(q.height),
    plannedShippingDate: q.plannedShippingDate,
    isCustomsDeclarable: String(q.isCustomsDeclarable),
    unitOfMeasurement: "metric",
    nextBusinessDay: "true", // jeśli w wybranym dniu nie ma produktów (weekend), pokaż najbliższy dzień roboczy
    requestEstimatedDeliveryDate: "true",
  });
  if (q.originPostalCode) params.set("originPostalCode", q.originPostalCode);
  if (q.destinationPostalCode) params.set("destinationPostalCode", q.destinationPostalCode);

  const res = await (cfg.fetchImpl ?? fetch)(`${DHL_EXPRESS_URLS[cfg.env]}/rates?${params.toString()}`, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString("base64"),
      Accept: "application/json",
      "x-version": DHL_EXPRESS_VERSION,
      "Message-Reference": crypto.randomUUID().replace(/-/g, "").slice(0, 28), // wymagane: 28-36 znaków
      "Message-Reference-Date": new Date().toUTCString(),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DhlExpressError(describeError(res.status, text), res.status);
  }
  const data = await res.json();
  const products: DhlProduct[] = ((data.products as any[]) || []).map((p) => {
    const provided = Number(p.weight?.provided);
    const volumetric = Number(p.weight?.volumetric);
    const detailed = ((p.detailedPriceBreakdown as any[]) || []).find((b) => b?.currencyType === "BILLC") ?? (p.detailedPriceBreakdown as any[])?.[0];
    return {
    code: String(p.productCode ?? ""),
    name: String(p.productName ?? ""),
    networkType: p.networkTypeCode ?? null,
    customerAgreement: !!p.isCustomerAgreement,
    transitDays: Number.isFinite(Number(p.deliveryCapabilities?.totalTransitDays)) ? Number(p.deliveryCapabilities.totalTransitDays) : null,
    estimatedDelivery: p.deliveryCapabilities?.estimatedDeliveryDateAndTime ?? null,
    pickupCutoff: p.pickupCapabilities?.localCutoffDateAndTime ?? null,
    billing: priceOf(p.totalPrice, "BILLC"),
    local: priceOf(p.totalPrice, "PULCL"),
    chargeableWeight: Number.isFinite(provided) || Number.isFinite(volumetric) ? Math.max(Number.isFinite(provided) ? provided : 0, Number.isFinite(volumetric) ? volumetric : 0) : null,
    volumetricWeight: Number.isFinite(volumetric) ? volumetric : null,
    breakdown: ((detailed?.breakdown as any[]) || [])
      .map((b) => ({ name: String(b?.name ?? b?.serviceCode ?? ""), price: Number(b?.price) }))
      .filter((b) => b.name && Number.isFinite(b.price) && b.price !== 0),
    };
  });
  return { products, warnings: ((data.warnings as any[]) || []).map(String) };
}

/* ---------------- tworzenie przesyłki (POST /shipments) ---------------- */

// Kraje UE, do których nadajemy bez odprawy celnej. Poza UE potrzebne są dane celne (opis, wartość, kod HS) — jeszcze nie obsługujemy.
// UWAGA: obejmuje też Polskę (PL) — potrzebne dla zamówień Back Market/refurbed z odbiorcą w Polsce (te
// marketplace'y nie mają własnej krajowej wysyłki, w odróżnieniu od Erli, które ma teraz Paczkomaty InPost
// bezpośrednio przez swoje API — patrz ErliParcelPanel.tsx). Allegro i Erli i tak nie przechodzą przez
// buildShipPrefill (lib/shipping.ts) niezależnie od kraju, więc nic tu dla nich się nie zmienia.
export const DHL_EU_COUNTRIES = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];

export const COUNTRY_NAMES: Record<string, string> = {
  AT: "Austria", BE: "Belgia", BG: "Bułgaria", HR: "Chorwacja", CY: "Cypr", CZ: "Czechy", DK: "Dania", EE: "Estonia", FI: "Finlandia",
  FR: "Francja", DE: "Niemcy", GR: "Grecja", HU: "Węgry", IE: "Irlandia", IT: "Włochy", LV: "Łotwa", LT: "Litwa", LU: "Luksemburg",
  MT: "Malta", NL: "Holandia", PL: "Polska", PT: "Portugalia", RO: "Rumunia", SK: "Słowacja", SI: "Słowenia", ES: "Hiszpania", SE: "Szwecja",
  GB: "Wielka Brytania", CH: "Szwajcaria", NO: "Norwegia", US: "USA", UA: "Ukraina", TR: "Turcja",
};

// Szablon etykiety 6x4 cala (= 10x15 cm), PDF do wydruku na Zebrze przez sterownik. Nazwę można zmienić zmienną DHL_EXPRESS_LABEL_TEMPLATE.
export const DEFAULT_LABEL_TEMPLATE = "ECOM26_64_001";

export type ShipmentParty = {
  company?: string;
  name: string;
  street: string; // ulica i numer domu w jednym polu
  postalCode: string;
  city: string;
  countryCode: string;
  phone: string;
  email?: string;
};

export type CreateShipmentInput = {
  productCode: string;
  plannedDate: string; // YYYY-MM-DD
  shipper: ShipmentParty;
  receiver: ShipmentParty;
  package: { weight: number; length: number; width: number; height: number; description: string };
  reference?: string; // np. numer zamówienia — drukowany jako referencja klienta
  labelTemplate?: string;
};

// DHL ogranicza linie adresu do 45 znaków (max 3 linie) — łamiemy na spacjach; gdy się nie mieści, zgłaszamy czytelny błąd zamiast ucinać.
export function splitAddressLines(street: string, max = 45): string[] {
  const words = street.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (w.length > max) throw new DhlExpressError(`Adres jest za długi (pojedyncze słowo „${w.slice(0, 20)}…” przekracza ${max} znaków).`);
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= max) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length === 0) throw new DhlExpressError("Podaj ulicę i numer domu.");
  if (lines.length > 3) throw new DhlExpressError("Adres jest za długi — DHL przyjmuje do 3 linii po 45 znaków.");
  return lines;
}

// "2026-09-28T12:00:00 GMT+02:00" — format daty nadania wymagany przez MyDHL API; przesunięcie liczymy dla strefy Europe/Warsaw.
export function plannedShippingDateAndTime(date: string, hour = 12): string {
  const probe = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const part = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", timeZoneName: "shortOffset" })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")?.value; // np. "GMT+2"
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part ?? "");
  const offset = m ? `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}` : "+01:00";
  return `${date}T${String(hour).padStart(2, "0")}:00:00 GMT${offset}`;
}

const party = (p: ShipmentParty) => {
  const [line1, line2, line3] = splitAddressLines(p.street);
  return {
    postalAddress: {
      postalCode: p.postalCode,
      cityName: p.city,
      countryCode: p.countryCode,
      addressLine1: line1,
      ...(line2 ? { addressLine2: line2 } : {}),
      ...(line3 ? { addressLine3: line3 } : {}),
    },
    contactInformation: {
      phone: p.phone,
      companyName: p.company?.trim() || p.name, // DHL wymaga nazwy firmy — dla osoby prywatnej wpisujemy jej imię i nazwisko
      // fullName tylko gdy jest osobna firma — inaczej companyName i fullName to ta sama osoba i etykieta drukuje ją dwa razy
      // (ten sam błąd znaleziony na żywej etykiecie DHL Parcel, patrz analogiczna poprawka w dhl-parcel/create/route.ts).
      ...(p.company?.trim() ? { fullName: p.name } : {}),
      ...(p.email ? { email: p.email } : {}),
    },
  };
};

export type CreatedShipment = {
  trackingNumber: string;
  trackingUrl: string | null;
  charges: { currencyType: string; priceCurrency: string; price: number }[];
  labelBase64: string | null;
  labelFormat: string | null;
  warnings: string[];
};

// Składa treść zapytania POST /shipments. Osobno od wysyłki, żeby dało się ją przetestować bez sieci.
export function buildShipmentRequest(cfg: Pick<DhlExpressConfig, "account">, input: CreateShipmentInput) {
  if (!DHL_EU_COUNTRIES.includes(input.receiver.countryCode)) {
    throw new DhlExpressError("Na razie nadajemy tylko do krajów UE (bez odprawy celnej).");
  }
  return {
    plannedShippingDateAndTime: plannedShippingDateAndTime(input.plannedDate),
    pickup: { isRequested: false }, // kuriera zamawiamy osobno (odbiór stały albo w panelu DHL)
    productCode: input.productCode,
    accounts: [{ typeCode: "shipper", number: cfg.account }],
    customerDetails: { shipperDetails: party(input.shipper), receiverDetails: party(input.receiver) },
    content: {
      packages: [
        {
          weight: input.package.weight,
          dimensions: { length: input.package.length, width: input.package.width, height: input.package.height },
          description: input.package.description.slice(0, 70),
          ...(input.reference ? { customerReferences: [{ typeCode: "CU", value: input.reference.slice(0, 35) }] } : {}),
        },
      ],
      isCustomsDeclarable: false,
      description: input.package.description.slice(0, 70),
      incoterm: "DAP",
      unitOfMeasurement: "metric",
    },
    outputImageProperties: {
      encodingFormat: "pdf",
      imageOptions: [{ typeCode: "label", templateName: input.labelTemplate || DEFAULT_LABEL_TEMPLATE }],
    },
    getRateEstimates: false,
  };
}

// POST /shipments — TWORZY przesyłkę i etykietę. Na środowisku produkcyjnym to prawdziwa przesyłka na koncie (koszt), a DHL Express
// nie pozwala jej anulować przez API (tylko w panelu DHL).
export async function dhlCreateShipment(cfg: DhlExpressConfig, input: CreateShipmentInput): Promise<CreatedShipment> {
  const body = buildShipmentRequest(cfg, input);
  const res = await (cfg.fetchImpl ?? fetch)(`${DHL_EXPRESS_URLS[cfg.env]}/shipments`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString("base64"),
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-version": DHL_EXPRESS_VERSION,
      "Message-Reference": crypto.randomUUID().replace(/-/g, "").slice(0, 28),
      "Message-Reference-Date": new Date().toUTCString(),
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text().catch(() => "");
  // DHL zwraca 201 (utworzono) albo 200 z częściowymi ostrzeżeniami; wszystko inne to błąd.
  if (res.status !== 201 && res.status !== 200) throw new DhlExpressError(describeError(res.status, text), res.status);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DhlExpressError("DHL Express zwrócił odpowiedź, której nie da się odczytać.", res.status);
  }
  const trackingNumber = String(data.shipmentTrackingNumber ?? "");
  if (!trackingNumber) throw new DhlExpressError("DHL Express nie zwrócił numeru przesyłki.", res.status);
  const label = ((data.documents as any[]) || []).find((d) => d?.typeCode === "label") ?? (data.documents as any[])?.[0];
  return {
    trackingNumber,
    trackingUrl: data.trackingUrl ?? null,
    charges: ((data.shipmentCharges as any[]) || [])
      .map((c) => ({ currencyType: String(c?.currencyType ?? ""), priceCurrency: String(c?.priceCurrency ?? ""), price: Number(c?.price) }))
      .filter((c) => Number.isFinite(c.price)),
    labelBase64: label?.content ?? null,
    labelFormat: label?.imageFormat ? String(label.imageFormat).toLowerCase() : null,
    warnings: ((data.warnings as any[]) || []).map(String),
  };
}
