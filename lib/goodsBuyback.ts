// Towar -> Skup: automatyczne wiersze z opłaconych zamówień Buyback (14.10.2026, na prośbę właściciela). CZYSTE funkcje (bez bazy), jedno miejsce liczenia —
// używa ich route app/api/goods/sync-buyback. Zasady (jak formularz "Dodaj towar", lib/goods.ts): cena zakupu = cena PO kontrofercie (a gdy jej nie było — początkowa),
// kurs NBP z ostatniego dnia roboczego PRZED datą płatności (czas polski), Cena PLN = cena × kurs, PCC = 2% całej wartości powyżej 1000 zł, Prowizja = 10% ceny w PLN
// + opłata logistyczna wg regulaminu (EUR × kurs), Prowizja + PCC = prowizja + PCC, Cena + koszty = Cena PLN + Serwis + Prowizja + PCC.
// Czego nie wiemy, zostaje puste (null) — nie zgadujemy: brak kursu -> bez cen w PLN, nierozpoznana kategoria/waluta inna niż EUR -> bez prowizji i sumy.
import { pccFromValuePln, tradeInCategory, TRADEIN_COMMISSION_RATE, TRADEIN_LOGISTICS_EUR, TRADEIN_LOGISTICS_REGION } from "@/lib/buybackCosts";
import { countryFromOrderNo, r2 } from "@/lib/goods";
import { rateBeforeDate, warsawDate, type NbpRate } from "@/lib/nbp";

// Od kiedy (data płatności, czas polski) opłacone zamówienia trafiają automatycznie do Skupu — decyzja właściciela 14.10.2026.
export const BUYBACK_GOODS_FROM = "2026-10-01";
export const BUYBACK_PAID_STATUSES = ["VALIDATED", "PAID", "MONEY_TRANSFERED"];

export type BbOrder = {
  order_public_id: string;
  payment_date: string | null;
  creation_date: string;
  market: string | null;
  sku: string | null;
  product_title: string | null;
  original_price: number | string | null;
  original_price_currency: string | null;
  counter_offer_price: number | string | null;
};
export type BbIntake = { serial_number: string | null; sku: string | null } | null;

export type BuiltGoods = {
  serial: string | null;
  name: string | null; // w Skupie to SKU nadane przez pracownika
  supplier: string;
  purchased_on: string;
  order_no: string;
  category: string | null;
  price: number | null;
  vat: string;
  currency: string;
  nbp_rate: number | null;
  price_pln: number | null;
  pcc: number | null;
  country: string | null;
  commission: number | null;
  commission_pcc: number | null;
  costs: number | null; // Serwis
  total_pln: number | null;
};

