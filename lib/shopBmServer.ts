// Recoo Sklep <- Back Market (21.10.2026): serwerowa część synchronizacji (route app/api/shop/bm-sync). Dwie operacje:
//  - "Odśwież oferty" (ręcznie): aktywne oferty BM z kategorii sklepu -> brakujące produkty/warianty + powiązania wariant <-> oferta
//    (shop_variant_sources). Istniejących produktów, wariantów, nazw ani cen NIE zmienia (ręczne poprawki w ERP zostają).
//  - "Odśwież ilości" (cron co 5 min, gdy synchronizacja włączona, albo ręcznie): stan wariantu = suma ilości jego aktywnych ofert BM;
//    zmiana stanu przez funkcję bazy shop_bm_set_stock (zapis ruchu "korekta" w shop_stock_moves).
// Oferty BM czytamy NA ŻYWO (GET /ws/listings?publication_state=2&min_quantity=1 — kilka stron), nie z migawki Listingów (ta jest co godzinę).
import type { SupabaseClient } from "@supabase/supabase-js";
import { bmFetchListingsPage, bmListingsConfigFromEnv, type BmListingsConfig } from "./listings";
import { planOffer, shopPricePln, variantQuantities, type BmLiveOffer, type OfferPlan } from "./shopBm";
import { imageGroupKey, imagesToCopy, type GroupImage } from "./shopImageGroups";

type Admin = SupabaseClient<any, any, any>;
const MAX_PAGES = 40; // 2000 aktywnych ofert — bezpiecznik przed pętlą bez końca
const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export async function fetchLiveBmOffers(cfg: BmListingsConfig): Promise<BmLiveOffer[]> {
  const out: BmLiveOffer[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { results, hasNext } = await bmFetchListingsPage(cfg, page, "publication_state=2&min_quantity=1");
    for (const l of results) {
      const id = l?.id ?? l?.listing_id;
      if (id === null || id === undefined) continue;
      const quantity = num(l.quantity) ?? 0;
      // filtr po stronie API powinien to zapewnić — sprawdzamy jeszcze raz, żeby oferta offline nie dała stanu
      if (quantity <= 0 || String(l.publication_state) !== "2") continue;
      out.push({ id: String(id), sku: l.sku ?? null, title: l.title ?? null, quantity, price: num(l.price), currency: l.currency ?? null, grade: l.grade ?? null });
    }
    if (!hasNext) return out;
  }
  throw new Error(`Back Market zwrócił ponad ${MAX_PAGES} stron aktywnych ofert — przerwano, nic nie zmieniono.`);
}

function bmConfigOrThrow(): BmListingsConfig {
  const cfg = bmListingsConfigFromEnv();
  if (!cfg) throw new Error("Brak BACKMARKET_AUTH w zmiennych środowiskowych.");
  return cfg;
}

async function selectAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(`Błąd odczytu z Supabase (${what}): ${error.message}`);
    const rows = (data as T[]) ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export type QuantityResult = { offers: number; variants: number; changed: number; units: number; errors: string[] };

