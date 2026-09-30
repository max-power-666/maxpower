// Zamówienia sprzedaży z marketplace'ów. Dziś tylko Back Market (GET /ws/orders); kolejne kanały
// dopisujemy tu jako nowe wartości `marketplace` + własny mapper, a lista "Zamówienia" (tabela
// sales_orders) pozostaje wspólna. Osobne od zamówień SKUPU (buyback_orders, lib/buybackOrders.ts).

export const MARKETPLACES = [
  { key: "backmarket", label: "Back Market" },
  { key: "refurbed", label: "Refurbed" },
  { key: "erli", label: "Erli" },
  { key: "allegro", label: "Allegro" },
  { key: "octopia", label: "Octopia" },
  { key: "amazon", label: "Amazon" },
  { key: "apilo", label: "Amazon (Apilo)" }, // integracja wycofana (zastąpiona bezpośrednim SP-API) — etykieta zostaje tylko dla historycznych zamówień
] as const;

// Kubełek statusu do filtrowania/wyświetlania na liście Zamówień — zastępuje dawne "Nasz status" (ręcznie
// zmieniane pole `sales_orders.our_status`), wycofane 30.09.2026 na prośbę właściciela: zamiast ręcznie śledzić
// postęp, korzystamy wprost ze statusu, jaki już mamy z synchronizacji każdego kanału. "Wysłane" i "Anulowane" to
// zamknięte, jednoznaczne stany; wszystko inne (do zaakceptowania, do wysyłki, oczekuje na płatność, opłacone, za
// pobraniem, w przygotowaniu...) to po prostu "Nowe" — wymaga jeszcze działania z naszej strony. Kolumna
// `our_status` zostaje w bazie jako martwy, nieużywany relikt (bez migracji usuwającej) — to samo podejście co przy
// tabeli `units` czy `apilo_orders`.
export type StatusBucket = "nowe" | "wyslane" | "anulowane";
export const STATUS_BUCKETS: { key: StatusBucket; label: string }[] = [
  { key: "nowe", label: "Nowe" },
  { key: "wyslane", label: "Wysłane" },
  { key: "anulowane", label: "Anulowane" },
];

// Te same listy co przy jednorazowych porządkach z 28-29.09.2026 (patrz historia zmian) — tam ustawiały
// "Nasz status" raz, tu klasyfikują na bieżąco, bez zapisu do bazy. refurbed FULFILLED (zrealizowane, czyli już
// dawno wysłane) i REJECTED/RETURNED (odrzucone/zwrócone — zamknięte, jak anulowane) dopisane tu świadomie, żeby
// nie zaśmiecały "Nowe" mimo że nie były częścią tamtego jednorazowego backfillu.
const SHIPPED_STATUS: Record<string, string[]> = {
  backmarket: ["9"],
  refurbed: ["SHIPPED", "FULFILLED"],
  erli: ["sent"], // nasz znacznik (erliDerivedStatus) — Erli sam nie ma "wysłane" na poziomie zamówienia
  allegro: ["SENT"], // nasz znacznik (allegroDerivedStatus) — status zamówienia sam nie ma "wysłane", patrz niżej
  octopia: ["Shipped", "Delivered"],
  amazon: ["Shipped"],
};
const CANCELLED_STATUS: Record<string, string[]> = {
  backmarket: ["cancelled", "refunded"],
  refurbed: ["CANCELLED", "REJECTED", "RETURNED"],
  erli: ["cancelled", "returned"],
  allegro: ["CANCELLED", "RETURNED"], // RETURNED to też nasz znacznik (allegroDerivedStatus)
  octopia: ["Cancelled", "Rejected", "Refused"], // Refused (56 zamówień na żywych danych) był pomijany — leciał do "nowe"
  amazon: ["Canceled"],
};

export function statusBucket(marketplace: string, status: string): StatusBucket {
  if ((SHIPPED_STATUS[marketplace] ?? []).includes(status)) return "wyslane";
  if ((CANCELLED_STATUS[marketplace] ?? []).includes(status)) return "anulowane";
  return "nowe";
}

