import { NextResponse } from "next/server";
import { requireRole } from "@/lib/serverAuth";
import { dhlParcelConfigFromEnv, dhlParcelLabel } from "@/lib/dhlParcel";
import { admin } from "@/lib/parcelServer";

// Ponowne pobranie etykiety przesyłki DHL Parcel (getLabels) — gdy przy nadaniu pobranie się nie udało, albo (od
// 30.09.2026) na żądanie w formacie ZPL do bezpośredniego druku na Zebrze przez QZ Tray. Admin, Manager i Zamówienia.
// format="zpl" (ZBLP) NIE jest zapisywany w bazie — dociągany świeżo przy każdym druku, żeby nie dokładać nowej
// kolumny tylko pod cache i uniknąć przestarzałej etykiety; format domyślny/"pdf" (BLP) działa jak dotąd i zapisuje.
export async function POST(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = dhlParcelConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji DHL Parcel." }, { status: 400 });
  const b = await request.json().catch(() => null);
  const id = Number(b?.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Brak identyfikatora przesyłki." }, { status: 400 });
  const wantsZpl = b?.format === "zpl";

  const { data: row } = await db.from("shipments").select("id, carrier, tracking_number, cancelled_at").eq("id", id).maybeSingle();
  if (!row || row.carrier !== "dhl_parcel") return NextResponse.json({ error: "Nie ma takiej przesyłki DHL Parcel." }, { status: 404 });
  if (row.cancelled_at) return NextResponse.json({ error: "Ta przesyłka została anulowana." }, { status: 409 });
  try {
    if (wantsZpl) {
      const l = await dhlParcelLabel(cfg, row.tracking_number, "ZBLP");
      return NextResponse.json({ ok: true, zplBase64: l.base64 });
    }
    const l = await dhlParcelLabel(cfg, row.tracking_number);
    await db.from("shipments").update({ label_data: l.base64, label_format: "pdf" }).eq("id", id);
    return NextResponse.json({ ok: true, labelBase64: l.base64 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się pobrać etykiety." }, { status: 502 });
  }
}
