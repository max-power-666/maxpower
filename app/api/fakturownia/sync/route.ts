import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Synchronizuje stan z Fakturowni do tabeli fakturownia_stock_cache w Supabase.
// Wywoływane przez: (1) Vercel Cron codziennie o północy (patrz vercel.json),
// (2) przycisk "Odśwież" w zakładce Magazyn.
//
// Brak fakturownia_sync_meta.last_synced_at oznacza pełny skan CAŁEGO katalogu Fakturowni
// (~19 000 produktów, ~190 stron, ok. minuty) — dlatego maxDuration niżej. Kolejne
// synchronizacje są przyrostowe: pytają tylko o produkty zmienione po dacie ostatniej
// synchronizacji (parametr date_from), więc trwają ułamek sekundy. Pełny skan zdarza się
// pierwszy raz oraz gdy supabase/schema.sql skasuje last_synced_at po dodaniu nowych kolumn.

export const maxDuration = 300;

const PER_PAGE = 100;
const PURCHASES_FROM = "2025-01-01"; // historia zakupów do marży sięga produktów utworzonych od tej daty
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

  // ?full=1 wymusza pełny skan mimo zapisanej daty ostatniej synchronizacji (zakładka Marża: gdy historia zakupów jest pusta, a magazyn już synchronizowano).
  const forceFull = new URL(request.url).searchParams.get("full") === "1";
  const lastSyncedAt = forceFull ? null : (metaRow?.last_synced_at as string | null | undefined);
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
  let purchasesSaved = 0;

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
        name: p.name ?? null,
        description: p.description ?? null,
        product_created_at: p.created_at ?? null,
        updated_at: new Date().toISOString(),
      }));
    const toDeleteIds = products.filter((p) => Number(p.stock_level) !== 1).map((p) => p.id);

    // WSZYSTKIE produkty (także sprzedane) do fakturownia_purchases — historia cen zakupu do liczenia marży (zakładka Marża); cache wyżej
    // trzyma tylko sztuki ze stanem 1 i kasuje sprzedane, więc po sprzedaży cena zakupu inaczej by przepadła.
    // Produkty utworzone od 01.01.2025 (decyzja właściciela: starsze sprzedane nie są potrzebne do marży) ORAZ wszystkie sztuki ze stanem 1 — filtr "Wszystkie" w Magazynie ma zawsze zawierać "Dostępne". Sam skan Fakturowni dalej obejmuje cały katalog —
    // cache magazynu (stan 1) musi widzieć też starsze sztuki, które wciąż leżą w magazynie.
    const purchases = products
      .filter((p) => Number(p.stock_level) === 1 || !p.created_at || String(p.created_at).slice(0, 10) >= PURCHASES_FROM)
      .map((p) => ({
      id: p.id,
      name: p.name ?? null,
      description: p.description ?? null,
      purchase_price_gross: Number(p.purchase_price_gross) || 0,
      category_name: (p.category_id != null && categoryNames[String(p.category_id)]) || "Bez kategorii",
      stock_level: p.stock_level === null || p.stock_level === undefined ? null : Number(p.stock_level),
      product_created_at: p.created_at ?? null,
      updated_at: new Date().toISOString(),
    }));
    if (purchases.length > 0) {
      const { error } = await admin.from("fakturownia_purchases").upsert(purchases);
      // Tylko BRAK tabeli (nie uruchomiono margin.sql) nie psuje synchronizacji magazynu; każdy inny błąd (np. uprawnienia) przerywa i jest widoczny.
      if (error && !/does not exist|schema cache|Could not find the table/i.test(error.message)) {
        return NextResponse.json({ error: `Błąd zapisu historii zakupów (fakturownia_purchases): ${error.message}` }, { status: 500 });
      }
      if (!error) purchasesSaved += purchases.length;
    }

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

  return NextResponse.json({ ok: true, processed, purchasesSaved, incremental: !!lastSyncedAt, syncedAt: syncStartedAt });
}