// Ustawia stan każdego powiązanego wariantu = suma ilości jego aktywnych ofert BM. `offers` można podać (np. świeżo pobrane przy "Odśwież oferty").
export async function runQuantitySync(admin: Admin, offers?: BmLiveOffer[]): Promise<QuantityResult> {
  const live = offers ?? (await fetchLiveBmOffers(bmConfigOrThrow()));
  const sources = await selectAll<{ variant_id: string; external_id: string }>(
    (a, b) => admin.from("shop_variant_sources").select("variant_id, external_id").eq("marketplace", "backmarket").order("id").range(a, b),
    "shop_variant_sources",
  );
  if (!sources.length) return { offers: live.length, variants: 0, changed: 0, units: 0, errors: [] };
  // Pusta lista aktywnych ofert przy istniejących powiązaniach to raczej problem z API niż wyprzedanie wszystkiego naraz — nie zerujemy sklepu.
  if (!live.length) throw new Error("Back Market nie zwrócił żadnej aktywnej oferty — przerwano, żeby nie wyzerować całego sklepu.");
  const liveQty = new Map(live.map((o) => [o.id, o.quantity]));
  const wanted = variantQuantities(sources, liveQty);
  const ids = [...wanted.keys()];
  const current = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from("shop_variants").select("id, stock").in("id", ids.slice(i, i + 200));
    if (error) throw new Error(`Błąd odczytu z Supabase (shop_variants): ${error.message}`);
    for (const v of data ?? []) current.set(v.id as string, Number(v.stock));
  }
  let changed = 0;
  const errors: string[] = [];
  for (const [id, qty] of wanted) {
    if (!current.has(id) || current.get(id) === qty) continue;
    const { error } = await admin.rpc("shop_bm_set_stock", { p_variant_id: id, p_qty: qty, p_note: "Synchronizacja z Back Market (ilość ofert)" });
    if (error) errors.push(error.message);
    else changed++;
  }
  // ilości ofert zapamiętujemy przy powiązaniach (podgląd w ERP); błąd tego zapisu nie psuje synchronizacji
  const now = new Date().toISOString();
  const seen = sources.filter((s) => liveQty.has(s.external_id)).map((s) => s.external_id);
  for (let i = 0; i < seen.length; i += 200) {
    const part = seen.slice(i, i + 200);
    await admin.from("shop_variant_sources").update({ last_seen_at: now }).eq("marketplace", "backmarket").in("external_id", part);
  }
  const units = [...wanted.values()].reduce((s, n) => s + n, 0);
  return { offers: live.length, variants: wanted.size, changed, units, errors: errors.slice(0, 5) };
}

export type OffersResult = { offers: number; inShop: number; newModels: number; newVariants: number; newLinks: number; newWithImages?: number; skipped: string[]; quantities: QuantityResult };

// Galerie istniejących produktów wg grupy zdjęć (lib/shopImageGroups.ts) — dawca = produkt grupy z największą liczbą zdjęć.
async function groupDonors(admin: Admin): Promise<Map<string, GroupImage[]>> {
  const models = await selectAll<{ id: string; name: string; category_slug: string }>((a, b) => admin.from("shop_models").select("id, name, category_slug").order("id").range(a, b), "shop_models");
  const imgs = await selectAll<GroupImage & { model_id: string }>(
    (a, b) => admin.from("shop_images").select("model_id, url, storage_path, alt, option_value, position").order("id").range(a, b),
    "shop_images",
  );
  const byModel = new Map<string, GroupImage[]>();
  for (const i of imgs) byModel.set(i.model_id, [...(byModel.get(i.model_id) ?? []), i]);
  const out = new Map<string, GroupImage[]>();
  for (const m of models) {
    const g = byModel.get(m.id);
    if (!g?.length) continue;
    const key = imageGroupKey(m.name, m.category_slug);
    if ((out.get(key)?.length ?? 0) < g.length) out.set(key, g);
  }
  return out;
}

async function latestEurRate(admin: Admin): Promise<number> {
  const { data, error } = await admin.from("nbp_rates").select("mid").eq("currency", "EUR").order("rate_date", { ascending: false }).limit(1).maybeSingle();
  if (error || !data) throw new Error(`Brak kursu EUR z NBP${error ? `: ${error.message}` : ""}.`);
  return Number(data.mid);
}

