import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { DhlExpressError, dhlCreateShipment, dhlExpressConfigFromEnv, type CreateShipmentInput } from "@/lib/dhlExpress";
import { parseShipmentBody } from "@/lib/shipmentInput";
import { parcelTrackingUrl } from "@/lib/parcelServer";
import { notifyMarketplace, markOurStatusShipped } from "@/lib/shipmentMarketplaceSync";

// Nadanie przesyłki DHL Express (POST /shipments) — tylko Admin, Manager i Zamówienia.
// UWAGA: na środowisku produkcyjnym to PRAWDZIWA przesyłka na koncie DHL (koszt), a DHL Express nie pozwala jej anulować przez API.
// Dlatego: wymagamy jawnego potwierdzenia (`confirm: true`), pilnujemy podwójnego kliknięcia kluczem `clientRequestId`
// (to samo kliknięcie nie nada dwóch przesyłek) i nigdy nie gubimy etykiety — gdy zapis w bazie się nie uda, oddajemy ją w odpowiedzi.
// Dane nadawcy pochodzą z tabeli shipping_settings (nie z przeglądarki). Na razie tylko kraje UE (bez odprawy celnej).

export const maxDuration = 60;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = dhlExpressConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji DHL Express (zmienne środowiskowe)." }, { status: 400 });

  const b = await request.json().catch(() => null);
  if (b?.confirm !== true) return NextResponse.json({ error: "Brak potwierdzenia nadania przesyłki." }, { status: 400 });
  const parsed = parseShipmentBody(b);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { receiver, pack, plannedDate, reference, order, requestId } = parsed.value;
  const productCode = typeof b?.productCode === "string" && /^[A-Z0-9]{1,3}$/.test(b.productCode.trim()) ? b.productCode.trim() : null;
  if (!productCode) return NextResponse.json({ error: "Uzupełnij: produkt DHL." }, { status: 400 });

  // To samo kliknięcie wysłane drugi raz (podwójny klik, ponowienie) zwraca już nadaną przesyłkę zamiast tworzyć nową.
  const { data: existing } = await db.from("shipments").select("id, tracking_number, tracking_url").eq("client_request_id", requestId).maybeSingle();
  if (existing) return NextResponse.json({ ok: true, saved: true, duplicate: true, id: existing.id, trackingNumber: existing.tracking_number, trackingUrl: existing.tracking_url });

  const { data: s, error: sErr } = await db.from("shipping_settings").select("*").eq("id", 1).maybeSingle();
  if (sErr || !s) return NextResponse.json({ error: "Brak danych nadawcy (tabela shipping_settings) — uruchom supabase/shipping.sql." }, { status: 500 });

  const input: CreateShipmentInput = {
    productCode,
    plannedDate,
    shipper: { company: s.shipper_company, name: s.shipper_name, street: s.street, postalCode: s.postal_code, city: s.city, countryCode: s.country_code, phone: s.phone, email: s.email ?? undefined },
    // DHL Express przyjmuje adres jako linie tekstu (do 3 x 45 znaków): ulica, numer i ewentualny lokal łączymy w jedno pole.
    receiver: {
      company: receiver.company,
      name: receiver.name,
      street: [receiver.street, receiver.houseNumber].filter(Boolean).join(" ") + (receiver.apartment ? `, ${receiver.apartment}` : ""),
      postalCode: receiver.postalCode,
      city: receiver.city,
      countryCode: receiver.countryCode,
      phone: receiver.phone,
      email: receiver.email,
    },
    package: { weight: pack.weight, length: pack.length, width: pack.width, height: pack.height, description: pack.description },
    reference,
    labelTemplate: process.env.DHL_EXPRESS_LABEL_TEMPLATE?.trim() || undefined,
  };

  let created;
  try {
    created = await dhlCreateShipment(cfg, input);
  } catch (e: any) {
    const status = e instanceof DhlExpressError && e.status && e.status >= 400 && e.status < 500 ? 422 : 502;
    return NextResponse.json({ error: e.message || "Nie udało się nadać przesyłki." }, { status });
  }

  // E-mail autora bierzemy z konta, nie z treści żądania (nie da się podpisać przesyłki cudzym adresem).
  const byEmail = (await db.auth.admin.getUserById(uid)).data.user?.email ?? null;
  const { data: row, error: insErr } = await db
    .from("shipments")
    .insert({
      client_request_id: requestId,
      carrier: "dhl_express",
      created_by_user_id: uid,
      created_by_email: byEmail,
      environment: cfg.env,
      marketplace: order?.marketplace ?? null,
      order_external_id: order?.externalId ?? null,
      product_code: productCode,
      product_name: typeof b?.productName === "string" ? b.productName.slice(0, 80) : null,
      tracking_number: created.trackingNumber,
      tracking_url: created.trackingUrl,
      planned_shipping_date: plannedDate,
      receiver: { ...receiver },
      package: { ...pack },
      charges: created.charges,
      label_format: created.labelFormat,
      label_data: created.labelBase64,
    })
    .select("id")
    .single();

  // Numer śledzenia dla marketplace'u: DHL Express czasem nie zwraca trackingUrl, więc dopełniamy ogólnym adresem DHL.
  const trackingUrl = created.trackingUrl ?? parcelTrackingUrl(created.trackingNumber);

  if (insErr || !row) {
    // Przesyłka JUŻ istnieje w DHL — oddajemy numer i etykietę, żeby nic się nie zmarnowało, i mówimy wprost, co się stało.
    // Zgłaszamy ją do marketplace'u mimo to (przesyłka jest prawdziwa niezależnie od tego, czy zapis u nas się udał).
    const sync = await notifyMarketplace(db, { marketplace: order?.marketplace ?? null, externalId: order?.externalId ?? null, carrier: "dhl_express", trackingNumber: created.trackingNumber, trackingUrl });
    const statusResult = await markOurStatusShipped(db, { marketplace: order?.marketplace ?? null, externalId: order?.externalId ?? null, byEmail });
    return NextResponse.json({
      ok: true,
      saved: false,
      error: `Przesyłka została nadana w DHL (nr ${created.trackingNumber}), ale nie udało się jej zapisać w aplikacji: ${insErr?.message ?? "brak odpowiedzi"}. Wydrukuj etykietę teraz i zanotuj numer.`,
      trackingNumber: created.trackingNumber,
      trackingUrl: created.trackingUrl,
      labelBase64: created.labelBase64,
      labelFormat: created.labelFormat,
      marketplaceSynced: sync.synced,
      marketplaceSyncError: sync.error,
      ourStatusError: statusResult.error,
    });
  }

  // Zgłoszenie do marketplace'u i zmiana "Nasz status" nigdy nie failują odpowiedzi — przesyłka jest już nadana
  // i zapisana; błąd zostaje w kolumnach shipments.marketplace_sync* (UI pokazuje ostrzeżenie z "Zgłoś ponownie" —
  // route sync-marketplace) albo trzeba poprawić "Nasz status" ręcznie z listy Zamówień.
  const sync = await notifyMarketplace(db, { marketplace: order?.marketplace ?? null, externalId: order?.externalId ?? null, carrier: "dhl_express", trackingNumber: created.trackingNumber, trackingUrl });
  await db.from("shipments").update({ marketplace_synced_at: sync.synced ? new Date().toISOString() : null, marketplace_sync_error: sync.error }).eq("id", row.id);
  const statusResult = await markOurStatusShipped(db, { marketplace: order?.marketplace ?? null, externalId: order?.externalId ?? null, byEmail });

  return NextResponse.json({
    ok: true,
    saved: true,
    id: row.id,
    environment: cfg.env,
    trackingNumber: created.trackingNumber,
    trackingUrl: created.trackingUrl,
    charges: created.charges,
    warnings: created.warnings,
    marketplaceSynced: sync.synced,
    marketplaceSyncError: sync.error,
    ourStatusError: statusResult.error,
  });
}