// Kategoria towaru (jak w arkuszu: Konsola / iPad / iPhone / Samsung / Audio / Macbook / Watch / Aparat) z SKU nadanego przez pracownika — wg prefiksu schematu SKU.
// Nierozpoznany prefiks -> null (zostaje puste, nie zgadujemy).
export function goodsCategoryFromSku(sku: string | null | undefined): string | null {
  const s = (sku || "").trim().toUpperCase();
  if (!s) return null;
  if (/^\d{3,}\s*\(\d\/\d\)/.test(s)) return "Aparat"; // "237387 (3/5)" — aparaty (ocena stanu w nawiasie)
  const p = s.split("-")[0];
  if (/^(AW|APPS|SGW)/.test(p)) return "Watch";
  if (/^(PS|XS|XO|NS|N3DS|NNDS|NDS|VSD|VVSD|MOQ|ASA|ONEX)/.test(p)) return "Konsola";
  if (/^(IPAD|ID)/.test(p)) return "iPad";
  if (/^IP/.test(p)) return "iPhone";
  if (/^(SGS|SGN|SGA|SGZ|S2|GP|A\d)/.test(p)) return "Samsung";
  if (/^(APM|AHP|APP|B7|MARSH|QC|OF)/.test(p)) return "Audio";
  if (/^MB/.test(p)) return "Macbook";
  return null;
}

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function buildBuybackGoods(o: BbOrder, intake: BbIntake, ratesByCurrency: Record<string, NbpRate[]>, serviceCostPln: number | null): BuiltGoods {
  const serial = (intake?.serial_number || "").trim().toUpperCase() || null;
  const sku = (intake?.sku || "").trim() || null;
  const price = num(o.counter_offer_price) ?? num(o.original_price);
  const currency = (o.original_price_currency || "EUR").toUpperCase();
  const date = warsawDate(o.payment_date || o.creation_date);
  const rate = currency === "PLN" ? 1 : rateBeforeDate(ratesByCurrency[currency] || [], date);
  const pricePln = price !== null && rate !== null ? r2(price * rate) : null;
  const pcc = pricePln !== null ? r2(pccFromValuePln(pricePln)) : null;
  // prowizja = 10% ceny w PLN + opłata logistyczna (EUR) × kurs; logistykę znamy tylko dla EUR i rozpoznanej kategorii produktu
  const feeCat = tradeInCategory(o.product_title, sku || o.sku);
  const logisticsEur = feeCat && currency === "EUR" ? TRADEIN_LOGISTICS_EUR[TRADEIN_LOGISTICS_REGION][feeCat] : null;
  const commission = pricePln !== null && rate !== null && logisticsEur !== null ? r2(pricePln * TRADEIN_COMMISSION_RATE + logisticsEur * rate) : null;
  const commissionPcc = commission !== null && pcc !== null ? r2(commission + pcc) : null;
  const costs = serviceCostPln !== null && serviceCostPln > 0 ? r2(serviceCostPln) : null;
  const total = pricePln !== null && commissionPcc !== null ? r2(pricePln + (costs ?? 0) + commissionPcc) : null;
  return {
    serial,
    name: sku,
    supplier: "BB",
    purchased_on: date,
    order_no: o.order_public_id,
    category: goodsCategoryFromSku(sku),
    price,
    vat: "VM",
    currency,
    nbp_rate: rate === null ? null : Math.round(rate * 10000) / 10000,
    price_pln: pricePln,
    pcc,
    country: countryFromOrderNo(o.order_public_id) || (o.market || "").trim().toUpperCase().slice(0, 2) || null,
    commission,
    commission_pcc: commissionPcc,
    costs,
    total_pln: total,
  };
}

type Existing = Partial<Record<keyof BuiltGoods, unknown>>;
const empty = (v: unknown) => v === null || v === undefined || v === "";
const near = (a: unknown, b: number | null) => (a === null || a === undefined ? b === null : b !== null && Math.abs(Number(a) - b) < 0.005);

// Poprawka istniejącego wiersza automatycznego: UZUPEŁNIA tylko puste pola (numer seryjny/SKU wpisane przez pracownika później, kurs, kategoria…) —
// niczego niepustego nie nadpisuje (ręczne zmiany są bezpieczne). Jedyna wartość odświeżana na bieżąco to Serwis (koszty części przypisanych po zakupie);
// po jego zmianie albo uzupełnieniu składników przeliczana jest "Cena + koszty". Zwraca same zmienione pola (pusty obiekt = nic do zrobienia).
export function refreshPatch(existing: Existing, built: BuiltGoods): Partial<BuiltGoods> {
  const patch: Record<string, unknown> = {};
  const fillKeys: (keyof BuiltGoods)[] = ["serial", "name", "category", "country", "nbp_rate", "price_pln", "pcc", "commission", "commission_pcc"];
  for (const k of fillKeys) if (empty(existing[k]) && !empty(built[k])) patch[k] = built[k];
  if (built.costs !== null && !near(existing.costs, built.costs)) patch.costs = built.costs;
  const merged = { ...existing, ...patch } as Existing;
  const pricePln = num(merged.price_pln as number | null);
  const commissionPcc = num(merged.commission_pcc as number | null);
  const costs = num(merged.costs as number | null);
  if (pricePln !== null && commissionPcc !== null) {
    const total = r2(pricePln + (costs ?? 0) + commissionPcc);
    if (!near(existing.total_pln, total)) patch.total_pln = total;
  }
  return patch as Partial<BuiltGoods>;
}
