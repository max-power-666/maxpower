// Odpowiedź API Back Market (obiekt zamówienia BuyBack) -> wiersz tabeli buyback_orders.
// Wspólne dla synchronizacji (orders-sync) i walidacji (validate), które oba zapisują zamówienie.

// Stan zamówienia BuyBack wg dokumentacji Back Market (schema buybackOrderState, api.backmarket.dev) — ale
// dokumentacja wymienia tylko 10 wartości (NEW/PENDING/TO_SEND/SENT/RECEIVED/COUNTER_PROPOSAL/VALIDATED/
// PAID/MONEY_TRANSFERED/SUSPENDED); na żywych danych występuje też CANCELED, którego w ogóle nie ma w
// schemacie (sprawdzone 30.09.2026: 7477 z ok. 17,5 tys. zamówień — drugi po MONEY_TRANSFERED najczęstszy
// stan) — ufamy żywym danym, nie dokumentacji, i trzymamy go tu mimo braku w schemacie. Nieznana wartość
// (gdyby BM dodał kolejną) pokazuje się surowa zamiast wybuchać.
export const BUYBACK_ORDER_STATES: Record<string, string> = {
  NEW: "Nowe",
  PENDING: "Oczekujące",
  TO_SEND: "Do wysłania",
  SENT: "Wysłane",
  RECEIVED: "Odebrane",
  COUNTER_PROPOSAL: "Kontroferta",
  VALIDATED: "Zwalidowane",
  PAID: "Opłacone",
  MONEY_TRANSFERED: "Wypłacono",
  SUSPENDED: "Wstrzymane",
  CANCELED: "Anulowane",
};
export function buybackStatusLabel(status: string): string {
  return BUYBACK_ORDER_STATES[status] ?? status;
}
// Kolorystyka pogrupowana wg znaczenia (nie każdy status osobny kolor — za dużo wartości, żeby to było
// czytelne): teal = zakończone wypłatą, niebieski = kontroferta (wymaga decyzji), rust = wstrzymane/anulowane,
// amber = wszystko inne w trakcie zwykłego biegu (nowe/oczekujące/do wysłania/wysłane/odebrane).
export function buybackStatusStyle(status: string): string {
  if (status === "VALIDATED" || status === "PAID" || status === "MONEY_TRANSFERED") return "bg-tealsoft text-teal";
  if (status === "COUNTER_PROPOSAL") return "bg-[#e3ecf9] text-[#2a6bb5]";
  if (status === "SUSPENDED" || status === "CANCELED") return "bg-rustsoft text-rust";
  return "bg-ambersoft text-amber";
}

export function mapOrder(o: any) {
  return {
    order_public_id: o.orderPublicId,
    status: o.status,
    market: o.market ?? null,
    creation_date: o.creationDate,
    modification_date: o.modificationDate,
    shipping_date: o.shippingDate ?? null,
    suspension_date: o.suspensionDate ?? null,
    receival_date: o.receivalDate ?? null,
    payment_date: o.paymentDate ?? null,
    counter_proposal_date: o.counterProposalDate ?? null,
    sku: o.listing?.sku ?? null,
    product_id: o.listing?.productId ?? null,
    product_title: o.listing?.title ?? null,
    grade: o.listing?.grade ?? null,
    customer_first_name: o.customer?.firstName ?? null,
    customer_last_name: o.customer?.lastName ?? null,
    customer_phone: o.customer?.phone ?? null,
    return_address: o.returnAddress ?? null,
    original_price: o.originalPrice?.value ?? null,
    original_price_currency: o.originalPrice?.currency ?? null,
    counter_offer_price: o.counterOfferPrice?.value ?? null,
    counter_offer_price_currency: o.counterOfferPrice?.currency ?? null,
    tracking_number: o.trackingNumber ?? null,
    shipper: o.shipper ?? null,
    transfer_certificate_link: o.transferCertificateLink ?? null,
    suspend_reasons: o.suspendReasons ?? null,
    counter_offer_reasons: o.counterOfferReasons ?? null,
    raw: o,
    synced_at: new Date().toISOString(),
  };
}
