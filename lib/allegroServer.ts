// Wspólne dla route'ów Allegro (tylko serwer): dostęp do tokenów OAuth w Supabase (service_role) i sprawdzenie, że wołający jest Adminem.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AllegroApp, AllegroTokens, TokenStore } from "./allegro";

// Zwraca null, dopóki nie ma kompletu: Client_ID, Client_Secret i ALLEGRO_UA. User-Agent nie ma wartości domyślnej celowo —
// zapytania z nieprawidłowym User-Agentem kończą się zablokowaniem klucza API przez Allegro.
export function allegroApp(): AllegroApp | null {
  // Wartości przycinamy: znak nowej linii albo spacja wklejone razem z kluczem psują dopasowanie po stronie Allegro.
  const clientId = process.env.ALLEGRO_CLIENT_ID?.trim();
  const clientSecret = process.env.ALLEGRO_CLIENT_SECRET?.trim();
  const userAgent = process.env.ALLEGRO_UA?.trim();
  return clientId && clientSecret && userAgent ? { clientId, clientSecret, userAgent } : null;
}

// Adres, na który Allegro odsyła przeglądarkę po zgodzie. MUSI być identyczny (znak w znak) z wpisanym w ustawieniach
// aplikacji na apps.developer.allegro.pl. Domyślnie budujemy go z adresu, pod którym otwarto aplikację; zmienna
// ALLEGRO_REDIRECT_URI pozwala go ustawić na sztywno (np. gdy aplikacja jest dostępna pod kilkoma domenami).
export function allegroRedirectUri(request: Request): string {
  return process.env.ALLEGRO_REDIRECT_URI?.trim() || `${new URL(request.url).origin}/api/orders/allegro-callback`;
}

export function serviceClient(): SupabaseClient<any, any, any> {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

export function tokenStore(admin: SupabaseClient<any, any, any>): TokenStore {
  return {
    async load() {
      const { data, error } = await admin
        .from("oauth_tokens")
        .select("refresh_token, access_token, access_expires_at")
        .eq("marketplace", "allegro")
        .maybeSingle();
      if (error) throw new Error(`Błąd odczytu tokenów z Supabase: ${error.message}`);
      return data?.refresh_token ? (data as AllegroTokens) : null;
    },
    async save(next, expectedRefresh) {
      const { data, error } = await admin
        .from("oauth_tokens")
        .update({ ...next, updated_at: new Date().toISOString() })
        .eq("marketplace", "allegro")
        .eq("refresh_token", expectedRefresh) // zamiana tylko, jeśli nikt inny nie odświeżył w międzyczasie
        .select("marketplace");
      if (error) throw new Error(`Błąd zapisu tokenów do Supabase: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
  };
}

// Zwraca id zalogowanego użytkownika, jeśli token w nagłówku jest ważny, a jego rola w `members` to Admin.
export async function requireAdmin(request: Request, admin: SupabaseClient<any, any, any>): Promise<string | null> {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data } = await anon.auth.getUser(token);
  const uid = data?.user?.id;
  if (!uid) return null;
  const { data: member } = await admin.from("members").select("role").eq("user_id", uid).maybeSingle();
  return member?.role === "Admin" ? uid : null;
}
