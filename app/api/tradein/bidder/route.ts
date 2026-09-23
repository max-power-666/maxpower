import { NextResponse } from "next/server";
import { bidderTick, isAuthorized } from "@/lib/buyback";

// Bidder Trade-in (patrz lib/buyback.ts).
// GET  — Vercel Cron co minutę (vercel.json): kontynuuje trwający przebieg albo startuje
//        nowy, jeśli bidder jest włączony i minął interwał.
// POST — przycisk "Uruchom teraz" w zakładce Trade-in: zleca przebieg i od razu robi tick.

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
  return handle(request, true);
}
