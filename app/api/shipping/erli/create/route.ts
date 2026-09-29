import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { erliShipConfigFromEnv, erliCreateParcel, ErliShipError } from "@/lib/erliShipping";
import { erliSearchOrders, type ErliClient } from "@/lib/erli";
import { mapErliOrder, mapErliToSales, mapErliItems, uniqueBy } from "@/lib/salesOrders";

// Nadanie przesyłki Erli — Paczkomaty InPost 24/7 (POST /shipping/parcels/, typeId "erliPaczkomat") — tylko
// Admin, Manager i Zamówienia. UWAGA: Erli nie ma środowiska testowego — każda przesyłka jest prawdziwa i płatna
// na koncie Erli (nie naszym DHL). Można ją anulować (route cancel), dopóki nie trafiła faktycznie do sieci InPost.
// Adres odbiorcy NIE jest przesyłany — Erli bierze go z zamówienia (klient wybrał konkretny paczkomat w Erli).
// Etykieta i numer śledzenia często nie są gotowe od razu — route label dogania je później.

export const maxDuration = 30;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = erliShipConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji Erli (ERLI_API_KEY)." }, { status: 400 });

  const b = await request.json().catch(() => null);
  if (b?.confirm !== true) return NextResponse.json({ error: "Brak potwierdzenia nadania przesyłki." }, { status: 400 });
  const externalId = typeof b?.externalId === "string" ? b.externalId.trim() : "";
  const requestId = typeof b?.clientRequestId === "string" ? b.clientRequestId : "";
  if (!externalId || !requestId) return NextResponse.json({ error: "Brak numeru zamówienia." }, { status: 400 });

  const weightKg = Number(b?.weightKg);
  const lengthCm = Number(b?.lengthCm);
  const widthCm = Number(b?.widthCm);
  const heightCm = Number(b?.heightCm);
  if (![weightKg, lengthCm, widthCm, heightCm].every((n) => Number.isFinite(n) && n > 0)) {
    return NextResponse.json({ error: "Uzupełnij: wagę i wymiary paczki (liczby większe od zera)." }, { status: 400 });
  }
  const weightG = Math.round(weightKg * 1000);
  const dims = { widthMm: Math.round(widthCm * 10), heightMm: Math.round(heightCm * 10), lengthMm: Math.round(lengthCm * 10) };
  if (weightG < 10 || weightG > 700_000 || [dims.widthMm, dims.heightMm, dims.lengthMm].some((v) => v < 1 || v > 2000)) {
    return NextResponse.json({ error: "Waga lub wymiary poza zakresem obsługiwanym przez Erli (waga 0,01–700 kg, wymiary 0,1–200 cm)." }, { status: 400 });
  }

  // To samo kliknięcie wysłane drugi raz zwraca już nadaną przesyłkę zamiast tworzyć nową.
  const { data: existing } = await db.from("shipments").select("id, tracking_number, tracking_url").eq("client_request_id", requestId).maybeSingle();
  if (existing) return NextResponse.json({ ok: true, saved: true, duplicate: true, id: existing.id, trackingNumber: existing.tracking_number, trackingUrl: existing.tracking_url });

  // Zabezpieczenie: paczkomat ma sens tylko dla zamówień, w których klient faktycznie wybrał punkt InPost.
  const { data: order, error: orderErr } = await db.from("erli_orders").select("raw").eq("id", externalId).maybeSingle();
  if (orderErr) return NextResponse.json({ error: `Nie udało się odczytać zamówienia: ${orderErr.message}` }, { status: 500 });
  const pickupPlace = (order?.raw as any)?.delivery?.pickupPlace ?? null;
  if (pickupPlace?.provider !== "inpost") {
    return NextResponse.json({ error: "To zamówienie nie ma wybranego punktu InPost (Paczkomatu) w Erli — nadaj przesyłkę innym sposobem." }, { status: 409 });
  }

  let parcel;
  try {
    parcel = await erliCreateParcel(cfg, { orderId: externalId, ...dims, weightG });
  } catch (e: any) {
    const status = e instanceof ErliShipError ? 422 : 502;
    return NextResponse.json({ error: e.message || "Nie udało się nadać przesyłki." }, { status });
  }

  // Numer śledzenia bywa dogrywany później (patrz erliSearchParcel) — do tego czasu potrzebujemy czegoś unikalnego
  // w tracking_number (kolumna NOT NULL), żeby zapis się nie wywalił.
  const trackingNumber = parcel.trackingNumber || `ERLI-${parcel.id}`;
  const byEmail = (await db.auth.admin.getUserById(uid)).data.user?.email ?? null;
  const { data: row, error: insErr } = await db
    .from("shipments")
    .insert({
      client_request_id: requestId,
      carrier: "erli_paczkomat",
      created_by_user_id: uid,
      created_by_email: byEmail,
      environment: "production", // Erli nie ma środowiska testowego
      marketplace: "erli",
      order_external_id: externalId,
      product_code: "erliPaczkomat",
      product_name: "Erli — Paczkomaty InPost 24/7",
      tracking_number: trackingNumber,
      tracking_url: null, // Erli nie daje linku śledzenia przy tworzeniu — dogania go sync zamówień Erli
      planned_shipping_date: null,
      receiver: { name: pickupPlace?.name ?? null, city: pickupPlace?.city ?? null, countryCode: String(pickupPlace?.country ?? "PL").toUpperCase() },
      package: { weight: weightKg, length: lengthCm, width: widthCm, height: heightCm, description: "Erli — Paczkomaty InPost 24/7" },
      // Erli nie zwraca "opłat" w tym sensie co DHL — kolumna niesie tu id paczki po stronie Erli (potrzebny do
      // anulowania, DELETE /shipping/parcels/{id}; żeby uniknąć osobnej kolumny/migracji tylko dla tego pola).
      charges: { erli_parcel_id: parcel.id },
      label_format: null,
      label_data: null,
    })
    .select("id")
    .single();

  if (insErr || !row) {
    return NextResponse.json({
      ok: true,
      saved: false,
      error: `Przesyłka została nadana w Erli (nr ${trackingNumber}), ale nie udało się jej zapisać w aplikacji: ${insErr?.message ?? "brak odpowiedzi"}. Zanotuj numer — etykietę pobierzesz z panelu Erli.`,
      trackingNumber,
      parcelId: parcel.id,
    });
  }

  // Odśwież zamówienie w erli_orders/sales_orders na miejscu — nadanie nie musi wcale ruszyć pola `updated` po
  // stronie Erli, więc zwykły cykliczny skan (kursor po `updated`) mógłby to zamówienie już nigdy nie złapać
  // (ten sam wzorzec problemu co przy zmianie statusu płatności — patrz orders/erli-sync/route.ts). Best-effort:
  // błąd tutaj nie może zepsuć odpowiedzi, przesyłka w Erli już istnieje i jest nadana.
  try {
    const cfg2: ErliClient = { apiKey: process.env.ERLI_API_KEY!, userAgent: process.env.ERLI_UA || "recoo-erp", baseUrl: process.env.ERLI_BASE_URL || undefined };
    const orders = await erliSearchOrders(cfg2, { filter: { field: "id", operator: "=", value: externalId } });
    const fresh = orders.find((o) => String(o?.id) === externalId);
    if (fresh) {
      await db.from("erli_orders").upsert(mapErliOrder(fresh));
      await db.from("sales_orders").upsert(mapErliToSales(fresh));
      const items = uniqueBy(mapErliItems(fresh), (i) => i.item_key);
      if (items.length > 0) await db.from("sales_order_items").upsert(items);
    }
  } catch {
    /* nie blokuje odpowiedzi — zawsze można odświeżyć ręcznie z karty zamówienia */
  }

  return NextResponse.json({
    ok: true,
    saved: true,
    id: row.id,
    trackingNumber,
    parcelId: parcel.id,
    labelReady: parcel.waybills.length > 0,
  });
}
