import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";
import { requireRole } from "@/lib/serverAuth";
import { runOffersRefresh, runQuantitySync } from "@/lib/shopBmServer";

// Recoo Sklep <- Back Market (21.10.2026). GET = cron co 5 min: odświeża ilości TYLKO gdy synchronizacja jest włączona (shop_sync_settings.enabled).
// POST (ERP -> Recoo Sklep -> Magazyn, zespół sklepu): { action: "toggle", enabled } | { action: "quantities" } | { action: "offers" }.
// Logika w lib/shopBmServer.ts.
export const maxDuration = 300;

const ROLES = ["Admin", "Manager", "Księgowa", "Sklep"];

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

async function saveResult(sb: ReturnType<typeof admin>, kind: "qty" | "offers", result: unknown) {
  const now = new Date().toISOString();
  const patch = kind === "qty" ? { last_qty_at: now, last_qty_result: result } : { last_offers_at: now, last_offers_result: result };
  await sb.from("shop_sync_settings").update(patch).eq("id", 1);
}

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
  const sb = admin();
  const { data: st, error } = await sb.from("shop_sync_settings").select("enabled").eq("id", 1).maybeSingle();
  if (error) return NextResponse.json({ skipped: `Brak ustawień synchronizacji (uruchom supabase/shop-bm-sync.sql): ${error.message}` });
  if (!st?.enabled) return NextResponse.json({ skipped: "Synchronizacja sklepu z Back Market jest wyłączona." });
  try {
    const result = await runQuantitySync(sb);
    await saveResult(sb, "qty", { ...result, source: "cron" });
    return NextResponse.json(result);
  } catch (e: any) {
    await saveResult(sb, "qty", { error: e.message || String(e), source: "cron" });
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
  const sb = admin();
  const uid = await requireRole(request, sb, ROLES);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień (Admin, Manager, Księgowa, Sklep)." }, { status: 403 });
  const { data: user } = await sb.auth.admin.getUserById(uid);
  const email = user?.user?.email ?? null;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === "toggle") {
      const enabled = body.enabled === true;
      const { error } = await sb.from("shop_sync_settings").update({ enabled, updated_by_email: email, updated_at: new Date().toISOString() }).eq("id", 1);
      if (error) throw new Error(`Nie zapisano ustawienia (uruchom supabase/shop-bm-sync.sql): ${error.message}`);
      return NextResponse.json({ enabled });
    }
    if (body.action === "quantities") {
      const result = await runQuantitySync(sb);
      await saveResult(sb, "qty", { ...result, source: email });
      return NextResponse.json(result);
    }
    if (body.action === "offers") {
      const result = await runOffersRefresh(sb);
      await saveResult(sb, "offers", { ...result, source: email });
      await saveResult(sb, "qty", { ...result.quantities, source: email });
      return NextResponse.json(result);
    }
    return NextResponse.json({ error: "Nieznana akcja." }, { status: 400 });
  } catch (e: any) {
    await saveResult(sb, body.action === "offers" ? "offers" : "qty", { error: e.message || String(e), source: email });
    return NextResponse.json({ error: e.message || String(e) }, { status: 500 });
  }
}
