import { NextResponse } from "next/server";
import { requireRole } from "@/lib/serverAuth";
import { upsConfigFromEnv, upsVoid } from "@/lib/ups";
import { admin } from "@/lib/parcelServer";

// Anulowanie przesyłki UPS (Void Shipment) — Admin, Manager i Zamówienia. UPS pozwala na to, dopóki przesyłka nie została odebrana/zeskanowana;
// w przeciwnym razie zwraca błąd i przesyłka zostaje aktywna (pokazujemy go wprost). Wiersz w bazie dostaje cancelled_at, nie jest usuwany (zapis księgowy).
// Uwaga: przesyłka nadana na środowisku testowym UPS jest anulowana w teście, produkcyjna — naprawdę.
export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = upsConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji UPS." }, { status: 400 });
  const b = await request.json().catch(() => null);
  if (b?.confirm !== true) return NextResponse.json({ error: "Brak potwierdzenia anulowania." }, { status: 400 });
  const id = Number(b?.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Brak identyfikatora przesyłki." }, { status: 400 });

  const { data: row } = await db.from("shipments").select("id, carrier, tracking_number, cancelled_at, environment").eq("id", id).maybeSingle();
  if (!row || row.carrier !== "ups") return NextResponse.json({ error: "Nie ma takiej przesyłki UPS." }, { status: 404 });
  if (row.cancelled_at) return NextResponse.json({ ok: true, alreadyCancelled: true });
  // Środowisko przesyłki musi zgadzać się z aktywnym (inaczej UPS odpowie "nie znaleziono" i wprowadzi w błąd).
  if (row.environment !== (cfg.env === "production" ? "production" : "test")) {
    return NextResponse.json({ error: `Przesyłka została nadana w środowisku „${row.environment}”, a aplikacja używa teraz „${cfg.env}” — przełącz UPS_ENV, żeby ją anulować.` }, { status: 409 });
  }
  try {
    await upsVoid(cfg, row.tracking_number);
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się anulować przesyłki." }, { status: 422 });
  }
  await db.from("shipments").update({ cancelled_at: new Date().toISOString(), label_data: null }).eq("id", id);
  return NextResponse.json({ ok: true });
}
