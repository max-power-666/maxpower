// Marża na sprzedanej sztuce (zakładka Marża, 03.10.2026). Czysta logika (bez Next.js/Supabase), testowana osobno.
//
// Definicja (decyzja właściciela): marża = cena sprzedaży (PLN, brutto) − cena zakupu − VAT od marży − wysyłka − koszty dodatkowe (Trade-in)
//   − prowizja marketplace'u − koszty serwisu. VAT liczony OD MARŻY: (cena sprzedaży − cena zakupu, BEZ kosztów dodatkowych) × 23/123,
//   nigdy ujemny. Koszty serwisu na razie zawsze puste (decyzja: dodamy po wprowadzeniu kosztów części).
// Zakres: tylko Back Market i refurbed (tam mamy rzetelne źródło prowizji): BM z wgranych faktur tygodniowych (dokładnie dla zamówień z faktury,
// resztę szacujemy średnią z faktur), refurbed z danych zamówienia. Inne kanały nie są na liście, dopóki nie znamy ich prowizji.
//
// Koszty poziomu ZAMÓWIENIA (wysyłka, opłaty z faktury BM) dzielimy na pozycje proporcjonalnie do ceny pozycji.

import { rateBeforeDate, type NbpRate } from "./nbp";
import { tradeInOrderCostPln, type BuybackOrderLite } from "./stockCosts";

export const MARGIN_VAT_RATE = 23; // % — VAT od marży (23/123 marży brutto), ta sama stała stawka co faktury (INVOICE_VAT_RATE)
export const MARGIN_MARKETPLACES = ["backmarket", "refurbed"] as const;

export type MarginDbRow = {
  marketplace: string;
  order_id: string;
  item_key: string;
  position: number;
  order_date: string | null;
  status: string;
  country_code: string | null;
  sku: string | null;
  product_name: string | null;
  serial_number: string;
  price: number | string | null;
  currency: string;
  order_total: number | string | null;
  order_items: number | string | null;
  purchase_price_gross: number | string | null;
  purchase_ref: string | null;
  tradein_status: string | null;
  tradein_title: string | null;
  tradein_sku: string | null;
  tradein_original_price: number | string | null;
  tradein_original_currency: string | null;
  tradein_counter_price: number | string | null;
  tradein_counter_currency: string | null;
  tradein_payment_date: string | null;
  tradein_creation_date: string | null;
  shipping_price: number | string | null;
  shipping_currency: string | null;
  shipping_manual: number | string | null;
  refurbed_commission: number | string | null;
  refurbed_commission_currency: string | null;
  bm_sales_fees: number | string | null;
  bm_payment_fees: number | string | null;
  bm_ccbm_fees: number | string | null;
  bm_has_invoice: boolean | null;
};

