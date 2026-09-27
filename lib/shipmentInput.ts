// Wspólna, serwerowa walidacja treści formularza przesyłki dla obu przewoźników (DHL Express i DHL Parcel). Nic nie ufa przeglądarce:
// każde pole jest sprawdzane i przycinane, a braki wracają jako jedna czytelna lista.

import { DHL_EU_COUNTRIES } from "./dhlExpress";
import { splitStreet } from "./shipping";

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);
const num = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

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
