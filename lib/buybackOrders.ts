// Odpowiedź API Back Market (obiekt zamówienia BuyBack) -> wiersz tabeli buyback_orders.
// Wspólne dla synchronizacji (orders-sync) i walidacji (validate), które oba zapisują zamówienie.

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
