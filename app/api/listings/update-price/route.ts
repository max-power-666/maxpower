import { NextResponse } from "next/server";
import { admin } from "@/lib/parcelServer";
import { requireRole } from "@/lib/serverAuth";
import { bmListingsConfigFromEnv } from "@/lib/listings";
import { bmSetListingPrice, refurbedSetReferencePrice } from "@/lib/marketPricing";
import { BM_LOCALE_BY_MARKET } from "@/lib/listingPrice";
import type { RefurbedClient } from "@/lib/refurbed";

// Zmiana ceny oferty na marketplace'ie (16.10.2026, Magazyn -> Do wystawienia). ZMIENIA PRAWDZIWĄ CENĘ NA ŻYWYM MARKETPLACE'IE — dlatego: tylko Admin/Manager/Księgowa, jedna oferta na wywołanie,
// wymagane `confirm: true` (UI pokazuje stare i nowe wartości i prosi o potwierdzenie), cena w walucie oferty z naszej bazy (nie z żądania), ochrona przed literówką (zmiana o ponad 50%
// wymaga dodatkowego `force: true`), każda próba (też nieudana) trafia do listing_price_log. Back Market: POST /ws/listings/{id} z samą ceną (rynek wg BACKMARKET_LANG);
// refurbed: UpdateOffer z reference_price. Opcjonalnie `minPrice` — cena minimalna dla automatu marketplace'u (BM: min_price/BackPricer, refurbed: reference_min_price). Nie zmienia ilości ani innych pól oferty.

