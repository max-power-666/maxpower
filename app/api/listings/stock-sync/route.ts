import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/buyback";
import { admin } from "@/lib/parcelServer";
import { requireRole } from "@/lib/serverAuth";
import { runStockSync } from "@/lib/stockSyncServer";

// Synchronizacja stanów BM <-> refurbed (16.10.2026). GET = cron co minutę (Bearer CRON_SECRET; działa tylko po włączeniu przez Admina). POST (Admin/Manager/Księgowa): { run: true } uruchamia przebieg teraz;
// POST (tylko Admin): { enabled: true|false } włącza/wyłącza synchronizację (włączenie oznacza całą dotychczasową historię zamówień jako obsłużoną).
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  return NextResponse.json(await runStockSync(admin()));
}

export async function POST(request: Request) {
  const db = admin();
  let body: { enabled?: unknown; run?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Niepoprawne żądanie." }, { status: 400 });
  }
  if (typeof body.enabled === "boolean") {
    const uid = await requireRole(request, db, ["Admin"]);
    if (!uid) return NextResponse.json({ error: "Włączać i wyłączać synchronizację może tylko Admin." }, { status: 403 });
    const { data: me } = await db.from("members").select("email").eq("user_id", uid).maybeSingle();
    if (body.enabled) {
      const { error } = await db.rpc("listing_stock_enable", { p_email: me?.email || "app" });
      if (error) return NextResponse.json({ error: /listing_stock/.test(error.message) ? "Brak tabel — uruchom supabase/listing-stock-sync.sql." : error.message }, { status: 500 });
    } else {
      const { error } = await db.from("listing_stock_settings").update({ enabled: false }).eq("id", 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, enabled: body.enabled });
  }
  if (body.run === true) {
    if (!(await requireRole(request, db, ["Admin", "Manager", "Księgowa"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
    return NextResponse.json(await runStockSync(db));
  }
  return NextResponse.json({ error: "Nieznane polecenie." }, { status: 400 });
}
