import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";

// Synchronizuje zamówienia BuyBack z Back Marketu do tabeli buyback_orders w Supabase.
// GET /ws/buyback/v1/orders — dokumentacja: https://api.backmarket.dev (sekcja BuyBack).
//
// Pierwsza synchronizacja (brak buyback_orders_sync_meta.last_synced_at) pobiera WSZYSTKIE
// zamówienia od 1 stycznia bieżącego roku (parametr creationDate). Kolejne są przyrostowe:
// pytają tylko o zamówienia zmienione po dacie ostatniej synchronizacji (modificationDate) —
// to jedno pole łapie zarówno nowe zamówienia, jak i zmiany statusu istniejących.
//
// Wywoływane przez: (1) Vercel Cron (patrz vercel.json), (2) ręcznie z tym samym tokenem
// co bidder (isAuthorized w lib/buyback.ts: sekret crona albo token zalogowanego użytkownika).

const MAX_PAGES = 200;

function supabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

function bmHeaders() {
  return {
    Accept: "application/json",
    "Accept-Language": process.env.BACKMARKET_LANG || "fr-fr",
    Authorization: process.env.BACKMARKET_AUTH!,
    "User-Agent": process.env.BACKMARKET_UA || "backmarket@recoo.io",
  };
}

function mapOrder(o: any) {
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

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  }
  if (!process.env.BACKMARKET_AUTH) {
    return NextResponse.json({ error: "Brak BACKMARKET_AUTH w .env.local" }, { status: 500 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY w .env.local" }, { status: 500 });
  }

  const admin = supabaseAdmin();
  const baseUrl = process.env.BACKMARKET_BASE_URL || "https://www.backmarket.fr";

  const { data: metaRow, error: metaError } = await admin
    .from("buyback_orders_sync_meta")
    .select("last_synced_at")
    .eq("id", 1)
    .maybeSingle();
  if (metaError) return NextResponse.json({ error: `Błąd odczytu z Supabase: ${metaError.message}` }, { status: 500 });

  const lastSyncedAt = metaRow?.last_synced_at as string | null | undefined;
  const syncStartedAt = new Date().toISOString();

  const baseParams = new URLSearchParams();
  if (lastSyncedAt) {
    baseParams.set("modificationDate", lastSyncedAt.slice(0, 10));
  } else {
    baseParams.set("creationDate", `${new Date().getFullYear()}-01-01`);
  }

  let processed = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams(baseParams);
    params.set("page", String(page));

    const res = await fetch(`${baseUrl}/ws/buyback/v1/orders?${params.toString()}`, {
      headers: bmHeaders(),
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Back Market zwrócił błąd (${res.status})` }, { status: 502 });
    }

    const data = await res.json();
    const results = (data.results || []) as any[];
    if (results.length === 0) break;

    const { error } = await admin.from("buyback_orders").upsert(results.map(mapOrder));
    if (error) return NextResponse.json({ error: `Błąd zapisu do Supabase: ${error.message}` }, { status: 500 });

    processed += results.length;
    if (!data.next) break;
  }

  const { error: metaWriteError } = await admin
    .from("buyback_orders_sync_meta")
    .upsert({ id: 1, last_synced_at: syncStartedAt });
  if (metaWriteError) {
    return NextResponse.json({ error: `Błąd zapisu do Supabase: ${metaWriteError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, processed, incremental: !!lastSyncedAt, syncedAt: syncStartedAt });
}