// Fragment filtra PostgREST (do supabase-js .or()/.not()) dla danego kubełka, zbudowany z TYCH SAMYCH list co
// statusBucket — żeby filtr na liście i etykieta w wierszu nigdy sobie nie zaprzeczyły. "Nowe" to NOT (wysłane OR
// anulowane), więc nie potrzebuje własnej listy — patrz użycie w SalesOrdersHub.tsx.
function bucketOrFilter(map: Record<string, string[]>): string {
  return Object.entries(map)
    .map(([mp, statuses]) => (statuses.length === 1 ? `and(marketplace.eq.${mp},status.eq.${statuses[0]})` : `and(marketplace.eq.${mp},status.in.(${statuses.join(",")}))`))
    .join(",");
}
export const shippedOrFilter = () => bucketOrFilter(SHIPPED_STATUS);
export const cancelledOrFilter = () => bucketOrFilter(CANCELLED_STATUS);

// Stany zamówienia Back Market (dokumentacja API, tabela "Order State").
export const BM_ORDER_STATES: Record<string, string> = {
  "0": "Nowe (weryfikacja płatności)",
  "10": "Oczekuje na płatność",
  "1": "Do zaakceptowania",
  "3": "Do wysyłki",
  "8": "Nieopłacone",
  "9": "Wysłane",
  // Nasze znaczniki wyliczone ze stanów pozycji (patrz mapBmToSales) — nie są wartościami z API:
  cancelled: "Anulowane",
  refunded: "Zwrot",
};

