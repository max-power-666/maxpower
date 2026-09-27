// Klient DHL Parcel (DHL24 WebAPI2, SOAP) — https://dhl24.com.pl/webapi2/doc/index.html, definicja WSDL: https://dhl24.com.pl/webapi2?wsdl.
// Przesyłki międzynarodowe: produkty EK (Connect) i PI (International). Autoryzacja: struktura authData (klucz użytkownika + hasło)
// w KAŻDEJ metodzie oprócz getVersion, płatnik po numerze klienta SAP (7 cyfr). W odróżnieniu od DHL Express przesyłkę można ANULOWAĆ
// przez API (deleteShipments), dopóki nie zamówiono po nią kuriera, a etykietę pobrać jako PDF (BLP) albo ZPL dla Zebry (ZBLP).
// Koperta SOAP jest składana ręcznie (document/literal), a odpowiedź czytana parserem XML — bez ciężkiej biblioteki SOAP.

import { XMLParser } from "fast-xml-parser";

export const DHL_PARCEL_NS = "https://dhl24.com.pl/webapi2/provider/service.html?ws=1";
export const DHL_PARCEL_BASE_URL = "https://dhl24.com.pl/webapi2";

export type DhlParcelConfig = { username: string; password: string; sap: string; baseUrl?: string; fetchImpl?: typeof fetch };

// Zwraca null, dopóki nie ma kompletu (klucz użytkownika, hasło, numer SAP). DHL_PARCEL_BASE_URL pozwala wskazać środowisko testowe
// (sandbox.dhl24.com.pl/webapi2), jeśli DHL kiedyś je udostępni — bez niego zawsze jest produkcja.
export function dhlParcelConfigFromEnv(env: Record<string, string | undefined> = process.env): DhlParcelConfig | null {
  const username = env.DHL_PARCEL_USERNAME?.trim();
  const password = env.DHL_PARCEL_PASSWORD?.trim();
  const sap = env.DHL_PARCEL_SAP?.trim();
  if (!username || !password || !sap) return null;
  return { username, password, sap, baseUrl: env.DHL_PARCEL_BASE_URL?.trim() || undefined };
}

export const dhlParcelIsSandbox = (cfg: Pick<DhlParcelConfig, "baseUrl">) => !!cfg.baseUrl && /sandbox/i.test(cfg.baseUrl);

export class DhlParcelError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false, // numery przesyłek i kody zostają tekstem (bez gubienia zer wiodących)
  trimValues: true,
  isArray: (name) => name === "item",
});

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Element XML; pomija wartości puste (undefined/null/""), booleany jako true/false. UWAGA: tekst jest escapowany — zagnieżdżone elementy
// trzeba podawać jako TABLICĘ (string[]), inaczej zostałyby potraktowane jak zwykły tekst.
export function el(name: string, value: string | number | boolean | null | undefined | string[]): string {
  if (value === undefined || value === null || value === "") return "";
  const inner = Array.isArray(value) ? value.join("") : typeof value === "string" ? esc(value) : String(value);
  return `<${name}>${inner}</${name}>`;
}

