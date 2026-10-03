// Koszty dodatkowe sztuk w magazynie (Magazyn -> Podsumowanie, 03.10.2026): do ceny zakupu dokładamy koszty, które ją podnoszą.
// DZIŚ jest tylko koszt Trade-in (prowizja Back Market + logistyka wg regulaminu, lib/buybackCosts.ts); z czasem dojdą kolejne
// składniki (koszty części, podatek PCC przy zakupie powyżej 1000 zł itd.) — każdy jako osobna linia kosztów (`CostLine`),
// sumowana do "wartości z kosztami", więc dodanie składnika nie zmienia reszty.

import { computeTradeInCosts } from "./buybackCosts";
import { rateBeforeDate, warsawDate, type NbpRate } from "./nbp";

export type BuybackOrderLite = {
  order_public_id: string;
  status: string;
  product_title: string | null;
  sku: string | null;
  original_price: number | string | null;
  original_price_currency: string | null;
  counter_offer_price: number | string | null;
  counter_offer_price_currency: string | null;
  payment_date: string | null;
  creation_date: string | null;
};

export type CostLine = {
  key: string; // "tradein" (dziś); kolejne: "parts", "pcc"...
  label: string;
  amountPln: number;
  detail: string; // krótki opis pod linią (z ilu zamówień/sztuk, ostrzeżenia)
};

// Koszty Trade-in naliczane są przy WYPŁACIE dla klienta (regulamin BM art. 16.2) — liczymy tylko zamówienia już wypłacone/zwalidowane.
export const TRADEIN_PAID_STATUSES = ["VALIDATED", "PAID", "MONEY_TRANSFERED"];

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Sztuka w magazynie wskazuje zamówienie Trade-in w polu `description` (numer zamówienia BM, np. FR-26392-JMMYS) — dopasowujemy po nim.
// Jedno zamówienie liczymy RAZ, nawet gdy kilka sztuk w magazynie wskazuje to samo (inaczej koszty by się dublowały). Koszt w EUR
// przeliczamy na PLN kursem NBP z dnia poprzedniego względem wypłaty (a gdy brak daty wypłaty — względem utworzenia zamówienia),
// tą samą zasadą co reszta aplikacji. Zamówienia bez kursu NBP są pominięte z sumy i policzone osobno (nie zgadujemy kursu).
// Koszt Trade-in JEDNEGO zamówienia w PLN (prowizja + logistyka z lib/buybackCosts.ts, EUR -> PLN kursem NBP z dnia poprzedniego względem wypłaty, plus PCC 2% od wartości > 1000 zł).
// null amountPln = nie da się policzyć (zamówienie niewypłacone/bez ceny albo brak kursu); noRate odróżnia brak kursu od reszty.
export function tradeInOrderCostPln(o: BuybackOrderLite, eurRates: NbpRate[]): { amountPln: number | null; noRate: boolean; incomplete: boolean } {
  if (!TRADEIN_PAID_STATUSES.includes(o.status)) return { amountPln: null, noRate: false, incomplete: false };
  // Data wypłaty (pole "Płatność" zamówienia BM) w czasie polskim; gdy BM jej nie podał (rzadkie), data utworzenia zamówienia.
  const date = warsawDate(o.payment_date || o.creation_date);
  const rate = date ? rateBeforeDate(eurRates, date) : null;
  const c = computeTradeInCosts({
    originalPrice: num(o.original_price),
    counterOfferPrice: num(o.counter_offer_price),
    currency: o.counter_offer_price_currency ?? o.original_price_currency,
    title: o.product_title,
    sku: o.sku,
    eurRate: rate,
  });
  if (!c) return { amountPln: null, noRate: false, incomplete: false };
  if (rate === null) return { amountPln: null, noRate: true, incomplete: c.extra === null };
  // Prowizja + logistyka (EUR) przeliczone kursem na PLN, a PCC (już policzone w PLN od wartości w PLN) dokładamy wprost. Gdy logistyki nie da się
  // ustalić (nieznana kategoria/waluta) — bierzemy samą prowizję i zaznaczamy to jako niepełne.
  const eurBase = c.logistics === null ? c.commission : c.commission + c.logistics;
  return { amountPln: eurBase * rate + (c.pccPln ?? 0), noRate: false, incomplete: c.extra === null };
}

export function stockTradeInCosts(descriptions: (string | null)[], orders: Map<string, BuybackOrderLite>, eurRates: NbpRate[]): CostLine {
  const seen = new Set<string>();
  let amount = 0;
  let linkedItems = 0;
  let noRate = 0;
  let incomplete = 0;
  for (const raw of descriptions) {
    const id = (raw || "").trim();
    const o = id ? orders.get(id) : undefined;
    if (!o || !TRADEIN_PAID_STATUSES.includes(o.status)) continue;
    linkedItems += 1;
    if (seen.has(id)) continue;
    seen.add(id);
    const r = tradeInOrderCostPln(o, eurRates);
    if (r.incomplete) incomplete += 1;
    if (r.noRate) {
      noRate += 1;
      continue;
    }
    if (r.amountPln !== null) amount += r.amountPln;
  }
  const parts = [`z ${seen.size} zamówień Trade-in (${linkedItems} sztuk w magazynie)`];
  if (noRate > 0) parts.push(`${noRate} zamówień pominięto — brak kursu NBP (kliknij „Odśwież” w zakładce NBP)`);
  if (incomplete > 0) parts.push(`${incomplete} bez logistyki (nieznana kategoria)`);
  return { key: "tradein", label: "Koszty Trade-in (prowizja BM + logistyka + PCC)", amountPln: Math.round(amount * 100) / 100, detail: parts.join("; ") };
}