// Stany pozycji (orderline) Back Market — tabela "States for Orderlines" w dokumentacji API.
export const BM_ORDERLINE_STATES: Record<string, string> = {
  "0": "Nowa (czeka na płatność)",
  "9": "Wstrzymana",
  "8": "Oczekuje na płatność",
  "1": "Opłacona (do zaakceptowania)",
  "2": "Zaakceptowana",
  "3": "Wysłana",
  "4": "Anulowana",
  "5": "Zwrot przed wysyłką",
  "6": "Zwrot po wysyłce",
  "7": "Nieopłacona",
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
// "sent" to TEŻ nasz znacznik, nie wartość z API — Erli na poziomie zamówienia w ogóle nie ma statusu "wysłane"
// (tylko pending/purchased/cancelled/returned); realny postęp (wysłano/dostarczono/wraca) siedzi w osobnym polu
// sellerStatus (erli_orders.seller_status), patrz erliDerivedStatus.
export const ERLI_ORDER_STATES: Record<string, string> = {
  pending: "Oczekuje na płatność",
  purchased: "Opłacone",
  purchased_cod: "Za pobraniem",
  sent: "Wysłane",
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
  // Nasze znaczniki wyliczone z fulfillment.status (patrz allegroDerivedStatus) — nie są wartościami status z API:
  SENT: "Wysłane",
  RETURNED: "Zwrócone",
};

// Stany zamówienia Octopia (Enums.Orders.Status).
export const OCTOPIA_ORDER_STATES: Record<string, string> = {
  Processing: "Przetwarzane",
  WaitingAcceptance: "Oczekuje na akceptację",
  Accepted: "Zaakceptowane",
  Refused: "Odrzucone",
  InPreparation: "W przygotowaniu",
  Shipped: "Wysłane",
  Delivered: "Dostarczone",
  Cancelled: "Anulowane",
  Rejected: "Odrzucone (kontrola)",
};

// Stany zamówienia Amazon (OrderStatus).
export const AMAZON_ORDER_STATES: Record<string, string> = {
  Pending: "Oczekuje na płatność",
  Unshipped: "Do wysyłki",
  PartiallyShipped: "Częściowo wysłane",
  Shipped: "Wysłane",
  Canceled: "Anulowane",
  Unfulfillable: "Niemożliwe do zrealizowania",
  InvoiceUnconfirmed: "Faktura niepotwierdzona",
  PendingAvailability: "Oczekuje na dostępność",
};

export function salesStatusLabel(marketplace: string, status: string): string {
  if (marketplace === "backmarket") return BM_ORDER_STATES[status] ?? `Stan ${status}`;
  if (marketplace === "refurbed") return REFURBED_ORDER_STATES[status] ?? status;
  if (marketplace === "erli") return ERLI_ORDER_STATES[status] ?? status;
  if (marketplace === "allegro") return ALLEGRO_ORDER_STATES[status] ?? status;
  if (marketplace === "octopia") return OCTOPIA_ORDER_STATES[status] ?? status;
  if (marketplace === "amazon") return AMAZON_ORDER_STATES[status] ?? status;
  return status;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Kod kraju odbiorcy (adres dostawy) do jednolitej postaci: 2 litery, wielkie, bez spacji. Niepełne/dziwne
// wartości (np. pełna nazwa kraju zamiast kodu) zostają odrzucone zamiast pokazywać coś mylącego.
const normCountry = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(s) ? s : null;
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

// Stan zamówienia w Back Market bywa mylący: gdy WSZYSTKIE pozycje dojdą do stanu końcowego, całe zamówienie dostaje stan 9
// ("przetworzone") — także wtedy, gdy klient je anulował i nic nie wysłano. Dlatego jeśli wszystkie pozycje są anulowane (4)
// albo zwrócone (5, 6), pokazujemy "cancelled" / "refunded" zamiast stanu zamówienia. Zamówienie tylko częściowo anulowane
// zachowuje stan z API (stany pozycji widać na karcie). Tę samą regułę ma jednorazowa poprawka w supabase/sales-orders.sql.
export function bmDerivedStatus(o: any): string {
  const states = ((o.orderlines as any[]) || []).map((l) => Number(l?.state));
  if (states.length > 0 && states.every((s) => s === 4)) return "cancelled";
  if (states.length > 0 && states.every((s) => s === 5 || s === 6)) return "refunded";
  return String(o.state);
}

// Metoda wysyłki (na razie tylko Back Market — inne kanały nie mają tego pola, null -> "—" w UI).
// Back Market API nie ma osobnego pola "standard/express": jedyny sygnał to shipper_display, nazwa przewoźnika/
// usługi wybrana dla zamówienia ("DHL" albo "DHL Express" w danych Recoo — potwierdzone na żywych zamówieniach,
// zanim jeszcze cokolwiek wysłaliśmy, więc to nie echo tego, co MY zgłaszamy, tylko coś ustalone wcześniej).
// delivery_mode to coś zupełnie innego (HOME_DELIVERY/COLLECTION_POINT — sposób ODBIORU, nie tempo wysyłki).
// Rozpoznajemy po słowie "express" w nazwie zamiast trzymać sztywną listę przewoźników (API dopuszcza różne: DHL,
// Colissimo, UPS...), żeby nowy przewoźnik bez "express" w nazwie sam wpadł do "Standard", a nie do "—".
export function bmShippingMethodLabel(shipperDisplay: unknown): string | null {
  const s = typeof shipperDisplay === "string" ? shipperDisplay.trim() : "";
  if (!s) return null;
  return /express/i.test(s) ? "Express" : "Standard";
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
    planned_shipping_date: o.expected_dispatch_date ?? null,
    status: bmDerivedStatus(o),
    sku: skus.length > 0 ? skus.join(", ") : null,
    tracking_number: o.tracking_number || null,
    country_code: normCountry(o.shipping_address?.country),
    shipping_method: bmShippingMethodLabel(o.shipper_display),
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

// Nasze własne zgłoszenie wysyłki (notifyMarketplace -> BatchUpdateOrderItemsState) ustawia numer przesyłki na
// pozycji, ale NIE zmienia stanu zamówienia (o.state) na SHIPPED — a osobny mechanizm śledzenia po stronie
// refurbed (item.shipment_status, wypełniany dopiero gdy przewoźnik zacznie raportować zdarzenia: INFO_RECEIVED/
// IN_TRANSIT/OUT_FOR_DELIVERY/AVAILABLE_FOR_PICKUP/DELIVERED/FAILED_ATTEMPT/EXCEPTION) potrafi już pokazywać
// realny postęp, podczas gdy o.state wciąż wisi na "ACCEPTED" — sprawdzone na żywych danych: zamówienie
// zsynchronizowane 29.09.2026 miało item.shipment_status="DELIVERED" (paczka faktycznie doręczona wg DHL), a
// o.state wciąż "ACCEPTED" (zgłoszone przez właściciela — kilka takich zamówień z numerem przesyłki w kolumnie
// "Nowe"). refurbedDerivedStatus podnosi taki przypadek do "SHIPPED" (wartość, którą refurbed i tak czasem sam
// zwraca — już w SHIPPED_STATUS) — o.state CANCELLED/REJECTED/RETURNED zostaje NADRZĘDNY, jak w pozostałych kanałach.
function refurbedDerivedStatus(o: any): string {
  const raw = String(o.state ?? "UNSPECIFIED");
  if (raw === "CANCELLED" || raw === "REJECTED" || raw === "RETURNED") return raw;
  const shipped = ((o.items as any[]) || []).some((it) => typeof it?.shipment_status === "string" && it.shipment_status && it.shipment_status !== "UNSPECIFIED");
  return shipped ? "SHIPPED" : raw;
}

export function mapRefurbedToSales(o: any) {
  const skus = Array.from(new Set(((o.items as any[]) || []).map((i) => (typeof i?.sku === "string" ? i.sku.trim() : "")).filter(Boolean)));
  return {
    marketplace: "refurbed",
    external_id: String(o.id),
    order_date: o.released_at ?? null,
    status: refurbedDerivedStatus(o),
    sku: skus.length > 0 ? skus.join(", ") : null,
    tracking_number: refurbedTracking(o),
    country_code: normCountry(o.shipping_address?.country_code),
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

// Status zamówienia (pending/purchased/cancelled/returned) NIE zawsze odzwierciedla realny postęp — Erli na tym
// poziomie w ogóle nie ma wartości "wysłane". Prawdziwy postęp siedzi w osobnym polu sellerStatus (created/
// readyToProcess/inProgress/sent/readyToPickup/received/returned/returningToSender/canceled/unknown — "Status
// zamówienia w systemie sprzedawcy" wg dokumentacji Erli), które dociera do nas jako erli_orders.seller_status, ale
// samo `status` go nie uwzględniało. Sprawdzone na żywych danych (30.09.2026, zgłoszenie właściciela): 472 zamówienia
// z seller_status="received" (DOSTARCZONE) miały status zamówienia wciąż "purchased" ("Opłacone"). Priorytet:
// cancelled/returned na poziomie ZAMÓWIENIA są jednoznaczne i nadrzędne (sellerStatus już nic tu nie zmienia);
// inaczej sellerStatus może podnieść "purchased"/"purchased_cod" do "sent" (wysłane/w drodze/dostarczone — celowo
// jeden wspólny znacznik, bez rozróżniania "w drodze" od "dostarczone") albo "cancelled"/"returned" (ten sam wzorzec
// co bmDerivedStatus dla Back Marketu — zamówienie może się okazać zamknięte, mimo że jego własny `status` tego nie
// pokazuje). **Trzeci, jeszcze bardziej wiarygodny sygnał: `deliveryTracking.status`** — realny status śledzenia
// przesyłki OD PRZEWOŹNIKA (InPost/DHL/...), niezależny od `sellerStatus` (który jest tylko polem "co sprzedawca
// ustawił w panelu Erli" i potrafi utknąć, mimo że przesyłka faktycznie dojechała). Sprawdzone na żywych danych
// 30.09.2026 (zgłoszenie właściciela — zamówienia sprzed prawie roku z numerem przesyłki wciąż pokazujące
// "Opłacone"): 34 zamówienia miały `deliveryTracking.status` = "sent"/"delivered", a `sellerStatus` wciąż utknięty
// na "inProgress". Oba sygnały sprawdzamy równolegle — który jako pierwszy wskaże postęp, ten wygrywa; `returned`
// ma pierwszeństwo przed `sent`/`cancelled` (późniejszy etap cyklu życia). **`readyToSend`/`waitingForCourier`
// też liczą się jako "wysłane"**, nie tylko `sent`/`readyToPickup`/`delivered` — enum `deliveryTracking.status`
// wg dokumentacji Erli sugeruje kolejność `preparing < readyToSend < waitingForCourier < sent < readyToPickup <
// ... < delivered` (czyli formalnie to jeszcze etap przed nadaniem), ale na żywych danych (30.09.2026, potwierdzone
// przez właściciela na 3 konkretnych zamówieniach — w tym jednym wysłanym poza naszą integracją Paczkomatów, z
// realnym numerem przesyłki UPS) paczka była już fizycznie wysłana, mimo że Erli samo nie zdążyło jeszcze przesunąć
// statusu dalej niż `readyToSend`. Dla naszych potrzeb liczy się fakt istnienia numeru przesyłki, nie dokładny etap
// u przewoźnika — ten sam "jeden wspólny znacznik" co przy `sent`/`readyToPickup`/`delivered`. Jedyny etap PRZED
// faktycznym nadaniem to `preparing` (label jeszcze nie gotowy) — ten świadomie zostaje bez zmian.
function erliDerivedStatus(o: any): string {
  const raw = String(o.status ?? "pending");
  if (raw === "cancelled" || raw === "returned") return raw;
  const base = raw === "purchased" && o.delivery?.cod === true ? "purchased_cod" : raw;
  const ss = o.sellerStatus;
  const dt = o.deliveryTracking?.status;
  const isReturned = ss === "returned" || ss === "returningToSender" || dt === "returned";
  const isCancelled = ss === "canceled" || dt === "canceled";
  const dtSent = dt === "sent" || dt === "readyToPickup" || dt === "delivered" || dt === "readyToSend" || dt === "waitingForCourier";
  const isSent = ss === "sent" || ss === "readyToPickup" || ss === "received" || dtSent;
  if (isReturned) return "returned";
  if (isCancelled) return "cancelled";
  if (isSent) return "sent";
  return base;
}

export function mapErliToSales(o: any) {
  const skus = Array.from(new Set(((o.items as any[]) || []).map(erliItemSku).filter((x): x is string => !!x)));
  const tr = o.deliveryTracking;
  return {
    marketplace: "erli",
    external_id: String(o.id),
    order_date: o.created ?? null,
    status: erliDerivedStatus(o),
    sku: skus.length > 0 ? skus.join(", ") : null,
    tracking_number: (tr?.trackingNumber && String(tr.trackingNumber).trim()) || (tr?.trackingUrl && String(tr.trackingUrl).trim()) || null,
    country_code: normCountry(o.user?.deliveryAddress?.country),
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

// Status zamówienia (checkout form) Allegro NIE ma wartości "wysłane" — to tylko BOUGHT/FILLED_IN/READY_FOR_PROCESSING/
// CANCELLED. Realny postęp realizacji siedzi w osobnym polu fulfillment.status ("Status realizacji" na karcie zamówienia,
// zapisywane w allegro_orders.fulfillment_status): NEW/PROCESSING/READY_FOR_SHIPMENT/READY_FOR_PICKUP/SENT/PICKED_UP/
// CANCELLED/SUSPENDED/RETURNED (dokumentacja Allegro: SENT ustawia się samo po dodaniu numeru przesyłki — dokładnie ten
// przypadek zgłoszony przez właściciela 30.09.2026, zamówienie z fulfillment.status=SENT pokazywało w kolumnie Status
// wciąż "Opłacone"). Ten sam wzorzec co erliDerivedStatus dla Erli: status zamówienia (CANCELLED) jest NADRZĘDNY —
// fulfillment już nic tam nie zmienia; inaczej SENT/PICKED_UP (odebrane przez kuriera z paczkomatu — też koniec drogi
// u nas, jeden wspólny znacznik jak przy Erli) -> "SENT", fulfillment.status CANCELLED (seller anulował realizację już
// opłaconego zamówienia — sprawdzone na żywych danych: 4 zamówienia w tym stanie) -> nasz "CANCELLED" (ta sama etykieta
// co anulowanie na poziomie zamówienia), RETURNED (całość zwrócona i zrefundowana, ustawiane tylko automatycznie przez
// Allegro) -> "RETURNED".
function allegroDerivedStatus(o: any): string {
  const raw = String(o.status ?? "BOUGHT");
  if (raw === "CANCELLED") return raw;
  const base = raw === "READY_FOR_PROCESSING" && o.payment?.type === "CASH_ON_DELIVERY" ? "READY_FOR_PROCESSING_COD" : raw;
  const fs = o.fulfillment?.status;
  if (fs === "SENT" || fs === "PICKED_UP") return "SENT";
  if (fs === "CANCELLED") return "CANCELLED";
  if (fs === "RETURNED") return "RETURNED";
  return base;
}

export function mapAllegroToSales(o: any) {
  const skus = Array.from(new Set(((o.lineItems as any[]) || []).map(allegroItemSku).filter((x): x is string => !!x)));
  // Numer przesyłki (waybill) nie jest na liście zamówień — dociągamy go osobnym zapytaniem do /shipments (pole _shipments).
  const waybill = ((o._shipments as any[]) || []).map((s) => (typeof s?.waybill === "string" ? s.waybill.trim() : "")).find(Boolean);
  return {
    marketplace: "allegro",
    external_id: String(o.id),
    order_date: allegroOrderDate(o),
    status: allegroDerivedStatus(o),
    sku: skus.length > 0 ? skus.join(", ") : null,
    tracking_number: waybill || null,
    country_code: normCountry(o.delivery?.address?.countryCode),
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

/* ---------------- podsumowanie dzienne ---------------- */

// Statusy, które NIE liczą się do "liczby zamówień": anulowane, zwrócone/odrzucone i jeszcze nieopłacone
// (klient nie zapłacił, więc to nie jest jeszcze zamówienie do realizacji). Zamówienie za pobraniem liczy się.
const NOT_COUNTED: Record<string, string[]> = {
  backmarket: ["cancelled", "refunded", "10", "0", "8"],
  refurbed: ["CANCELLED", "REJECTED", "RETURNED"],
  erli: ["cancelled", "returned", "pending"],
  allegro: ["CANCELLED", "BOUGHT", "FILLED_IN", "RETURNED"],
  octopia: ["Cancelled", "Rejected", "Refused"], // brakujący wpis do 30.09.2026 — te statusy liczyły się jak żywe zamówienia
};

export function isCountedOrder(marketplace: string, status: string): boolean {
  return !(NOT_COUNTED[marketplace] ?? []).includes(status);
}

export type DayCount = { total: number; byMarketplace: Record<string, number> };

// Liczy zamówienia z dzisiaj i wczoraj według LOKALNEJ doby (północ do północy w strefie przeglądarki).
export function summarizeDays(
  rows: { marketplace: string; status: string; order_date: string | null }[],
  now: Date = new Date()
): { today: DayCount; yesterday: DayCount } {
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const out = { today: { total: 0, byMarketplace: {} as Record<string, number> }, yesterday: { total: 0, byMarketplace: {} as Record<string, number> } };
  for (const r of rows) {
    if (!r.order_date || !isCountedOrder(r.marketplace, r.status)) continue;
    const t = Date.parse(r.order_date);
    const bucket = t >= startToday ? out.today : t >= startYesterday ? out.yesterday : null;
    if (!bucket || t >= startToday + 24 * 3600 * 1000 + 3600 * 1000) continue; // przyszłe daty (błędne dane) pomijamy
    bucket.total += 1;
    bucket.byMarketplace[r.marketplace] = (bucket.byMarketplace[r.marketplace] ?? 0) + 1;
  }
  return out;
}

export const startOfYesterdayIso = (now: Date = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();

// Jedna operacja upsert nie może zawierać dwóch wierszy o tym samym kluczu ("ON CONFLICT DO UPDATE command cannot affect row a
// second time"), a paczki pobranych zamówień potrafią mieć duplikaty: kursor po dacie jest włączny (kolejna strona zaczyna od
// ostatniego zamówienia poprzedniej), a lista z numerami stron przesuwa się, gdy zamówienie zmieni się w trakcie pobierania.
// Przy powtórzeniu wygrywa późniejsze (świeższe) wystąpienie.
export function uniqueBy<T>(list: T[], key: (item: T) => string): T[] {
  const m = new Map<string, T>();
  for (const item of list) m.set(key(item), item);
  return Array.from(m.values());
}

/* ---------------- Octopia ---------------- */

// Zamówienie Octopia -> wiersz surowej tabeli octopia_orders.
export function mapOctopiaOrder(o: any) {
  return {
    id: String(o.orderId),
    reference: o.reference ?? null,
    status: o.status ?? "Processing",
    sales_channel_id: o.salesChannel?.id ?? null,
    sales_channel_name: o.salesChannel?.name ?? null,
    currency_code: o.currencyCode ?? null,
    total_price: num(o.totalPrice?.sellingPrice ?? o.totalPrice?.offerPrice),
    purchased_at: o.purchasedAt ?? null,
    updated_at: o.updatedAt ?? null,
    created_at: o.createdAt ?? null,
    raw: o,
    synced_at: new Date().toISOString(),
  };
}

// Numer przesyłki: pierwszy niepusty parcelNumber z dowolnej pozycji.
const octopiaTracking = (o: any): string | null => {
  for (const l of (o.lines as any[]) || []) for (const p of (l.parcels as any[]) || []) if (typeof p?.parcelNumber === "string" && p.parcelNumber.trim()) return p.parcelNumber.trim();
  return null;
};

// Kraj odbiorcy: Octopia nie ma adresu na poziomie zamówienia, tylko na każdej pozycji — bierzemy pierwszą, która go ma.
const octopiaCountry = (o: any): string | null => {
  for (const l of (o.lines as any[]) || []) {
    const c = normCountry(l?.shippingAddress?.countryCode);
    if (c) return c;
  }
  return null;
};

export function mapOctopiaToSales(o: any) {
  const skus = Array.from(new Set(((o.lines as any[]) || []).map((l) => (typeof l?.offer?.sellerProductId === "string" ? l.offer.sellerProductId.trim() : "")).filter(Boolean)));
  return {
    marketplace: "octopia",
    external_id: String(o.orderId),
    order_date: o.purchasedAt ?? o.createdAt ?? null,
    status: String(o.status ?? "Processing"),
    sku: skus.length > 0 ? skus.join(", ") : null,
    tracking_number: octopiaTracking(o),
    country_code: octopiaCountry(o),
    synced_at: new Date().toISOString(),
  };
}

// Każda pozycja Octopia to jedna sztuka (quantity > 1 rozbijamy jak w pozostałych kanałach): klucz "orderLineId", "id-2"...
export function mapOctopiaItems(o: any) {
  const items: { marketplace: string; external_id: string; item_key: string; position: number; sku: string | null }[] = [];
  ((o.lines as any[]) || []).forEach((l, i) => {
    const qty = Math.max(Number.isFinite(Number(l?.quantity)) ? Math.trunc(Number(l.quantity)) : 1, 1);
    const base = String(l?.orderLineId ?? i + 1);
    const sku = typeof l?.offer?.sellerProductId === "string" && l.offer.sellerProductId.trim() ? l.offer.sellerProductId.trim() : null;
    for (let k = 1; k <= qty; k++) {
      items.push({ marketplace: "octopia", external_id: String(o.orderId), item_key: k > 1 ? `${base}-${k}` : base, position: items.length + 1, sku });
    }
  });
  return items;
}

/* ---------------- Amazon (bezpośrednia integracja SP-API) ---------------- */

// Zamówienie Amazon -> wiersz surowej tabeli amazon_orders.
export function mapAmazonOrder(o: any) {
  return {
    id: String(o.AmazonOrderId),
    status: o.OrderStatus ?? "Pending",
    marketplace_id: o.MarketplaceId ?? null,
    purchase_date: o.PurchaseDate ?? null,
    last_update_date: o.LastUpdateDate ?? null,
    order_total: Number.isFinite(Number(o.OrderTotal?.Amount)) ? Number(o.OrderTotal.Amount) : null,
    currency_code: o.OrderTotal?.CurrencyCode ?? null,
    raw: o,
    synced_at: new Date().toISOString(),
  };
}

// Bez "sku" — pozycje (i SKU) dochodzą osobną fazą synchronizacji (GET .../orderItems), bo mają inny limit szybkości
// niż lista zamówień. Dzięki temu faza listy zamówień nigdy nie nadpisuje SKU pustą wartością (patrz orders/amazon-sync).
export function mapAmazonToSales(o: any) {
  return {
    marketplace: "amazon",
    external_id: String(o.AmazonOrderId),
    order_date: o.PurchaseDate ?? null,
    planned_shipping_date: o.LatestShipDate ?? null,
    status: String(o.OrderStatus ?? "Pending"),
    tracking_number: null, // numer przesyłki nie jest częścią odpowiedzi zamówienia w tym API
    country_code: normCountry(o.ShippingAddress?.CountryCode),
    synced_at: new Date().toISOString(),
  };
}

// Pozycje jednego zamówienia (z osobnego zapytania GET orderItems) -> wiersze sales_order_items. Ilość > 1 rozbijamy
// jak w pozostałych kanałach; klucz to OrderItemId (stały, nie zależy od kolejności w odpowiedzi).
export function mapAmazonItems(orderId: string, items: any[]) {
  const rows: { marketplace: string; external_id: string; item_key: string; position: number; sku: string | null }[] = [];
  items.forEach((it, i) => {
    const qty = Math.max(Number.isFinite(Number(it?.QuantityOrdered)) ? Math.trunc(Number(it.QuantityOrdered)) : 1, 1);
    const base = String(it?.OrderItemId ?? i + 1);
    const sku = typeof it?.SellerSKU === "string" && it.SellerSKU.trim() ? it.SellerSKU.trim() : null;
    for (let k = 1; k <= qty; k++) {
      rows.push({ marketplace: "amazon", external_id: orderId, item_key: k > 1 ? `${base}-${k}` : base, position: rows.length + 1, sku });
    }
  });
  return rows;
}
