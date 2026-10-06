import { NextResponse } from "next/server";
import { rcpAdmin, rcpCaller, clientIp, loadAllowedIps } from "@/lib/rcpServer";
import { isValidIp, normalizeIp } from "@/lib/rcp";

// Ustawienia RCP: lista adresów IP komputerów w firmie. GET — Admin i Manager (z adresem bieżącego komputera, żeby dało się go dodać jednym kliknięciem), POST — tylko Admin.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const db = rcpAdmin();
  const me = await rcpCaller(request, db);
  if (!me || !["Admin", "Manager"].includes(me.role)) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  return NextResponse.json({ ok: true, allowedIps: await loadAllowedIps(db), myIp: clientIp(request) });
}

export async function POST(request: Request) {
  const db = rcpAdmin();
  const me = await rcpCaller(request, db);
  if (!me || me.role !== "Admin") return NextResponse.json({ error: "Brak uprawnień (tylko Admin)." }, { status: 403 });
  const b = await request.json().catch(() => null);
  const raw: unknown[] = Array.isArray(b?.allowedIps) ? b.allowedIps : [];
  const ips = Array.from(new Set(raw.map((x) => normalizeIp(String(x))).filter(Boolean)));
  const bad = ips.find((x) => !isValidIp(x));
  if (bad) return NextResponse.json({ error: `Nieprawidłowy adres IP: ${bad}` }, { status: 400 });
  if (ips.length > 50) return NextResponse.json({ error: "Za dużo adresów (max 50)." }, { status: 400 });
  const { error } = await db.from("rcp_settings").upsert({ id: 1, allowed_ips: ips, updated_at: new Date().toISOString(), updated_by_email: me.email });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, allowedIps: ips });
}
