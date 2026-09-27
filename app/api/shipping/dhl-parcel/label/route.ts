import { NextResponse } from "next/server";
import { requireRole } from "@/lib/serverAuth";
import { dhlParcelConfigFromEnv, dhlParcelLabel } from "@/lib/dhlParcel";
import { admin } from "@/lib/parcelServer";

// Ponowne pobranie etykiety przesyłki DHL Parcel (getLabels) i zapis w bazie — gdy przy nadaniu pobranie się nie udało. Admin i Manager.
export async function POST(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ["Admin", "Manager"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = dhlParcelConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji DHL Parcel." }, { status: 400 });
  const b = await request.json().catch(() => null);
  const id = Number(b?.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Brak identyfikatora przesyłki." }, { status: 400 });

  const { data: row } = await db.from("shipments").select("id, carrier, tracking_number, cancelled_at").eq("id", id).maybeSingle();
  if (!row || row.carrier !== "dhl_parcel") return NextResponse.json({ error: "Nie ma takiej przesyłki DHL Parcel." }, { status: 404 });
  if (row.cancelled_at) return NextResponse.json({ error: "Ta przesyłka została anulowana." }, { status: 409 });
  try {
    const l = await dhlParcelLabel(cfg, row.tracking_number);
    await db.from("shipments").update({ label_data: l.base64, label_format: "pdf" }).eq("id", id);
    return NextResponse.json({ ok: true, labelBase64: l.base64 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się pobrać etykiety." }, { status: 502 });
  }
}
