// Towar -> Fakturownia (15.10.2026, na prośbę właściciela): półautomatyczne wysyłanie pozycji Towaru do magazynu Fakturowni jako PRODUKTU (dotąd wpisywanego ręcznie).
// CZYSTE funkcje (bez bazy i bez sieci) — używa ich app/api/fakturownia/push-goods. Odwzorowują sposób, w jaki produkty są wpisywane ręcznie i czytane przez synchronizację
// magazynu (app/api/fakturownia/sync): nazwa produktu = numer seryjny (też kod), opis = numer zamówienia Buyback (dla pozycji ze Skupu dokładnie numer, bo po nim
// dopasowujemy koszty Trade-in) albo numer faktury, kategoria wg nazwy, cena zakupu BRUTTO, stan 1.
// Pola zgodne z dokumentacją API Fakturowni (github.com/fakturownia/api, "Dodanie produktu"); NIE testowane na żywym koncie (token jest tylko na Vercelu).

export type GoodsForFakturownia = {
  id: number;
  kind: "vm_v23" | "trade_in";
  serial: string | null;
  name: string | null;
  order_no: string | null;
  invoice_no: string | null;
  category: string | null;
  vat: string | null;
  price_pln: number | string | null;
  fakturownia_product_id?: number | null;
};

export type FakturowniaProduct = {
  name: string;
  code: string;
  description: string;
  category_id?: number;
  purchase_price_net: string;
  purchase_price_gross: string;
  purchase_tax?: string;
  currency: "PLN";
  quantity_unit: "szt";
  service: "0";
  limited: "1";
  stock_level: "1";
};

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

// Towar V23 ma cenę zakupu w "Cena PLN" jako NETTO (VAT odliczalny); Fakturownia przechowuje cenę zakupu BRUTTO, więc doliczamy 23%.
export function purchaseGrossFromGoods(g: Pick<GoodsForFakturownia, "vat" | "price_pln">): number | null {
  const p = g.price_pln === null || g.price_pln === undefined || g.price_pln === "" ? null : Number(g.price_pln);
  if (p === null || !Number.isFinite(p) || p <= 0) return null;
  return g.vat === "V23" ? Math.round(p * 1.23 * 100) / 100 : p;
}

export function fakturowniaDescription(g: Pick<GoodsForFakturownia, "kind" | "name" | "order_no" | "invoice_no">): string {
  const ref = (g.order_no || "").trim() || (g.invoice_no || "").trim();
  if (g.kind === "trade_in") return (g.order_no || "").trim(); // Skup: dokładnie numer zamówienia Buyback (po nim liczymy koszty Trade-in)
  const nm = (g.name || "").trim();
  return [ref, nm].filter(Boolean).join(" — ");
}

export function buildFakturowniaProduct(g: GoodsForFakturownia, categoryId: number | null): FakturowniaProduct | null {
  const serial = (g.serial || "").trim();
  const gross = purchaseGrossFromGoods(g);
  if (!serial || gross === null) return null;
  return {
    name: serial,
    code: serial,
    description: fakturowniaDescription(g),
    ...(categoryId !== null ? { category_id: categoryId } : {}),
    // jak przy wpisywaniu ręcznym (15.10.2026, zrzut formularza): bez stawki VAT cena zakupu netto = brutto; V23 — netto z Towaru, brutto ×1,23 i stawka 23
    purchase_price_net: money(g.vat === "V23" ? gross / 1.23 : gross),
    purchase_price_gross: money(gross),
    ...(g.vat === "V23" ? { purchase_tax: "23" } : {}),
    currency: "PLN",
    quantity_unit: "szt",
    service: "0",
    limited: "1",
    stock_level: "1",
  };
}

// Klucze, pod którymi numer seryjny może występować w nazwie produktu w Fakturowni — te same cztery co w widoku goods_register_available (pełna nazwa, pierwszy człon,
// numer w nawiasie na końcu, końcowy człon), małe litery, bez zer wiodących.
export function nameKeys(name: string | null | undefined): string[] {
  const n = (name || "").trim();
  if (!n) return [];
  const lower = n.toLowerCase();
  const first = lower.replace(/\s+/g, " ").split(" ")[0];
  const paren = (lower.match(/\(([a-z0-9]+)\)\s*$/) || [])[1];
  const last = (lower.match(/([a-z0-9]+)$/) || [])[1];
  // pełna nazwa zawsze; człony pochodne tylko gdy wyglądają na numer (>= 5 znaków), żeby krótki końcowy człon ("D" z "IPX-256-D") nie blokował wysyłki fałszywym "już jest"
  const strip = (k: string) => k.replace(/^0+/, "");
  const derived = [first, paren, last].filter((k): k is string => !!k).map(strip).filter((k) => k.length >= 5);
  return Array.from(new Set([strip(lower), ...derived].filter((k) => k !== "")));
}
export const serialKey = (serial: string | null | undefined) => (serial || "").trim().toLowerCase().replace(/^0+/, "");
