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
