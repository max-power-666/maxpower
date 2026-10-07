import { NextResponse } from "next/server";
import { rcpAdmin, rcpCaller, clientIp, loadAllowedIps } from "@/lib/rcpServer";
import { isIpAllowed, RCP_AREAS, ADMIN_WORK_ROLES } from "@/lib/rcp";

// Rejestracja czasu pracy: start | break | admin | resume | leave | change_area | end. Zapis WYŁĄCZNIE tu (tabela rcp_segments nie ma polityk zapisu), po sprawdzeniu adresu IP
// komputera (tylko komputery w firmie — lista w rcp_settings; pusta = bez ograniczenia). Samą zmianę stanu robi atomowa funkcja bazy rcp_act (zegar serwera).
export const dynamic = "force-dynamic";

const ACTIONS = ["start", "break", "admin", "resume", "leave", "change_area", "end"];

export async function POST(request: Request) {
  const db = rcpAdmin();
  const me = await rcpCaller(request, db);
  if (!me) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const b = await request.json().catch(() => null);
  const action = typeof b?.action === "string" ? b.action : "";
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: "Nieznana akcja." }, { status: 400 });
  if (action === "admin" && !ADMIN_WORK_ROLES.includes(me.role)) return NextResponse.json({ error: "Prace administracyjne mogą rejestrować tylko kierownicy." }, { status: 403 });
  const area = typeof b?.area === "string" ? b.area.trim() : "";
  if (area && !(RCP_AREAS as readonly string[]).includes(area)) return NextResponse.json({ error: "Nieznany obszar pracy." }, { status: 400 });

  const ip = clientIp(request);
  const allowed = await loadAllowedIps(db);
  if (!isIpAllowed(ip, allowed)) {
    return NextResponse.json({ error: `Czas pracy można rejestrować tylko z komputerów w firmie. Twój adres (${ip || "nieznany"}) nie jest na liście — poproś Admina.`, code: "ip" }, { status: 403 });
  }

  const { data, error } = await db.rpc("rcp_act", { p_user: me.uid, p_email: me.email, p_action: action, p_area: area || null, p_leave: typeof b?.leave === "string" ? b.leave : null, p_ip: ip || null });
  if (error) {
    if (error.code === "P0001") return NextResponse.json({ error: error.message }, { status: 409 });
    const missing = error.code === "PGRST202" || error.code === "42883";
    return NextResponse.json({ error: missing ? "Brak funkcji RCP — uruchom supabase/rcp.sql w Supabase." : error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, open: data ?? null, now: new Date().toISOString() });
}
