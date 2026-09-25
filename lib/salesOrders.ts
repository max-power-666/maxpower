// Zamówienia sprzedaży z marketplace'ów. Dziś tylko Back Market (GET /ws/orders); kolejne kanały
// dopisujemy tu jako nowe wartości `marketplace` + własny mapper, a lista "Zamówienia" (tabela
// sales_orders) pozostaje wspólna. Osobne od zamówień SKUPU (buyback_orders, lib/buybackOrders.ts).

export const MARKETPLACES = [
  { key: "backmarket", label: "Back Market" },
  { key: "refurbed", label: "Refurbed" },
  { key: "erli", label: "Erli" },
  { key: "allegro", label: "Allegro" },
] as const;

// Nasz wewnętrzny status realizacji zamówienia (niezależny od statusu kanału) — kolumna sales_orders.our_status.
export const OUR_STATUSES = [
  { key: "nowe", label: "Nowe" },
  { key: "w_realizacji", label: "W realizacji" },
  { key: "wyslane", label: "Wysłane" },
] as const;
export type OurStatus = (typeof OUR_STATUSES)[number]["key"];

// Stany zamówienia Back Market (dokumentacja API, tabela "Order State").
export const BM_ORDER_STATES: Record<string, string> = {
  "0": "Nowe (weryfikacja płatności)",
  "10": "Oczekuje na płatność",
  "1": "Do zaakceptowania",
  "3": "Do wysyłki",
  "8": "Nieopłacone",
  "9": "Wysłane",
};

// Stany zamówienia refurbed (OrderState z API) — liczone z stanów pozycji.
export const REFURBED_ORDER_STATES: Record<string, string> = {
  NEW: "Nowe",
  ACCEPTED: "Zaakceptowane",
  SHIPPED: "Wysłane",
  FULFILLED: "Zrealizowane",
  PARTIALLY_FULFILLED: "Częściowo zrealizowane",
  UNFULFILLED: "Niezrealizowane",
  REJECTED: "Odrzucone",
  CANCELLED: "Anulowane",
  RETURNED: "Zwrócone",
};

// Stany zamówienia Erli (pole status): pending = czeka na płatność, purchased = opłacone (także pobranie).
// UWAGA: w API zamówienie za pobraniem (COD) też ma status "purchased" (tak samo jak opłacone), więc żeby ich nie mylić
// zapisujemy je w sales_orders jako "purchased_cod" (patrz mapErliToSales) — to nasz znacznik, nie wartość z API.
export const ERLI_ORDER_STATES: Record<string, string> = {
  pending: "Oczekuje na płatność",
  purchased: "Opłacone",
  purchased_cod: "Za pobraniem",
  cancelled: "Anulowane",
  returned: "Zwrócone",
};

// Stany zamówienia Allegro (checkout form). UWAGA jak przy Erli: zamówienie za pobraniem (payment.type = CASH_ON_DELIVERY)
// ma ten sam status READY_FOR_PROCESSING co opłacone, więc zapisujemy je jako "READY_FOR_PROCESSING_COD" (nasz znacznik).
export const ALLEGRO_ORDER_STATES: Record<string, string> = {
  BOUGHT: "Kupione (bez formularza)",
  FILLED_IN: "Oczekuje na płatność",
  READY_FOR_PROCESSING: "Opłacone",
  READY_FOR_PROCESSING_COD: "Za pobraniem",
  CANCELLED: "Anulowane",
};

