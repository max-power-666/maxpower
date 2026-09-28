import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { notifyMarketplace, type ShipmentCarrier } from "@/lib/shipmentMarketplaceSync";

// Ponawia zgłoszenie numeru przesyłki do marketplace'u (Back Market / refurbed) dla przesyłki, której
// pierwsza próba (przy nadaniu — patrz dhl-express/create i dhl-parcel/create) się nie udała. Tylko Admin, Manager i Zamówienia.

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  const b = await request.json().catch(() => null);
  const id = Number(b?.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Brak id przesyłki." }, { status: 400 });

  const { data: s, error: sErr } = await db
    .from("shipments")
    .select("id, carrier, marketplace, order_external_id, tracking_number, tracking_url")
    .eq("id", id)
    .maybeSingle();
  if (sErr || !s) return NextResponse.json({ error: "Nie znaleziono przesyłki." }, { status: 404 });
  if (!s.marketplace || !s.order_external_id) return NextResponse.json({ error: "Ta przesyłka nie jest powiązana z żadnym zamówieniem." }, { status: 400 });
  if (!s.tracking_url) return NextResponse.json({ error: "Brak numeru śledzenia dla tej przesyłki." }, { status: 400 });

  const sync = await notifyMarketplace(db, {
    marketplace: s.marketplace,
    externalId: s.order_external_id,
    carrier: s.carrier as ShipmentCarrier,
    trackingNumber: s.tracking_number,
    trackingUrl: s.tracking_url,
  });
  await db.from("shipments").update({ marketplace_synced_at: sync.synced ? new Date().toISOString() : null, marketplace_sync_error: sync.error }).eq("id", id);

  if (!sync.synced) return NextResponse.json({ ok: true, synced: false, error: sync.error }, { status: 502 });
  return NextResponse.json({ ok: true, synced: true });
}
