import { NextResponse } from "next/server";
import { admin } from "@/lib/parcelServer";
import { requireRole } from "@/lib/serverAuth";

// Cena minimalna / maksymalna oferty dla bidderów cen (19.10.2026). Nic nie zmienia na marketplace'ie — to tylko nasze granice; zmianę cen robi osobna, potwierdzana akcja.
export const maxDuration = 30;

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Księgowa"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień (ceny min/max: Admin, Manager, Księgowa)." }, { status: 403 });
  let body: { marketplace?: unknown; externalId?: unknown; minPrice?: unknown; maxPrice?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Niepoprawne żądanie." }, { status: 400 });
  }
  const marketplace = String(body.marketplace || "");
  const externalId = String(body.externalId || "").trim();
  if (marketplace !== "octopia") return NextResponse.json({ error: "Reguły cen są na razie tylko dla Cdiscount." }, { status: 400 });
  if (!externalId) return NextResponse.json({ error: "Brak ID oferty." }, { status: 400 });
  const parse = (v: unknown): number | null | "bad" => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) && n > 0 && n < 100_000 ? Math.round(n * 100) / 100 : "bad";
  };
  const min = parse(body.minPrice);
  const max = parse(body.maxPrice);
  if (min === "bad" || max === "bad") return NextResponse.json({ error: "Cena musi być dodatnią liczbą." }, { status: 400 });
  if (min !== null && max !== null && max < min) return NextResponse.json({ error: "Cena maksymalna nie może być niższa od minimalnej." }, { status: 400 });
  const { data: listing } = await db.from("marketplace_listings").select("external_id").eq("marketplace", marketplace).eq("external_id", externalId).maybeSingle();
  if (!listing) return NextResponse.json({ error: "Tej oferty nie ma w naszej bazie (Listingi)." }, { status: 404 });
  const { data: me } = await db.from("members").select("email").eq("user_id", uid).maybeSingle();
  const who = (me?.email as string | undefined) || "app";
  const { data: old, error: oe } = await db.from("listing_price_rules").select("min_price, max_price, history").eq("marketplace", marketplace).eq("external_id", externalId).maybeSingle();
  if (oe) return NextResponse.json({ error: /listing_price_rules/.test(oe.message) ? "Brak tabeli reguł cen — uruchom supabase/listing-price-rules.sql w Supabase." : oe.message }, { status: 500 });
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  if (old && num(old.min_price) === min && num(old.max_price) === max) return NextResponse.json({ ok: true, minPrice: min, maxPrice: max, unchanged: true });
  if (!old && min === null && max === null) return NextResponse.json({ ok: true, minPrice: null, maxPrice: null, unchanged: true });
  const history = [...(((old?.history as unknown[]) || []).slice(-49)), { at: new Date().toISOString(), by_email: who, from: { min: num(old?.min_price), max: num(old?.max_price) }, to: { min, max } }];
  const { error } = await db.from("listing_price_rules").upsert({ marketplace, external_id: externalId, min_price: min, max_price: max, updated_by_email: who, updated_at: new Date().toISOString(), history }, { onConflict: "marketplace,external_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, minPrice: min, maxPrice: max });
}
