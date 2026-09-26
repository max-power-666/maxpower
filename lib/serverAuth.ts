// Sprawdzanie po stronie serwera, kto woła route: token zalogowanego użytkownika (nagłówek Authorization) i jego rola z `members`.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Zwraca id użytkownika, jeśli token jest ważny, a jego rola należy do `roles`; w przeciwnym razie null.
export async function requireRole(request: Request, admin: SupabaseClient<any, any, any>, roles: string[]): Promise<string | null> {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data } = await anon.auth.getUser(token);
  const uid = data?.user?.id;
  if (!uid) return null;
  const { data: member } = await admin.from("members").select("role").eq("user_id", uid).maybeSingle();
  return member?.role && roles.includes(member.role) ? uid : null;
}
