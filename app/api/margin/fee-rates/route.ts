import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRoleOrView } from "@/lib/serverAuth";
import { loadFeeRates } from "@/lib/feeRates";

// Średnie stawki prowizji Allegro i Erli z faktur kosztowych (16.10.2026) — dane do pigułki "Prowizje" w Marży (Admin, Manager, Księgowa). Metoda: lib/feeRates.ts.
export const maxDuration = 60;

export async function GET(request: Request) {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  if (!(await requireRoleOrView(request, db, ["Admin", "Manager", "Księgowa"], "margin"))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  try {
    const { rates, error } = await loadFeeRates(db);
    return NextResponse.json({ ok: true, rates, error });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Nie udało się policzyć stawek." }, { status: 500 });
  }
}
