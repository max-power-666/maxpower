// Faktury (zakładka Faktury, 01.10.2026): wystawianie faktur VAT w Fakturowni dla zamówień, które mają już
// numer seryjny/IMEI na KAŻDEJ pozycji i numer przesyłki na zamówieniu. Wyzwalacz jest RĘCZNY — jawny przycisk
// "Wystaw fakturę" na liście (świadoma decyzja właściciela: to prawdziwy dokument księgowo-podatkowy, trudny do
// cofnięcia — korekta to osobny dokument, nie usunięcie — więc nie generujemy ich automatycznie bez przeglądu).
// Ten sam FAKTUROWNIA_DOMAIN/FAKTUROWNIA_API_TOKEN co fakturownia/sync (zakładka Magazyn) — jedno konto.

import { rawBuyerAddress } from "./shipping";

// Stawka VAT jednolita dla wszystkich pozycji/kanałów (decyzja właściciela 01.10.2026 — bez logiki OSS per kraj
// nabywcy na razie). Stała, nie rozsiana po kodzie, żeby zmiana w przyszłości (np. na OSS) była w jednym miejscu.
export const INVOICE_VAT_RATE = 23;

export type InvoiceBuyerPrefill = {
  name: string;
  company: string;
  street: string;
  houseNumber: string;
  apartment: string;
  postalCode: string;
  city: string;
  countryCode: string;
  taxNo: string; // zawsze pusty z prefillu — żadne API marketplace'u nie przekazuje NIP-u, pracownik wpisuje ręcznie gdy nabywca poda firmę
};

const EMPTY_BUYER: InvoiceBuyerPrefill = {
  name: "", company: "", street: "", houseNumber: "", apartment: "", postalCode: "", city: "", countryCode: "", taxNo: "",
};

// Wstępne wypełnienie danych nabywcy z surowego zamówienia — bez filtra kraju (w odróżnieniu od buildShipPrefill
// w lib/shipping.ts, który filtruje do krajów DHL). Dla kanałów bez obsługi adresu (Erli, Allegro, Amazon — patrz
// komentarz w rawBuyerAddress) zwraca puste pola: pracownik uzupełnia je ręcznie w formularzu przed wystawieniem —
// to nie blokuje wystawienia faktury dla tych kanałów, tylko nie ma czym wstępnie wypełnić formularza.
export function buildInvoiceBuyerPrefill(marketplace: string, raw: any, customerEmail?: string | null): InvoiceBuyerPrefill {
  const p = rawBuyerAddress(marketplace, raw, customerEmail);
  if (!p) return EMPTY_BUYER;
  return {
    name: p.name,
    company: p.company,
    street: p.street,
    houseNumber: p.houseNumber,
    apartment: p.apartment,
    postalCode: p.postalCode,
    city: p.city,
    countryCode: p.countryCode,
    taxNo: "",
  };
}

export type InvoicePosition = {
  name: string;
  code: string | null; // SKU
  additionalInfo: string | null; // numer seryjny/IMEI
  totalPriceGross: number;
  currency: string;
};

export type FakturowniaConfig = { domain: string; token: string };

export function fakturowniaConfigFromEnv(): FakturowniaConfig | null {
  const domain = process.env.FAKTUROWNIA_DOMAIN;
  const token = process.env.FAKTUROWNIA_API_TOKEN;
  if (!domain || !token) return null;
  return { domain, token };
}

// Tworzy fakturę VAT w Fakturowni (POST /invoices.json). Sprzedawca = domyślny department konta (nie podajemy
// seller_*/department_id — jedno konto, jedna firma, Fakturownia bierze dane z ustawień konta). Nabywca inline
// (buyer_name/buyer_tax_no/...), bez client_id — nie zakładamy osobnej kartoteki klienta w Fakturowni dla
// każdego kupującego z marketplace'u, to by zaśmieciło listę kontrahentów. Pozycje: total_price_gross + tax
// (cena z sales_order_items.price jest ceną konsumencką, czyli brutto — sprawdzone przy dodawaniu kolumny "Cena"
// w Zamówieniach), code = SKU, additional_info = numer seryjny/IMEI (ten sam wzorzec co identyfikator przy
// zgłoszeniu numeru przesyłki do marketplace'u — lib/shipmentMarketplaceSync.ts).
// Nie testowane na żywym API (brak kluczy w środowisku asystenta) — zweryfikowane na atrapie `fetch` wg
// dokumentacji (app.fakturownia.pl/api, github.com/fakturownia/api).
export async function createFakturowniaInvoice(
  cfg: FakturowniaConfig,
  buyer: InvoiceBuyerPrefill,
  positions: InvoicePosition[],
  opts: { sellDate: string; issueDate: string; orderNumber: string }
): Promise<{ id: number; number: string; issueDate: string; sellDate: string; totalGross: number; currency: string }> {
  const currency = positions.find((p) => p.currency)?.currency || "PLN";
  const body = {
    api_token: cfg.token,
    invoice: {
      kind: "vat",
      issue_date: opts.issueDate,
      sell_date: opts.sellDate,
      payment_to: opts.issueDate,
      currency,
      oid: opts.orderNumber,
      buyer_name: buyer.company ? buyer.company : buyer.name,
      buyer_tax_no: buyer.taxNo || undefined,
      buyer_street: [buyer.street, buyer.houseNumber].filter(Boolean).join(" ") + (buyer.apartment ? `/${buyer.apartment}` : ""),
      buyer_post_code: buyer.postalCode,
      buyer_city: buyer.city,
      buyer_country: buyer.countryCode,
      positions: positions.map((p) => ({
        name: p.name,
        code: p.code || undefined,
        additional_info: p.additionalInfo || undefined,
        quantity: 1,
        tax: String(INVOICE_VAT_RATE),
        total_price_gross: p.totalPriceGross,
      })),
    },
  };

  const res = await fetch(`https://${cfg.domain}.fakturownia.pl/invoices.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && (data.message || data.error || JSON.stringify(data))) || `Fakturownia zwróciła błąd (${res.status})`;
    throw new Error(msg);
  }
  return {
    id: data.id,
    number: data.number,
    issueDate: data.issue_date,
    sellDate: data.sell_date,
    totalGross: Number(data.price_gross) || positions.reduce((s, p) => s + p.totalPriceGross, 0),
    currency: data.currency || currency,
  };
}

export const INVOICE_STATUSES = [
  { key: "wystawiono", label: "Wystawiono" },
  { key: "zaplacone", label: "Zapłacone" },
] as const;

export function invoiceStatusStyle(status: string): string {
  return status === "zaplacone" ? "bg-tealsoft text-teal" : "bg-ambersoft text-amber";
}
