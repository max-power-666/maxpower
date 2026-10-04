import { NextResponse } from "next/server";
import { requireRole } from "@/lib/serverAuth";
import { upsConfigFromEnv, upsCreate, upsServiceName, upsTrackingUrl, UpsError } from "@/lib/ups";
import { parseShipmentBody, parseExtraPackages, parseQuotedCharges } from "@/lib/shipmentInput";
import { admin } from "@/lib/parcelServer";
import { loadUpsShipper, parseUpsCod, upsReceiver } from "@/lib/upsServer";
import { notifyMarketplace } from "@/lib/shipmentMarketplaceSync";

// Nadanie przesyłki UPS (Shipping API) — tylko Admin, Manager i Zamówienia. Etykieta ZPL 4x6 wraca od razu w odpowiedzi i jest zapisywana
// w shipments (label_format "zpl" — ta sama ścieżka druku/podglądu co DHL Express). Na środowisku produkcyjnym to PRAWDZIWA, płatna przesyłka;
// da się ją anulować (route cancel), dopóki UPS jej nie odbierze. Zabezpieczenia jak przy DHL: jawne `confirm: true`, klucz `clientRequestId` przeciw
// podwójnemu nadaniu, gdy zapis w bazie się nie uda — odpowiedź zwraca numer i etykietę, a zgłoszenie do marketplace'u nigdy nie failuje nadania.

export const maxDuration = 60;

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = upsConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji UPS (zmienne środowiskowe)." }, { status: 400 });

  const b = await request.json().catch(() => null);
  if (b?.confirm !== true) return NextResponse.json({ error: "Brak potwierdzenia nadania przesyłki." }, { status: 400 });
  const parsed = parseShipmentBody(b);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const extra = parseExtraPackages(b?.extraPackages);
  if (!extra.ok) return NextResponse.json({ error: extra.error }, { status: 400 });
  const { receiver, pack, plannedDate, reference, order, requestId } = parsed.value;
  const serviceCode = typeof b?.productCode === "string" && /^\d{2}$/.test(b.productCode) ? b.productCode : null;
  if (!serviceCode) return NextResponse.json({ error: "Wybierz usługę UPS." }, { status: 400 });

  const { data: existing } = await db.from("shipments").select("id, tracking_number, tracking_url").eq("client_request_id", requestId).maybeSingle();
  if (existing) return NextResponse.json({ ok: true, saved: true, duplicate: true, id: existing.id, trackingNumber: existing.tracking_number, trackingUrl: existing.tracking_url });

  const shipper = await loadUpsShipper(db);
  if (!shipper) return NextResponse.json({ error: "Brak danych nadawcy (tabela shipping_settings) — uruchom supabase/shipping.sql." }, { status: 500 });

  const cod = parseUpsCod(b?.cod, receiver.countryCode, shipper.countryCode);
  if (!cod.ok) return NextResponse.json({ error: cod.error }, { status: 400 });

  let created;
  try {
    created = await upsCreate(cfg, { serviceCode, shipper, receiver: upsReceiver(receiver), packages: [pack, ...extra.value], description: pack.description, reference, cod: cod.value });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się nadać przesyłki." }, { status: e instanceof UpsError ? 422 : 502 });
  }

  const byEmail = (await db.auth.admin.getUserById(uid)).data.user?.email ?? null;
  const trackingUrl = upsTrackingUrl(created.shipmentId);
  const env = cfg.env === "production" ? "production" : "test";
  // Cena: UPS zwraca ją w odpowiedzi (stawka wynegocjowana, gdy konto ją ma); przy braku — cena z wyceny z przeglądarki.
  const charges = created.charge ? [{ currencyType: "BILLC", priceCurrency: created.charge.currency, price: created.charge.price }] : parseQuotedCharges(b?.billing, b?.local);
  const { data: row, error: insErr } = await db
    .from("shipments")
    .insert({
      client_request_id: requestId,
      carrier: "ups",
      created_by_user_id: uid,
      created_by_email: byEmail,
      environment: env,
      marketplace: order?.marketplace ?? null,
      order_external_id: order?.externalId ?? null,
      product_code: serviceCode,
      product_name: upsServiceName(serviceCode),
      tracking_number: created.shipmentId,
      tracking_url: trackingUrl,
      planned_shipping_date: plannedDate,
      receiver: { ...receiver },
      // Obiekt (nie sama tablica jak w DHL Parcel): paczki + pobranie (kwota COD, gdy zażądano) — lista przesyłek pokazuje znacznik COD.
      package: { pieces: [pack, ...extra.value], cod: cod.value },
      charges,
      label_format: created.labelBase64 ? "zpl" : null,
      label_data: created.labelBase64,
    })
    .select("id")
    .single();

  const notify = () => notifyMarketplace(db, { marketplace: order?.marketplace ?? null, externalId: order?.externalId ?? null, carrier: "ups", trackingNumber: created.shipmentId, trackingUrl });
  if (insErr || !row) {
    const sync = await notify();
    return NextResponse.json({
      ok: true,
      saved: false,
      error: `Przesyłka została nadana w UPS (nr ${created.shipmentId}), ale nie udało się jej zapisać w aplikacji: ${insErr?.message ?? "brak odpowiedzi"}. Wydrukuj etykietę teraz i zanotuj numer — możesz też anulować ją w panelu UPS.`,
      trackingNumber: created.shipmentId,
      trackingUrl,
      labelBase64: created.labelBase64,
      labelFormat: "zpl",
      marketplaceSynced: sync.synced,
      marketplaceSyncError: sync.error,
    });
  }

  const sync = await notify();
  await db.from("shipments").update({ marketplace_synced_at: sync.synced ? new Date().toISOString() : null, marketplace_sync_error: sync.error }).eq("id", row.id);

  return NextResponse.json({
    ok: true,
    saved: true,
    id: row.id,
    environment: env,
    trackingNumber: created.shipmentId,
    trackingUrl,
    labelBase64: created.labelBase64,
    labelFormat: "zpl",
    marketplaceSynced: sync.synced,
    marketplaceSyncError: sync.error,
  });
}
