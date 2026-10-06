import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Wspólne dla route'ów RCP (06.10.2026): kto woła (każda rola z nadaną rolą), adres IP komputera, lista dozwolonych adresów.

export const rcpAdmin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export type RcpCaller = { uid: string; email: string; role: string };

// Zalogowany użytkownik z NADANĄ rolą (osoba bez roli nie rejestruje czasu). null, gdy token nieważny albo brak roli.
export async function rcpCaller(request: Request, db: SupabaseClient<any, any, any>): Promise<RcpCaller | null> {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data } = await anon.auth.getUser(token);
  const user = data?.user;
  if (!user) return null;
  const { data: m } = await db.from("members").select("role").eq("user_id", user.id).maybeSingle();
  const role = (m?.role as string | undefined) || "";
  return role ? { uid: user.id, email: user.email ?? "", role } : null;
}

// Adres IP klienta za proxy Vercela: pierwszy z x-forwarded-for, a w razie braku x-real-ip.
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return (request.headers.get("x-real-ip") || "").trim();
}

export async function loadAllowedIps(db: SupabaseClient<any, any, any>): Promise<string[]> {
  const { data, error } = await db.from("rcp_settings").select("allowed_ips").eq("id", 1).maybeSingle();
  if (error) return []; // przed uruchomieniem rcp.sql nie ma tabeli — wtedy i tak nie ma jak rejestrować (rcp_act też nie istnieje)
  return ((data?.allowed_ips as string[] | null) || []).filter(Boolean);
}
