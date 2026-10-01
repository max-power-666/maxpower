// Wspólna, serwerowa walidacja treści formularza przesyłki dla obu przewoźników (DHL Express i DHL Parcel). Nic nie ufa przeglądarce:
// każde pole jest sprawdzane i przycinane, a braki wracają jako jedna czytelna lista.

import { DHL_EU_COUNTRIES } from "./dhlExpress";
import { splitStreet } from "./shipping";

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);
const num = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

export type ParsedPackage = { weight: number; length: number; width: number; height: number };

// Dodatkowe paczki (druga, trzecia...) dla wieloelementowej przesyłki DHL Parcel — DHL24 wspiera to wprost w API
// (pieceList z wieloma pozycjami w JEDNEJ przesyłce, potwierdzone w dokumentacji createShipments), a nieobsługiwaną
// kombinację produkt/liczba paczek sam odrzuci czytelnym błędem przy nadaniu, więc nie zgadujemy tu żadnego limitu
// ani nie ograniczamy wyboru produktu. Pierwsza paczka to nadal "package" z parseShipmentBody (waga/wymiary +
// wspólny opis zawartości dla całej przesyłki, jeden na wszystkie sztuki) — ta lista to TYLKO kolejne sztuki.
// DHL Express tego nie używa (multi-piece nie dotyczy tej integracji).
export function parseExtraPackages(raw: unknown): { ok: true; value: ParsedPackage[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Nieprawidłowy format dodatkowych paczek." };
  const out: ParsedPackage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] ?? {};
    const weight = num(p.weight, 0.1, 70);
    const length = num(p.length, 1, 300);
    const width = num(p.width, 1, 300);
    const height = num(p.height, 1, 300);
    if (weight === null || length === null || width === null || height === null) {
      return { ok: false, error: `Paczka ${i + 2}: uzupełnij wagę (0,1–70 kg) i wymiary.` };
    }
    out.push({ weight, length, width, height });
  }
  return { ok: true, value: out };
}

export type QuotedCharge = { currencyType: string; priceCurrency: string; price: number };

// Cena z WYCENY (krok tuż przed kliknięciem "Nadaj przesyłkę") — jedyne miejsce, gdzie ta cena w ogóle jest znana
// (01.10.2026, zgłoszenie właściciela: koszt wysyłki nigdzie się nie zapisywał). Sprawdzone na żywych danych:
// DHL Express zwraca puste `shipmentCharges` przy tworzeniu przesyłki, a DHL Parcel (DHL24) w ogóle nie ma pola
// z ceną w odpowiedzi createShipments — więc trzeba przekazać cenę z przeglądarki (tam, gdzie wycena już się
// odbyła) i zapisać JĄ, zamiast ufać (pustej) odpowiedzi przewoźnika. `billing`/`local` to DhlMoney ({price,
// currency}) — ten sam, ujednolicony kształt dla obu przewoźników po stronie ShippingView.tsx (QuoteRow).
export function parseQuotedCharges(billing: unknown, local: unknown): QuotedCharge[] {
  const out: QuotedCharge[] = [];
  const b = billing as { price?: unknown; currency?: unknown } | null;
  const l = local as { price?: unknown; currency?: unknown } | null;
  if (b && Number.isFinite(Number(b.price)) && typeof b.currency === "string") {
    out.push({ currencyType: "BILLC", priceCurrency: b.currency, price: Number(b.price) });
  }
  if (l && Number.isFinite(Number(l.price)) && typeof l.currency === "string") {
    out.push({ currencyType: "PULCL", priceCurrency: l.currency, price: Number(l.price) });
  }
  return out;
}

export type ParsedShipment = {
  receiver: { company?: string; name: string; street: string; houseNumber: string; apartment?: string; postalCode: string; city: string; countryCode: string; phone: string; email?: string };
  pack: { weight: number; length: number; width: number; height: number; description: string; template: string | null };
  plannedDate: string;
  reference?: string;
  order: { marketplace: string; externalId: string } | null;
  requestId: string;
};

export function parseShipmentBody(b: any): { ok: true; value: ParsedShipment } | { ok: false; error: string } {
  const requestId = typeof b?.clientRequestId === "string" && /^[0-9a-f-]{36}$/i.test(b.clientRequestId) ? b.clientRequestId : null;
  if (!requestId) return { ok: false, error: "Brak identyfikatora żądania." };
  const r = b?.receiver ?? {};
  const country = typeof r.countryCode === "string" ? r.countryCode.trim().toUpperCase() : "";
  const p = b?.package ?? {};
  const plannedDate = typeof b?.plannedDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.plannedDate) ? b.plannedDate : null;
  const parsed = {
    company: str(r.company, 100) ?? undefined,
    name: str(r.name, 100),
    street: str(r.street, 100),
    houseNumber: str(r.houseNumber, 20),
    apartment: str(r.apartment, 20) ?? undefined,
    postalCode: str(r.postalCode, 12),
    city: str(r.city, 45),
    countryCode: DHL_EU_COUNTRIES.includes(country) ? country : null,
    phone: str(r.phone, 40),
    email: str(r.email, 70) ?? undefined,
  };
  const pack = { weight: num(p.weight, 0.1, 70), length: num(p.length, 1, 300), width: num(p.width, 1, 300), height: num(p.height, 1, 300), description: str(p.description, 70) };

  // Ulica i numer: jeśli numeru nie podano osobno, próbujemy go wyciągnąć z pola ulicy ("Hauptstr. 5").
  let street = parsed.street;
  let houseNumber = parsed.houseNumber;
  if (street && !houseNumber) {
    const sp = splitStreet(street);
    street = sp.street;
    houseNumber = sp.houseNumber || null;
  }

  const missing: string[] = [];
  if (!parsed.name) missing.push("imię i nazwisko odbiorcy");
  if (!street) missing.push("ulica");
  if (!houseNumber) missing.push("numer domu");
  if (!parsed.postalCode) missing.push("kod pocztowy");
  if (!parsed.city) missing.push("miasto");
  if (!parsed.countryCode) missing.push("kraj (tylko UE)");
  if (!parsed.phone) missing.push("telefon odbiorcy");
  if (pack.weight === null) missing.push("waga (0,1–70 kg)");
  if (pack.length === null || pack.width === null || pack.height === null) missing.push("wymiary");
  if (!pack.description) missing.push("opis zawartości");
  if (!plannedDate) missing.push("data nadania");
  if (missing.length > 0) return { ok: false, error: `Uzupełnij: ${missing.join(", ")}.` };

  const order = b?.order && typeof b.order.marketplace === "string" && typeof b.order.externalId === "string" ? { marketplace: b.order.marketplace, externalId: b.order.externalId } : null;
  return {
    ok: true,
    value: {
      receiver: { company: parsed.company, name: parsed.name!, street: street!, houseNumber: houseNumber!, apartment: parsed.apartment, postalCode: parsed.postalCode!, city: parsed.city!, countryCode: parsed.countryCode!, phone: parsed.phone!, email: parsed.email },
      pack: { weight: pack.weight!, length: pack.length!, width: pack.width!, height: pack.height!, description: pack.description!, template: str(p.template, 60) },
      plannedDate: plannedDate!,
      reference: str(b?.reference, 35) ?? undefined,
      order,
      requestId,
    },
  };
}
