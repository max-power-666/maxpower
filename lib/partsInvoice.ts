// Import części z faktury zakupu (Serwis -> Części, 06.10.2026): plik (PDF/zdjęcie/CSV) -> model Claude czyta pozycje jako dane
// strukturalne (wymuszone narzędzie `report_invoice`) -> pracownik poprawia/akceptuje listę -> zapis do service_parts.
// Czysta logika bez Next.js, z wstrzykiwanym `fetch`, żeby dało się ją testować na atrapie (bez klucza Anthropic).

export type ParsedItem = {
  name: string;
  partCode: string | null;
  quantity: number;
  currency: string; // kod ISO 4217
  priceNet: number | null; // cena JEDNOSTKOWA netto w walucie faktury
  note: string | null; // np. "cena przeliczona z brutto"
};
export type ParsedInvoice = {
  supplier: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null; // YYYY-MM-DD
  currency: string;
  items: ParsedItem[];
  notes: string | null;
};

export const INVOICE_MAX_BYTES = 3_500_000; // body route'a na Vercelu ma limit 4,5 MB, base64 powiększa plik o 1/3 — a my wysyłamy multipart
export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
export const TEXT_EXTS = ["csv", "txt", "xml", "json", "tsv"];

export const REPORT_INVOICE_TOOL = {
  name: "report_invoice",
  description: "Zgłasza odczytane z faktury/zamówienia zakupu dane nagłówka i listę pozycji (towarów).",
  input_schema: {
    type: "object",
    properties: {
      supplier: { type: ["string", "null"], description: "Sprzedawca/dostawca (nazwa firmy lub sklepu) — NIE nabywca." },
      invoice_no: { type: ["string", "null"], description: "Numer faktury (lub zamówienia, gdy to nie faktura)." },
      invoice_date: { type: ["string", "null"], description: "Data wystawienia, format YYYY-MM-DD." },
      currency: { type: "string", description: "Waluta dokumentu, kod ISO 4217 (PLN, EUR, USD...)." },
      items: {
        type: "array",
        description: "Pozycje towarowe w kolejności z dokumentu. Bez kosztów dostawy, opłat, rabatów globalnych i sum.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Nazwa towaru dokładnie jak na dokumencie (można skrócić zbędne dopiski)." },
            part_code: { type: ["string", "null"], description: "Kod/SKU/symbol/indeks/EAN towaru, jeśli jest na dokumencie." },
            quantity: { type: "number", description: "Ilość sztuk (liczba całkowita >= 1)." },
            unit_price_net: { type: ["number", "null"], description: "Cena JEDNOSTKOWA NETTO (bez VAT) za 1 sztukę, w walucie dokumentu." },
            note: { type: ["string", "null"], description: "Krótka uwaga tylko gdy coś jest niepewne lub przeliczone (np. 'cena z brutto 23%')." },
          },
          required: ["name", "quantity", "unit_price_net"],
        },
      },
      notes: { type: ["string", "null"], description: "Uwagi o dokumencie, np. pominięte koszty dostawy, nieczytelne fragmenty." },
    },
    required: ["currency", "items"],
  },
};

export const INVOICE_SYSTEM_PROMPT =
  "Jesteś narzędziem do odczytu faktur zakupu części do napraw elektroniki (konsole, smartfony, laptopy). " +
  "Przeczytaj załączony dokument i ZAWSZE zgłoś wynik, wywołując narzędzie report_invoice (nie odpowiadaj tekstem). Zasady: " +
  "(1) tylko pozycje towarowe — pomiń dostawę/transport, opłaty, rabaty ogólne, sumy i podsumowania VAT; " +
  "(2) unit_price_net to cena JEDNOSTKOWA NETTO za 1 sztukę; gdy dokument podaje tylko ceny brutto, a znana jest stawka VAT, przelicz na netto (brutto / (1 + stawka)) i zaznacz to w note; " +
  "gdy faktura podaje wartość pozycji (nie cenę jednostkową), podziel ją przez ilość; " +
  "(3) nie zgaduj — gdy ceny albo kodu nie widać, wpisz null; (4) ilość jako liczba całkowita; (5) sprzedawca to wystawca dokumentu, nie nabywca; " +
  "(6) daty w formacie YYYY-MM-DD; (7) nazwy zostaw w języku dokumentu.";

type Block = { type: string; [k: string]: unknown };

