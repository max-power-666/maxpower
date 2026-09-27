// Wspólne dla route'ów Apilo (tylko serwer): dostęp do tokenów OAuth w Supabase (service_role, tabela oauth_tokens,
// wiersz marketplace = 'apilo' — ta sama tabela co dla Allegro).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ApiloApp, ApiloTokens, TokenStore } from "./apilo";

export function apiloApp(): ApiloApp | null {
  const clientId = process.env.APILO_CLIENT_ID?.trim();
  const clientSecret = process.env.APILO_CLIENT_SECRET?.trim();
  const baseUrl = process.env.APILO_BASE_URL?.trim().replace(/\/$/, "");
  return clientId && clientSecret && baseUrl ? { clientId, clientSecret, baseUrl } : null;
}

export function serviceClient(): SupabaseClient<any, any, any> {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

export function apiloTokenStore(admin: SupabaseClient<any, any, any>): TokenStore {
  return {
    async load() {
      const { data, error } = await admin.from("oauth_tokens").select("refresh_token, access_token, access_expires_at").eq("marketplace", "apilo").maybeSingle();
      if (error) throw new Error(`Błąd odczytu tokenów z Supabase: ${error.message}`);
      return data?.refresh_token ? (data as ApiloTokens) : null;
    },
    async save(next, expectedRefresh) {
      const { data, error } = await admin
        .from("oauth_tokens")
        .update({ ...next, updated_at: new Date().toISOString() })
        .eq("marketplace", "apilo")
        .eq("refresh_token", expectedRefresh)
        .select("marketplace");
      if (error) throw new Error(`Błąd zapisu tokenów do Supabase: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
  };
}

// Zwraca id zalogowanego użytkownika, jeśli token jest ważny, a jego rola w `members` to Admin.
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