async function soapCall(cfg: DhlParcelConfig, operation: string, inner: string, auth = true): Promise<any> {
  const authXml = auth ? el("authData", [el("username", cfg.username), el("password", cfg.password)]) : "";
  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${DHL_PARCEL_NS}">` +
    `<soapenv:Body><tns:${operation}>${authXml}${inner}</tns:${operation}></soapenv:Body></soapenv:Envelope>`;
  const res = await (cfg.fetchImpl ?? fetch)(`${cfg.baseUrl ?? DHL_PARCEL_BASE_URL}/provider/service.html?ws=1`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${DHL_PARCEL_NS}#${operation}"`, Accept: "text/xml" },
    body: envelope,
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text().catch(() => "");
  let body: any;
  try {
    body = parser.parse(text)?.Envelope?.Body;
  } catch {
    body = undefined;
  }
  if (body?.Fault) {
    throw new DhlParcelError(`DHL Parcel: ${String(body.Fault.faultstring ?? body.Fault.faultcode ?? "błąd usługi")}`);
  }
  if (!res.ok || !body) throw new DhlParcelError(`DHL Parcel (${res.status}): ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "brak odpowiedzi"}`);
  return body[`${operation}Response`]?.[`${operation}Result`] ?? body[`${operation}Response`];
}

const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export type ParcelAddress = {
  name: string;
  postalCode: string;
  city: string;
  street: string;
  houseNumber: string;
  apartmentNumber?: string;
  contactPerson?: string;
  contactPhone?: string;
  contactEmail?: string;
};
export type ParcelPackage = { weight: number; length: number; width: number; height: number };

// Limity długości pól w DHL24 — przekroczenie dawałoby odrzucenie albo ucięcie, więc zgłaszamy je od razu czytelnym błędem.
const LIMITS: Record<string, number> = { name: 60, city: 17, street: 35, houseNumber: 10, apartmentNumber: 10, contactPerson: 60, contactPhone: 20, contactEmail: 60 };
const FIELD_PL: Record<string, string> = { name: "nazwa", city: "miejscowość", street: "ulica", houseNumber: "numer domu", apartmentNumber: "numer lokalu", contactPerson: "osoba kontaktowa", contactPhone: "telefon", contactEmail: "e-mail" };

export function assertParcelLimits(who: string, a: ParcelAddress) {
  for (const [k, max] of Object.entries(LIMITS)) {
    const v = (a as any)[k];
    if (typeof v === "string" && v.length > max) {
      throw new DhlParcelError(`${who}: pole „${FIELD_PL[k]}” ma ${v.length} znaków, a DHL Parcel przyjmuje maksymalnie ${max}${k === "city" ? " — skróć nazwę miejscowości" : ""}.`);
    }
  }
}

const pieceXml = (p: ParcelPackage) =>
  el("item", [
    el("type", "PACKAGE"),
    el("width", Math.ceil(p.width)), // DHL24 przyjmuje wymiary jako liczby całkowite (cm) — zaokrąglamy w górę
    el("height", Math.ceil(p.height)),
    el("length", Math.ceil(p.length)),
    el("weight", p.weight),
    el("quantity", 1),
  ]);

/* ---------------- wycena ---------------- */

export type ParcelQuote = { product: string; ok: boolean; price: number | null; fuelSurcharge: number | null; error?: string };

// getPrice dla jednego produktu (EK albo PI). Gdy produkt nie jest dostępny na trasie, DHL zwraca błąd — oddajemy go jako wynik
// (ok: false), żeby w tabeli było widać, że produkt jest niedostępny i dlaczego, zamiast przerywać całą wycenę.
export async function dhlParcelPrice(
  cfg: DhlParcelConfig,
  q: { product: string; shipper: ParcelAddress; receiver: ParcelAddress & { country: string }; package: ParcelPackage }
): Promise<ParcelQuote> {
  const addr = (a: ParcelAddress) =>
    el("name", a.name) + el("postalCode", a.postalCode) + el("city", a.city) + el("street", a.street) + el("houseNumber", a.houseNumber) + el("apartmentNumber", a.apartmentNumber);
  try {
    const r = await soapCall(
      cfg,
      "getPrice",
      el("shipment", [
        el("payment", [el("accountNumber", cfg.sap), el("payerType", "SHIPPER")]),
        el("shipper", [el("country", "PL"), addr(q.shipper)]),
        el("receiver", [el("country", q.receiver.country), el("addressType", "C"), addr(q.receiver)]),
        el("service", [el("product", q.product)]),
        el("pieceList", [pieceXml(q.package)]),
      ])
    );
    const price = Number(r?.price);
    const fuel = Number(r?.fuelSurcharge);
    if (!Number.isFinite(price)) return { product: q.product, ok: false, price: null, fuelSurcharge: null, error: "DHL nie zwrócił ceny." };
    return { product: q.product, ok: true, price, fuelSurcharge: Number.isFinite(fuel) ? fuel : null };
  } catch (e: any) {
    return { product: q.product, ok: false, price: null, fuelSurcharge: null, error: String(e?.message ?? e).replace(/^DHL Parcel:\s*/, "") };
  }
}

/* ---------------- tworzenie, etykieta, anulowanie ---------------- */

export type CreateParcelInput = {
  product: string; // EK | PI
  shipmentDate: string; // YYYY-MM-DD
  shipper: ParcelAddress;
  receiver: ParcelAddress & { country: string };
  package: ParcelPackage;
  content: string;
  reference?: string;
};

export function buildCreateShipmentsXml(cfg: Pick<DhlParcelConfig, "sap">, i: CreateParcelInput): string {
  const contact = (a: ParcelAddress) => el("contactPerson", a.contactPerson) + el("contactPhone", a.contactPhone) + el("contactEmail", a.contactEmail);
  const base = (a: ParcelAddress) => el("name", a.name) + el("postalCode", a.postalCode) + el("city", a.city) + el("street", a.street) + el("houseNumber", a.houseNumber) + el("apartmentNumber", a.apartmentNumber);
  return el("shipments", [
    el("item", [
      el("shipper", [base(i.shipper), contact(i.shipper)]),
      el("receiver", [el("country", i.receiver.country), el("addressType", "C"), base(i.receiver), contact(i.receiver)]),
      el("pieceList", [pieceXml(i.package)]),
      el("payment", [el("paymentMethod", "BANK_TRANSFER"), el("payerType", "SHIPPER"), el("accountNumber", cfg.sap)]),
      el("service", [el("product", i.product)]),
      el("shipmentDate", i.shipmentDate),
      el("content", i.content.slice(0, 30)),
      el("reference", i.reference?.slice(0, 20)),
    ]),
  ]);
}

export type CreatedParcel = { shipmentId: string; labelBase64: string | null; labelMime: string | null; labelError?: string };

// createShipments + getLabels(BLP = PDF). Gdy przesyłka powstanie, a pobranie etykiety się nie uda, zwracamy numer i błąd etykiety
// (labelError) — przesyłka istnieje, a etykietę da się pobrać ponownie (dhlParcelLabel).
export async function dhlParcelCreate(cfg: DhlParcelConfig, i: CreateParcelInput): Promise<CreatedParcel> {
  assertParcelLimits("Nadawca", i.shipper);
  assertParcelLimits("Odbiorca", i.receiver);
  const r = await soapCall(cfg, "createShipments", buildCreateShipmentsXml(cfg, i));
  const item = (r?.item as any[] | undefined)?.[0];
  const shipmentId = s(item?.shipmentId);
  if (!shipmentId) {
    // Błąd walidacji przychodzi jako element zamiast danych przesyłki — pokazujemy cały jego tekst.
    const msg = item ? Object.values(item).map(s).filter(Boolean).join("; ") : "";
    throw new DhlParcelError(`DHL Parcel odrzucił przesyłkę${msg ? `: ${msg}` : "."}`);
  }
  try {
    const l = await dhlParcelLabel(cfg, shipmentId);
    return { shipmentId, labelBase64: l.base64, labelMime: l.mime };
  } catch (e: any) {
    return { shipmentId, labelBase64: null, labelMime: null, labelError: String(e?.message ?? e) };
  }
}

export async function dhlParcelLabel(cfg: DhlParcelConfig, shipmentId: string): Promise<{ base64: string; mime: string }> {
  const r = await soapCall(cfg, "getLabels", el("itemsToPrint", [el("item", [el("labelType", "BLP"), el("shipmentId", shipmentId)])]));
  const item = (r?.item as any[] | undefined)?.[0];
  const data = s(item?.labelData);
  if (!data) throw new DhlParcelError(`Nie udało się pobrać etykiety${item ? `: ${Object.values(item).map(s).filter(Boolean).join("; ")}` : "."}`);
  return { base64: data, mime: s(item?.labelMimeType) || "application/pdf" };
}

// Anulowanie przesyłki (tylko gdy nie zamówiono po nią kuriera).
export async function dhlParcelDelete(cfg: DhlParcelConfig, shipmentId: string): Promise<void> {
  const r = await soapCall(cfg, "deleteShipments", el("shipments", [el("item", shipmentId)]));
  const item = (r?.item as any[] | undefined)?.[0];
  if (String(item?.result).toLowerCase() !== "true") throw new DhlParcelError(`Nie udało się anulować przesyłki${item?.error ? `: ${s(item.error)}` : "."}`);
}

// Test połączenia bez uwierzytelniania: getVersion zwraca wersję usługi.
export async function dhlParcelVersion(cfg: DhlParcelConfig): Promise<string> {
  return s(await soapCall(cfg, "getVersion", "", false));
}