export function buildInvoiceContent(file: { name: string; mediaType: string; base64?: string; text?: string }): Block[] {
  const intro: Block = { type: "text", text: `Plik: ${file.name}. Odczytaj pozycje tego dokumentu zakupu.` };
  if (file.text !== undefined) return [intro, { type: "text", text: `Zawartość pliku:\n${file.text}` }];
  if (file.mediaType === "application/pdf") return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } }, intro];
  return [{ type: "image", source: { type: "base64", media_type: file.mediaType, data: file.base64 } }, intro];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/\s/g, "").replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown, max = 200): string | null => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  return s ? s.slice(0, max) : null;
};
const isoDate = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
};

// Zamienia surowe dane z narzędzia na bezpieczny kształt (liczby, długości, waluta) — model bywa nieprecyzyjny.
export function normalizeInvoice(raw: any): ParsedInvoice {
  const currencyRaw = str(raw?.currency, 3)?.toUpperCase();
  const currency = currencyRaw && /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : "PLN";
  const items: ParsedItem[] = [];
  for (const it of Array.isArray(raw?.items) ? raw.items : []) {
    const name = str(it?.name);
    if (!name) continue;
    const q = Math.round(num(it?.quantity) ?? 1);
    const price = num(it?.unit_price_net);
    items.push({
      name,
      partCode: str(it?.part_code, 80),
      quantity: Math.min(100, Math.max(1, q)),
      currency,
      priceNet: price !== null && price >= 0 ? Math.round(price * 10000) / 10000 : null,
      note: str(it?.note, 120),
    });
  }
  return { supplier: str(raw?.supplier), invoiceNo: str(raw?.invoice_no, 80), invoiceDate: isoDate(raw?.invoice_date), currency, items, notes: str(raw?.notes, 300) };
}

export async function parseInvoiceWithClaude(opts: {
  apiKey: string;
  model: string;
  file: { name: string; mediaType: string; base64?: string; text?: string };
  fetchImpl?: typeof fetch;
}): Promise<{ invoice: ParsedInvoice; usage: { input: number; output: number } }> {
  const f = opts.fetchImpl ?? fetch;
  const usage = { input: 0, output: 0 };
  const convo: { role: "user" | "assistant"; content: string | Block[] }[] = [{ role: "user", content: buildInvoiceContent(opts.file) }];
  // Nowsze modele nie przyjmują wymuszonego tool_choice {type: "tool"} (błąd 400 "type tool and any are not supported for this model"),
  // więc zostawiamy tryb auto — prompt każe zawsze zgłosić wynik narzędziem, a gdy model mimo to odpowie tekstem, prosimy raz jeszcze.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await f("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: opts.model, max_tokens: 8000, system: INVOICE_SYSTEM_PROMPT, tools: [REPORT_INVOICE_TOOL], messages: convo }),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || `Błąd API Anthropic (${res.status}).`);
    usage.input += Number(data?.usage?.input_tokens) || 0;
    usage.output += Number(data?.usage?.output_tokens) || 0;
    const content: Block[] = Array.isArray(data?.content) ? data.content : [];
    const tu: any = content.find((b: any) => b.type === "tool_use" && b.name === REPORT_INVOICE_TOOL.name);
    if (tu) {
      if (data?.stop_reason === "max_tokens") throw new Error("Dokument ma zbyt wiele pozycji, żeby odczytać go naraz — podziel plik na mniejsze części.");
      return { invoice: normalizeInvoice(tu.input), usage };
    }
    if (data?.stop_reason === "max_tokens") throw new Error("Dokument ma zbyt wiele pozycji, żeby odczytać go naraz — podziel plik na mniejsze części.");
    convo.push({ role: "assistant", content });
    convo.push({ role: "user", content: "Zgłoś wynik narzędziem report_invoice (tylko narzędziem, bez komentarza)." });
  }
  throw new Error("Model nie zwrócił odczytu faktury — spróbuj ponownie albo dodaj pozycje ręcznie.");
}

// ---- Zapis ----
export type ImportItemInput = { name: string; supplierCode: string | null; quantity: number; currency: string; priceNet: number | null; nbpRate: number | null; pricePln: number | null };
export type ImportBody = { supplier: string | null; invoiceNo: string | null; invoiceDate: string | null; receivedAt: string | null; items: ImportItemInput[] };
export const MAX_IMPORT_ITEMS = 200;
export const MAX_IMPORT_ROWS = 500;

