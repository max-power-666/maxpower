// Marża na sprzedanej sztuce (zakładka Marża, 03.10.2026). Czysta logika (bez Next.js/Supabase), testowana osobno.
//
// Definicja (decyzja właściciela): marża = cena sprzedaży (PLN, brutto) − cena zakupu − VAT od marży − wysyłka − koszty dodatkowe (Trade-in)
//   − prowizja marketplace'u − koszty serwisu. VAT liczony OD MARŻY: (cena sprzedaży − cena zakupu, BEZ kosztów dodatkowych) × 23/123,
//   nigdy ujemny. Koszty serwisu na razie zawsze puste (decyzja: dodamy po wprowadzeniu kosztów części).
// Zakres: tylko Back Market i refurbed (tam mamy rzetelne źródło prowizji): BM z wgranych faktur tygodniowych (dokładnie dla zamówień z faktury,
// resztę szacujemy średnią z faktur), refurbed z danych zamówienia. Inne kanały nie są na liście, dopóki nie znamy ich prowizji.
//
// Koszty poziomu ZAMÓWIENIA (wysyłka, opłaty z faktury BM) dzielimy na pozycje proporcjonalnie do ceny pozycji.

import { rateBeforeDate, rateInfoBeforeDate, type NbpRate } from "./nbp";
import { tradeInOrderCostPln, type BuybackOrderLite } from "./stockCosts";
import { tradeInCategory, TRADEIN_CATEGORY_LABELS, type TradeInCategory } from "./buybackCosts";

// Prowizja Back Market od sprzedaży — reguły sprawdzone na 707 zamówieniach z faktur (wszystkie zgodne co do stawki, poza kilkoma zamówieniami z mieszanymi pozycjami):
//  - KONSOLE: standardowo 11% (regulamin art. 15.1, "pozostałe produkty"), ale w programie Accelerator for Sellers (zaproszenie BM dla M13) obniżka o 5 pkt proc.
//    — czyli 6% — dla sprzedaży konsol do FR/DE/ES/IT w okresie 15.08–31.12.2026. Poza tymi krajami albo poza okresem programu: 11%.
//    Program NIE obejmuje konsol retro, gier ani akcesoriów konsolowych.
//  - AKCESORIA konsolowe (pady, Joy-Cony): 20% (akcesoria innych marek), bez obniżki.
//  - POZOSTAŁE (aparaty, zegarki, telefony...): 11% (bez obniżki; stawki 10%/12% dla MacBooków/smartfonów ES-FR z regulaminu pomijamy — poza zakresem listy).
export const BM_ACCELERATOR = { markets: ["FR", "DE", "ES", "IT"], from: "2026-08-15", to: "2026-12-31", reductionPp: 5 };
export const BM_STANDARD_PCT = 11;
export const BM_ACCESSORY_PCT = 20;
export type BmKind = "console" | "accessory" | "other";

export function bmKind(sku: string | null | undefined, title: string | null | undefined): BmKind {
  const p = (sku || "").split("-")[0].toLowerCase();
  const t = (title || "").toLowerCase();
  if (/^(pad|ds4|nsjc|ps5pad|joy)/.test(p) || /manette|controller|joy-?con|joystick|dualshock|dualsense|gamepad|\bpad\b/.test(t)) return "accessory";
  if (/macbook|laptop/.test(t)) return "other";
  return tradeInCategory(title, sku) === "consoles_laptops" ? "console" : "other";
}

// Stawka prowizji (% ceny sprzedaży) wg reguł wyżej; `date` = data zamówienia (YYYY-MM-DD), `country` = kraj odbiorcy.
export function bmCommissionPct(o: { sku: string | null | undefined; title: string | null | undefined; country: string | null | undefined; date: string }): { pct: number; kind: BmKind; accelerator: boolean } {
  const kind = bmKind(o.sku, o.title);
  if (kind === "accessory") return { pct: BM_ACCESSORY_PCT, kind, accelerator: false };
  if (kind === "console" && o.country && BM_ACCELERATOR.markets.includes(o.country.toUpperCase()) && o.date >= BM_ACCELERATOR.from && o.date <= BM_ACCELERATOR.to) {
    return { pct: BM_STANDARD_PCT - BM_ACCELERATOR.reductionPp, kind, accelerator: true };
  }
  return { pct: BM_STANDARD_PCT, kind, accelerator: false };
}


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
  details: MarginDetail[]; // szczegółowe wyliczenie (rozwijany wiersz w UI): każdy składnik z kwotą i opisem skąd się wziął
};

