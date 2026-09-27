// Wspólne dla zakładki Wysyłka i karty zamówienia: dane do wstępnego wypełnienia formularza przesyłki z zamówienia,
// domyślna data nadania. Osobno od lib/dhlExpress.ts, bo to logika interfejsu, a nie API przewoźnika.

import { DHL_EU_COUNTRIES } from "./dhlExpress";

export type ShipPrefill = {
  marketplace: string;
  externalId: string;
  name: string;
  company: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  phone: string;
  email: string;
};

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// Adres odbiorcy z surowego zamówienia. Zwraca null, gdy zamówienie nie nadaje się do przesyłki zagranicznej (brak adresu albo kraj
// spoza obsługiwanych, w tym Polska — krajowe zamówienia z Allegro i Erli realizujemy inaczej).
export function buildShipPrefill(marketplace: string, externalId: string, raw: any, customerEmail?: string | null): ShipPrefill | null {
  let p: Omit<ShipPrefill, "marketplace" | "externalId"> | null = null;
  if (marketplace === "backmarket") {
    const a = raw?.shipping_address;
    if (a) {
      p = {
        name: [clean(a.firstName), clean(a.lastName)].filter(Boolean).join(" "),
        company: clean(a.company),
        street: [clean(a.street), clean(a.street2)].filter(Boolean).join(", "),
        postalCode: clean(a.postalCode),
        city: clean(a.city),
        countryCode: clean(a.country).toUpperCase(),
        phone: clean(a.phoneNumber),
        email: clean(customerEmail),
      };
    }
  } else if (marketplace === "refurbed") {
    const a = raw?.shipping_address;
    if (a) {
      p = {
        name: [clean(a.first_name), clean(a.family_name)].filter(Boolean).join(" "),
        company: clean(a.company_name),
        street: [[clean(a.street_name), clean(a.house_no)].filter(Boolean).join(" "), clean(a.supplement)].filter(Boolean).join(", "),
        postalCode: clean(a.post_code),
        city: clean(a.town),
        countryCode: clean(a.country_code).toUpperCase(),
        phone: clean(a.phone_number),
        email: clean(customerEmail),
      };
    }
  }
  if (!p || !DHL_EU_COUNTRIES.includes(p.countryCode)) return null;
  return { marketplace, externalId, ...p };
}

// Domyślna data nadania: dziś, jeśli dzień roboczy i przed południem (czas lokalny), w przeciwnym razie najbliższy dzień roboczy.
export function defaultShippingDate(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const isWorkday = (x: Date) => x.getDay() !== 0 && x.getDay() !== 6;
  if (!(isWorkday(d) && now.getHours() < 12)) {
    do d.setDate(d.getDate() + 1);
    while (!isWorkday(d));
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Etykieta (base64) -> adres blob do otwarcia/druku w przeglądarce.
export function base64ToBlobUrl(base64: string, mime = "application/pdf"): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
