import { NextResponse } from "next/server";
import { rcpAdmin, rcpCaller, clientIp, loadAllowedIps } from "@/lib/rcpServer";
import { isIpAllowed } from "@/lib/rcp";

// Stan rejestracji zalogowanej osoby (widżet RCP): trwający odcinek, czas serwera, adres IP i czy z tego komputera wolno rejestrować. Zamyka zaległe odcinki z poprzednich dni.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const db = rcpAdmin();
    const me = await rcpCaller(request, db);
    if (!me) return NextResponse.json({ error: "Brak uprawnień (nie rozpoznano zalogowanej osoby z rolą)." }, { status: 403 });
    const closed = await db.rpc("rcp_close_stale", { p_user: me.uid });
    const { data: open, error } = await db.from("rcp_segments").select("id, kind, area, started_at, needs_review").eq("user_id", me.uid).is("ended_at", null).maybeSingle();
    if (error) {
      const missing = error.code === "42P01" || error.code === "PGRST205";
      return NextResponse.json({ error: missing ? "Brak tabel RCP — uruchom supabase/rcp.sql w Supabase." : `Błąd odczytu stanu: ${error.message}`, setup: missing }, { status: missing ? 200 : 500 });
    }
    const ip = clientIp(request);
    const allowed = await loadAllowedIps(db);
    return NextResponse.json({ ok: true, now: new Date().toISOString(), open: open ?? null, ip, restricted: allowed.length > 0, ipAllowed: isIpAllowed(ip, allowed), staleClosed: closed.error ? `błąd: ${closed.error.message}` : closed.data });
  } catch (e: any) {
    return NextResponse.json({ error: `Błąd serwera RCP: ${e?.message || e}` }, { status: 500 });
  }
}
