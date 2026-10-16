import { NextResponse } from "next/server";
import { admin } from "@/lib/parcelServer";
import { requireRole } from "@/lib/serverAuth";
import { bmListingsConfigFromEnv } from "@/lib/listings";
import { bmMarketInfo, refurbedMarketInfo, type MarketInfo } from "@/lib/marketPricing";
import type { RefurbedClient } from "@/lib/refurbed";

// Cena BuyBox/Backbox z marketplace'ów (16.10.2026, Magazyn -> Do wystawienia): na żywo, dla podanych ofert (external_id z marketplace_listings = ID oferty/listingu).
// Back Market: GET /ws/backbox/v1/competitors/{listingId}; refurbed: OfferService/GetOffer. Dostęp: Admin, Manager, Księgowa. Tylko odczyt — niczego nie zmienia.

export const maxDuration = 60;
const MAX_ITEMS = 24;

type Item = { marketplace: string; externalId: string };
type Out = { marketplace: string; externalId: string; ok: boolean; markets: MarketInfo[]; error?: string };

export async function POST(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ["Admin", "Manager", "Księgowa"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  let body: { items?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Niepoprawne żądanie." }, { status: 400 });
  }
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((x: any) => ({ marketplace: String(x?.marketplace || ""), externalId: String(x?.externalId || "").trim() }))
    .filter((x: Item) => (x.marketplace === "backmarket" || x.marketplace === "refurbed") && x.externalId) as Item[];
  if (items.length === 0) return NextResponse.json({ error: "Nie wskazano ofert." }, { status: 400 });
  if (items.length > MAX_ITEMS) return NextResponse.json({ error: `Za dużo ofert naraz (max ${MAX_ITEMS}).` }, { status: 400 });

  const bm = bmListingsConfigFromEnv();
  const rf: RefurbedClient | null = process.env.REFURBED_API_TOKEN ? { token: process.env.REFURBED_API_TOKEN, userAgent: process.env.REFURBED_UA || "recoo-erp", baseUrl: process.env.REFURBED_BASE_URL || undefined } : null;
  const results: Out[] = [];
  for (const it of items) {
    try {
      if (it.marketplace === "backmarket") {
        if (!bm) throw new Error("Back Market nie jest skonfigurowany (brak BACKMARKET_AUTH).");
        results.push({ ...it, ok: true, markets: await bmMarketInfo(bm, it.externalId) });
      } else {
        if (!rf) throw new Error("refurbed nie jest skonfigurowany (brak REFURBED_API_TOKEN).");
        results.push({ ...it, ok: true, markets: await refurbedMarketInfo(rf, it.externalId) });
      }
    } catch (e: any) {
      results.push({ ...it, ok: false, markets: [], error: e?.message || String(e) });
    }
  }
  return NextResponse.json({ ok: true, results, bmLang: bm?.lang ?? null });
}
