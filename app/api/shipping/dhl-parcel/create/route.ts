import { NextResponse } from "next/server";
import { requireRole } from "@/lib/serverAuth";
import { dhlParcelConfigFromEnv, dhlParcelCreate, dhlParcelIsSandbox, DhlParcelError } from "@/lib/dhlParcel";
import { parseShipmentBody } from "@/lib/shipmentInput";
import { admin, loadShipper, parcelTrackingUrl } from "@/lib/parcelServer";
import { notifyMarketplace } from "@/lib/shipmentMarketplaceSync";

// Nadanie przesyłki DHL Parcel (createShipments + getLabels) — tylko Admin i Manager.
// UWAGA: bez środowiska testowego to PRAWDZIWA przesyłka na koncie DHL. Da się ją anulować (route cancel), dopóki nie zamówiono po nią kuriera.
// Zabezpieczenia jak przy Expressie: jawne `confirm: true`, klucz `clientRequestId` przeciw podwójnemu nadaniu, etykieta nigdy nie ginie
// (gdy zapis w bazie się nie uda albo pobranie etykiety zawiedzie, odpowiedź mówi to wprost i zawiera numer). Na razie tylko kraje UE.

export const maxDuration = 60;

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = dhlParcelConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji DHL Parcel (zmienne środowiskowe)." }, { status: 400 });

  const b = await request.json().catch(() => null);
  if (b?.confirm !== true) return NextResponse.json({ error: "Brak potwierdzenia nadania przesyłki." }, { status: 400 });
  const parsed = parseShipmentBody(b);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { receiver, pack, plannedDate, reference, order, requestId } = parsed.value;
  const product = b?.productCode === "EK" || b?.productCode === "PI" ? (b.productCode as string) : null;
  if (!product) return NextResponse.json({ error: "Wybierz produkt: EK (Connect) albo PI (International)." }, { status: 400 });

  const { data: existing } = await db.from("shipments").select("id, tracking_number, tracking_url").eq("client_request_id", requestId).maybeSingle();
  if (existing) return NextResponse.json({ ok: true, saved: true, duplicate: true, id: existing.id, trackingNumber: existing.tracking_number, trackingUrl: existing.tracking_url });

  const shipper = await loadShipper(db);
  if (!shipper) return NextResponse.json({ error: "Brak danych nadawcy (tabela shipping_settings) — uruchom supabase/shipping.sql." }, { status: 500 });

  let created;
  try {
    created = await dhlParcelCreate(cfg, {
      product,
      shipmentDate: plannedDate,
      shipper,
      receiver: {
        country: receiver.countryCode,
        name: receiver.company || receiver.name,
        postalCode: receiver.postalCode,
        city: receiver.city,
        street: receiver.street,
        houseNumber: receiver.houseNumber,
        apartmentNumber: receiver.apartment,
        // Tylko gdy jest firma — inaczej "name" i "contactPerson" to ta sama osoba i etykieta DHL24 drukuje ją dwa razy.
        contactPerson: receiver.company ? receiver.name : undefined,
        contactPhone: receiver.phone,
        contactEmail: receiver.email,
      },
      package: pack,
      content: pack.description,
      reference,
    });
  } catch (e: any) {
    const status = e instanceof DhlParcelError ? 422 : 502;
    return NextResponse.json({ error: e.message || "Nie udało się nadać przesyłki." }, { status });
  }

  const byEmail = (await db.auth.admin.getUserById(uid)).data.user?.email ?? null;
  const trackingUrl = parcelTrackingUrl(created.shipmentId);
  const { data: row, error: insErr } = await db
    .from("shipments")
    .insert({
      client_request_id: requestId,
      carrier: "dhl_parcel",
      created_by_user_id: uid,
      created_by_email: byEmail,
      environment: dhlParcelIsSandbox(cfg) ? "test" : "production",
      marketplace: order?.marketplace ?? null,
      order_external_id: order?.externalId ?? null,
      product_code: product,
      product_name: product === "EK" ? "DHL Connect" : "DHL International",
      tracking_number: created.shipmentId,
      tracking_url: trackingUrl,
      planned_shipping_date: plannedDate,
      receiver: { ...receiver },
      package: { ...pack },
      charges: null, // getPrice pokazał cenę przed nadaniem; DHL24 nie zwraca opłaty przy tworzeniu przesyłki
      label_format: created.labelBase64 ? "pdf" : null,
      label_data: created.labelBase64,
    })
    .select("id")
    .single();

  if (insErr || !row) {
    // Zgłaszamy do marketplace'u mimo to (przesyłka jest prawdziwa niezależnie od tego, czy zapis u nas się udał).
    const sync = await notifyMarketplace(db, { marketplace: order?.marketplace ?? null, externalId: order?.externalId ?? null, carrier: "dhl_parcel", trackingNumber: created.shipmentId, trackingUrl });
    return NextResponse.json({
      ok: true,
      saved: false,
      error: `Przesyłka została nadana w DHL (nr ${created.shipmentId}), ale nie udało się jej zapisać w aplikacji: ${insErr?.message ?? "brak odpowiedzi"}. Wydrukuj etykietę teraz i zanotuj numer — możesz też anulować ją w DHL24.`,
      trackingNumber: created.shipmentId,
      trackingUrl,
      labelBase64: created.labelBase64,
      marketplaceSynced: sync.synced,
      marketplaceSyncError: sync.error,
    });
  }

  // Zgłoszenie do marketplace'u nigdy nie failuje odpowiedzi — przesyłka jest już nadana i zapisana; błąd zostaje
  // w kolumnach shipments.marketplace_sync* (UI pokazuje ostrzeżenie z "Zgłoś ponownie" — route sync-marketplace).
  const sync = await notifyMarketplace(db, { marketplace: order?.marketplace ?? null, externalId: order?.externalId ?? null, carrier: "dhl_parcel", trackingNumber: created.shipmentId, trackingUrl });
  await db.from("shipments").update({ marketplace_synced_at: sync.synced ? new Date().toISOString() : null, marketplace_sync_error: sync.error }).eq("id", row.id);

  return NextResponse.json({
    ok: true,
    saved: true,
    id: row.id,
    environment: dhlParcelIsSandbox(cfg) ? "test" : "production",
    trackingNumber: created.shipmentId,
    trackingUrl,
    labelError: created.labelError ?? null, // przesyłka istnieje, ale etykieta nie została pobrana — użyj "Pobierz etykietę ponownie"
    marketplaceSynced: sync.synced,
    marketplaceSyncError: sync.error,
  });
}
