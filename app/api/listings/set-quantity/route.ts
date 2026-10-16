import { NextResponse } from "next/server";
import { admin } from "@/lib/parcelServer";
import { requireRole } from "@/lib/serverAuth";
import { bmListingsConfigFromEnv } from "@/lib/listings";
import { bmGetQuantity, bmSetQuantity, refurbedGetStock, refurbedSetStock } from "@/lib/marketStock";
import type { RefurbedClient } from "@/lib/refurbed";

// Ręczne ustawienie ilości ofert na marketplace'ach (16.10.2026, Magazyn -> Do wystawienia -> "Zaktualizuj ilości"). ZMIENIA PRAWDZIWE STANY NA ŻYWYM MARKETPLACE'IE — tylko Admin/Manager/Księgowa,
// wymagane `confirm: true` (UI pokazuje zmiany ilości i prosi o potwierdzenie), max 24 oferty na wywołanie, każda zmiana (też nieudana) trafia do listing_stock_log. Ilość z żądania jest ustawiana wprost.
export const maxDuration = 60;

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Księgowa"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień (zmiana ilości: Admin, Manager, Księgowa)." }, { status: 403 });
  let body: { items?: unknown; confirm?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Niepoprawne żądanie." }, { status: 400 });
  }
  if (body.confirm !== true) return NextResponse.json({ error: "Wymagane potwierdzenie (confirm)." }, { status: 400 });
  const items = (Array.isArray(body.items) ? body.items : [])
    .map((x: any) => ({ marketplace: String(x?.marketplace || ""), externalId: String(x?.externalId || "").trim(), quantity: Number(x?.quantity), reason: typeof x?.reason === "string" ? x.reason.slice(0, 300) : null }))
    .filter((x) => (x.marketplace === "backmarket" || x.marketplace === "refurbed") && x.externalId && Number.isInteger(x.quantity) && x.quantity >= 0 && x.quantity <= 1000);
  if (items.length === 0) return NextResponse.json({ error: "Nie wskazano ofert (ilość: liczba całkowita 0–1000)." }, { status: 400 });
  if (items.length > 24) return NextResponse.json({ error: "Za dużo ofert naraz (max 24)." }, { status: 400 });
  const { data: me } = await db.from("members").select("email").eq("user_id", uid).maybeSingle();
  const who = (me?.email as string | undefined) || "app";
  const bm = bmListingsConfigFromEnv();
  const rf: RefurbedClient | null = process.env.REFURBED_API_TOKEN ? { token: process.env.REFURBED_API_TOKEN, userAgent: process.env.REFURBED_UA || "recoo-erp", baseUrl: process.env.REFURBED_BASE_URL || undefined } : null;
  const results: { marketplace: string; externalId: string; ok: boolean; old?: number | null; applied?: number; error?: string }[] = [];
  for (const it of items) {
    const { data: row } = await db.from("marketplace_listings").select("sku").eq("marketplace", it.marketplace).eq("external_id", it.externalId).maybeSingle();
    let old: number | null = null;
    try {
      if (!row) throw new Error("Tej oferty nie ma w naszej bazie (Listingi) — odśwież Listingi.");
      if (it.marketplace === "backmarket") {
        if (!bm) throw new Error("Back Market nie jest skonfigurowany (brak BACKMARKET_AUTH).");
        old = await bmGetQuantity(bm, it.externalId);
        if (old !== it.quantity) await bmSetQuantity(bm, it.externalId, it.quantity);
      } else {
        if (!rf) throw new Error("refurbed nie jest skonfigurowany (brak REFURBED_API_TOKEN).");
        old = await refurbedGetStock(rf, it.externalId);
        if (old !== it.quantity) await refurbedSetStock(rf, it.externalId, it.quantity);
      }
      await db.from("marketplace_listings").update({ quantity: it.quantity }).eq("marketplace", it.marketplace).eq("external_id", it.externalId);
      await db.from("listing_stock_log").insert({ source: "manual", by_email: who, marketplace: it.marketplace, external_id: it.externalId, sku: row?.sku ?? null, old_quantity: old, new_quantity: it.quantity, reason: it.reason, ok: true });
      results.push({ marketplace: it.marketplace, externalId: it.externalId, ok: true, old, applied: it.quantity });
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 400);
      await db.from("listing_stock_log").insert({ source: "manual", by_email: who, marketplace: it.marketplace, external_id: it.externalId, sku: row?.sku ?? null, old_quantity: old, new_quantity: it.quantity, reason: it.reason, ok: false, error: msg });
      results.push({ marketplace: it.marketplace, externalId: it.externalId, ok: false, error: msg });
    }
  }
  return NextResponse.json({ results });
}
