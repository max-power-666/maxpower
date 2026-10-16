import { NextResponse } from "next/server";
import { admin } from "@/lib/parcelServer";
import { requireRole } from "@/lib/serverAuth";
import { refurbedDeleteMarketOffer, refurbedGetOfferMarkets } from "@/lib/marketPricing";
import type { RefurbedClient } from "@/lib/refurbed";

// Usuwanie RĘCZNYCH cen krajów (override) oferty refurbed (16.10.2026, Magazyn -> Do wystawienia). Kraj z override jest poza automatem refurbed (nie schodzi do ceny minimalnej w poszukiwaniu BuyBox) —
// po usunięciu wraca do ceny wyliczanej z ceny referencyjnej i minimum oferty. ZMIENIA PRAWDZIWE CENY NA ŻYWYM MARKETPLACE'IE: tylko Admin/Manager/Księgowa, wymagane `confirm`, serwer sam czyta
// ofertę na żywo i usuwa wyłącznie kraje, które faktycznie mają override (pozostałe pomija), każda próba trafia do listing_price_log.
export const maxDuration = 60;

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Księgowa"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień (zmiana cen: Admin, Manager, Księgowa)." }, { status: 403 });
  let body: { externalId?: unknown; markets?: unknown; confirm?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Niepoprawne żądanie." }, { status: 400 });
  }
  const externalId = String(body.externalId || "").trim();
  const wanted = Array.from(new Set((Array.isArray(body.markets) ? body.markets : []).map((m) => String(m || "").trim().toUpperCase()).filter(Boolean)));
  if (!externalId) return NextResponse.json({ error: "Brak ID oferty." }, { status: 400 });
  if (wanted.length === 0) return NextResponse.json({ error: "Nie wskazano krajów." }, { status: 400 });
  if (wanted.length > 40) return NextResponse.json({ error: "Za dużo krajów naraz (max 40)." }, { status: 400 });
  if (body.confirm !== true) return NextResponse.json({ error: "Wymagane potwierdzenie (confirm)." }, { status: 400 });
  if (!process.env.REFURBED_API_TOKEN) return NextResponse.json({ error: "refurbed nie jest skonfigurowany (brak REFURBED_API_TOKEN)." }, { status: 500 });
  const c: RefurbedClient = { token: process.env.REFURBED_API_TOKEN, userAgent: process.env.REFURBED_UA || "recoo-erp", baseUrl: process.env.REFURBED_BASE_URL || undefined };
  const { data: row } = await db.from("marketplace_listings").select("sku").eq("marketplace", "refurbed").eq("external_id", externalId).maybeSingle();
  if (!row) return NextResponse.json({ error: "Tej oferty nie ma w naszej bazie (Listingi) — odśwież Listingi i spróbuj ponownie." }, { status: 404 });
  const { data: me } = await db.from("members").select("email").eq("user_id", uid).maybeSingle();
  const who = (me?.email as string | undefined) || "app";
  let live;
  try {
    live = await refurbedGetOfferMarkets(c, externalId);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Nie udało się odczytać oferty." }, { status: 502 });
  }
  const results: { market: string; ok: boolean; skipped?: boolean; error?: string }[] = [];
  for (const code of wanted) {
    const m = live.markets.find((x) => x.market.toUpperCase() === code);
    if (!m || !m.override) {
      results.push({ market: code, ok: true, skipped: true });
      continue;
    }
    const entry = { by_email: who, marketplace: "refurbed", external_id: externalId, sku: row.sku, old_price: m.ours, new_price: live.referencePrice ?? m.ours ?? 0, currency: m.currency, reason: `[${code}] usunięto ręczną cenę (override): było ${m.ours ?? "—"} / min ${m.minPrice ?? "—"}; ${typeof body.reason === "string" ? body.reason.slice(0, 300) : ""}`.trim() };
    try {
      await refurbedDeleteMarketOffer(c, externalId, code);
      results.push({ market: code, ok: true });
      await db.from("listing_price_log").insert({ ...entry, ok: true, error: null });
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 300);
      results.push({ market: code, ok: false, error: msg });
      await db.from("listing_price_log").insert({ ...entry, ok: false, error: msg });
    }
  }
  const removed = results.filter((r) => r.ok && !r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  return NextResponse.json({ results, removed, failed, skipped: results.filter((r) => r.skipped).length }, { status: removed > 0 || failed === 0 ? 200 : 502 });
}
