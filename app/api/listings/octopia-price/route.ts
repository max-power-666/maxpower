import { NextResponse } from "next/server";
import { admin } from "@/lib/parcelServer";
import { requireRole } from "@/lib/serverAuth";
import { octopiaConfigFromEnv } from "@/lib/octopia";
import { applyOctopiaPrices } from "@/lib/octopiaPriceApply";

// Zmiana cen ofert Cdiscount (19.10.2026, bidder cen — zadanie ZAD-7). ZMIENIA PRAWDZIWE CENY NA ŻYWYM MARKETPLACE'IE, dlatego: tylko Admin/Manager/Księgowa, wymagane `confirm: true`
// (UI pokazuje stare i nowe ceny), cena nie niższa od naszej ceny minimalnej i nie wyższa od maksymalnej (listing_price_rules), zmiana o ponad 50% wymaga `force: true`,
// waluta z naszej bazy (tylko EUR), każda próba (też nieudana) trafia do listing_price_log. API Octopii zmienia ceny wsadowo i asynchronicznie (paczka ofert Update) — patrz lib/octopia.ts.
// NIE testowane na żywym API.

export const maxDuration = 60;
const MAX_ITEMS = 50;

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Księgowa"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień (zmiana cen: Admin, Manager, Księgowa)." }, { status: 403 });
  let body: { changes?: unknown; confirm?: unknown; force?: unknown };
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
    const r = await applyOctopiaPrices(db, cfg, who, raw.map((c) => ({ externalId: String(c?.externalId || "").trim(), price: Number(c?.price), reason: typeof c?.reason === "string" ? c.reason : "" })), { force: body.force === true });
    return NextResponse.json(r, { status: r.okCount > 0 || r.results.length === 0 ? 200 : 502 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Nie udało się zmienić cen." }, { status: 500 });
  }
}
