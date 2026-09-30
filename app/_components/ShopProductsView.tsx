"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import type { MemberLite } from "@/lib/displayName";
import {
  SHOP_URL,
  formatPln,
  imageSrc,
  slugify,
  type ShopCategory,
  type ShopImage,
  type ShopModel,
  type ShopVariant,
} from "@/lib/shop";
import ShopProductEditor from "./ShopProductEditor";

// Recoo Sklep → Produkty: katalog sklepu (modele, warianty, zdjęcia, kategorie). Dane: supabase/shop.sql.
// Stan magazynowy jest tu tylko do odczytu — zmienia się go w zakładce Magazyn (Recoo Sklep).

const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

type StatusFilter = "all" | "published" | "draft";

export default function ShopProductsView({
  session,
  members,
  isAdmin,
}: {
  session: Session;
  members: MemberLite[];
  isAdmin: boolean;
}) {
  const [sub, setSub] = useState<"products" | "categories">("products");
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [models, setModels] = useState<ShopModel[]>([]);
  const [variants, setVariants] = useState<Pick<ShopVariant, "model_id" | "price" | "stock" | "active">[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [missingSchema, setMissingSchema] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null); // id modelu albo "new"
  const loadSeq = useRef(0);

  async function load() {
    const seq = ++loadSeq.current;
    const [c, m, v, i] = await Promise.all([
      supabase.from("shop_categories").select("*").order("sort"),
      supabase.from("shop_models").select("*").order("sort"),
      supabase.from("shop_variants").select("model_id, price, stock, active"),
      supabase.from("shop_images").select("model_id, url, position").order("position"),
    ]);
    if (seq !== loadSeq.current) return; // starsza odpowiedź — pomijamy
    const err = c.error || m.error || v.error || i.error;
    setLoading(false);
    if (err) {
      // 42P01 = tabela nie istnieje: migracja jeszcze nie uruchomiona
      setMissingSchema(err.code === "42P01" || /does not exist|schema cache/i.test(err.message));
      setError(err.message);
      return;
    }
    setError("");
    setMissingSchema(false);
    setCategories((c.data as ShopCategory[]) ?? []);
    setModels((m.data as ShopModel[]) ?? []);
    setVariants((v.data as typeof variants) ?? []);
    const t: Record<string, string> = {};
    for (const img of (i.data as Pick<ShopImage, "model_id" | "url">[]) ?? []) if (!t[img.model_id]) t[img.model_id] = img.url;
    setThumbs(t);
  }

  useEffect(() => {
    load();
    // Realtime: zmiany z innego komputera (albo z Magazynu) — jedno odświeżenie na serię zdarzeń.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 800);
    };
    const channel = supabase
      .channel("shop-products")
      .on("postgres_changes", { event: "*", schema: "public", table: "shop_models" }, reload)
      .on("postgres_changes", { event: "*", schema: "public", table: "shop_variants" }, reload)
      .subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    const s: Record<string, { count: number; active: number; min: number | null; max: number | null; stock: number }> = {};
    for (const v of variants) {
      const x = (s[v.model_id] ??= { count: 0, active: 0, min: null, max: null, stock: 0 });
      x.count++;
      if (v.active) {
        x.active++;
        x.stock += v.stock;
        const p = Number(v.price);
        x.min = x.min === null ? p : Math.min(x.min, p);
        x.max = x.max === null ? p : Math.max(x.max, p);
      }
    }
    return s;
  }, [variants]);

  const catName = (slug: string) => categories.find((c) => c.slug === slug);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return models.filter(
      (m) =>
        (!category || m.category_slug === category) &&
        (status === "all" || (status === "published" ? m.published : !m.published)) &&
        (!q || `${m.name} ${m.brand} ${m.slug} ${m.keywords}`.toLowerCase().includes(q)),
    );
  }, [models, search, category, status]);

  async function togglePublished(m: ShopModel) {
    setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, published: !m.published } : x)));
    const { error } = await supabase.from("shop_models").update({ published: !m.published }).eq("id", m.id);
    if (error) {
      setError(error.message);
      load();
    }
  }

  if (missingSchema) {
    return (
      <div className="border border-line bg-white p-6 max-w-2xl">
        <h2 className="text-sm font-semibold mb-2">Katalog sklepu nie jest jeszcze w bazie</h2>
        <p className="text-sm text-inksoft">
          Uruchom plik <b>supabase/shop.sql</b> w Supabase → SQL Editor. Utworzy tabele sklepu i przeniesie do nich obecny katalog
          (produkty, warianty, ceny, zdjęcia).
        </p>
        <p className="text-xs text-inksoft mt-3">Szczegóły: {error}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button className={pill(sub === "products")} onClick={() => setSub("products")}>Produkty</button>
        <button className={pill(sub === "categories")} onClick={() => setSub("categories")}>Kategorie</button>
      </div>

      {error && <div className="mb-4 border border-rust bg-rustsoft text-rust px-3 py-2 text-sm">{error}</div>}

      {sub === "categories" ? (
        <CategoriesPanel categories={categories} models={models} isAdmin={isAdmin} onChanged={load} onError={setError} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Szukaj: nazwa, marka, słowa kluczowe"
              className="w-72 border border-line bg-white px-3 py-2 rounded text-sm"
            />
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="border border-line bg-white px-2 py-2 rounded text-sm">
              <option value="">Wszystkie kategorie</option>
              {categories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                  {c.hidden ? " (ukryta)" : ""}
                </option>
              ))}
            </select>
            {(["all", "published", "draft"] as StatusFilter[]).map((s) => (
              <button key={s} className={pill(status === s)} onClick={() => setStatus(s)}>
                {s === "all" ? "Wszystkie" : s === "published" ? "Opublikowane" : "Szkice"}
              </button>
            ))}
            <button onClick={() => setOpenId("new")} className="ml-auto px-4 py-2 rounded bg-ink text-paper text-sm font-semibold">
              + Nowy produkt
            </button>
          </div>

          <div className="border border-line bg-white overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-inksoft border-b border-line">
                  <th className="p-3 w-14"></th>
                  <th className="p-3">Produkt</th>
                  <th className="p-3">Kategoria</th>
                  <th className="p-3">Warianty</th>
                  <th className="p-3">Cena</th>
                  <th className="p-3" title="Suma stanów aktywnych wariantów — edycja w zakładce Magazyn">Stan</th>
                  <th className="p-3">Widoczność</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={8} className="p-6 text-center text-inksoft">Ładowanie…</td></tr>
                )}
                {!loading && list.length === 0 && (
                  <tr><td colSpan={8} className="p-6 text-center text-inksoft">Brak produktów dla wybranych filtrów.</td></tr>
                )}
                {list.map((m) => {
                  const s = stats[m.id];
                  const cat = catName(m.category_slug);
                  const visible = m.published && !cat?.hidden;
                  return (
                    <tr key={m.id} className="border-b border-line last:border-b-0 hover:bg-paper align-middle">
                      <td className="p-2">
                        <div className="h-11 w-11 rounded overflow-hidden flex items-center justify-center border border-line" style={{ background: m.color }}>
                          {thumbs[m.id] ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={imageSrc(thumbs[m.id])} alt="" className="h-full w-full object-contain p-1" />
                          ) : (
                            <span className="text-[10px] text-inksoft">brak</span>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <button onClick={() => setOpenId(m.id)} className="text-left font-semibold text-teal hover:underline">
                          {m.name}
                        </button>
                        <div className="text-xs text-inksoft">
                          {m.brand}
                          {m.brand && " · "}
                          {m.slug}
                          {m.is_new && <span className="ml-2 font-semibold text-ink">NOWOŚĆ</span>}
                          {m.featured && <span className="ml-2 font-semibold text-ink">POLECANY</span>}
                        </div>
                      </td>
                      <td className="p-3">
                        {cat?.name ?? m.category_slug}
                        {cat?.hidden && <span className="ml-1 text-xs text-inksoft">(ukryta)</span>}
                      </td>
                      <td className="p-3 text-inksoft">
                        {s ? `${s.active} akt.${s.count !== s.active ? ` / ${s.count}` : ""}` : "0"}
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        {s?.min === null || !s ? "—" : s.min === s.max ? formatPln(s.min) : `${formatPln(s.min)} – ${formatPln(s.max)}`}
                      </td>
                      <td className={`p-3 font-semibold ${s && s.stock > 0 ? "" : "text-rust"}`}>{s?.stock ?? 0}</td>
                      <td className="p-3">
                        <button
                          onClick={() => togglePublished(m)}
                          title={m.published ? "Kliknij, żeby ukryć w sklepie (szkic)" : "Kliknij, żeby opublikować"}
                          className={`text-xs font-semibold px-2 py-1 rounded-full whitespace-nowrap ${
                            m.published ? "bg-tealsoft text-teal" : "bg-paper text-inksoft border border-line"
                          }`}
                        >
                          {m.published ? "Opublikowany" : "Szkic"}
                        </button>
                      </td>
                      <td className="p-3 text-right">
                        {visible && (
                          <a href={`${SHOP_URL}/produkt/${m.slug}`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-teal hover:underline whitespace-nowrap">
                            W sklepie ↗
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-inksoft">
            {list.length} z {models.length} produktów. Sklep pokazuje produkt, gdy jest opublikowany, a jego kategoria nie jest ukryta.
          </p>
        </>
      )}

      {openId && (
        <ShopProductEditor
          session={session}
          members={members}
          isAdmin={isAdmin}
          modelId={openId === "new" ? null : openId}
          categories={categories}
          existingSlugs={models.map((m) => m.slug)}
          onClose={() => setOpenId(null)}
          onSaved={(id) => {
            load();
            setOpenId(id);
          }}
          onDeleted={() => {
            setOpenId(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function CategoriesPanel({
  categories,
  models,
  isAdmin,
  onChanged,
  onError,
}: {
  categories: ShopCategory[];
  models: ShopModel[];
  isAdmin: boolean;
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const [name, setName] = useState("");
  const count = (slug: string) => models.filter((m) => m.category_slug === slug).length;

  async function patch(slug: string, p: Partial<ShopCategory>) {
    const { error } = await supabase.from("shop_categories").update(p).eq("slug", slug);
    if (error) onError(error.message);
    onChanged();
  }
  async function move(i: number, dir: -1 | 1) {
    const a = categories[i];
    const b = categories[i + dir];
    if (!a || !b) return;
    // zamiana miejscami; sort może się powtarzać, więc ustawiamy jawnie pozycje z listy
    const order = categories.map((c) => c.slug);
    [order[i], order[i + dir]] = [order[i + dir], order[i]];
    await Promise.all(order.map((slug, idx) => supabase.from("shop_categories").update({ sort: idx }).eq("slug", slug)));
    onChanged();
  }
  async function add() {
    const n = name.trim();
    const slug = slugify(n);
    if (!n || !slug) return;
    if (categories.some((c) => c.slug === slug)) return onError(`Kategoria "${slug}" już istnieje.`);
    const { error } = await supabase
      .from("shop_categories")
      .insert({ slug, name: n, tagline: "", hidden: true, sort: categories.length });
    if (error) onError(error.message);
    setName("");
    onChanged();
  }
  async function remove(c: ShopCategory) {
    if (count(c.slug) > 0) return onError(`Kategoria "${c.name}" ma produkty — najpierw przenieś je do innej kategorii.`);
    if (!confirm(`Usunąć kategorię "${c.name}"?`)) return;
    const { error } = await supabase.from("shop_categories").delete().eq("slug", c.slug);
    if (error) onError(error.message);
    onChanged();
  }

  return (
    <div className="max-w-4xl">
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Kolejność</th>
              <th className="p-3">Nazwa</th>
              <th className="p-3">Podpis (np. marki)</th>
              <th className="p-3">Adres</th>
              <th className="p-3">Produkty</th>
              <th className="p-3">W sklepie</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c, i) => (
              <tr key={c.slug} className="border-b border-line last:border-b-0">
                <td className="p-2 whitespace-nowrap">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="px-2 disabled:opacity-30" aria-label="W górę">↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === categories.length - 1} className="px-2 disabled:opacity-30" aria-label="W dół">↓</button>
                </td>
                <td className="p-2">
                  <input defaultValue={c.name} onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && patch(c.slug, { name: e.target.value.trim() })} className="w-44 border border-line bg-white px-2 py-1 rounded text-sm" />
                </td>
                <td className="p-2">
                  <input defaultValue={c.tagline} onBlur={(e) => e.target.value !== c.tagline && patch(c.slug, { tagline: e.target.value.trim() })} className="w-56 border border-line bg-white px-2 py-1 rounded text-sm" />
                </td>
                <td className="p-2 text-xs text-inksoft">/kategoria/{c.slug}</td>
                <td className="p-2">{count(c.slug)}</td>
                <td className="p-2">
                  <button
                    onClick={() => patch(c.slug, { hidden: !c.hidden })}
                    className={`text-xs font-semibold px-2 py-1 rounded-full ${c.hidden ? "bg-paper text-inksoft border border-line" : "bg-tealsoft text-teal"}`}
                  >
                    {c.hidden ? "Ukryta" : "Widoczna"}
                  </button>
                </td>
                <td className="p-2 text-right">
                  {isAdmin && (
                    <button onClick={() => remove(c)} className="text-xs text-rust hover:underline">Usuń</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Nowa kategoria, np. Słuchawki" className="w-64 border border-line bg-white px-3 py-2 rounded text-sm" />
        <button onClick={add} className="px-4 py-2 rounded border border-line bg-white text-sm font-semibold">Dodaj</button>
      </div>
      <p className="mt-2 text-xs text-inksoft">Nowa kategoria startuje jako ukryta — pokaż ją, gdy będą w niej produkty. Ukrycie kategorii chowa w sklepie wszystkie jej produkty (dane zostają).</p>
    </div>
  );
}
