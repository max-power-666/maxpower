import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { nbpRateFor } from "@/lib/partsServer";

// Kurs NBP dla ręcznie zmienionej waluty/daty w oknie importu części: GET ?currency=EUR&date=YYYY-MM-DD (kurs z dnia roboczego PRZED datą).
export async function GET(request: Request) {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  if (!(await requireRole(request, db, ["Admin", "Manager", "Serwis", "Kierownik serwisu"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const u = new URL(request.url);
  const rate = await nbpRateFor((u.searchParams.get("currency") || "").toUpperCase(), u.searchParams.get("date"));
  return NextResponse.json({ ok: true, rate });
}
