import { NextResponse } from "next/server";
import { requireRole } from "@/lib/serverAuth";
import { dhlParcelConfigFromEnv, dhlParcelDelete } from "@/lib/dhlParcel";
import { admin } from "@/lib/parcelServer";

// Anulowanie przesyłki DHL Parcel (deleteShipments) — Admin i Manager. DHL pozwala na to tylko wtedy, gdy nie zamówiono po nią kuriera;
// w przeciwnym razie zwraca błąd i przesyłka zostaje aktywna (pokazujemy go wprost). Wiersz w bazie dostaje znacznik cancelled_at,
// nie jest usuwany (zapis księgowy).
export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = dhlParcelConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji DHL Parcel." }, { status: 400 });
  const b = await request.json().catch(() => null);
  if (b?.confirm !== true) return NextResponse.json({ error: "Brak potwierdzenia anulowania." }, { status: 400 });
  const id = Number(b?.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Brak identyfikatora przesyłki." }, { status: 400 });

  const { data: row } = await db.from("shipments").select("id, carrier, tracking_number, cancelled_at").eq("id", id).maybeSingle();
  if (!row || row.carrier !== "dhl_parcel") return NextResponse.json({ error: "Nie ma takiej przesyłki DHL Parcel." }, { status: 404 });
  if (row.cancelled_at) return NextResponse.json({ ok: true, alreadyCancelled: true });
  try {
    await dhlParcelDelete(cfg, row.tracking_number);
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się anulować przesyłki." }, { status: 422 });
  }
  await db.from("shipments").update({ cancelled_at: new Date().toISOString(), label_data: null }).eq("id", id);
  return NextResponse.json({ ok: true });
}
