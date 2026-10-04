// UPS — wycena, nadanie i anulowanie przesyłek (UPS REST API, specyfikacje OpenAPI z github.com/UPS-API/api-documentation; 04.10.2026).
// Czysta logika bez Next.js/Supabase, testowana na atrapie fetch.
//
// Autoryzacja: OAuth2 client_credentials (POST /security/v1/oauth/token, Basic Client ID:Secret, nagłówek x-merchant-id = numer konta). Token żyje
// kilka godzin (test 1 h, produkcja 4 h) — trzymamy go w pamięci procesu aż do wygaśnięcia, bez zapisu w bazie (jak token Octopii).
// Środowiska: test (wwwcie.ups.com) i produkcja (onlinetools.ups.com); domyślnie TEST, produkcja tylko przy UPS_ENV=production.
// Ceny: wszystkie w walucie konta (u nas PLN), netto; gdy konto ma stawki wynegocjowane, bierzemy je (NegotiatedRateCharges), inaczej cennik katalogowy.

export type UpsConfig = {
  clientId: string;
  clientSecret: string;
  account: string; // numer konta UPS (6 znaków)
  env: "test" | "production";
  fetchImpl?: typeof fetch;
};

export class UpsError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export function upsConfigFromEnv(): UpsConfig | null {
  const clientId = process.env.UPS_CLIENT_ID?.trim();
  const clientSecret = process.env.UPS_CLIENT_SECRET?.trim();
  const account = process.env.UPS_ACCOUNT_NUMBER?.trim();
  if (!clientId || !clientSecret || !account) return null;
  return { clientId, clientSecret, account, env: process.env.UPS_ENV === "production" ? "production" : "test" };
}

const host = (cfg: UpsConfig) => (cfg.env === "production" ? "https://onlinetools.ups.com" : "https://wwwcie.ups.com");
const API_VERSION = "v2409";

// Usługi UPS (kody wg dokumentacji). Wycena (Shop) sama zwraca tylko te, które są dostępne na trasie i koncie — ta mapa służy do nazw.
export const UPS_SERVICES: Record<string, string> = {
  "07": "UPS Express",
  "08": "UPS Expedited",
  "11": "UPS Standard",
  "14": "UPS Express Early",
  "54": "UPS Express Plus",
  "65": "UPS Express Saver",
  "70": "UPS Access Point Economy",
};
export const upsServiceName = (code: string) => UPS_SERVICES[code] ?? `UPS usługa ${code}`;
// Usługa, którą zaznaczamy domyślnie (najtańszy standard; wycena i tak pokazuje wszystkie dostępne).
export const UPS_DEFAULT_SERVICE = "11";

export const upsTrackingUrl = (tracking: string) => `https://www.ups.com/track?loc=pl_PL&tracknum=${encodeURIComponent(tracking)}`;

// Token z pamięci procesu (klucz: środowisko + klient). Odnawiany 60 s przed wygaśnięciem.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
export function resetUpsTokenCache() {
  tokenCache.clear();
}

