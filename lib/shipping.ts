// Wspólne dla zakładki Wysyłka i karty zamówienia: dane do wstępnego wypełnienia formularza przesyłki z zamówienia,
// domyślna data nadania. Osobno od lib/dhlExpress.ts, bo to logika interfejsu, a nie API przewoźnika.

import { DHL_EU_COUNTRIES } from "./dhlExpress";

export type ShipPrefill = {
  marketplace: string;
  externalId: string;
  name: string;
  company: string;
  street: string; // sama ulica (bez numeru domu)
  houseNumber: string;
  apartment: string; // numer lokalu / dodatek adresu
  postalCode: string;
  city: string;
  countryCode: string;
  phone: string;
  email: string;
};

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// Rozdziela "ulica numer" na ulicę i numer domu (DHL Parcel wymaga osobnych pól). Obsługuje numer na końcu ("Hauptstr. 5", "Rue X, 12b")
// i na początku ("12 Rue de la Paix"); gdy nie da się rozpoznać numeru, całość zostaje ulicą, a numer pusty (użytkownik uzupełnia w formularzu).
export function splitStreet(text: string): { street: string; houseNumber: string } {
  const t = clean(text);
  const trailing = /^(.*\D)[\s,]+(\d+[A-Za-z]?(?:[/-]\d+[A-Za-z]?)?)$/.exec(t);
  if (trailing) return { street: trailing[1].replace(/[\s,]+$/, ""), houseNumber: trailing[2] };
  const leading = /^(\d+[A-Za-z]?(?:[/-]\d+[A-Za-z]?)?)[\s,]+(\D.*)$/.exec(t);
  if (leading) return { street: leading[2], houseNumber: leading[1] };
  return { street: t, houseNumber: "" };
}

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
        ...splitStreet(clean(a.street)),
        apartment: clean(a.street2), // druga linia adresu Back Market (piętro, lokal) trafia do numeru lokalu
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
        // Refurbed podaje numer domu osobno; dodatek adresu ("3. OG") trafia do numeru lokalu.
        street: clean(a.street_name),
        houseNumber: clean(a.house_no),
        apartment: clean(a.supplement),
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