export type MarginResult = {
  marketplace: string;
  orderId: string;
  itemKey: string;
  orderDate: string | null;
  sku: string | null;
  productName: string | null;
  serial: string;
  price: number | null;
  currency: string;
  salePln: number | null;
  purchasePln: number | null;
  vatPln: number | null;
  shippingPln: number | null;
  extraPln: number | null;
  commissionPln: number | null;
  commissionSource: "faktura" | "szacunek" | "refurbed" | null;
  servicePln: number | null; // zawsze null — koszty serwisu jeszcze nie wchodzą do marży
  marginPln: number | null;
  marginPct: number | null; // marża / cena sprzedaży
  flags: string[]; // czego brakuje (marża wtedy niepełna) — pokazywane w UI
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export type BmLine = { invoice_ref: string; invoice_key: string; order_id: string | null; amount: number | string; sku?: string | null };
export type BmRates = {
  commissionPct: number; // % ceny sprzedaży: prowizja ("sales_fees") — średnia z faktur
  paymentPct: number; // % ceny sprzedaży: opłata płatnicza ("payment_fees")
  ccbmFixedEur: number; // € za pozycję: Customer Care by Back Market ("ccbm_fees") — kwota stała, nie procent
  orders: number; // z ilu zamówień policzono
  invoices: string[]; // numery faktur wzięte do średniej
};

// Średnie stawki BM z wgranych faktur: z ostatnich `weeks` tygodni faktur (numer zaczyna się od daty RRRRMMDD), tylko zamówienia SPRZEDANE i niezwrócone
// (zwroty mają ujemne "sales" i kredyty prowizji — wypaczyłyby średnią). Zwraca null, gdy nie ma z czego liczyć.
export function deriveBmRates(lines: BmLine[], weeks = 8): BmRates | null {
  const dates = lines.map((l) => l.invoice_ref.slice(0, 8)).filter((d) => /^\d{8}$/.test(d)).sort();
  if (dates.length === 0) return null;
  const last = dates[dates.length - 1];
  const lastMs = Date.UTC(+last.slice(0, 4), +last.slice(4, 6) - 1, +last.slice(6, 8));
  const cutoff = lastMs - weeks * 7 * 86400000;
  const inWindow = lines.filter((l) => {
    const d = l.invoice_ref.slice(0, 8);
    return /^\d{8}$/.test(d) && Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) >= cutoff;
  });
  const byOrder = new Map<string, Record<string, number>>();
  for (const l of inWindow) {
    if (!l.order_id) continue;
    const o = byOrder.get(l.order_id) || {};
    o[l.invoice_key] = (o[l.invoice_key] || 0) + Number(l.amount);
    byOrder.set(l.order_id, o);
  }
  let sales = 0, comm = 0, pay = 0, ccbm = 0, ccbmLines = 0, orders = 0;
  for (const o of byOrder.values()) {
    if (!(o.sales > 0) || o.refunds) continue;
    orders++;
    sales += o.sales;
    comm += -(o.sales_fees || 0);
    pay += -(o.payment_fees || 0);
  }
  for (const l of inWindow) {
    if (l.invoice_key === "ccbm_fees" && Number(l.amount) < 0) {
      ccbm += -Number(l.amount);
      ccbmLines++;
    }
  }
  if (orders === 0 || sales <= 0) return null;
  return {
    commissionPct: (comm / sales) * 100,
    paymentPct: (pay / sales) * 100,
    ccbmFixedEur: ccbmLines > 0 ? ccbm / ccbmLines : 0,
    orders,
    invoices: Array.from(new Set(inWindow.map((l) => l.invoice_ref))).sort(),
  };
}

export type MarginContext = {
  eurRates: NbpRate[];
  dkkRates: NbpRate[];
  bmRates: BmRates | null;
};

function toPln(amount: number, currency: string | null | undefined, date: string, ctx: MarginContext): number | null {
  const cur = (currency || "PLN").toUpperCase();
  if (cur === "PLN") return amount;
  const rates = cur === "EUR" ? ctx.eurRates : cur === "DKK" ? ctx.dkkRates : null;
  if (!rates) return null;
  const r = rateBeforeDate(rates, date);
  return r === null ? null : amount * r;
}

