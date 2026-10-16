import { NextResponse } from "next/server";
import { admin } from "@/lib/parcelServer";
import { requireRole } from "@/lib/serverAuth";
import { bmListingsConfigFromEnv } from "@/lib/listings";
import { bmSetListingPrice, refurbedSetReferencePrice } from "@/lib/marketPricing";
import type { RefurbedClient } from "@/lib/refurbed";

// Zmiana ceny oferty na marketplace'ie (16.10.2026, Magazyn -> Do wystawienia). ZMIENIA PRAWDZIWĄ CENĘ NA ŻYWYM MARKETPLACE'IE — dlatego: tylko Admin/Manager/Księgowa, jedna oferta na wywołanie,
// wymagane `confirm: true` (UI pokazuje stare i nowe wartości i prosi o potwierdzenie), cena w walucie oferty z naszej bazy (nie z żądania), ochrona przed literówką (zmiana o ponad 50%
// wymaga dodatkowego `force: true`), każda próba (też nieudana) trafia do listing_price_log. Back Market: POST /ws/listings/{id} z samą ceną (rynek wg BACKMARKET_LANG);
// refurbed: UpdateOffer z reference_price. Nie zmienia ilości ani innych pól oferty.

export const maxDuration = 60;

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Księgowa"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień (zmiana cen: Admin, Manager, Księgowa)." }, { status: 403 });
  let body: { marketplace?: unknown; externalId?: unknown; price?: unknown; confirm?: unknown; force?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Niepoprawne żądanie." }, { status: 400 });
  }
  const marketplace = String(body.marketplace || "");
  const externalId = String(body.externalId || "").trim();
  const price = Number(body.price);
  if (marketplace !== "backmarket" && marketplace !== "refurbed") return NextResponse.json({ error: "Nieznany marketplace." }, { status: 400 });
  if (!externalId) return NextResponse.json({ error: "Brak ID oferty." }, { status: 400 });
  if (!Number.isFinite(price) || price <= 0 || price > 100_000) return NextResponse.json({ error: "Niepoprawna cena." }, { status: 400 });
  if (body.confirm !== true) return NextResponse.json({ error: "Wymagane potwierdzenie (confirm)." }, { status: 400 });

  const { data: row, error: re } = await db.from("marketplace_listings").select("sku, price, currency, quantity").eq("marketplace", marketplace).eq("external_id", externalId).maybeSingle();
  if (re) return NextResponse.json({ error: `Błąd odczytu oferty: ${re.message}` }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Tej oferty nie ma w naszej bazie (Listingi) — odśwież Listingi i spróbuj ponownie." }, { status: 404 });
  const currency = String(row.currency || "EUR").toUpperCase();
  const oldPrice = row.price === null || row.price === undefined ? null : Number(row.price);
  if (oldPrice !== null && oldPrice > 0 && Math.abs(price / oldPrice - 1) > 0.5 && body.force !== true) {
    return NextResponse.json({ error: `Zmiana ceny z ${oldPrice} na ${price} ${currency} to ponad 50% — wygląda na pomyłkę. Jeśli to zamierzone, potwierdź ponownie.`, needsForce: true }, { status: 409 });
  }
  const { data: me } = await db.from("members").select("email").eq("user_id", uid).maybeSingle();
  const who = (me?.email as string | undefined) || "app";
  const log = async (ok: boolean, error: string | null) => {
    const { error: le } = await db.from("listing_price_log").insert({ by_email: who, marketplace, external_id: externalId, sku: row.sku, old_price: oldPrice, new_price: price, currency, reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : null, ok, error });
    return le;
  };
  try {
    let applied: number | null = null;
    if (marketplace === "backmarket") {
      const cfg = bmListingsConfigFromEnv();
      if (!cfg) throw new Error("Back Market nie jest skonfigurowany (brak BACKMARKET_AUTH).");
      applied = (await bmSetListingPrice(cfg, externalId, price, currency)).price;
    } else {
      if (!process.env.REFURBED_API_TOKEN) throw new Error("refurbed nie jest skonfigurowany (brak REFURBED_API_TOKEN).");
      const c: RefurbedClient = { token: process.env.REFURBED_API_TOKEN, userAgent: process.env.REFURBED_UA || "recoo-erp", baseUrl: process.env.REFURBED_BASE_URL || undefined };
      applied = (await refurbedSetReferencePrice(c, externalId, price, currency)).price;
    }
    const logErr = await log(true, null);
    await db.from("marketplace_listings").update({ price: applied ?? price }).eq("marketplace", marketplace).eq("external_id", externalId); // migawka odświeży się sama przy następnej synchronizacji
    return NextResponse.json({ ok: true, applied: applied ?? price, requested: price, mismatch: applied !== null && Math.abs(applied - price) > 0.009, logWarning: logErr ? `Cena zmieniona, ale nie zapisano wpisu w dzienniku: ${logErr.message}` : null });
  } catch (e: any) {
    await log(false, String(e?.message || e).slice(0, 500));
    return NextResponse.json({ error: e?.message || "Nie udało się zmienić ceny." }, { status: 502 });
  }
}
