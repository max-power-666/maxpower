import { NextResponse } from "next/server";
import { bidderRunSkus, bidderTick, isAuthorized } from "@/lib/buyback";

// Bidder Trade-in (patrz lib/buyback.ts).
// GET  — Vercel Cron co minutę (vercel.json): kontynuuje trwający przebieg albo startuje
//        nowy, jeśli bidder jest włączony i minął interwał.
// POST — przycisk "Uruchom teraz" w zakładce Trade-in: zleca przebieg i od razu robi tick.
//        Z body { skus: [...] } (05.10.2026, "Uruchom dla zaznaczonych"): przebieg TYLKO dla wskazanych SKU, od razu (bidderRunSkus).

export const dynamic = "force-dynamic";
export const maxDuration = 300; // wymaga planu Vercel Pro (Hobby: max 60 s)

async function handle(request: Request, requestRun: boolean) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  }
  try {
    const result = await bidderTick({ requestRun });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Błąd biddera" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request, false);
}

export async function POST(request: Request) {
  const body = await request.clone().json().catch(() => null);
  if (body && Array.isArray(body.skus)) {
    if (!(await isAuthorized(request))) return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
    try {
      return NextResponse.json(await bidderRunSkus(body.skus));
    } catch (e: any) {
      return NextResponse.json({ error: e.message || "Błąd biddera" }, { status: 500 });
    }
  }
  return handle(request, true);
}
