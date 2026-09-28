import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { erliShipConfigFromEnv, erliCancelParcel, ErliShipError } from "@/lib/erliShipping";

// Anulowanie przesyłki Erli (DELETE /shipping/parcels/{id}) — Admin, Manager i Zamówienia. Działa tylko, dopóki
// przesyłka faktycznie nie trafiła do sieci InPost; w przeciwnym razie Erli zwraca błąd i przesyłka zostaje aktywna.
// Wiersz w bazie dostaje znacznik cancelled_at, nie jest usuwany (zapis księgowy) — tak samo jak DHL Parcel.

export async function POST(request: Request) {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const uid = await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = erliShipConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji Erli (ERLI_API_KEY)." }, { status: 400 });
  const b = await request.json().catch(() => null);
  if (b?.confirm !== true) return NextResponse.json({ error: "Brak potwierdzenia anulowania." }, { status: 400 });
  const id = Number(b?.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Brak identyfikatora przesyłki." }, { status: 400 });

  const { data: row } = await db.from("shipments").select("id, carrier, charges, cancelled_at").eq("id", id).maybeSingle();
  if (!row || row.carrier !== "erli_paczkomat") return NextResponse.json({ error: "Nie ma takiej przesyłki Erli." }, { status: 404 });
  if (row.cancelled_at) return NextResponse.json({ ok: true, alreadyCancelled: true });
  const erliParcelId = (row.charges as any)?.erli_parcel_id;
  if (!Number.isInteger(erliParcelId)) return NextResponse.json({ error: "Brak identyfikatora przesyłki po stronie Erli." }, { status: 409 });

  try {
    await erliCancelParcel(cfg, { id: erliParcelId });
  } catch (e: any) {
    const status = e instanceof ErliShipError ? 422 : 502;
    return NextResponse.json({ error: e.message || "Nie udało się anulować przesyłki." }, { status });
  }
  await db.from("shipments").update({ cancelled_at: new Date().toISOString(), label_data: null }).eq("id", id);
  return NextResponse.json({ ok: true });
}
