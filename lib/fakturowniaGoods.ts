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
  sku?: string | null; // SKU rozstrzygnięte po stronie serwera (patrz resolveSku) — trafia do pola "Kod produktu"
};

export type FakturowniaProduct = {
  name: string;
  code?: string; // SKU (puste, gdy SKU nie da się ustalić)
  description: string;
  category_id?: number;
  purchase_price_net: string;
  purchase_price_gross?: string; // tylko dla VM (bez VAT netto = brutto); dla V23 brutto liczy Fakturownia ze stawki 23
  purchase_tax?: string;
  currency: "PLN";
  quantity_unit: "szt";
  service: "0";
  limited: "1";
  stock_level: "1";
};

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

// Cena zakupu: wysyłamy NETTO (decyzja właściciela 15.10.2026). Towar V23 ma w "Cena PLN" cenę NETTO (VAT odliczalny) — idzie 1:1 jako cena zakupu netto ze stawką 23, a brutto
// liczy Fakturownia; w VM (bez VAT) cena netto = brutto = "Cena PLN".
export function purchaseNetFromGoods(g: Pick<GoodsForFakturownia, "price_pln">): number | null {
  const p = g.price_pln === null || g.price_pln === undefined || g.price_pln === "" ? null : Number(g.price_pln);
  if (p === null || !Number.isFinite(p) || p <= 0) return null;
  return Math.round(p * 100) / 100;
}
// Brutto do lokalnego cache (podgląd "Dostępny" przed synchronizacją): V23 netto × 1,23, VM = netto.
export function purchaseGrossForCache(p: Pick<FakturowniaProduct, "purchase_price_net" | "purchase_tax" | "purchase_price_gross">): number {
  if (p.purchase_price_gross !== undefined) return Number(p.purchase_price_gross);
  return Math.round(Number(p.purchase_price_net) * (1 + Number(p.purchase_tax || 0) / 100) * 100) / 100;
}

export function fakturowniaDescription(g: Pick<GoodsForFakturownia, "kind" | "name" | "order_no" | "invoice_no" | "sku">): string {
  const ref = (g.order_no || "").trim() || (g.invoice_no || "").trim();
  if (g.kind === "trade_in") return (g.order_no || "").trim(); // Skup: dokładnie numer zamówienia Buyback (po nim liczymy koszty Trade-in)
  const nm = (g.name || "").trim();
  return [ref, nm && nm !== (g.sku || "").trim() ? nm : ""].filter(Boolean).join(" — "); // nazwa, tylko gdy nie jest samym SKU (SKU idzie do kodu produktu)
}

// Czy tekst wygląda jak SKU (kod bez spacji z myślnikami, np. SGW9C-44-BK-A, albo aparat "237387 (3/5)") — w Towarze pole "Nazwa" bywa SKU albo opisową nazwą.
export const looksLikeSku = (v: string | null | undefined): boolean => {
  const t = (v || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9./]*(-[A-Za-z0-9./]+)+$/.test(t) || /^\d{3,}\s*\(\d\/\d\)$/.test(t);
};

export function buildFakturowniaProduct(g: GoodsForFakturownia, categoryId: number | null): FakturowniaProduct | null {
  const serial = (g.serial || "").trim();
  const net = purchaseNetFromGoods(g);
  if (!serial || net === null) return null;
  return {
    name: serial, // Nazwa = numer seryjny
    ...(g.sku && g.sku.trim() ? { code: g.sku.trim() } : {}), // Kod produktu = SKU
    description: fakturowniaDescription(g),
    ...(categoryId !== null ? { category_id: categoryId } : {}),
    // jak przy wpisywaniu ręcznym (zrzut formularza): VM — bez stawki VAT, cena zakupu netto = brutto; V23 — netto ze stawką 23 (brutto liczy Fakturownia)
    purchase_price_net: money(net),
    ...(g.vat === "V23" ? { purchase_tax: "23" } : { purchase_price_gross: money(net) }),
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