export async function runOffersRefresh(admin: Admin): Promise<OffersResult> {
  const live = await fetchLiveBmOffers(bmConfigOrThrow());
  const rate = await latestEurRate(admin);
  const plans = live.map(planOffer).filter((p): p is OfferPlan => !!p);
  const skipped: string[] = [];

  const linked = new Set(
    (await selectAll<{ external_id: string }>((a, b) => admin.from("shop_variant_sources").select("external_id").eq("marketplace", "backmarket").order("id").range(a, b), "shop_variant_sources")).map((r) => r.external_id),
  );
  const todo = plans.filter((p) => !linked.has(p.offer.id));
  let newModels = 0;
  let newVariants = 0;
  let newLinks = 0;
  let newWithImages = 0;

  if (todo.length) {
    const usedSkus = new Set((await selectAll<{ sku: string }>((a, b) => admin.from("shop_variants").select("sku").order("id").range(a, b), "shop_variants")).map((r) => r.sku));
    const donors = await groupDonors(admin);
    const { data: maxSort } = await admin.from("shop_models").select("sort").order("sort", { ascending: false }).limit(1).maybeSingle();
    let sort = Number(maxSort?.sort ?? 0) + 1;

    // grupy: produkt (slug) -> stan -> oferty
    const byModel = new Map<string, OfferPlan[]>();
    for (const p of todo) byModel.set(p.modelSlug, [...(byModel.get(p.modelSlug) ?? []), p]);

    for (const [slug, group] of byModel) {
      const first = group[0];
      let { data: model, error } = await admin.from("shop_models").select("id").eq("slug", slug).maybeSingle();
      if (error) throw new Error(`Błąd odczytu z Supabase (shop_models): ${error.message}`);
      if (!model) {
        const ins = await admin
          .from("shop_models")
          .insert({ slug, name: first.name, brand: first.brand, category_slug: first.category, color: first.color, keywords: [...new Set(group.map((g) => g.offer.sku).filter(Boolean))].join(" "), published: true, sort: sort++ })
          .select("id")
          .single();
        if (ins.error) {
          skipped.push(`${first.name}: ${ins.error.message}`);
          continue;
        }
        model = ins.data;
        newModels++;
        // zdjęcia z grupy (ta sama konsola z innym dyskiem / grą); błąd kopiowania nie blokuje importu
        const donor = donors.get(imageGroupKey(first.name, first.category));
        if (donor) {
          const rows = imagesToCopy(donor, []).map((s) => ({ model_id: model!.id, url: s.url, storage_path: s.storage_path, alt: first.name, option_value: s.option_value, position: s.position }));
          const imgIns = await admin.from("shop_images").insert(rows);
          if (imgIns.error) skipped.push(`${first.name}: zdjęcia z grupy — ${imgIns.error.message}`);
          else newWithImages++;
        }
      }
      const byGrade = new Map<string, OfferPlan[]>();
      for (const p of group) byGrade.set(p.grade, [...(byGrade.get(p.grade) ?? []), p]);
      for (const [grade, offers] of byGrade) {
        const { data: existing, error: vErr } = await admin.from("shop_variants").select("id").eq("model_id", model!.id).eq("grade", grade).is("option_value", null).maybeSingle();
        if (vErr) throw new Error(`Błąd odczytu z Supabase (shop_variants): ${vErr.message}`);
        let variantId = existing?.id as string | undefined;
        if (!variantId) {
          const eur = offers.map((o) => (o.offer.currency === "EUR" ? o.offer.price : null)).filter((x): x is number => x !== null);
          if (!eur.length) {
            skipped.push(`${first.name} (${grade}): cena oferty nie w EUR — pominięto`);
            continue;
          }
          let sku = offers[0].sku;
          for (let i = 1; usedSkus.has(sku); i++) sku = `${offers[0].sku}-BM${i > 1 ? i : ""}`;
          usedSkus.add(sku);
          // stan 0 — ustawi go od razu runQuantitySync (z zapisem ruchu)
          const ins = await admin.from("shop_variants").insert({ model_id: model!.id, sku, option_value: null, grade, price: shopPricePln(Math.min(...eur), rate), stock: 0, active: true }).select("id").single();
          if (ins.error) {
            skipped.push(`${first.name} (${grade}): ${ins.error.message}`);
            continue;
          }
          variantId = ins.data.id as string;
          newVariants++;
        }
        for (const o of offers) {
          const { error: lErr } = await admin
            .from("shop_variant_sources")
            .insert({ variant_id: variantId, marketplace: "backmarket", external_id: o.offer.id, external_sku: o.offer.sku, title: o.offer.title });
          if (lErr) skipped.push(`${o.offer.sku}: ${lErr.message}`);
          else newLinks++;
        }
      }
    }
  }
  const quantities = await runQuantitySync(admin, live);
  return { offers: live.length, inShop: plans.length, newModels, newVariants, newLinks, newWithImages, skipped: skipped.slice(0, 10), quantities };
}
