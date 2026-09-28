import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { erliShipConfigFromEnv, erliSearchParcel } from "@/lib/erliShipping";

// Dogania numer śledzenia i etykietę przesyłki Erli (Paczkomat) — Erli nie zwraca ich od razu przy tworzeniu
// (patrz lib/erliShipping.ts), trzeba dopytać osobno. Admin, Manager i Zamówienia.

export const maxDuration = 30;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = erliShipConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji Erli (ERLI_API_KEY)." }, { status: 400 });

  const b = await request.json().catch(() => null);
  const id = Number(b?.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Brak identyfikatora przesyłki." }, { status: 400 });

  const { data: row } = await db.from("shipments").select("id, carrier, order_external_id, cancelled_at").eq("id", id).maybeSingle();
  if (!row || row.carrier !== "erli_paczkomat") return NextResponse.json({ error: "Nie ma takiej przesyłki Erli." }, { status: 404 });
  if (row.cancelled_at) return NextResponse.json({ error: "Ta przesyłka została anulowana." }, { status: 409 });
  if (!row.order_external_id) return NextResponse.json({ error: "Przesyłka bez numeru zamówienia." }, { status: 409 });

  let parcel;
  try {
    parcel = await erliSearchParcel(cfg, { orderId: row.order_external_id });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się sprawdzić przesyłki w Erli." }, { status: 502 });
  }
  if (!parcel) return NextResponse.json({ error: "Erli nie ma jeszcze danych tej przesyłki — spróbuj ponownie za chwilę." }, { status: 409 });

  const update: Record<string, unknown> = {};
  if (parcel.trackingNumber) update.tracking_number = parcel.trackingNumber;

  let labelBase64: string | null = null;
  const waybillUrl = parcel.waybills[0];
  if (waybillUrl) {
    try {
      const res = await fetch(waybillUrl, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const buf = await res.arrayBuffer();
      labelBase64 = Buffer.from(buf).toString("base64");
      update.label_data = labelBase64;
      update.label_format = "pdf";
    } catch (e: any) {
      return NextResponse.json({ error: `Etykieta jest gotowa w Erli, ale nie udało się jej pobrać: ${e.message || e}. Spróbuj ponownie.` }, { status: 502 });
    }
  }

  if (Object.keys(update).length > 0) await db.from("shipments").update(update).eq("id", id);

  if (!labelBase64) return NextResponse.json({ ok: true, ready: false, status: parcel.status, trackingNumber: parcel.trackingNumber });
  return NextResponse.json({ ok: true, ready: true, labelBase64, trackingNumber: parcel.trackingNumber });
}