export function computeMargin(row: MarginDbRow, ctx: MarginContext): MarginResult {
  const flags: string[] = [];
  const price = num(row.price);
  const date = (row.order_date || "").slice(0, 10);
  const orderTotal = num(row.order_total);
  const items = Math.max(1, num(row.order_items) ?? 1);
  // udział pozycji w kosztach zamówienia: wg ceny, a gdy brak cen — po równo
  const share = price !== null && orderTotal !== null && orderTotal > 0 ? price / orderTotal : 1 / items;

  const salePln = price !== null && date ? toPln(price, row.currency, date, ctx) : null;
  if (salePln === null) flags.push(price === null ? "brak ceny sprzedaży" : "brak kursu NBP");

  const purchase = num(row.purchase_price_gross);
  if (purchase === null) flags.push("brak ceny zakupu");

  // wysyłka: cena z wyceny DHL jest autorytatywna, ręczny koszt tylko gdy jej nie ma (jak na karcie zamówienia)
  let shippingTotal: number | null = null;
  const shipPrice = num(row.shipping_price);
  if (shipPrice !== null && date) shippingTotal = toPln(shipPrice, row.shipping_currency, date, ctx);
  else if (num(row.shipping_manual) !== null) shippingTotal = num(row.shipping_manual);
  const shippingPln = shippingTotal === null ? null : shippingTotal * share;
  if (shippingPln === null) flags.push("brak kosztu wysyłki");

  // koszty dodatkowe = Trade-in (prowizja BM + logistyka wg regulaminu); sztuka spoza Trade-in (np. faktura "VAT marża") nie ma ich w ogóle (0)
  let extraPln: number | null = 0;
  if (row.tradein_status) {
    const t = tradeInOrderCostPln(
      {
        order_public_id: row.purchase_ref || "",
        status: row.tradein_status,
        product_title: row.tradein_title,
        sku: row.tradein_sku,
        original_price: row.tradein_original_price,
        original_price_currency: row.tradein_original_currency,
        counter_offer_price: row.tradein_counter_price,
        counter_offer_price_currency: row.tradein_counter_currency,
        payment_date: row.tradein_payment_date,
        creation_date: row.tradein_creation_date,
      } as BuybackOrderLite,
      ctx.eurRates
    );
    extraPln = t.amountPln;
    if (t.amountPln === null && t.noRate) flags.push("brak kursu NBP dla kosztów Trade-in");
  }

  // prowizja marketplace'u
  let commissionPln: number | null = null;
  let commissionSource: MarginResult["commissionSource"] = null;
  if (row.marketplace === "refurbed") {
    const c = num(row.refurbed_commission);
    if (c !== null && date) {
      commissionPln = toPln(c, row.refurbed_commission_currency, date, ctx);
      commissionSource = "refurbed";
    }
  } else if (row.marketplace === "backmarket" && date) {
    const salesFees = num(row.bm_sales_fees);
    if (row.bm_has_invoice && salesFees !== null) {
      // dokładnie z faktury: prowizja + opłata płatnicza (+ CCBM, a gdy jeszcze go nie ma na żadnej fakturze — średnia stała); wartości ujemne = koszt
      const ccbm = num(row.bm_ccbm_fees);
      const eurOrder = -(salesFees + (num(row.bm_payment_fees) ?? 0)) + (ccbm !== null ? -ccbm : 0);
      const eurItem = eurOrder * share + (ccbm === null && ctx.bmRates ? ctx.bmRates.ccbmFixedEur : 0);
      commissionPln = toPln(eurItem, "EUR", date, ctx);
      commissionSource = "faktura";
    } else if (ctx.bmRates && price !== null && (row.currency || "EUR").toUpperCase() === "EUR") {
      // zamówienie jeszcze bez faktury: średnia % z faktur od ceny + stała opłata CCBM za pozycję (w EUR, zamówienia BM są w EUR)
      const eur = price * ((ctx.bmRates.commissionPct + ctx.bmRates.paymentPct) / 100) + ctx.bmRates.ccbmFixedEur;
      commissionPln = toPln(eur, "EUR", date, ctx);
      commissionSource = "szacunek";
    }
  }
  if (commissionPln === null) flags.push("brak prowizji");
  else if (commissionSource === "szacunek") flags.push("prowizja szacowana ze średniej");

  const vatPln = salePln !== null && purchase !== null ? round2(Math.max(0, salePln - purchase) * (MARGIN_VAT_RATE / (100 + MARGIN_VAT_RATE))) : null;
  const marginPln =
    salePln !== null && purchase !== null && vatPln !== null
      ? round2(salePln - purchase - vatPln - (shippingPln ?? 0) - (extraPln ?? 0) - (commissionPln ?? 0))
      : null;

  return {
    marketplace: row.marketplace,
    orderId: row.order_id,
    itemKey: row.item_key,
    orderDate: row.order_date,
    sku: row.sku,
    productName: row.product_name,
    serial: row.serial_number,
    price,
    currency: row.currency,
    salePln: salePln === null ? null : round2(salePln),
    purchasePln: purchase,
    vatPln,
    shippingPln: shippingPln === null ? null : round2(shippingPln),
    extraPln: extraPln === null ? null : round2(extraPln),
    commissionPln: commissionPln === null ? null : round2(commissionPln),
    commissionSource,
    servicePln: null,
    marginPln,
    marginPct: marginPln !== null && salePln ? marginPln / salePln : null,
    flags,
  };
}
