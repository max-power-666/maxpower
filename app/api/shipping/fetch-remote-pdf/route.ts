import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";

// Pobiera PDF spod zewnętrznego adresu (dziś: delivery_note/packing slip Back Marketu, podpisany link do S3) i
// zwraca jako base64 — serwerowy proxy, żeby druk bezpośredni (QZ Tray) nie musiał robić cross-origin fetch z
// przeglądarki (CORS na S3 bywa różny/nieprzewidywalny). Tylko Admin, Manager i Zamówienia. Prosta ochrona przed
// SSRF: tylko https i tylko hosty spoza prywatnych/lokalnych zakresów — to i tak trafia tylko do
// zaufanego, zalogowanego zespołu, nie jest publiczne.

const ROLES = ["Admin", "Manager", "Zamówienia"];
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BLOCKED_HOST_PATTERNS = [/^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^169\.254\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^\[?::1\]?$/];

export async function POST(request: Request) {
  if (!(await requireRole(request, admin(), ROLES))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const b = await request.json().catch(() => null);
  const url = typeof b?.url === "string" ? b.url : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: "Nieprawidłowy adres." }, { status: 400 });
  }
  if (parsed.protocol !== "https:") return NextResponse.json({ error: "Dozwolone tylko adresy https." }, { status: 400 });
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(parsed.hostname))) return NextResponse.json({ error: "Ten adres jest zablokowany." }, { status: 400 });

  try {
    const res = await fetch(parsed.toString(), { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return NextResponse.json({ error: `Pobranie dokumentu nie powiodło się (${res.status}).` }, { status: 502 });
    const buf = Buffer.from(await res.arrayBuffer());
    return NextResponse.json({ ok: true, base64: buf.toString("base64") });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się pobrać dokumentu." }, { status: 502 });
  }
}
