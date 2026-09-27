import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { DHL_EU_COUNTRIES, DhlExpressError, dhlCreateShipment, dhlExpressConfigFromEnv, type CreateShipmentInput, type ShipmentParty } from "@/lib/dhlExpress";

// Nadanie przesyłki DHL Express (POST /shipments) — tylko Admin i Manager.
// UWAGA: na środowisku produkcyjnym to PRAWDZIWA przesyłka na koncie DHL (koszt), a DHL Express nie pozwala jej anulować przez API.
// Dlatego: wymagamy jawnego potwierdzenia (`confirm: true`), pilnujemy podwójnego kliknięcia kluczem `clientRequestId`
// (to samo kliknięcie nie nada dwóch przesyłek) i nigdy nie gubimy etykiety — gdy zapis w bazie się nie uda, oddajemy ją w odpowiedzi.
// Dane nadawcy pochodzą z tabeli shipping_settings (nie z przeglądarki). Na razie tylko kraje UE (bez odprawy celnej).

export const maxDuration = 60;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);
const num = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = dhlExpressConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji DHL Express (zmienne środowiskowe)." }, { status: 400 });

  const b = await request.json().catch(() => null);
  if (b?.confirm !== true) return NextResponse.json({ error: "Brak potwierdzenia nadania przesyłki." }, { status: 400 });
  const requestId = typeof b?.clientRequestId === "string" && /^[0-9a-f-]{36}$/i.test(b.clientRequestId) ? b.clientRequestId : null;
  if (!requestId) return NextResponse.json({ error: "Brak identyfikatora żądania." }, { status: 400 });

  // To samo kliknięcie wysłane drugi raz (podwójny klik, ponowienie) zwraca już nadaną przesyłkę zamiast tworzyć nową.
  const { data: existing } = await db.from("shipments").select("id, tracking_number, tracking_url").eq("client_request_id", requestId).maybeSingle();
  if (existing) return NextResponse.json({ ok: true, saved: true, duplicate: true, id: existing.id, trackingNumber: existing.tracking_number, trackingUrl: existing.tracking_url });

  const r = b?.receiver ?? {};
  const country = typeof r.countryCode === "string" ? r.countryCode.trim().toUpperCase() : "";
  const receiver: Partial<ShipmentParty> = {
    company: str(r.company, 100) ?? undefined,
    name: str(r.name, 100) ?? undefined,
    street: str(r.street, 135) ?? undefined,
    postalCode: str(r.postalCode, 12) ?? undefined,
    city: str(r.city, 45) ?? undefined,
    countryCode: DHL_EU_COUNTRIES.includes(country) ? country : undefined,
    phone: str(r.phone, 40) ?? undefined,
    email: str(r.email, 70) ?? undefined,
  };
  const p = b?.package ?? {};
  const pack = {
    weight: num(p.weight, 0.1, 70),
    length: num(p.length, 1, 300),
    width: num(p.width, 1, 300),
    height: num(p.height, 1, 300),
    description: str(p.description, 70),
  };
  const productCode = str(b?.productCode, 3);
  const plannedDate = typeof b?.plannedDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.plannedDate) ? b.plannedDate : null;

  const missing: string[] = [];
  if (!receiver.name) missing.push("imię i nazwisko odbiorcy");
  if (!receiver.street) missing.push("ulica i numer");
  if (!receiver.postalCode) missing.push("kod pocztowy");
  if (!receiver.city) missing.push("miasto");
  if (!receiver.countryCode) missing.push("kraj (tylko UE)");
  if (!receiver.phone) missing.push("telefon odbiorcy");
  if (pack.weight === null) missing.push("waga (0,1–70 kg)");
  if (pack.length === null || pack.width === null || pack.height === null) missing.push("wymiary");
  if (!pack.description) missing.push("opis zawartości");
  if (!productCode) missing.push("produkt DHL");
  if (!plannedDate) missing.push("data nadania");
  if (missing.length > 0) return NextResponse.json({ error: `Uzupełnij: ${missing.join(", ")}.` }, { status: 400 });

  const { data: s, error: sErr } = await db.from("shipping_settings").select("*").eq("id", 1).maybeSingle();
  if (sErr || !s) return NextResponse.json({ error: "Brak danych nadawcy (tabela shipping_settings) — uruchom supabase/shipping.sql." }, { status: 500 });

  const input: CreateShipmentInput = {
    productCode: productCode!,
    plannedDate: plannedDate!,
    shipper: { company: s.shipper_company, name: s.shipper_name, street: s.street, postalCode: s.postal_code, city: s.city, countryCode: s.country_code, phone: s.phone, email: s.email ?? undefined },
    receiver: receiver as ShipmentParty,
    package: { weight: pack.weight!, length: pack.length!, width: pack.width!, height: pack.height!, description: pack.description! },
    reference: str(b?.reference, 35) ?? undefined,
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

  const order = b?.order && typeof b.order.marketplace === "string" && typeof b.order.externalId === "string" ? b.order : null;
  const { data: row, error: insErr } = await db
    .from("shipments")
    .insert({
      client_request_id: requestId,
      created_by_user_id: uid,
      created_by_email: byEmail,
      environment: cfg.env,
      marketplace: order?.marketplace ?? null,
      order_external_id: order?.externalId ?? null,
      product_code: productCode,
      product_name: str(b?.productName, 80),
      tracking_number: created.trackingNumber,
      tracking_url: created.trackingUrl,
      planned_shipping_date: plannedDate,
      receiver: { ...receiver },
      package: { ...pack, template: str(p.template, 60) },
      charges: created.charges,
      label_format: created.labelFormat,
      label_data: created.labelBase64,
    })
    .select("id")
    .single();

  if (insErr || !row) {
    // Przesyłka JUŻ istnieje w DHL — oddajemy numer i etykietę, żeby nic się nie zmarnowało, i mówimy wprost, co się stało.
    return NextResponse.json({
      ok: true,
      saved: false,
      error: `Przesyłka została nadana w DHL (nr ${created.trackingNumber}), ale nie udało się jej zapisać w aplikacji: ${insErr?.message ?? "brak odpowiedzi"}. Wydrukuj etykietę teraz i zanotuj numer.`,
      trackingNumber: created.trackingNumber,
      trackingUrl: created.trackingUrl,
      labelBase64: created.labelBase64,
      labelFormat: created.labelFormat,
    });
  }
  return NextResponse.json({
    ok: true,
    saved: true,
    id: row.id,
    environment: cfg.env,
    trackingNumber: created.trackingNumber,
    trackingUrl: created.trackingUrl,
    charges: created.charges,
    warnings: created.warnings,
  });
}
