import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/allegro";
import { allegroApp, serviceClient } from "@/lib/allegroServer";

// Powrót z Allegro po wyrażeniu zgody: ?code=...&state=... (albo ?error=... po anulowaniu). To zwykłe przejście
// przeglądarki, bez nagłówka Authorization — dlatego wiarygodność żądania potwierdza `state`, który wydaliśmy przy
// rozpoczęciu autoryzacji (allegro-auth POST, ważny 10 minut, jednorazowy). Kod wymieniamy na tokeny i zapisujemy w oauth_tokens.

function back(request: Request, status: string, message?: string) {
  const url = new URL("/", request.url);
  url.searchParams.set("allegro", status);
  if (message) url.searchParams.set("msg", message.slice(0, 200));
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("error")) return back(request, "error", `Allegro: ${params.get("error_description") || params.get("error")}`);
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return back(request, "error", "Brak kodu autoryzacji w odpowiedzi Allegro.");

  const app = allegroApp();
  if (!app) return back(request, "error", "Brak ALLEGRO_CLIENT_ID / ALLEGRO_CLIENT_SECRET.");
  const admin = serviceClient();

  const { data: row } = await admin.from("oauth_tokens").select("pending_state, pending_state_expires").eq("marketplace", "allegro").maybeSingle();
  if (!row?.pending_state || row.pending_state !== state || Date.parse(row.pending_state_expires) < Date.now()) {
    return back(request, "error", "Nieprawidłowy albo wygasły znacznik autoryzacji — spróbuj ponownie.");
  }

  try {
    const redirectUri = `${new URL(request.url).origin}/api/orders/allegro-callback`;
    const t = await exchangeCode(app, code, redirectUri);
    const { error } = await admin.from("oauth_tokens").upsert({
      marketplace: "allegro",
      refresh_token: t.refresh_token,
      access_token: t.access_token,
      access_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
      pending_state: null, // znacznik jest jednorazowy
      pending_state_expires: null,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Błąd zapisu do Supabase: ${error.message}`);
    // Nowe połączenie = zacznij pobieranie od początku roku, bez względu na wcześniejszy kursor.
    await admin.from("sales_orders_sync_meta").upsert({ marketplace: "allegro", scan_cursor: null });
    return back(request, "connected");
  } catch (e: any) {
    return back(request, "error", e.message || "Nie udało się połączyć z Allegro.");
  }
}