async function upsToken(cfg: UpsConfig): Promise<string> {
  const key = `${cfg.env}:${cfg.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`${host(cfg)}/security/v1/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
      "x-merchant-id": cfg.account,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    const msg = j?.response?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new UpsError(`UPS odrzucił logowanie: ${msg}`, res.status);
  }
  tokenCache.set(key, { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token as string;
}

async function upsCall(cfg: UpsConfig, method: "POST" | "DELETE", path: string, body?: unknown): Promise<any> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const token = await upsToken(cfg);
  const res = await doFetch(`${host(cfg)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", transId: Math.random().toString(36).slice(2, 12), transactionSrc: "recoo-erp" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = j?.response?.errors?.[0];
    throw new UpsError(e ? `UPS: ${e.message}${e.code ? ` (${e.code})` : ""}` : `UPS odpowiedział błędem HTTP ${res.status}.`, res.status);
  }
  return j;
}

// --- adresy

export type UpsAddress = {
  name: string; // max 35 znaków (Name i AttentionName)
  attentionName?: string;
  phone: string;
  email?: string;
  street: string; // pełna ulica z numerem — łamana na linie po max 35 znaków (do 3)
  city: string; // max 30 znaków
  postalCode: string;
  countryCode: string;
};

// UPS liczy limit 35 znaków na każdą z (max 3) linii adresu — łamiemy na spacjach, za długi adres to czytelny błąd, nie ucinanie.
export function upsAddressLines(street: string): string[] {
  const words = street.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (w.length > 35) throw new UpsError(`Adres jest za długi dla UPS (słowo „${w.slice(0, 20)}…” ma ponad 35 znaków).`);
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= 35) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > 3) throw new UpsError("Adres jest za długi dla UPS (maksymalnie 3 linie po 35 znaków).");
  return lines;
}

// Polski kod pocztowy UPS przyjmuje w formie NN-NNN (kod z samych cyfr, jak w ustawieniach DHL24, uzupełniamy myślnikiem).
export function upsPostalCode(code: string, country: string): string {
  const c = code.trim();
  if (country.toUpperCase() === "PL" && /^\d{5}$/.test(c)) return `${c.slice(0, 2)}-${c.slice(2)}`;
  return c;
}

function checkLen(label: string, v: string, max: number) {
  if (v.length > max) throw new UpsError(`${label} jest za długie dla UPS (max ${max} znaków): „${v}”.`);
}

const cleanPhone = (p: string) => p.replace(/[^\d+]/g, "").replace(/^\+/, "").slice(0, 15) || "0";

function addressBlock(a: UpsAddress, withShipperNumber?: string) {
  checkLen("Nazwa", a.name, 35);
  checkLen("Miasto", a.city, 30);
  const block: any = {
    Name: a.name,
    AttentionName: (a.attentionName ?? a.name).slice(0, 35),
    Phone: { Number: cleanPhone(a.phone) },
    Address: { AddressLine: upsAddressLines(a.street), City: a.city, PostalCode: upsPostalCode(a.postalCode, a.countryCode), CountryCode: a.countryCode.toUpperCase() },
  };
  if (a.email) block.EMailAddress = a.email.slice(0, 50);
  if (withShipperNumber) block.ShipperNumber = withShipperNumber;
  return block;
}

export type UpsPackage = { weight: number; length: number; width: number; height: number };
// Rating API nazywa pole opakowania "PackagingType", Shipping API — "Packaging" (kod 02 = opakowanie klienta).
const pkgBlock = (p: UpsPackage, kind: "rate" | "ship", description?: string) => ({
  ...(description ? { Description: description.slice(0, 35) } : {}),
  ...(kind === "rate" ? { PackagingType: { Code: "02" } } : { Packaging: { Code: "02" } }),
  Dimensions: { UnitOfMeasurement: { Code: "CM" }, Length: String(Math.ceil(p.length)), Width: String(Math.ceil(p.width)), Height: String(Math.ceil(p.height)) },
  PackageWeight: { UnitOfMeasurement: { Code: "KGS" }, Weight: p.weight.toFixed(1) },
});

// --- pobranie (COD)

// Pobranie UPS (Shipment-level COD) — dostępne dla przesyłek KRAJOWYCH w Polsce (potwierdzone wyceną na koncie: PL→PL przyjmuje kody 1 i 9, kod 0 i 8 odrzuca).
// Kod 1 = "Cash only" (gotówka, jak przy pobraniu Erli/Allegro). Kwota w PLN, 10,00–50 000,00 (pole MonetaryValue w specyfikacji ma min. 5 znaków, np. "10.00").
export type UpsCod = { amount: number; currency: string };
export const UPS_COD_MIN = 10;
export const UPS_COD_MAX = 50000;
export function upsCodOptions(cod: UpsCod | null | undefined) {
  if (!cod) return {};
  if (!(cod.amount >= UPS_COD_MIN && cod.amount <= UPS_COD_MAX)) throw new UpsError(`Kwota pobrania musi mieścić się w przedziale ${UPS_COD_MIN}–${UPS_COD_MAX} zł.`);
  return { ShipmentServiceOptions: { COD: { CODFundsCode: "1", CODAmount: { CurrencyCode: cod.currency, MonetaryValue: cod.amount.toFixed(2) } } } };
}

// --- wycena (Rating, Shop)

export type UpsQuote = {
  code: string;
  name: string;
  price: number; // cena do zapłaty (wynegocjowana, jeśli konto ją ma; inaczej katalogowa)
  currency: string;
  negotiated: boolean;
  chargeableWeight: number | null;
  breakdown: { name: string; price: number }[];
  warnings: string[];
};

export async function upsRate(cfg: UpsConfig, o: { shipper: UpsAddress; receiver: UpsAddress; packages: UpsPackage[]; cod?: UpsCod | null }): Promise<UpsQuote[]> {
  const body = {
    RateRequest: {
      Request: { TransactionReference: { CustomerContext: "recoo-erp" } },
      Shipment: {
        Shipper: addressBlock(o.shipper, cfg.account),
        ShipTo: addressBlock(o.receiver),
        ShipFrom: addressBlock(o.shipper),
        ShipmentRatingOptions: { NegotiatedRatesIndicator: "Y" },
        ...upsCodOptions(o.cod),
        Package: o.packages.map((p) => pkgBlock(p, "rate")),
      },
    },
  };
  const j = await upsCall(cfg, "POST", `/api/rating/${API_VERSION}/Shop`, body);
  const rated: any[] = j?.RateResponse?.RatedShipment ?? [];
  const num = (m: any) => (m?.MonetaryValue !== undefined ? Number(m.MonetaryValue) : null);
  return rated.map((r) => {
    const neg = r.NegotiatedRateCharges;
    const negTotal = num(neg?.TotalCharge);
    const useNeg = negTotal !== null;
    const src = useNeg ? neg : r;
    const total = (useNeg ? negTotal : num(r.TotalCharges)) as number;
    const base = num(src.BaseServiceCharge) ?? num(src.TransportationCharges);
    const breakdown: { name: string; price: number }[] = [];
    if (base !== null) breakdown.push({ name: "Opłata podstawowa", price: base });
    for (const c of src.ItemizedCharges ?? []) breakdown.push({ name: c.Code === "375" ? "Dopłata paliwowa" : `Dopłata (kod ${c.Code})`, price: Number(c.MonetaryValue) });
    const svc = num(src.ServiceOptionsCharges);
    if (svc) breakdown.push({ name: "Opcje usługi", price: svc });
    return {
      code: String(r.Service?.Code ?? ""),
      name: upsServiceName(String(r.Service?.Code ?? "")),
      price: total,
      currency: String((useNeg ? neg.TotalCharge : r.TotalCharges)?.CurrencyCode ?? "PLN"),
      negotiated: useNeg,
      chargeableWeight: r.BillingWeight?.Weight !== undefined ? Number(r.BillingWeight.Weight) : null,
      breakdown,
      warnings: (r.RatedShipmentAlert ?? []).map((a: any) => String(a.Description)).filter((d: string) => !/may vary from the displayed reference rates/i.test(d)),
    };
  });
}

// --- nadanie (Shipping)

export type UpsCreated = {
  shipmentId: string;
  trackingNumbers: string[]; // jeden na paczkę
  labelBase64: string | null; // ZPL wszystkich paczek jedna po drugiej, w base64 — jak etykieta DHL Express, ta sama ścieżka druku
  labelsBase64: string[]; // etykiety wszystkich paczek (ZPL base64)
  charge: { price: number; currency: string } | null;
};

export async function upsCreate(
  cfg: UpsConfig,
  o: { serviceCode: string; shipper: UpsAddress; receiver: UpsAddress; packages: UpsPackage[]; description: string; reference?: string; cod?: UpsCod | null }
): Promise<UpsCreated> {
  const body = {
    ShipmentRequest: {
      Request: { RequestOption: "nonvalidate", TransactionReference: { CustomerContext: o.reference ?? "recoo-erp" } },
      Shipment: {
        Description: o.description.slice(0, 50),
        Shipper: addressBlock(o.shipper, cfg.account),
        ShipTo: addressBlock(o.receiver),
        ShipFrom: addressBlock(o.shipper),
        PaymentInformation: { ShipmentCharge: { Type: "01", BillShipper: { AccountNumber: cfg.account } } },
        Service: { Code: o.serviceCode },
        ShipmentRatingOptions: { NegotiatedRatesIndicator: "Y" },
        ...upsCodOptions(o.cod),
        ...(o.reference ? { ReferenceNumber: { Code: "02", Value: o.reference.slice(0, 35) } } : {}),
        Package: o.packages.map((p) => pkgBlock(p, "ship", o.description)),
      },
      LabelSpecification: { LabelImageFormat: { Code: "ZPL" }, LabelStockSize: { Height: "6", Width: "4" } },
    },
  };
  const j = await upsCall(cfg, "POST", `/api/shipments/${API_VERSION}/ship`, body);
  const res = j?.ShipmentResponse?.ShipmentResults;
  if (!res?.ShipmentIdentificationNumber) throw new UpsError("UPS nie zwrócił numeru przesyłki.");
  const pk: any[] = Array.isArray(res.PackageResults) ? res.PackageResults : res.PackageResults ? [res.PackageResults] : [];
  const labels: string[] = pk.map((p) => p.ShippingLabel?.GraphicImage).filter(Boolean);
  const money = res.NegotiatedRateCharges?.TotalCharge ?? res.ShipmentCharges?.TotalCharges;
  return {
    shipmentId: String(res.ShipmentIdentificationNumber),
    trackingNumbers: pk.map((p) => String(p.TrackingNumber)),
    labelBase64: labels.length ? Buffer.from(labels.map((l) => Buffer.from(l, "base64").toString("latin1")).join("\n"), "latin1").toString("base64") : null,
    labelsBase64: labels,
    charge: money ? { price: Number(money.MonetaryValue), currency: String(money.CurrencyCode ?? "PLN") } : null,
  };
}

// --- anulowanie (Void) — możliwe, dopóki przesyłka nie została odebrana przez UPS

export async function upsVoid(cfg: UpsConfig, shipmentId: string): Promise<void> {
  const j = await upsCall(cfg, "DELETE", `/api/shipments/${API_VERSION}/void/cancel/${encodeURIComponent(shipmentId)}`);
  const status = j?.VoidShipmentResponse?.SummaryResult?.Status?.Code;
  if (status !== undefined && String(status) !== "1") {
    throw new UpsError(`UPS nie anulował przesyłki: ${j?.VoidShipmentResponse?.SummaryResult?.Status?.Description ?? "brak szczegółów"}.`);
  }
}