export const maxDuration = 60;

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Księgowa"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień (zmiana cen: Admin, Manager, Księgowa)." }, { status: 403 });
  let body: { marketplace?: unknown; externalId?: unknown; price?: unknown; minPrice?: unknown; markets?: unknown; confirm?: unknown; force?: unknown; reason?: unknown };
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
  const minPrice = body.minPrice === undefined || body.minPrice === null || body.minPrice === "" ? null : Number(body.minPrice);
  if (minPrice !== null && (!Number.isFinite(minPrice) || minPrice <= 0 || minPrice > price)) return NextResponse.json({ error: "Niepoprawna cena minimalna (musi być dodatnia i nie wyższa niż cena)." }, { status: 400 });
  if (body.confirm !== true) return NextResponse.json({ error: "Wymagane potwierdzenie (confirm)." }, { status: 400 });

  // Back Market: ceny per rynek (16.10.2026) — { market: "DE", price, minPrice }; tylko rynki z mapy języków i tylko w sensownym zakresie względem ceny głównej
  type MarketChange = { market: string; lang: string; price: number; minPrice: number | null };
  let marketChanges: MarketChange[] = [];
  if (marketplace === "backmarket" && Array.isArray(body.markets) && body.markets.length > 0) {
    if (body.markets.length > 16) return NextResponse.json({ error: "Za dużo rynków naraz." }, { status: 400 });
    for (const x of body.markets as any[]) {
      const market = String(x?.market || "").toUpperCase();
      const lang = BM_LOCALE_BY_MARKET[market];
      const p = Number(x?.price);
      const mp = x?.minPrice === undefined || x?.minPrice === null ? null : Number(x.minPrice);
      if (!lang) return NextResponse.json({ error: `Rynek ${market} nie jest obsługiwany.` }, { status: 400 });
      if (!Number.isFinite(p) || p <= 0 || p > 100_000 || p < price * 0.5 || p > price * 2) return NextResponse.json({ error: `Niepoprawna cena dla rynku ${market}.` }, { status: 400 });
      if (mp !== null && (!Number.isFinite(mp) || mp <= 0 || mp > p || 1.08 * mp < p - 0.005)) return NextResponse.json({ error: `Niepoprawna cena minimalna dla rynku ${market} (musi spełniać: min ≤ cena ≤ 1,08 × min).` }, { status: 400 });
      marketChanges.push({ market, lang, price: p, minPrice: mp });
    }
  }
  const { data: row, error: re } = await db.from("marketplace_listings").select("sku, price, min_price, currency, quantity").eq("marketplace", marketplace).eq("external_id", externalId).maybeSingle();
  if (re) return NextResponse.json({ error: `Błąd odczytu oferty: ${re.message}` }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Tej oferty nie ma w naszej bazie (Listingi) — odśwież Listingi i spróbuj ponownie." }, { status: 404 });
  const currency = String(row.currency || "EUR").toUpperCase();
  const oldPrice = row.price === null || row.price === undefined ? null : Number(row.price);
  if (oldPrice !== null && oldPrice > 0 && Math.abs(price / oldPrice - 1) > 0.5 && body.force !== true) {
    return NextResponse.json({ error: `Zmiana ceny z ${oldPrice} na ${price} ${currency} to ponad 50% — wygląda na pomyłkę. Jeśli to zamierzone, potwierdź ponownie.`, needsForce: true }, { status: 409 });
  }
  const oldMin = row.min_price === null || row.min_price === undefined ? null : Number(row.min_price);
  const { data: me } = await db.from("members").select("email").eq("user_id", uid).maybeSingle();
  const who = (me?.email as string | undefined) || "app";
  const log = async (ok: boolean, error: string | null) => {
    const entry = { by_email: who, marketplace, external_id: externalId, sku: row.sku, old_price: oldPrice, new_price: price, currency, reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : null, ok, error };
    let { error: le } = await db.from("listing_price_log").insert({ ...entry, old_min_price: oldMin, new_min_price: minPrice });
    if (le && /min_price/.test(le.message)) ({ error: le } = await db.from("listing_price_log").insert(entry)); // przed uruchomieniem listing-price-log.sql bez kolumn cen minimalnych
    return le;
  };
  const logMarket = async (mc: MarketChange, ok: boolean, error: string | null) => {
    const entry = { by_email: who, marketplace, external_id: externalId, sku: row.sku, old_price: null, new_price: mc.price, currency, reason: `[${mc.market}] ${typeof body.reason === "string" ? body.reason.slice(0, 450) : ""}`.trim(), ok, error };
    const { error: le } = await db.from("listing_price_log").insert({ ...entry, new_min_price: mc.minPrice });
    if (le && /min_price/.test(le.message)) await db.from("listing_price_log").insert(entry);
  };
  try {
    let applied: number | null = null;
    let appliedMin: number | null = null;
    if (marketplace === "backmarket") {
      const cfg = bmListingsConfigFromEnv();
      if (!cfg) throw new Error("Back Market nie jest skonfigurowany (brak BACKMARKET_AUTH).");
      if (marketChanges.length > 0) {
        const primary = cfg.lang.split("-")[1]?.toUpperCase();
        const results: { market: string; ok: boolean; applied?: number | null; appliedMin?: number | null; error?: string }[] = [];
        for (const mc of marketChanges) {
          try {
            const r = await bmSetListingPrice(cfg, externalId, mc.price, currency, mc.minPrice, mc.lang);
            results.push({ market: mc.market, ok: true, applied: r.price, appliedMin: r.minPrice });
            await logMarket(mc, true, null);
            if (mc.market === primary) await db.from("marketplace_listings").update({ price: r.price ?? mc.price, ...(mc.minPrice !== null ? { min_price: r.minPrice ?? mc.minPrice } : {}) }).eq("marketplace", marketplace).eq("external_id", externalId);
          } catch (e: any) {
            const msg = String(e?.message || e).slice(0, 300);
            results.push({ market: mc.market, ok: false, error: msg });
            await logMarket(mc, false, msg);
          }
        }
        const okCount = results.filter((r) => r.ok).length;
        return NextResponse.json({ ok: okCount > 0, marketResults: results, okCount, failCount: results.length - okCount }, { status: okCount > 0 ? 200 : 502 });
      }
      ({ price: applied, minPrice: appliedMin } = await bmSetListingPrice(cfg, externalId, price, currency, minPrice));
    } else {
      if (!process.env.REFURBED_API_TOKEN) throw new Error("refurbed nie jest skonfigurowany (brak REFURBED_API_TOKEN).");
      const c: RefurbedClient = { token: process.env.REFURBED_API_TOKEN, userAgent: process.env.REFURBED_UA || "recoo-erp", baseUrl: process.env.REFURBED_BASE_URL || undefined };
      ({ price: applied, minPrice: appliedMin } = await refurbedSetReferencePrice(c, externalId, price, currency, minPrice));
    }
    const logErr = await log(true, null);
    await db.from("marketplace_listings").update({ price: applied ?? price, ...(minPrice !== null ? { min_price: appliedMin ?? minPrice } : {}) }).eq("marketplace", marketplace).eq("external_id", externalId); // migawka odświeży się sama przy następnej synchronizacji
    return NextResponse.json({ ok: true, applied: applied ?? price, requested: price, appliedMin: appliedMin ?? (minPrice !== null ? minPrice : null), minMismatch: minPrice !== null && appliedMin !== null && Math.abs(appliedMin - minPrice) > 0.009, mismatch: applied !== null && Math.abs(applied - price) > 0.009, logWarning: logErr ? `Cena zmieniona, ale nie zapisano wpisu w dzienniku: ${logErr.message}` : null });
  } catch (e: any) {
    await log(false, String(e?.message || e).slice(0, 500));
    return NextResponse.json({ error: e?.message || "Nie udało się zmienić ceny." }, { status: 502 });
  }
}
