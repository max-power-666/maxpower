import { NextResponse } from "next/server";
import { admin } from "@/lib/parcelServer";
import { requireRole } from "@/lib/serverAuth";
import { buildFakturowniaProduct, nameKeys, purchaseGrossForCache, serialKey, type GoodsForFakturownia } from "@/lib/fakturowniaGoods";

// Towar -> Fakturownia (15.10.2026): wysyła wybrane pozycje Towaru do magazynu Fakturowni jako produkty (POST /products.json). Półautomat: przycisk w zakładce Towar
// (jeden wiersz albo zaznaczone), z podglądem ("dryRun") przed wysyłką. Nie tworzy duplikatów: pomija pozycje bez numeru seryjnego/ceny, już wysłane z aplikacji oraz
// takie, których numer jest już w Fakturowni (cache magazynu + historia zakupów + świeżo zmienione produkty pobrane na żywo).
// Dostęp: Admin, Manager, Księgowa (to zapis do systemu księgowego). Nie testowane na żywym koncie Fakturowni — pierwsze wysłanie warto zrobić na jednej pozycji.

export const maxDuration = 60;
const MAX_IDS = 100;

type Result = { id: number; serial: string | null; status: "ready" | "sent" | "skipped" | "error"; message: string; productId?: number; payload?: unknown };