export type MarginDetail = { key: string; label: string; sign: "+" | "-" | "="; amountPln: number | null; note: string };

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export type BmLine = { invoice_ref: string; invoice_key: string; order_id: string | null; amount: number | string; sku?: string | null; designation?: string | null };
export type BmRates = {
  commissionPct: number; // % ceny sprzedaży: średnia prowizja z faktur (tylko do wyświetlenia — szacunek idzie wg reguł bmCommissionPct, nie średniej)
  paymentPct: number; // % ceny sprzedaży: opłata płatnicza ("payment_fees") — średnia z faktur (regulamin: 1%)
  ccbmFixedEur: number; // € za pozycję: Customer Care by Back Market ("ccbm_fees") dla konsol i reszty — kwota stała, nie procent
  ccbmAccessoryEur: number; // € za pozycję CCBM dla akcesoriów (znacznie niższa)
  orders: number; // z ilu zamówień policzono
  invoices: string[]; // numery faktur wzięte do średnich
};

// Średnie z wgranych faktur: z ostatnich `weeks` tygodni faktur (numer zaczyna się od daty RRRRMMDD), tylko zamówienia SPRZEDANE i niezwrócone (zwroty mają ujemne "sales"
// i kredyty prowizji — wypaczyłyby średnią). CCBM liczymy osobno dla akcesoriów (SKU z wiersza "sales" zamówienia) i dla pozostałych. Zwraca null, gdy nie ma z czego liczyć.
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
  const skuOf = new Map<string, string>();
  for (const l of inWindow) {
    if (!l.order_id) continue;
    const o = byOrder.get(l.order_id) || {};
    o[l.invoice_key] = (o[l.invoice_key] || 0) + Number(l.amount);
    byOrder.set(l.order_id, o);
    if (l.invoice_key === "sales" && l.sku) skuOf.set(l.order_id, l.sku);
  }
  let sales = 0, comm = 0, pay = 0, orders = 0;
  for (const o of byOrder.values()) {
    if (!(o.sales > 0) || o.refunds) continue;
    orders++;
    sales += o.sales;
    comm += -(o.sales_fees || 0);
    pay += -(o.payment_fees || 0);
  }
  let ccbmMain = 0, ccbmMainN = 0, ccbmAcc = 0, ccbmAccN = 0;
  for (const l of inWindow) {
    if (l.invoice_key !== "ccbm_fees" || !(Number(l.amount) < 0) || !l.order_id) continue;
    const acc = bmKind(skuOf.get(l.order_id) ?? l.sku ?? null, l.designation ?? null) === "accessory";
    if (acc) {
      ccbmAcc += -Number(l.amount);
      ccbmAccN++;
    } else {
      ccbmMain += -Number(l.amount);
      ccbmMainN++;
    }
  }
  if (orders === 0 || sales <= 0) return null;
  return {
    commissionPct: (comm / sales) * 100,
    paymentPct: (pay / sales) * 100,
    ccbmFixedEur: ccbmMainN > 0 ? ccbmMain / ccbmMainN : 6.99,
    ccbmAccessoryEur: ccbmAccN > 0 ? ccbmAcc / ccbmAccN : 1.99,
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

const f2 = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f4 = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const dm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

export function computeMargin(row: MarginDbRow, ctx: MarginContext): MarginResult {
  const flags: string[] = [];
  const details: MarginDetail[] = [];
  const price = num(row.price);
  const date = (row.order_date || "").slice(0, 10);
  const orderTotal = num(row.order_total);
  const items = Math.max(1, num(row.order_items) ?? 1);
  // udział pozycji w kosztach zamówienia: wg ceny, a gdy brak cen — po równo
  const share = price !== null && orderTotal !== null && orderTotal > 0 ? price / orderTotal : 1 / items;
  const shareNote = items > 1 ? ` Zamówienie ma ${items} pozycje — koszt zamówienia dzielony wg ceny pozycji (udział ${f2(share * 100)}%).` : "";
  const cur = (row.currency || "PLN").toUpperCase();
  const rateOf = (c: string) => {
    const rs = c === "EUR" ? ctx.eurRates : c === "DKK" ? ctx.dkkRates : null;
    return rs && date ? rateInfoBeforeDate(rs, date) : null;
  };

  // --- cena sprzedaży
  const salePln = price !== null && date ? toPln(price, row.currency, date, ctx) : null;
  if (salePln === null) flags.push(price === null ? "brak ceny sprzedaży" : "brak kursu NBP");
  {
    let note = "";
    if (price === null) note = "Brak ceny pozycji w zamówieniu.";
    else if (cur === "PLN") note = `Cena z zamówienia: ${f2(price)} zł (brutto).`;
    else {
      const ri = rateOf(cur);
      note = ri ? `${f2(price)} ${cur} × kurs NBP ${f4(ri.mid)} (z ${dm(ri.rateDate)}, dzień roboczy przed zamówieniem ${dm(date)}) — cena brutto.` : `${f2(price)} ${cur} — brak kursu NBP sprzed ${date}.`;
    }
    details.push({ key: "sale", label: "Cena sprzedaży", sign: "+", amountPln: salePln === null ? null : round2(salePln), note });
  }

  // --- cena zakupu
  const purchase = num(row.purchase_price_gross);
  if (purchase === null) flags.push("brak ceny zakupu");
  details.push({
    key: "purchase",
    label: "Cena zakupu",
    sign: "-",
    amountPln: purchase,
    note: purchase === null ? "Brak ceny zakupu tej sztuki w historii zakupów z Fakturowni (pobierz ją przyciskiem „Pobierz z Fakturowni”)." : `Z Fakturowni, wg numeru seryjnego${row.purchase_ref ? ` (zamówienie/dokument: ${row.purchase_ref.trim()})` : ""}.`,
  });

  // --- VAT od marży (po cenie sprzedaży i zakupu, bez kosztów dodatkowych)
  const vatPln = salePln !== null && purchase !== null ? round2(Math.max(0, salePln - purchase) * (MARGIN_VAT_RATE / (100 + MARGIN_VAT_RATE))) : null;
  details.push({
    key: "vat",
    label: "VAT od marży",
    sign: "-",
    amountPln: vatPln,
    note:
      vatPln === null
        ? "Nie do policzenia bez ceny sprzedaży i zakupu."
        : salePln! - purchase! <= 0
          ? "Sprzedaż nie przekracza zakupu — VAT od marży wynosi 0."
          : `(sprzedaż ${f2(salePln!)} − zakup ${f2(purchase!)}) × ${MARGIN_VAT_RATE}/${100 + MARGIN_VAT_RATE}, bez kosztów dodatkowych.`,
  });

  // --- wysyłka: cena z wyceny DHL jest autorytatywna, ręczny koszt tylko gdy jej nie ma (jak na karcie zamówienia)
  let shippingTotal: number | null = null;
  let shipNote = "Brak kosztu wysyłki: przesyłka nienadana przez ERP albo bez zapisanej ceny, i bez ręcznego kosztu na karcie zamówienia.";
  const shipPrice = num(row.shipping_price);
  if (shipPrice !== null && date) {
    shippingTotal = toPln(shipPrice, row.shipping_currency, date, ctx);
    shipNote = `Cena z wyceny DHL zapisana przy nadaniu: ${f2(shipPrice)} ${(row.shipping_currency || "PLN").toUpperCase()} (netto wg cennika).`;
  } else if (num(row.shipping_manual) !== null) {
    shippingTotal = num(row.shipping_manual);
    shipNote = `Ręcznie wpisany koszt wysyłki z karty zamówienia: ${f2(shippingTotal!)} zł.`;
  }
  const shippingPln = shippingTotal === null ? null : shippingTotal * share;
  if (shippingPln === null) flags.push("brak kosztu wysyłki");
  details.push({ key: "shipping", label: "Wysyłka", sign: "-", amountPln: shippingPln === null ? null : round2(shippingPln), note: shippingPln === null ? shipNote : shipNote + shareNote });

  // --- koszty dodatkowe = Trade-in (prowizja BM + logistyka wg regulaminu + PCC); sztuka spoza Trade-in (np. faktura "VAT marża") nie ma ich w ogóle (0)
  let extraPln: number | null = 0;
  let extraNote = "Zakup nie z Trade-in (np. od firmy, faktura „VAT marża”) — brak kosztów dodatkowych. Koszty części i serwisu dojdą później.";
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
    if (t.detail) {
      const d = t.detail;
      const lg = d.logisticsEur === null ? "logistyka: nieznana kategoria (pominięta)" : `logistyka ${f2(d.logisticsEur)} € (${TRADEIN_CATEGORY_LABELS[d.category as TradeInCategory] ?? "kategoria"}, magazyn w Polsce)`;
      extraNote = `Trade-in ${row.purchase_ref?.trim() ?? ""}: cena po kontrofercie ${f2(d.basisEur)} € → prowizja BM 10% = ${f2(d.commissionEur)} €; ${lg}; razem przeliczone kursem NBP ${f4(d.rate)} (dzień roboczy przed płatnością ${dm(d.dateUsed)}). PCC: ${
        d.pccPln && d.pccPln > 0 ? `${f2(d.pccPln)} zł (2% od wartości ${f2(d.valuePln ?? 0)} zł, powyżej 1000 zł)` : `0 zł (wartość ${f2(d.valuePln ?? 0)} zł nie przekracza 1000 zł)`
      }.`;
    } else if (t.amountPln === null) {
      extraNote = t.noRate ? "Brak kursu NBP z dnia płatności zamówienia Trade-in — koszty nie do policzenia." : `Zamówienie Trade-in (${row.tradein_status}) niewypłacone — koszty jeszcze nie naliczone.`;
    }
  }
  details.push({ key: "extra", label: "Koszty dodatkowe", sign: "-", amountPln: extraPln === null ? null : round2(extraPln), note: extraNote });

  // --- prowizja marketplace'u
  let commissionPln: number | null = null;
  let commissionSource: MarginResult["commissionSource"] = null;
  let commNote = "Brak źródła prowizji dla tego zamówienia.";
  if (row.marketplace === "refurbed") {
    const c = num(row.refurbed_commission);
    if (c !== null && date) {
      commissionPln = toPln(c, row.refurbed_commission_currency, date, ctx);
      commissionSource = "refurbed";
      const ri = (row.refurbed_commission_currency || "EUR").toUpperCase() === "PLN" ? null : rateOf((row.refurbed_commission_currency || "EUR").toUpperCase());
      commNote = `Z danych zamówienia refurbed (prowizja bazowa + płatność + dynamiczna): ${f2(c)} ${(row.refurbed_commission_currency || "").toUpperCase()}${ri ? ` × kurs NBP ${f4(ri.mid)} (z ${dm(ri.rateDate)})` : ""}.`;
    } else commNote = "Brak kwoty prowizji w danych zamówienia refurbed.";
  } else if (row.marketplace === "backmarket" && date) {
    const salesFees = num(row.bm_sales_fees);
    const ri = rateOf("EUR");
    const rateTxt = ri ? ` × kurs NBP ${f4(ri.mid)} (z ${dm(ri.rateDate)})` : "";
    if (row.bm_has_invoice && salesFees !== null) {
      // dokładnie z faktury: prowizja + opłata płatnicza (+ CCBM, a gdy jeszcze go nie ma na żadnej fakturze — średnia stała); wartości ujemne = koszt
      const ccbm = num(row.bm_ccbm_fees);
      const pay = num(row.bm_payment_fees) ?? 0;
      const eurOrder = -(salesFees + pay) + (ccbm !== null ? -ccbm : 0);
      const kindCcbm = ctx.bmRates ? (bmKind(row.sku, row.product_name) === "accessory" ? ctx.bmRates.ccbmAccessoryEur : ctx.bmRates.ccbmFixedEur) : 0;
      const eurItem = eurOrder * share + (ccbm === null ? kindCcbm : 0);
      commissionPln = toPln(eurItem, "EUR", date, ctx);
      commissionSource = "faktura";
      commNote = `Dokładnie z faktury Back Market (zamówienie): prowizja ${f2(-salesFees)} € + opłata płatnicza ${f2(-pay)} € + CCBM ${ccbm !== null ? f2(-ccbm) + " €" : `${f2(kindCcbm)} € (jeszcze niezafakturowane — średnia)`} = ${f2(-(salesFees + pay) + (ccbm !== null ? -ccbm : kindCcbm))} €${rateTxt}.${shareNote}`;
    } else if (price !== null && cur === "EUR") {
      // zamówienie jeszcze bez faktury: stawka WG REGUŁ (kraj, okres programu Accelerator, rodzaj produktu) + opłata płatnicza (średnia z faktur albo 1% z regulaminu)
      // + stała opłata CCBM za pozycję (średnia z faktur albo 6,99 € / 1,99 € dla akcesoriów); działa też bez wgranych faktur — wtedy wartości z regulaminu
      const c = bmCommissionPct({ sku: row.sku, title: row.product_name, country: row.country_code, date });
      const payPct = ctx.bmRates?.paymentPct ?? 1;
      const ccbm = c.kind === "accessory" ? (ctx.bmRates?.ccbmAccessoryEur ?? 1.99) : (ctx.bmRates?.ccbmFixedEur ?? 6.99);
      const eur = price * ((c.pct + payPct) / 100) + ccbm;
      commissionPln = toPln(eur, "EUR", date, ctx);
      commissionSource = "szacunek";
      const why =
        c.kind === "accessory"
          ? "akcesorium konsolowe — 20% bez obniżki"
          : c.kind === "console"
            ? c.accelerator
              ? `konsola do ${row.country_code} w okresie programu Accelerator (11% − 5 pkt proc.)`
              : `konsola${row.country_code && BM_ACCELERATOR.markets.includes(row.country_code.toUpperCase()) ? " poza okresem programu Accelerator" : ` do ${row.country_code || "nieznanego kraju"} (poza FR/DE/ES/IT)`} — stawka standardowa 11%`
            : "produkt spoza konsol — stawka standardowa 11%";
      commNote = `SZACUNEK (zamówienia nie ma jeszcze na wgranej fakturze): ${f2(price)} € × (${c.pct}% prowizji [${why}] + ${f2(payPct)}% opłaty płatniczej) + CCBM ${f2(ccbm)} € = ${f2(eur)} €${rateTxt}.`;
    }
  }
  if (commissionPln === null) flags.push("brak prowizji");
  else if (commissionSource === "szacunek") flags.push("prowizja szacowana wg reguł");
  details.push({ key: "commission", label: "Prowizja marketplace", sign: "-", amountPln: commissionPln === null ? null : round2(commissionPln), note: commNote });

  details.push({ key: "service", label: "Koszty serwisu", sign: "-", amountPln: null, note: "Jeszcze nieuwzględniane w marży (dodamy po wprowadzeniu kosztów części)." });

  const marginPln =
    salePln !== null && purchase !== null && vatPln !== null
      ? round2(salePln - purchase - vatPln - (shippingPln ?? 0) - (extraPln ?? 0) - (commissionPln ?? 0))
      : null;
  details.push({
    key: "margin",
    label: "Marża",
    sign: "=",
    amountPln: marginPln,
    note: marginPln === null ? "Nie do policzenia — brakuje ceny sprzedaży (lub kursu) albo ceny zakupu." : "sprzedaż − zakup − VAT od marży − wysyłka − koszty dodatkowe − prowizja (− serwis). Brakujące koszty liczone jako 0 (patrz ostrzeżenia).",
  });

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
    details,
  };
}
