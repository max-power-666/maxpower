// Zamówienia sprzedaży z marketplace'ów. Dziś tylko Back Market (GET /ws/orders); kolejne kanały
// dopisujemy tu jako nowe wartości `marketplace` + własny mapper, a lista "Zamówienia" (tabela
// sales_orders) pozostaje wspólna. Osobne od zamówień SKUPU (buyback_orders, lib/buybackOrders.ts).

export const MARKETPLACES = [{ key: "backmarket", label: "Back Market" }] as const;

// Stany zamówienia Back Market (dokumentacja API, tabela "Order State").
export const BM_ORDER_STATES: Record<string, string> = {
  "0": "Nowe (weryfikacja płatności)",
  "10": "Oczekuje na płatność",
  "1": "Opłacone (do zaakceptowania)",
  "3": "Do wysyłki",
  "8": "Nieopłacone",
  "9": "Wysłane",
};

export function salesStatusLabel(marketplace: string, status: string): string {
  if (marketplace === "backmarket") return BM_ORDER_STATES[status] ?? `Stan ${status}`;
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