export function salesStatusLabel(marketplace: string, status: string): string {
  if (marketplace === "backmarket") return BM_ORDER_STATES[status] ?? `Stan ${status}`;
  if (marketplace === "refurbed") return REFURBED_ORDER_STATES[status] ?? status;
  if (marketplace === "erli") return ERLI_ORDER_STATES[status] ?? status;
  if (marketplace === "allegro") return ALLEGRO_ORDER_STATES[status] ?? status;
  return status;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Odpowiedź GET /ws/orders (jedno zamówienie) -> wiersz surowej tabeli bm_orders.
export function mapBmOrder(o: any) {
  return {
    order_id: o.order_id,
    state: o.state,
    country_code: o.country_code ?? null,
    date_creation: o.date_creation ?? null,
    date_modification: o.date_modification ?? null,
    date_payment: o.date_payment ?? null,
    date_shipping: o.date_shipping ?? null,
    expected_dispatch_date: o.expected_dispatch_date ?? null,
    price: num(o.price),
    shipping_price: num(o.shipping_price),
    currency: o.currency ?? null,
    sales_taxes: num(o.sales_taxes),
    payment_method: o.payment_method ?? null,
    installment_payment: o.installment_payment ?? null,
    paypal_reference: o.paypal_reference ?? null,
    delivery_mode: o.delivery_mode ?? null,
    delivery_note: o.delivery_note ?? null,
    tracking_number: o.tracking_number ?? null,
    tracking_url: o.tracking_url ?? null,
    shipper_display: o.shipper_display ?? null,
    is_backship: o.is_backship ?? null,
    orderlines: o.orderlines ?? null,
    shipping_address: o.shipping_address ?? null,
    billing_address: o.billing_address ?? null,
    raw: o,
    synced_at: new Date().toISOString(),
  };
}

// To samo zamówienie -> wiersz wspólnej tabeli sales_orders. W orderlines[].listing API zwraca SKU.
export function mapBmToSales(o: any) {
  const skus = Array.from(
    new Set(((o.orderlines as any[]) || []).map((l) => (typeof l?.listing === "string" ? l.listing.trim() : "")).filter(Boolean))
  );
  return {
    marketplace: "backmarket",
    external_id: String(o.order_id),
    order_date: o.date_creation ?? null,
    status: String(o.state),
    sku: skus.length > 0 ? skus.join(", ") : null,
    tracking_number: o.tracking_number || null,
    synced_at: new Date().toISOString(),
  };
}

// Pozycje zamówienia -> wiersze sales_order_items. Jedna sztuka = jeden wiersz (pozycja z ilością > 1 jest
// rozbijana), klucz to id pozycji z API ("id", dla kolejnych sztuk "id-2", "id-3"). Ta sama zasada kluczy
// i kolejności jest w jednorazowym uzupełnieniu w supabase/sales-orders.sql — zmieniając jedno, zmień drugie.
export function mapBmItems(o: any) {
  const items: { marketplace: string; external_id: string; item_key: string; position: number; sku: string | null }[] = [];
  const lines: any[] = Array.isArray(o.orderlines) ? o.orderlines : [];
  lines.forEach((l, i) => {
    const qty = Math.max(Number.isFinite(Number(l?.quantity)) ? Math.trunc(Number(l.quantity)) : 1, 1);
    const base = String(l?.id ?? i + 1);
    const sku = typeof l?.listing === "string" && l.listing.trim() ? l.listing.trim() : null;
    for (let k = 1; k <= qty; k++) {
      items.push({
        marketplace: "backmarket",
        external_id: String(o.order_id),
        item_key: k > 1 ? `${base}-${k}` : base,
        position: items.length + 1,
        sku,
      });
    }
  });
  return items;
}

/* ---------------- refurbed ---------------- */

// Zamówienie refurbed (Order z API) -> wiersz surowej tabeli refurbed_orders. Reszta pól (adresy, pozycje,
// prowizje...) zostaje w `raw`.
export function mapRefurbedOrder(o: any) {
  return {
    id: String(o.id),
    state: o.state ?? "UNSPECIFIED",
    released_at: o.released_at ?? null,
    customer_email: o.customer_email ?? null,
    currency_code: o.currency_code ?? null,
    total_charged: num(o.total_charged),
    payment_method: o.payment_method ?? null,
    raw: o,
    synced_at: new Date().toISOString(),
  };
}

// Numer przesyłki: refurbed nie ma numeru, tylko link śledzenia paczki na pozycji — bierzemy pierwszy niepusty.
const refurbedTracking = (o: any): string | null => {
  for (const it of (o.items as any[]) || []) if (typeof it?.parcel_tracking_url === "string" && it.parcel_tracking_url.trim()) return it.parcel_tracking_url.trim();
  return null;
};

export function mapRefurbedToSales(o: any) {
  const skus = Array.from(new Set(((o.items as any[]) || []).map((i) => (typeof i?.sku === "string" ? i.sku.trim() : "")).filter(Boolean)));
  return {
    marketplace: "refurbed",
    external_id: String(o.id),
    order_date: o.released_at ?? null,
    status: String(o.state ?? "UNSPECIFIED"),
    sku: skus.length > 0 ? skus.join(", ") : null,
    tracking_number: refurbedTracking(o),
    synced_at: new Date().toISOString(),
  };
}

// W refurbed każda sztuka to osobna pozycja (order_item) z własnym id — to jest klucz pozycji.
export function mapRefurbedItems(o: any) {
  return ((o.items as any[]) || []).map((it, i) => ({
    marketplace: "refurbed",
    external_id: String(o.id),
    item_key: String(it?.id ?? i + 1),
    position: i + 1,
    sku: typeof it?.sku === "string" && it.sku.trim() ? it.sku.trim() : null,
  }));
}

/* ---------------- Erli ---------------- */

// Zamówienie Erli (Order z API) -> wiersz surowej tabeli erli_orders. Kwoty w API są w groszach (całkowite).
export function mapErliOrder(o: any) {
  return {
    id: String(o.id),
    status: o.status ?? "pending",
    seller_status: o.sellerStatus ?? null,
    market: o.market ?? null,
    currency: o.currency ?? null,
    total_price: Number.isFinite(Number(o.totalPrice)) ? Math.trunc(Number(o.totalPrice)) : null,
    created: o.created ?? null,
    updated: o.updated ?? null,
    purchased_at: o.purchasedAt ?? null,
    raw: o,
    synced_at: new Date().toISOString(),
  };
}

// SKU pozycji Erli: pole sku jest opcjonalne, wtedy bierzemy externalId (id produktu w systemie sprzedawcy).
const erliItemSku = (it: any): string | null => {
  const v = typeof it?.sku === "string" && it.sku.trim() ? it.sku.trim() : typeof it?.externalId === "string" ? it.externalId.trim() : "";
  return v || null;
};

export function mapErliToSales(o: any) {
  const skus = Array.from(new Set(((o.items as any[]) || []).map(erliItemSku).filter((x): x is string => !!x)));
  const tr = o.deliveryTracking;
  return {
    marketplace: "erli",
    external_id: String(o.id),
    order_date: o.created ?? null,
    // Za pobraniem = status "purchased" + delivery.cod. Tylko "purchased": anulowane/zwrócone zostają, jak są.
    status: o.status === "purchased" && o.delivery?.cod === true ? "purchased_cod" : String(o.status ?? "pending"),
    sku: skus.length > 0 ? skus.join(", ") : null,
    tracking_number: (tr?.trackingNumber && String(tr.trackingNumber).trim()) || (tr?.trackingUrl && String(tr.trackingUrl).trim()) || null,
    synced_at: new Date().toISOString(),
  };
}

// Pozycja Erli z ilością > 1 jest rozbijana na osobne sztuki (jak w Back Market): klucz "id", "id-2", "id-3"...
export function mapErliItems(o: any) {
  const items: { marketplace: string; external_id: string; item_key: string; position: number; sku: string | null }[] = [];
  ((o.items as any[]) || []).forEach((it, i) => {
    const qty = Math.max(Number.isFinite(Number(it?.quantity)) ? Math.trunc(Number(it.quantity)) : 1, 1);
    const base = String(it?.id ?? i + 1);
    for (let k = 1; k <= qty; k++) {
      items.push({
        marketplace: "erli",
        external_id: String(o.id),
        item_key: k > 1 ? `${base}-${k}` : base,
        position: items.length + 1,
        sku: erliItemSku(it),
      });
    }
  });
  return items;
}

/* ---------------- Allegro ---------------- */

// Zamówienie Allegro (checkout form) -> wiersz surowej tabeli allegro_orders.
export function mapAllegroOrder(o: any) {
  return {
    id: String(o.id),
    status: o.status ?? "BOUGHT",
    fulfillment_status: o.fulfillment?.status ?? null,
    payment_type: o.payment?.type ?? null,
    marketplace_id: o.marketplace?.id ?? null,
    buyer_login: o.buyer?.login ?? null,
    total_to_pay: num(o.summary?.totalToPay?.amount),
    currency: o.summary?.totalToPay?.currency ?? null,
    updated_at: o.updatedAt ?? null,
    raw: o,
    synced_at: new Date().toISOString(),
  };
}

// SKU pozycji Allegro: id oferty w systemie sprzedawcy (offer.external.id), a gdy go brak — id oferty Allegro.
const allegroItemSku = (li: any): string | null => {
  const v = (typeof li?.offer?.external?.id === "string" && li.offer.external.id.trim()) || (li?.offer?.id != null ? String(li.offer.id) : "");
  return v || null;
};

// Data zamówienia = najwcześniejszy zakup pozycji (boughtAt); gdy jej brak, data ostatniej zmiany.
const allegroOrderDate = (o: any): string | null => {
  const dates = ((o.lineItems as any[]) || []).map((li) => li?.boughtAt).filter((d): d is string => typeof d === "string" && !!d).sort();
  return dates[0] ?? o.updatedAt ?? null;
};

export function mapAllegroToSales(o: any) {
  const skus = Array.from(new Set(((o.lineItems as any[]) || []).map(allegroItemSku).filter((x): x is string => !!x)));
  // Numer przesyłki (waybill) nie jest na liście zamówień — dociągamy go osobnym zapytaniem do /shipments (pole _shipments).
  const waybill = ((o._shipments as any[]) || []).map((s) => (typeof s?.waybill === "string" ? s.waybill.trim() : "")).find(Boolean);
  return {
    marketplace: "allegro",
    external_id: String(o.id),
    order_date: allegroOrderDate(o),
    status: o.status === "READY_FOR_PROCESSING" && o.payment?.type === "CASH_ON_DELIVERY" ? "READY_FOR_PROCESSING_COD" : String(o.status ?? "BOUGHT"),
    sku: skus.length > 0 ? skus.join(", ") : null,
    tracking_number: waybill || null,
    synced_at: new Date().toISOString(),
  };
}

// Pozycja z ilością > 1 jest rozbijana na osobne sztuki: klucz "id", "id-2", "id-3"...
export function mapAllegroItems(o: any) {
  const items: { marketplace: string; external_id: string; item_key: string; position: number; sku: string | null }[] = [];
  ((o.lineItems as any[]) || []).forEach((li, i) => {
    const qty = Math.max(Number.isFinite(Number(li?.quantity)) ? Math.trunc(Number(li.quantity)) : 1, 1);
    const base = String(li?.id ?? i + 1);
    for (let k = 1; k <= qty; k++) {
      items.push({
        marketplace: "allegro",
        external_id: String(o.id),
        item_key: k > 1 ? `${base}-${k}` : base,
        position: items.length + 1,
        sku: allegroItemSku(li),
      });
    }
  });
  return items;
}
