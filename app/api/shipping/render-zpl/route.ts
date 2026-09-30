import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";

// Renderuje surowy ZPL (etykieta DHL Express/Parcel) jako PDF do podglądu na ekranie / trybu "Generuj PDF" —
// przez darmowe publiczne API Labelary (labelary.com), bez własnego renderera ZPL. Etykieta DHL to 10x15 cm (4x6
// cala), 8dpmm odpowiada standardowej rozdzielczości 203 dpi etykieciarek Zebra. Tylko Admin, Manager i Zamówienia
// (te same role, co reszta Wysyłki) — nic nie zapisuje, czysty odczyt/konwersja.

const ROLES = ["Admin", "Manager", "Zamówienia"];
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(request: Request) {
  if (!(await requireRole(request, admin(), ROLES))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const b = await request.json().catch(() => null);
  const zpl = typeof b?.zpl === "string" ? b.zpl : "";
  if (!zpl.trim()) return NextResponse.json({ error: "Brak treści etykiety (ZPL)." }, { status: 400 });

  try {
    const res = await fetch("https://api.labelary.com/v1/printers/8dpmm/labels/4x6/0/", {
      method: "POST",
      headers: { Accept: "application/pdf", "Content-Type": "application/x-www-form-urlencoded" },
      body: zpl,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: `Labelary zwróciło błąd (${res.status}): ${text.slice(0, 200)}` }, { status: 502 });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return NextResponse.json({ ok: true, pdfBase64: buf.toString("base64") });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się wyrenderować podglądu etykiety." }, { status: 502 });
  }
}
