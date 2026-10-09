// Zakładka Towar (10.10.2026): podpowiedzi liczone w formularzu "Dodaj towar". Wszystkie wartości można w formularzu poprawić ręcznie —
// zasady odtworzone z arkusza Towar.numbers (sprawdzone na 1064 wierszach Trade-in: Cena PLN = cena zakupu × kurs NBP, a "cena PLN + koszty"
// = Cena PLN + koszty + prowizja z PCC).
import { PCC_RATE, TRADEIN_COMMISSION_RATE, TRADEIN_LOGISTICS_EUR, TRADEIN_LOGISTICS_REGION, pccFromValuePln, type TradeInCategory } from "@/lib/buybackCosts";

export const r2 = (n: number) => Math.round(n * 100) / 100;

// Cena PLN = cena zakupu × kurs NBP (waluta obca) albo sama cena (PLN). Brak kursu dla waluty obcej -> null.
export function goodsPricePln(price: number | null, currency: string, nbp: number | null): number | null {
  if (price === null || Number.isNaN(price)) return null;
  if (currency === "PLN") return r2(price);
  if (nbp === null || Number.isNaN(nbp)) return null;
  return r2(price * nbp);
}

// Kategoria z arkusza -> kategoria opłaty logistycznej Back Market (regulamin Trade-in).
export function goodsFeeCategory(category: string | null | undefined): TradeInCategory | null {
  const c = (category || "").trim().toLowerCase();
  if (c === "konsola" || c === "macbook") return "consoles_laptops";
  if (c === "ipad") return "tablets";
  if (c === "samsung" || c === "iphone" || c === "audio") return "phones_audio";
  return null;
}

// Podpowiedź "prowizja + PCC" dla Trade-in w PLN: 10% ceny + opłata logistyczna wg kategorii (w EUR, kurs NBP) + PCC (2% całej wartości powyżej 1000 zł).
// Zwraca też samo PCC. Nieznana kategoria albo brak kursu -> sama prowizja 10% (bez logistyki) i PCC; null, gdy brak ceny w PLN.
export function suggestTradeInFees(o: { price: number | null; pricePln: number | null; nbp: number | null; category: string | null }): { pcc: number; commissionPcc: number } | null {
  if (o.pricePln === null || o.price === null) return null;
  const pcc = pccFromValuePln(o.pricePln);
  const cat = goodsFeeCategory(o.category);
  const logisticsEur = cat ? TRADEIN_LOGISTICS_EUR[TRADEIN_LOGISTICS_REGION][cat] : 0;
  const rate = o.nbp ?? 0;
  const commission = o.pricePln * TRADEIN_COMMISSION_RATE + logisticsEur * rate;
  return { pcc: r2(pcc), commissionPcc: r2(commission + pcc) };
}

// "Cena PLN + koszty" = Cena PLN + koszty (+ prowizja z PCC w Trade-in).
export function goodsTotalPln(o: { pricePln: number | null; costs: number | null; commissionPcc: number | null }): number | null {
  if (o.pricePln === null) return null;
  return r2(o.pricePln + (o.costs ?? 0) + (o.commissionPcc ?? 0));
}

// Kraj z numeru zamówienia Back Market ("FR-26412-WXUBA" -> FR); starsze numery z samych cyfr nie niosą kraju.
export function countryFromOrderNo(orderNo: string | null | undefined): string | null {
  const m = /^([A-Za-z]{2})-/.exec((orderNo || "").trim());
  return m ? m[1].toUpperCase() : null;
}

export { PCC_RATE };
