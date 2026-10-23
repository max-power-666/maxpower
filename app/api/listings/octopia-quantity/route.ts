import { NextResponse } from "next/server";
import { admin } from "@/lib/parcelServer";
import { requireRole } from "@/lib/serverAuth";
import { octopiaConfigFromEnv } from "@/lib/octopia";
import { applyOctopiaQuantities } from "@/lib/octopiaQuantityApply";

// Zmiana ilości ofert Cdiscount (23.10.2026). ZMIENIA PRAWDZIWY STAN NA ŻYWYM MARKETPLACE'IE, dlatego: tylko Admin/Manager/Księgowa, wymagane `confirm: true` (UI pokazuje starą i nową ilość),
// ilość całkowita 0–9999, każda próba (też nieudana) trafia do listing_stock_log. API Octopii zmienia oferty wsadowo i asynchronicznie (paczka ofert Update) — patrz lib/octopia.ts. NIE testowane na żywym API.
export const maxDuration = 60;
const MAX_ITEMS = 50;

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Księgowa"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień (zmiana ilości: Admin, Manager, Księgowa)." }, { status: 403 });
  let body: { changes?: unknown; confirm?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Niepoprawne żądanie." }, { status: 400 });
  }
  if (body.confirm !== true) return NextResponse.json({ error: "Wymagane potwierdzenie (confirm)." }, { status: 400 });
  const raw = Array.isArray(body.changes) ? (body.changes as any[]) : [];
  if (raw.length === 0) return NextResponse.json({ error: "Brak zmian do wykonania." }, { status: 400 });
  if (raw.length > MAX_ITEMS) return NextResponse.json({ error: `Za dużo ofert naraz (max ${MAX_ITEMS}).` }, { status: 400 });
  const cfg = octopiaConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Octopia nie jest skonfigurowana (brak OCTOPIA_CLIENT_ID/SECRET/SELLER_ID)." }, { status: 400 });

  const { data: me } = await db.from("members").select("email").eq("user_id", uid).maybeSingle();
  const who = (me?.email as string | undefined) || "app";
  try {
    const r = await applyOctopiaQuantities(db, cfg, who, raw.map((c) => ({ externalId: String(c?.externalId || "").trim(), quantity: Number(c?.quantity) })));
    return NextResponse.json(r, { status: r.okCount > 0 || r.results.length === 0 ? 200 : 502 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Nie udało się zmienić ilości." }, { status: 500 });
  }
}
