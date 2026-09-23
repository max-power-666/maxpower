import { NextResponse } from "next/server";
import { fetchCompetitors, isAuthorized } from "@/lib/buyback";

// Podgląd konkurencji dla jednego listingu (panel SKU w zakładce Trade-in).
// Tylko odczyt — niczego nie zmienia na Back Markecie.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  }
  const listingId = new URL(request.url).searchParams.get("listing_id");
  if (!listingId) return NextResponse.json({ error: "Brak listing_id." }, { status: 400 });
  try {
    return NextResponse.json(await fetchCompetitors(listingId));
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Błąd Back Market" }, { status: 502 });
  }
}
