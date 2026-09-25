import { NextResponse } from "next/server";
import { authorizeUrl } from "@/lib/allegro";
import { allegroApp, requireAdmin, serviceClient } from "@/lib/allegroServer";

// Łączenie konta Allegro (OAuth Authorization Code) — tylko Admin.
//  GET  -> stan połączenia: { configured, connected, connectedAt, redirectUri }
//  POST -> { url }: adres strony Allegro, na którą przeglądarka ma przejść, żeby wyrazić zgodę (scope: tylko odczyt zamówień).
// Adres przekierowania (redirectUri) trzeba wpisać dokładnie tak samo w ustawieniach aplikacji na apps.developer.allegro.pl.
// Po zgodzie Allegro odsyła przeglądarkę do /api/orders/allegro-callback (patrz tamten plik).

const redirectUriFor = (request: Request) => `${new URL(request.url).origin}/api/orders/allegro-callback`;

export async function GET(request: Request) {
  const admin = serviceClient();
  if (!(await requireAdmin(request, admin))) return NextResponse.json({ error: "Tylko Admin." }, { status: 403 });
  const { data } = await admin.from("oauth_tokens").select("refresh_token, connected_at").eq("marketplace", "allegro").maybeSingle();
  return NextResponse.json({
    configured: !!allegroApp(),
    connected: !!data?.refresh_token,
    connectedAt: data?.connected_at ?? null,
    redirectUri: redirectUriFor(request),
  });
}

export async function POST(request: Request) {
  const admin = serviceClient();
  if (!(await requireAdmin(request, admin))) return NextResponse.json({ error: "Tylko Admin." }, { status: 403 });
  const app = allegroApp();
  if (!app) return NextResponse.json({ error: "Brak ALLEGRO_CLIENT_ID / ALLEGRO_CLIENT_SECRET / ALLEGRO_UA w zmiennych środowiskowych." }, { status: 400 });

  // Losowy znacznik (state) chroni callback przed podstawionym żądaniem: przyjmiemy tylko ten, który sami wydaliśmy.
  const state = crypto.randomUUID();
  const { error } = await admin.from("oauth_tokens").upsert({
    marketplace: "allegro",
    pending_state: state,
    pending_state_expires: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (error) return NextResponse.json({ error: `Błąd zapisu do Supabase: ${error.message}` }, { status: 500 });
  return NextResponse.json({ url: authorizeUrl(app.clientId, redirectUriFor(request), state) });
}
