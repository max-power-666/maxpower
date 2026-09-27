import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/apilo";
import { apiloApp, requireAdmin, serviceClient } from "@/lib/apiloServer";

// Połączenie z Apilo — tylko Admin. W odróżnieniu od Allegro nie ma tu przekierowania: kod autoryzacyjny generuje się
// w panelu Apilo (Administracja / API Apilo, po utworzeniu aplikacji) i Admin wkleja go tu RĘCZNIE, jednorazowo.
//  GET  -> stan połączenia: { configured, connected, connectedAt }
//  POST -> { code }: wymienia kod na pierwszą parę tokenów i zapisuje je w bazie (dalej odświeżają się same).

export async function GET(request: Request) {
  const admin = serviceClient();
  if (!(await requireAdmin(request, admin))) return NextResponse.json({ error: "Tylko Admin." }, { status: 403 });
  const { data } = await admin.from("oauth_tokens").select("refresh_token, connected_at").eq("marketplace", "apilo").maybeSingle();
  return NextResponse.json({ configured: !!apiloApp(), connected: !!data?.refresh_token, connectedAt: data?.connected_at ?? null });
}

export async function POST(request: Request) {
  const admin = serviceClient();
  if (!(await requireAdmin(request, admin))) return NextResponse.json({ error: "Tylko Admin." }, { status: 403 });
  const app = apiloApp();
  if (!app) return NextResponse.json({ error: "Brak APILO_CLIENT_ID / APILO_CLIENT_SECRET / APILO_BASE_URL w zmiennych środowiskowych." }, { status: 400 });

  const b = await request.json().catch(() => null);
  const code = typeof b?.code === "string" ? b.code.trim() : "";
  if (!code) return NextResponse.json({ error: "Wklej kod autoryzacyjny z panelu Apilo." }, { status: 400 });

  try {
    const t = await exchangeCode(app, code);
    const { error } = await admin.from("oauth_tokens").upsert({
      marketplace: "apilo",
      refresh_token: t.refresh_token,
      access_token: t.access_token,
      access_expires_at: t.access_expires_at,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Błąd zapisu do Supabase: ${error.message}`);
    // Nowe połączenie = zacznij pobieranie od początku roku, bez względu na wcześniejszy kursor.
    await admin.from("sales_orders_sync_meta").upsert({ marketplace: "apilo", scan_cursor: null, full_scan_done: false });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się połączyć z Apilo." }, { status: 422 });
  }
}
