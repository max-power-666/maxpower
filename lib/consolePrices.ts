// Katalog konsol -> "SKU i ceny" (10.10.2026, na prośbę właściciela — "ceny, sku w jednej kolumnie, podobnie jak plik xlsx"): jedna linia na SKU z ceną skupu
// wyliczoną z danych Biddera (cena max) i sugerowaną ceną sprzedaży. Wzór ceny skupu jest ten sam co kolumna "Cena PLN" w Bidderze (`bidderPricePln`):
// (cena max + 10% + 16,90 €) × bieżący kurs EUR z NBP. Sugerowana cena = cena skupu × (1 + narzut).
import { bidderPricePln } from "@/lib/bidderPln";

export const CONSOLE_MARKUP_DEFAULT = 0.5; // narzut na cenę sprzedaży (właściciel: 50%); w widoku do zmiany lokalnie
export const NOT_BOUGHT_MAX_EUR = 10; // w Bidderze cena max 0 € albo 10 € = "nie skupujemy" (10 € to cena techniczna na czas przebiegu)

export type CatalogRowLite = {
  id: number;
  position: number;
  name: string;
  sku_satisfactory: string | null; // klasa C
  sku_good: string | null; // klasa B
  sku_very_good: string | null; // klasa A
};
export type BidderSkuLite = { sku: string; max_price: number | null; ignored: boolean | null };

export type ConsolePriceRow = {
  key: string;
  sku: string;
  name: string;
  cls: "A" | "B" | "C";
  bidderSku: string | null;
  maxEur: number | null; // cena max z Biddera, gdy SKU jest skupowane (> 10 €)
  buyPln: number | null; // cena skupu
  suggestedPln: number | null; // sugerowana cena
  notes: string[];
};

// SKU z katalogu ma kolor (PS5S-1TB-WE-A-1M), a w Bidderze koloru nie ma (PS5S-1TB-A-1M); PS5 Pro w Bidderze nie ma też pojemności (PS5P-A-0M).
export function bidderKeysFor(sku: string): string[] {
  const p = sku.split("-");
  if (p.length < 5) return [sku];
  return [[...p.slice(0, 2), ...p.slice(3)].join("-"), [p[0], ...p.slice(3)].join("-")];
}

export function buildConsolePriceRows(rows: CatalogRowLite[], bidder: Map<string, BidderSkuLite>, eurRate: number | null, markup: number): ConsolePriceRow[] {
  const out: ConsolePriceRow[] = [];
  const classes: ["A" | "B" | "C", keyof CatalogRowLite][] = [["A", "sku_very_good"], ["B", "sku_good"], ["C", "sku_satisfactory"]];
  for (const r of rows) {
    for (const [cls, col] of classes) {
      const sku = r[col] as string | null;
      if (!sku) continue; // wiersz katalogu bez SKU dla tej klasy
      const key = bidderKeysFor(sku).find((k) => bidder.has(k)) ?? null;
      const b = key ? bidder.get(key)! : null;
      const notes: string[] = [];
      let maxEur: number | null = null;
      if (!b) notes.push("brak SKU w Bidderze");
      else {
        const mx = Number(b.max_price ?? 0);
        if (!mx || mx <= NOT_BOUGHT_MAX_EUR) notes.push(`cena max w Bidderze ${mx || 0} € — nie skupujemy, brak ceny`);
        else {
          maxEur = mx;
          if (b.ignored) notes.push("SKU ignorowane w Bidderze (cena max nieaktywna)");
        }
      }
      const buyPln = maxEur !== null ? bidderPricePln(maxEur, eurRate) : null;
      if (maxEur !== null && buyPln === null) notes.push("brak kursu EUR z NBP");
      out.push({
        key: `${r.id}-${cls}`,
        sku,
        name: r.name,
        cls,
        bidderSku: key,
        maxEur,
        buyPln,
        suggestedPln: buyPln !== null ? Math.round(buyPln * (1 + markup) * 100) / 100 : null,
        notes,
      });
    }
  }
  return out;
}
