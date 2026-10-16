// Sugerowana cena sprzedaży dla "Magazyn -> Do wystawienia" (16.10.2026): cena, przy której zysk netto po WSZYSTKICH kosztach to X% ceny sprzedaży — widełki 20–25% (edytowalne).
// Ta sama definicja marży co w zakładce Marża (lib/margin.ts): marża = sprzedaż − zakup − VAT − wysyłka − koszty dodatkowe − prowizja (− serwis, który siedzi w kosztach dodatkowych z Towaru),
// marża % = marża ÷ cena sprzedaży (brutto). Czyste funkcje, bez bazy.
//
// Wzór dla VAT-marży (VM): marża = P − Cp − (P − Cp)·23/123 − S − X − r·P − F, gdzie P = cena sprzedaży brutto (PLN), Cp = cena zakupu, S = wysyłka, X = koszty dodatkowe (serwis, prowizja
// i PCC z Towaru), r = prowizja + opłata płatnicza (% ceny), F = stałe opłaty (CCBM). Z warunku marża = m·P:  P = (Cp·(1 − k) + S + X + F) / (1 − k − r − m),  k = 23/123.
// Dla V23 (zakup z odliczonym VAT, Cp netto): marża = P/1,23 − Cp − S − X − r·P − F  =>  P = (Cp + S + X + F) / (1/1,23 − r − m).
import { bmCommissionPct, bmKind, type BmKind } from "./margin";

export type VatMode = "VM" | "V23";
export type PriceInputs = { purchasePln: number; extraPln: number; vat: VatMode; shippingPln: number; targetPct: number; eurRate: number };
export type MarketRules = { commissionPct: number; paymentPct: number; fixedEur: number };

const K = 23 / 123;

export function suggestedPricePln(i: PriceInputs, r: MarketRules): number | null {
  const rate = (r.commissionPct + r.paymentPct) / 100;
  const m = i.targetPct / 100;
  const fixed = r.fixedEur * i.eurRate;
  const num = i.vat === "V23" ? i.purchasePln + i.shippingPln + i.extraPln + fixed : i.purchasePln * (1 - K) + i.shippingPln + i.extraPln + fixed;
  const den = (i.vat === "V23" ? 1 / 1.23 : 1 - K) - rate - m;
  if (!(den > 0) || !Number.isFinite(num)) return null;
  return num / den;
}

export type MarginAtPrice = { salePln: number; vatPln: number; commissionPln: number; marginPln: number; marginPct: number };
export function marginAtPrice(pricePln: number, i: PriceInputs, r: MarketRules): MarginAtPrice {
  const commissionPln = pricePln * ((r.commissionPct + r.paymentPct) / 100) + r.fixedEur * i.eurRate;
  const vatPln = i.vat === "V23" ? pricePln - pricePln / 1.23 : Math.max(0, (pricePln - i.purchasePln) * K);
  const marginPln = pricePln - i.purchasePln - vatPln - i.shippingPln - i.extraPln - commissionPln;
  return { salePln: pricePln, vatPln, commissionPln, marginPln, marginPct: pricePln > 0 ? marginPln / pricePln : 0 };
}

// Cena w pełnych EUR (marketplace'y sprzedają w euro): zaokrąglamy W GÓRĘ, żeby zysk nie spadł poniżej celu.
export type Suggestion = { eur: number; pricePln: number; exactPln: number; margin: MarginAtPrice };
export function suggestPrice(i: PriceInputs, r: MarketRules): Suggestion | null {
  const exact = suggestedPricePln(i, r);
  if (exact === null || !(i.eurRate > 0)) return null;
  const eur = Math.ceil(exact / i.eurRate);
  const pricePln = eur * i.eurRate;
  return { eur, pricePln, exactPln: exact, margin: marginAtPrice(pricePln, i, r) };
}

// ---- Reguły marketplace'ów ----
export type Assumptions = {
  targetMinPct: number; // dolna granica widełek zysku netto, % ceny sprzedaży
  targetMaxPct: number; // górna granica widełek
  shippingPln: number; // koszt wysyłki do klienta (PLN netto)
  bmCountry: string; // kraj sprzedaży na Back Market — decyduje o programie Accelerator (konsole 6% do FR/DE/ES/IT do 31.12.2026)
  bmPaymentPct: number; // opłata płatnicza BM (regulamin 1%)
  rfCommissionPct: number; // refurbed: prowizja bazowa (z danych zamówień: 12%)
  rfPaymentPct: number; // refurbed: opłata płatnicza (z danych zamówień: 1,5%)
  rfMarket: string; // refurbed: rynek, którego BuyBox bierzemy do strategii cen (oferta ma jedną cenę referencyjną dla wielu rynków)
  undercutEur: number; // o ile € schodzimy poniżej ceny do wygrania BuyBox (0 = dokładnie cena do wygrania; max marża)
};
export const DEFAULT_ASSUMPTIONS: Assumptions = { targetMinPct: 20, targetMaxPct: 25, shippingPln: 37, bmCountry: "FR", bmPaymentPct: 1, rfCommissionPct: 12, rfPaymentPct: 1.5, rfMarket: "DE", undercutEur: 0 };
export const BM_CCBM_EUR = { main: 6.99, accessory: 1.99 }; // stała opłata CCBM za pozycję (regulamin; średnie z faktur w Marży są zbliżone)

export function bmRules(sku: string, a: Assumptions, today: string): { rules: MarketRules; kind: BmKind; note: string } {
  const c = bmCommissionPct({ sku, title: null, country: a.bmCountry, date: today });
  const fixedEur = c.kind === "accessory" ? BM_CCBM_EUR.accessory : BM_CCBM_EUR.main;
  const why = c.kind === "accessory" ? "akcesorium konsolowe" : c.kind === "console" ? (c.accelerator ? `konsola do ${a.bmCountry} w programie Accelerator (do 31.12.2026)` : "konsola poza programem Accelerator") : c.kind === "smartwatch" ? (c.accelerator ? "smartwatch w programie Accelerator (do 30.11.2026)" : "smartwatch") : "pozostałe produkty";
  return { rules: { commissionPct: c.pct, paymentPct: a.bmPaymentPct, fixedEur }, kind: c.kind, note: `prowizja ${c.pct}% (${why}) + płatność ${a.bmPaymentPct}% + CCBM ${fixedEur} €` };
}
export const refurbedRules = (a: Assumptions): { rules: MarketRules; note: string } => ({
  rules: { commissionPct: a.rfCommissionPct, paymentPct: a.rfPaymentPct, fixedEur: 0 },
  note: `prowizja ${a.rfCommissionPct}% + płatność ${a.rfPaymentPct}% (bez stałej opłaty)`,
});

export { bmKind };

// Normalizacja SKU do porównania SKU z listy "Do wystawienia" (SKU magazynowe, np. PS4-500-BK-B) z SKU ofert (często z końcówką -nM i dodatkiem "+gra"): bez "+…" i bez "-0M/-1M/-2M".
export const normListingSku = (sku: string | null | undefined) => (sku || "").trim().toUpperCase().replace(/\+.*$/, "").replace(/-\d+M$/, "");