// Waliduje to, co przysłała przeglądarka (serwer nie ufa UI). Zwraca błąd po polsku albo oczyszczone dane.
export function validateImport(b: any): { error: string } | { data: ImportBody } {
  const items = Array.isArray(b?.items) ? b.items : [];
  if (items.length === 0) return { error: "Brak pozycji do zapisania." };
  if (items.length > MAX_IMPORT_ITEMS) return { error: `Za dużo pozycji naraz (max ${MAX_IMPORT_ITEMS}).` };
  const out: ImportItemInput[] = [];
  let rows = 0;
  for (const [i, it] of items.entries()) {
    const name = str(it?.name);
    if (!name) return { error: `Pozycja ${i + 1}: brak nazwy części.` };
    const quantity = Math.round(num(it?.quantity) ?? NaN);
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100) return { error: `Pozycja ${i + 1}: ilość musi być liczbą od 1 do 100.` };
    const currency = (str(it?.currency, 3) || "PLN").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return { error: `Pozycja ${i + 1}: nieprawidłowa waluta.` };
    const priceNet = it?.priceNet === null || it?.priceNet === "" || it?.priceNet === undefined ? null : num(it.priceNet);
    const nbpRate = it?.nbpRate === null || it?.nbpRate === "" || it?.nbpRate === undefined ? null : num(it.nbpRate);
    let pricePln = it?.pricePln === null || it?.pricePln === "" || it?.pricePln === undefined ? null : num(it.pricePln);
    if ((it?.priceNet ?? null) !== null && it.priceNet !== "" && (priceNet === null || priceNet < 0)) return { error: `Pozycja ${i + 1}: nieprawidłowa cena netto.` };
    if (nbpRate !== null && nbpRate <= 0) return { error: `Pozycja ${i + 1}: kurs musi być dodatni.` };
    if (pricePln !== null && pricePln < 0) return { error: `Pozycja ${i + 1}: nieprawidłowa cena w PLN.` };
    if (pricePln === null && priceNet !== null && currency === "PLN") pricePln = priceNet; // PLN: cena w złotówkach to ta sama liczba
    rows += quantity;
    out.push({ name, supplierCode: str(it?.supplierCode, 80), quantity, currency, priceNet, nbpRate: currency === "PLN" ? 1 : nbpRate, pricePln });
  }
  if (rows > MAX_IMPORT_ROWS) return { error: `Za dużo sztuk naraz (${rows}, max ${MAX_IMPORT_ROWS}).` };
  return { data: { supplier: str(b?.supplier), invoiceNo: str(b?.invoiceNo, 80), invoiceDate: isoDate(b?.invoiceDate), receivedAt: isoDate(b?.receivedAt), items: out } };
}

// Jedna sztuka = jeden wiersz (jak w arkuszu); w partii o ilości > 1 pierwszy wiersz niesie batch_qty (informacja, nie licznik).
// part_code NIE jest tu ustawiany: każda sztuka dostaje własny, unikalny kod z naszej serii (10xxxxxx) nadawany w bazie przez
// service_parts_import (atomowo, kolejno). Kod z faktury (symbol dostawcy) trafia do uwag: "Kod dostawcy: ...".
export function expandToRows(d: ImportBody, createdByEmail: string | null) {
  const rows: Record<string, unknown>[] = [];
  for (const it of d.items) {
    for (let k = 0; k < it.quantity; k++) {
      rows.push({
        received_at: d.receivedAt,
        invoice_no: d.invoiceNo,
        invoice_date: d.invoiceDate,
        supplier: d.supplier,
        status: "Dotarło",
        name: it.name,
        notes: it.supplierCode ? `Kod dostawcy: ${it.supplierCode}` : null,
        batch_qty: k === 0 && it.quantity > 1 ? it.quantity : null,
        price_net: it.priceNet,
        currency: it.currency,
        nbp_rate: it.nbpRate,
        price_pln: it.pricePln,
        source: "invoice",
        created_by_email: createdByEmail,
      });
    }
  }
  return rows;
}

// Kody nadane zapisanym pozycjom: baza zwraca listę kodów w kolejności wierszy (pozycja 1 x ilość, pozycja 2 x ilość...).
export function codeRanges(items: { name: string; quantity: number }[], codes: string[]): { name: string; quantity: number; first: string; last: string }[] {
  const out: { name: string; quantity: number; first: string; last: string }[] = [];
  let i = 0;
  for (const it of items) {
    out.push({ name: it.name, quantity: it.quantity, first: codes[i], last: codes[i + it.quantity - 1] });
    i += it.quantity;
  }
  return out;
}
