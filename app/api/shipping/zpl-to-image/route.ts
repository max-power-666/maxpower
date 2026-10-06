import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { pngToMono } from "@/lib/pngToMono";
import { monoToGfa } from "@/lib/gifToZpl";

// Etykieta ZPL -> ZPL zawierający TYLKO obraz (^GFA) — dla drukarek, które nie rozumieją fontów ZPL tak jak Zebra (06.10.2026: HPRT HD100 w trybie
// emulacji ZPL drukował etykiety DHL Express z nieczytelnym tekstem, choć kody kreskowe wychodziły poprawnie). ZPL jest renderowany przez Labelary (ta sama
// usługa co podgląd PDF w render-zpl; 8 dpmm = 203 dpi, 10x15 cm), wynik PNG zamieniany na czerń/biel i na grafikę ZPL — taką drukuje każda drukarka z ^GF.
// Tylko Admin, Manager i Zamówienia; nic nie zapisuje.

export const maxDuration = 30;

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
      headers: { Accept: "image/png", "Content-Type": "application/x-www-form-urlencoded" },
      body: zpl,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: `Labelary zwróciło błąd (${res.status}): ${text.slice(0, 200)}` }, { status: 502 });
    }
    const mono = pngToMono(new Uint8Array(await res.arrayBuffer()));
    const { total, rowBytes, data } = monoToGfa(mono);
    const ox = Math.max(0, Math.floor((812 - mono.width) / 2));
    const out = `^XA\n^PW812\n^LL1218\n^LH0,0\n^FO${ox},0^GFA,${total},${total},${rowBytes},${data}^FS\n^XZ\n`;
    return NextResponse.json({ ok: true, zpl: out });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się zamienić etykiety na obraz." }, { status: 502 });
  }
}
