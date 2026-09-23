import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Synchronizuje stan z Fakturowni do tabeli fakturownia_stock_cache w Supabase.
// Wywoływane przez: (1) Vercel Cron codziennie o północy (patrz vercel.json),
// (2) przycisk "Odśwież" w zakładce Magazyn.
//
// Ważne: pierwsza synchronizacja (brak fakturownia_sync_meta.last_synced_at) skanuje
// CAŁY katalog Fakturowni (u nas ~19 000 produktów, ~190 stron) — to za długo na
// limit czasu funkcji serwerowej na Vercelu. Kolejne synchronizacje są przyrostowe:
// pytają Fakturownię tylko o produkty zmienione po dacie ostatniej synchronizacji
// (parametr date_from), więc trwają ułamek sekundy. Pierwsze zasilenie tabeli robi
// się osobno (patrz rozmowa/README) — ten route nie jest do tego używany.

const PER_PAGE = 100;
const MAX_PAGES = 300;

function supabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function isAuthorized(request: Request): Promise<boolean> {
  const header = request.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;

  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return true;

  // w przeciwnym razie akceptujemy token zalogowanego użytkownika appki (przycisk "Odśwież")
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data } = await anon.auth.getUser(token);
  return !!data?.user;
}

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  }

  const domain = process.env.FAKTUROWNIA_DOMAIN;
  const token = process.env.FAKTUROWNIA_API_TOKEN;
  if (!domain || !token) {
    return NextResponse.json({ error: "Brak FAKTUROWNIA_DOMAIN / FAKTUROWNIA_API_TOKEN w .env.local" }, { status: 500 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Brak SUPABASE_SERVICE_ROLE_KEY w .env.local" }, { status: 500 });
  }

  const admin = supabaseAdmin();

  const { data: metaRow, error: metaError } = await admin
    .from("fakturownia_sync_meta")
    .select("last_synced_at")
    .eq("id", 1)
    .maybeSingle();
  if (metaError) return NextResponse.json({ error: `Błąd odczytu z Supabase: ${metaError.message}` }, { status: 500 });

  const lastSyncedAt = metaRow?.last_synced_at as string | null | undefined;
  const dateFromParam = lastSyncedAt ? `&date_from=${encodeURIComponent(lastSyncedAt.slice(0, 10))}` : "";

  const catRes = await fetch(
    `https://${domain}.fakturownia.pl/categories.json?api_token=${encodeURIComponent(token)}&per_page=100`,
    { cache: "no-store" }
  );
  if (!catRes.ok) {
    return NextResponse.json({ error: `Fakturownia (kategorie) zwróciła błąd (${catRes.status})` }, { status: 502 });
  }
  const categories = (await catRes.json()) as { id: number; name: string }[];
  const categoryNames: Record<string, string> = {};
  categories.forEach((c) => (categoryNames[String(c.id)] = c.name));

  const syncStartedAt = new Date().toISOString();
  let processed = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://${domain}.fakturownia.pl/products.json?api_token=${encodeURIComponent(token)}&per_page=${PER_PAGE}&page=${page}${dateFromParam}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json({ error: `Fakturownia zwróciła błąd (${res.status})` }, { status: 502 });
    }

    const products = (await res.json()) as any[];
    if (!Array.isArray(products) || products.length === 0) break;

    const toUpsert = products
      .filter((p) => Number(p.stock_level) === 1)
      .map((p) => ({
        id: p.id,
        category_id: p.category_id ?? null,
        category_name: (p.category_id != null && categoryNames[String(p.category_id)]) || "Bez kategorii",
        purchase_price_gross: Number(p.purchase_price_gross) || 0,
        updated_at: new Date().toISOString(),
      }));
    const toDeleteIds = products.filter((p) => Number(p.stock_level) !== 1).map((p) => p.id);

    if (toUpsert.length > 0) {
      const { error } = await admin.from("fakturownia_stock_cache").upsert(toUpsert);
      if (error) return NextResponse.json({ error: `Błąd zapisu do Supabase: ${error.message}` }, { status: 500 });
    }
    if (toDeleteIds.length > 0) {
      const { error } = await admin.from("fakturownia_stock_cache").delete().in("id", toDeleteIds);
      if (error) return NextResponse.json({ error: `Błąd zapisu do Supabase: ${error.message}` }, { status: 500 });
    }

    processed += products.length;
    if (products.length < PER_PAGE) break;
  }

  const { error: metaWriteError } = await admin
    .from("fakturownia_sync_meta")
    .upsert({ id: 1, last_synced_at: syncStartedAt });
  if (metaWriteError) {
    return NextResponse.json({ error: `Błąd zapisu do Supabase: ${metaWriteError.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, processed, incremental: !!lastSyncedAt, syncedAt: syncStartedAt });
}
