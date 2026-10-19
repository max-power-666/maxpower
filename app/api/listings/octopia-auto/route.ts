import { NextResponse } from "next/server";
import { admin } from "@/lib/parcelServer";
import { isAuthorized } from "@/lib/buyback";
import { octopiaConfigFromEnv } from "@/lib/octopia";
import { applyOctopiaPrices } from "@/lib/octopiaPriceApply";
import { selectAutoChanges, type AutoCandidate, type AutoMode } from "@/lib/octopiaBidder";

// Automat cen Cdiscount (19.10.2026, na prośbę właściciela — "automatycznie podnieść cenę, gdy konkurencja przestaje się wyprzedawać"): cron co 15 min (kilka minut po synchronizacji ofert)
// stosuje propozycje bidderu dla ofert z włączonym trybem automatu (listing_price_rules.auto_mode = raise | both). ZMIENIA PRAWDZIWE CENY — dlatego: tylko oferty jawnie włączone, tylko ze świeżą
// migawką (< 30 min), bezpieczniki z lib/octopiaBidder.ts (selectAutoChanges) i ta sama walidacja min/max co ręczna zmiana (lib/octopiaPriceApply.ts); każda zmiana trafia do listing_price_log (autor "Automat Cdiscount").
// NIE testowane na żywym API Octopii.

export const maxDuration = 60;
const AUTO_WHO = "Automat Cdiscount";
const FRESH_MS = 30 * 60_000;
const MAX_ITEMS = 50;

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
  const cfg = octopiaConfigFromEnv();
  if (!cfg) return NextResponse.json({ ok: true, skipped: "Octopia nie jest skonfigurowana." });
  const db = admin();

  const { data: rules, error: re } = await db.from("listing_price_rules").select("external_id, min_price, max_price, auto_mode").eq("marketplace", "octopia").in("auto_mode", ["raise", "both"]);
  if (re) return NextResponse.json({ ok: !/auto_mode|listing_price_rules/.test(re.message), skipped: /auto_mode|listing_price_rules/.test(re.message) ? "Brak kolumny/tabeli reguł — uruchom supabase/listing-price-rules.sql." : undefined, error: /auto_mode|listing_price_rules/.test(re.message) ? undefined : re.message });
  if (!rules || rules.length === 0) return NextResponse.json({ ok: true, enabled: 0, changes: 0 });

  const ids = rules.map((r: any) => r.external_id as string);
  const { data: listings, error: le } = await db.from("marketplace_listings").select("external_id, state, quantity, price, details, snapshot_at").eq("marketplace", "octopia").in("external_id", ids);
  if (le) return NextResponse.json({ ok: false, error: le.message }, { status: 500 });
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data: recent } = await db.from("listing_price_log").select("external_id, created_at").eq("marketplace", "octopia").eq("by_email", AUTO_WHO).eq("ok", true).gte("created_at", since).in("external_id", ids);
  const lastAuto = new Map<string, number>();
  for (const r of recent || []) lastAuto.set(r.external_id as string, Math.max(lastAuto.get(r.external_id as string) ?? 0, Date.parse(r.created_at as string)));

  const now = Date.now();
  const ruleBy = new Map(rules.map((r: any) => [r.external_id as string, r]));
  const staleCount = { n: 0 };
  const cands: AutoCandidate[] = [];
  for (const l of listings || []) {
    if (now - Date.parse(l.snapshot_at as string) > FRESH_MS) { staleCount.n++; continue; } // migawka nieświeża (synchronizacja ofert nie działa) — nie ruszamy cen na starych danych
    const r: any = ruleBy.get(l.external_id as string);
    cands.push({
      externalId: l.external_id as string,
      state: l.state as string | null,
      quantity: l.quantity as number | null,
      price: l.price === null ? null : Number(l.price),
      details: l.details,
      rule: { min: r.min_price === null ? null : Number(r.min_price), max: r.max_price === null ? null : Number(r.max_price), autoMode: r.auto_mode as AutoMode },
      lastAutoAt: lastAuto.get(l.external_id as string) ?? null,
    });
  }
  const { changes, skipped } = selectAutoChanges(cands, now);
  if (changes.length === 0) return NextResponse.json({ ok: true, enabled: rules.length, stale: staleCount.n, changes: 0, skipped });
  try {
    const r = await applyOctopiaPrices(db, cfg, AUTO_WHO, changes.slice(0, MAX_ITEMS));
    return NextResponse.json({ ok: r.failCount === 0, enabled: rules.length, stale: staleCount.n, applied: r.okCount, failed: r.failCount, packageId: r.packageId, packageState: r.packageState, results: r.results.map((x) => ({ id: x.externalId, ok: x.ok, message: x.message })), skipped });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Błąd automatu cen." }, { status: 502 });
  }
}