async function fetchAll<T>(build: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    const chunk = (data as T[]) || [];
    out.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return out;
}

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Księgowa"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień (wysyłanie do Fakturowni: Admin, Manager, Księgowa)." }, { status: 403 });
  const domain = process.env.FAKTUROWNIA_DOMAIN;
  const token = process.env.FAKTUROWNIA_API_TOKEN;
  if (!domain || !token) return NextResponse.json({ error: "Brak FAKTUROWNIA_DOMAIN / FAKTUROWNIA_API_TOKEN." }, { status: 500 });

  let body: { ids?: unknown; dryRun?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Niepoprawne żądanie." }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? Array.from(new Set(body.ids.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))) : [];
  if (ids.length === 0) return NextResponse.json({ error: "Nie wskazano pozycji." }, { status: 400 });
  if (ids.length > MAX_IDS) return NextResponse.json({ error: `Za dużo pozycji naraz (max ${MAX_IDS}).` }, { status: 400 });
  const dryRun = body.dryRun === true;

  try {
    const base = `https://${domain}.fakturownia.pl`;
    const { data: me } = await db.from("members").select("email").eq("user_id", uid).maybeSingle();
    const who = (me?.email as string | undefined) || "app";

    const { data: rows, error: re } = await db
      .from("goods_register")
      .select("id, kind, serial, name, order_no, invoice_no, category, vat, price_pln, fakturownia_product_id")
      .in("id", ids);
    if (re) {
      if (/fakturownia_product_id/.test(re.message)) return NextResponse.json({ error: "Brak kolumn w bazie — uruchom supabase/goods-fakturownia.sql w Supabase." }, { status: 500 });
      throw new Error(re.message);
    }
    const goods = (rows || []) as GoodsForFakturownia[];

    // kategorie Fakturowni wg nazwy (bez rozróżniania wielkości liter)
    const catRes = await fetch(`${base}/categories.json?api_token=${encodeURIComponent(token)}&per_page=100`, { cache: "no-store" });
    if (!catRes.ok) throw new Error(`Fakturownia (kategorie) zwróciła błąd (${catRes.status}).`);
    const catByName = new Map<string, { id: number; name: string }>();
    for (const c of (await catRes.json()) as { id: number; name: string }[]) catByName.set(String(c.name).trim().toLowerCase(), c);

    // numery już obecne w Fakturowni: cache magazynu, historia zakupów i produkty zmienione w ostatnich dniach (pobrane na żywo — cache odświeża się raz dziennie)
    const known = new Set<string>();
    for (const t of ["fakturownia_stock_cache", "fakturownia_purchases"]) {
      const names = await fetchAll<{ name: string | null }>((a, b) => db.from(t).select("name").order("id").range(a, b));
      for (const n of names) for (const k of nameKeys(n.name)) known.add(k);
    }
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    for (let page = 1; page <= 10; page++) {
      const r = await fetch(`${base}/products.json?api_token=${encodeURIComponent(token)}&per_page=100&page=${page}&date_from=${since}`, { cache: "no-store" });
      if (!r.ok) break;
      const list = (await r.json()) as { name?: string }[];
      if (!Array.isArray(list) || list.length === 0) break;
      for (const p of list) for (const k of nameKeys(p.name)) known.add(k);
      if (list.length < 100) break;
    }

    const results: Result[] = [];
    const seen = new Set<string>(); // ten sam numer dwa razy w jednej paczce
    for (const g of goods) {
      const serial = (g.serial || "").trim();
      const res = (status: Result["status"], message: string, extra: Partial<Result> = {}) => results.push({ id: g.id, serial: serial || null, status, message, ...extra });
      if (g.fakturownia_product_id) {
        res("skipped", `Już wysłano do Fakturowni (produkt ${g.fakturownia_product_id}).`);
        continue;
      }
      if (!serial) {
        res("skipped", "Brak numeru seryjnego — uzupełnij go przed wysłaniem.");
        continue;
      }
      const key = serialKey(serial);
      if (known.has(key) || seen.has(key)) {
        res("skipped", "Ten numer jest już w Fakturowni (albo powtarza się w zaznaczonych).");
        continue;
      }
      const cat = g.category ? catByName.get(g.category.trim().toLowerCase()) ?? null : null;
      const payload = buildFakturowniaProduct(g, cat ? cat.id : null);
      if (!payload) {
        res("skipped", "Brak ceny w PLN (Cena PLN) — uzupełnij ją przed wysłaniem.");
        continue;
      }
      const warn = g.category && !cat ? ` (uwaga: w Fakturowni nie ma kategorii „${g.category}” — produkt bez kategorii)` : !g.category ? " (uwaga: pozycja nie ma kategorii)" : "";
      seen.add(key);
      if (dryRun) {
        res("ready", `Gotowe do wysłania${warn}.`, { payload });
        continue;
      }
      const pr = await fetch(`${base}/products.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ api_token: token, product: payload }),
      });
      const text = await pr.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* odpowiedź nie-JSON */
      }
      if (!pr.ok || !json?.id) {
        res("error", `Fakturownia odrzuciła produkt (${pr.status}): ${(json?.message ? JSON.stringify(json.message) : text).slice(0, 300)}`);
        continue;
      }
      const productId = Number(json.id);
      const nowIso = new Date().toISOString();
      // zapis w Towarze (znacznik "wysłano") + od razu do cache/historii Fakturowni, żeby "Dostępny" przeskoczył na Tak bez czekania na synchronizację
      const { error: ue } = await db.from("goods_register").update({ fakturownia_product_id: productId, fakturownia_sent_at: nowIso, fakturownia_sent_by: who }).eq("id", g.id);
      const catName = cat ? cat.name : "Bez kategorii";
      await db.from("fakturownia_stock_cache").upsert({ id: productId, category_id: cat ? cat.id : null, category_name: catName, purchase_price_gross: purchaseGrossForCache(payload), name: payload.name, description: payload.description, product_created_at: nowIso, updated_at: nowIso });
      await db.from("fakturownia_purchases").upsert({ id: productId, name: payload.name, description: payload.description, purchase_price_gross: purchaseGrossForCache(payload), category_name: catName, stock_level: 1, product_created_at: nowIso, updated_at: nowIso });
      res("sent", ue ? `Wysłano (produkt ${productId}), ale nie zapisano znacznika w Towarze: ${ue.message}` : `Wysłano (produkt ${productId})${warn}.`, { productId });
      await new Promise((r) => setTimeout(r, 150));
    }
    for (const id of ids) if (!goods.some((g) => g.id === id)) results.push({ id, serial: null, status: "skipped", message: "Pozycja nie istnieje." });
    const count = (s: Result["status"]) => results.filter((r) => r.status === s).length;
    return NextResponse.json({ ok: true, dryRun, ready: count("ready"), sent: count("sent"), skipped: count("skipped"), errors: count("error"), results });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Błąd wysyłania do Fakturowni." }, { status: 500 });
  }
}
