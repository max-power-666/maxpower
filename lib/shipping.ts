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

// Adres odbiorcy z surowego zamówienia, BEZ filtra kraju — wspólna część dla buildShipPrefill (wysyłka, filtruje
// do DHL_EU_COUNTRIES) i buildInvoiceBuyerPrefill (lib/invoices.ts — faktura ma obowiązywać niezależnie od tego,
// czy danym kanałem/krajem w ogóle wysyłamy DHL-em). Zwraca null, gdy brak adresu albo marketplace inny niż
// backmarket/refurbed/octopia (Erli/Allegro/Amazon — patrz komentarz niżej przy Amazon).
export function rawBuyerAddress(marketplace: string, raw: any, customerEmail?: string | null): Omit<ShipPrefill, "marketplace" | "externalId"> | null {
  let p: Omit<ShipPrefill, "marketplace" | "externalId"> | null = null;
  if (marketplace === "backmarket") {
    const a = raw?.shipping_address;
    if (a) {
      // Pola Back Market API to snake_case (first_name/last_name/postal_code/phone), NIE camelCase — wcześniej
      // była tu literówka (firstName/lastName/postalCode/phoneNumber), przez którą imię, kod pocztowy i telefon
      // zawsze wychodziły puste, dla każdego zamówienia Back Market, niezależnie od jego stanu.
      p = {
        name: [clean(a.first_name), clean(a.last_name)].filter(Boolean).join(" "),
        company: clean(a.company),
        ...splitStreet(clean(a.street)),
        apartment: clean(a.street2), // druga linia adresu Back Market (piętro, lokal) trafia do numeru lokalu
        postalCode: clean(a.postal_code),
        city: clean(a.city),
        countryCode: clean(a.country).toUpperCase(),
        phone: clean(a.phone),
        // Back Market nie ma osobnej kolumny z e-mailem klienta (w odróżnieniu od refurbed) — ale shipping_address.email
        // to działający adres przekaźnikowy Back Marketu (np. shipping_12345_86991986@eu.perso-email.com, nie prawdziwy
        // e-mail kupującego — dla prywatności), który wystarczy do awizacji przesyłki. customerEmail zawsze przychodzi
        // tu jako null dla tego kanału (SalesOrderCard.tsx), więc tylko zapasowo, gdyby się to kiedyś zmieniło.
        email: clean(a.email) || clean(customerEmail),
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
  } else if (marketplace === "octopia") {
    // Octopia: adres jest tylko PER-POZYCJA (lines[].shippingAddress), nie na poziomie zamówienia — ten sam wzorzec
    // co przy wyciąganiu country_code (mapOctopiaToSales) — bierzemy pierwszą pozycję. Pola sprawdzone na żywych
    // danych (firstName/lastName/addressLine1/addressLine2/postalCode/city/countryCode/phone/email) — kompletne,
    // w odróżnieniu od Amazon (patrz niżej), więc to zwykły brakujący branch, nie ograniczenie API. companyName nie
    // pojawiło się w sprawdzonych zamówieniach (same osoby prywatne), ale to samo pole istnieje w billingAddress
    // tego samego API, więc prawdopodobnie działa też tu — dla zamówień bez firmy po prostu zostanie puste.
    const a = (raw?.lines as any[])?.[0]?.shippingAddress;
    if (a) {
      p = {
        name: [clean(a.firstName), clean(a.lastName)].filter(Boolean).join(" "),
        company: clean(a.companyName),
        ...splitStreet(clean(a.addressLine1)),
        apartment: clean(a.addressLine2),
        postalCode: clean(a.postalCode),
        city: clean(a.city),
        countryCode: clean(a.countryCode).toUpperCase(),
        phone: clean(a.phone),
        email: clean(a.email) || clean(customerEmail),
      };
    }
  }
  // Amazon NIE ma tu branchu celowo: SP-API zwraca ShippingAddress bez imienia/nazwiska, linii adresu i telefonu —
  // tylko city/postalCode/countryCode — niezależnie od stanu zamówienia (sprawdzone na 30 zamówieniach, w tym
  // "Shipped"). To nie błąd mapowania: nasza aplikacja Amazon ma rolę "Inventory and Order Tracking" bez dostępu do
  // danych PII (Restricted Data Token) — pełny adres wymaga osobnego zatwierdzenia w Seller Central i osobnego
  // wywołania (POST /tokens/.../restrictedDataToken + GET /orders/v0/orders/{id}/address) — do zrobienia po stronie
  // właściciela, zanim to ma sens kodować. Erli i Allegro też bez branchu na razie — do zrobienia, gdy będą
  // potrzebne (dziś mają własne, osobne ścieżki wysyłki, które adresu z tej funkcji nie potrzebują).
  return p;
}

// Adres odbiorcy z surowego zamówienia, filtrowany do krajów, gdzie wysyłamy DHL-em (DHL_EU_COUNTRIES — obejmuje
// Polskę). Zwraca null, gdy brak adresu albo kraj spoza listy.
export function buildShipPrefill(marketplace: string, externalId: string, raw: any, customerEmail?: string | null): ShipPrefill | null {
  const p = rawBuyerAddress(marketplace, raw, customerEmail);
  if (!p || !DHL_EU_COUNTRIES.includes(p.countryCode)) return null;
  return { marketplace, externalId, ...p };
}

// shipments.charges ma kształt DHL (tablica) tylko dla dhl_express/dhl_parcel/ups — dla erli_paczkomat to co innego
// (id paczki Erli, potrzebny do anulowania), więc nigdy nie zakładamy tablicy bez sprawdzenia. Współdzielone
// między ShippingView.tsx (lista "Nadane przesyłki") i SalesOrderCard.tsx (pole "Koszt wysyłki", 01.10.2026).
export function dhlCharge(charges: unknown): { currencyType: string; priceCurrency: string; price: number } | null {
  return Array.isArray(charges) ? charges.find((c: any) => c?.currencyType === "BILLC") ?? charges[0] ?? null : null;
}

// getPrice zwraca cenę BAZOWĄ i dopłatę paliwową jako PROCENT (nie kwotę) — cena do zapłaty to baza + procent od bazy
// (jak "Cena netto" w panelu DHL24). Jedno miejsce dla formularza wyceny i dopisywania brakującej ceny.
export function parcelQuoteTotal(base: number, fuelPct: number | null): number {
  const surcharge = fuelPct ? Math.round(base * fuelPct) / 100 : 0;
  return Math.round((base + surcharge) * 100) / 100;
}

// getPrice dla jednego produktu (EK albo PI). Gdy produkt nie jest dostępny na trasie, DHL zwraca błąd — oddajemy go jako wynik
// (ok: false), żeby w tabeli było widać, że produkt jest niedostępny i dlaczego, zamiast przerywać całą wycenę.
// Formularz przesyłki z zamówienia RĘCZNEGO (Swopify i inne kanały bez integracji): dane z sales_orders.manual_details
// (adres dostawy z maila, już z rozdzieloną ulicą i numerem domu; telefon i e-mail z danych klienta).
export function buildManualShipPrefill(marketplace: string, externalId: string, d: any): ShipPrefill | null {
  const a = d?.shipping;
  if (!a) return null;
  return {
    marketplace,
    externalId,
    name: clean(a.name) || clean(d?.customer?.name),
    company: clean(a.company),
    street: clean(a.street),
    houseNumber: clean(a.houseNumber),
    apartment: clean(a.apartment),
    postalCode: clean(a.postalCode),
    city: clean(a.city),
    countryCode: clean(a.countryCode).toUpperCase(),
    phone: clean(d?.customer?.phone),
    email: clean(d?.customer?.email),
  };
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
