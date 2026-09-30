"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import {
  SHOP_COLORS,
  SHOP_FIELD_LABELS,
  SHOP_GRADES,
  SHOP_URL,
  gradeLabel,
  imageSrc,
  skuFor,
  skuPrefixFor,
  slugify,
  type ShopCategory,
  type ShopGrade,
  type ShopImage,
  type ShopLogEntry,
  type ShopModel,
  type ShopVariant,
} from "@/lib/shop";

// Karta produktu sklepu (panel boczny): dane modelu, warianty z cenami, zdjęcia, dziennik zmian.
// Stan magazynowy wariantu jest tu tylko do odczytu (zmiana: zakładka Magazyn w Recoo Sklep).

const inputCls = "w-full border border-line bg-white px-2 py-2 rounded text-sm";
const labelCls = "block text-xs font-semibold text-inksoft mb-1";

type Draft = {
  name: string;
  slug: string;
  brand: string;
  category_slug: string;
  description: string;
  highlights: string; // jedna cecha w linii
  option_label: string;
  color: string;
  keywords: string;
  is_new: boolean;
  featured: boolean;
  published: boolean;
};

type VariantRow = {
  key: string; // stabilny klucz wiersza (id z bazy albo tymczasowy)
  id: string | null;
  sku: string;
  option_value: string;
  grade: ShopGrade;
  price: string;
  old_price: string;
  stock: number;
  active: boolean;
};

const emptyDraft = (category: string): Draft => ({
  name: "",
  slug: "",
  brand: "",
  category_slug: category,
  description: "",
  highlights: "",
  option_label: "",
  color: SHOP_COLORS[0].hex,
  keywords: "",
  is_new: false,
  featured: false,
  published: false,
});

let tmpId = 0;
const newKey = () => `new-${++tmpId}`;

export default function ShopProductEditor({
  members,
  isAdmin,
  modelId,
  categories,
  existingSlugs,
  onClose,
  onSaved,
  onDeleted,
}: {
  session: Session;
  members: MemberLite[];
  isAdmin: boolean;
  modelId: string | null;
  categories: ShopCategory[];
  existingSlugs: string[];
  onClose: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const isNew = modelId === null;
  const [model, setModel] = useState<ShopModel | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft(categories.find((c) => !c.hidden)?.slug ?? categories[0]?.slug ?? ""));
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [original, setOriginal] = useState<ShopVariant[]>([]);
  const [images, setImages] = useState<ShopImage[]>([]);
  const [log, setLog] = useState<ShopLogEntry[]>([]);
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load(id: string) {
    const [m, v, i, l] = await Promise.all([
      supabase.from("shop_models").select("*").eq("id", id).single(),
      supabase.from("shop_variants").select("*").eq("model_id", id).order("sort"),
      supabase.from("shop_images").select("*").eq("model_id", id).order("position"),
      supabase.from("shop_log").select("*").eq("model_id", id).order("at", { ascending: false }).limit(100),
    ]);
    setLoading(false);
    if (m.error) return setError(m.error.message);
    const mm = m.data as ShopModel;
    setModel(mm);
    setDraft({
      name: mm.name,
      slug: mm.slug,
      brand: mm.brand,
      category_slug: mm.category_slug,
      description: mm.description,
      highlights: (mm.highlights ?? []).join("\n"),
      option_label: mm.option_label ?? "",
      color: mm.color,
      keywords: mm.keywords,
      is_new: mm.is_new,
      featured: mm.featured,
      published: mm.published,
    });
    const vv = (v.data as ShopVariant[]) ?? [];
    setOriginal(vv);
    setRows(
      vv.map((x) => ({
        key: x.id,
        id: x.id,
        sku: x.sku,
        option_value: x.option_value ?? "",
        grade: x.grade,
        price: String(Number(x.price)),
        old_price: x.old_price === null ? "" : String(Number(x.old_price)),
        stock: x.stock,
        active: x.active,
      })),
    );
    setImages((i.data as ShopImage[]) ?? []);
    setLog((l.data as ShopLogEntry[]) ?? []);
  }

  useEffect(() => {
    if (modelId) load(modelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  function setName(name: string) {
    setDraft((d) => ({ ...d, name, slug: slugTouched ? d.slug : slugify(name) }));
  }

  const prefix = useMemo(() => {
    // Prefiks SKU istniejącego modelu bierzemy z jego pierwszego SKU (ciągłość), dla nowego — z nazwy.
    const first = original[0]?.sku;
    return first ? first.split("-")[0] : skuPrefixFor(draft.name);
  }, [original, draft.name]);

  function addVariant() {
    const last = rows[rows.length - 1];
    const used = new Set(rows.filter((r) => r.option_value === (last?.option_value ?? "")).map((r) => r.grade));
    const grade = SHOP_GRADES.find((g) => !used.has(g.value))?.value ?? "jak-nowy";
    const option = last?.option_value ?? "";
    setRows((r) => [
      ...r,
      {
        key: newKey(),
        id: null,
        sku: skuFor(prefix, option || null, grade),
        option_value: option,
        grade,
        price: "",
        old_price: last?.old_price ?? "",
        stock: 0,
        active: true,
      },
    ]);
  }

  function updateRow(key: string, p: Partial<VariantRow>) {
    setRows((rs) =>
      rs.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...p };
        // Dla NOWEGO wiersza SKU podąża za opcją i stanem, dopóki nikt go nie zmienił ręcznie.
        if (!r.id && ("option_value" in p || "grade" in p) && r.sku === skuFor(prefix, r.option_value || null, r.grade)) {
          next.sku = skuFor(prefix, next.option_value || null, next.grade);
        }
        return next;
      }),
    );
  }

  function validate(): string | null {
    if (!draft.name.trim()) return "Podaj nazwę produktu.";
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(draft.slug)) return "Adres (slug) może mieć tylko małe litery, cyfry i myślniki.";
    if (existingSlugs.includes(draft.slug) && draft.slug !== model?.slug) return `Adres "${draft.slug}" jest już zajęty przez inny produkt.`;
    if (!draft.category_slug) return "Wybierz kategorię.";
    const combos = new Set<string>();
    const skus = new Set<string>();
    for (const r of rows) {
      if (!r.sku || !/^[A-Z0-9+-]+$/.test(r.sku)) return `SKU "${r.sku}" — dozwolone tylko wielkie litery, cyfry, "+" i "-".`;
      if (skus.has(r.sku)) return `SKU "${r.sku}" występuje dwa razy.`;
      skus.add(r.sku);
      const combo = `${r.option_value.trim()}|${r.grade}`;
      if (combos.has(combo)) return `Dwa warianty mają tę samą opcję i stan (${r.option_value || "bez opcji"}, ${gradeLabel(r.grade)}).`;
      combos.add(combo);
      if (r.price === "" || !(Number(r.price) >= 0)) return `Wariant ${r.sku}: podaj cenę.`;
      if (r.old_price !== "" && !(Number(r.old_price) >= 0)) return `Wariant ${r.sku}: niepoprawna cena nowego.`;
    }
    if (draft.published && !rows.some((r) => r.active)) return "Opublikowany produkt musi mieć co najmniej jeden aktywny wariant.";
    return null;
  }

  async function save() {
    const v = validate();
    if (v) return setError(v);
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(),
        slug: draft.slug,
        brand: draft.brand.trim(),
        category_slug: draft.category_slug,
        description: draft.description.trim(),
        highlights: draft.highlights.split("\n").map((s) => s.trim()).filter(Boolean),
        option_label: draft.option_label.trim() || null,
        color: draft.color,
        keywords: draft.keywords.trim(),
        is_new: draft.is_new,
        featured: draft.featured,
        published: draft.published,
      };
      let id = modelId;
      if (isNew) {
        const { data, error } = await supabase.from("shop_models").insert({ ...payload, sort: 1000 }).select("id").single();
        if (error) throw error;
        id = data.id as string;
      } else {
        // wysyłamy tylko zmienione pola — dziennik zmian pokaże dokładnie to, co ktoś ruszył
        const changed = Object.fromEntries(
          Object.entries(payload).filter(([k, val]) => JSON.stringify(val) !== JSON.stringify((model as Record<string, unknown>)[k])),
        );
        if (Object.keys(changed).length) {
          const { error } = await supabase.from("shop_models").update(changed).eq("id", id!);
          if (error) throw error;
        }
      }

      // Warianty: usunięte → delete, zmienione → update, nowe → insert.
      const keepIds = new Set(rows.filter((r) => r.id).map((r) => r.id));
      const removed = original.filter((o) => !keepIds.has(o.id));
      if (removed.length) {
        const { error } = await supabase.from("shop_variants").delete().in("id", removed.map((r) => r.id));
        if (error) throw error;
      }
      for (const [idx, r] of rows.entries()) {
        const rec = {
          sku: r.sku,
          option_value: r.option_value.trim() || null,
          grade: r.grade,
          price: Number(r.price),
          old_price: r.old_price === "" ? null : Number(r.old_price),
          active: r.active,
          sort: idx,
        };
        if (!r.id) {
          const { error } = await supabase.from("shop_variants").insert({ ...rec, model_id: id, stock: 0 });
          if (error) throw error;
        } else {
          const o = original.find((x) => x.id === r.id)!;
          const diff = Object.fromEntries(
            Object.entries(rec).filter(([k, val]) => {
              const ov = (o as Record<string, unknown>)[k];
              return k === "price" || k === "old_price" ? (ov === null ? null : Number(ov)) !== val : ov !== val;
            }),
          );
          if (Object.keys(diff).length) {
            const { error } = await supabase.from("shop_variants").update(diff).eq("id", r.id);
            if (error) throw error;
          }
        }
      }
      setNotice("Zapisano. Sklep pokaże zmiany w ciągu minuty.");
      if (isNew) onSaved(id!);
      else await load(id!);
    } catch (e) {
      const msg = e instanceof Error ? e.message : (e as { message?: string }).message ?? String(e);
      setError(/duplicate key.*sku/i.test(msg) ? "Któreś SKU jest już użyte w innym produkcie." : msg);
    } finally {
      setSaving(false);
    }
  }

  async function removeModel() {
    if (!model) return;
    if (!confirm(`Usunąć produkt "${model.name}" razem z wariantami i zdjęciami? Tego nie da się cofnąć.\n\nJeśli chcesz go tylko schować ze sklepu — odznacz "Opublikowany".`)) return;
    const paths = images.map((i) => i.storage_path).filter(Boolean) as string[];
    if (paths.length) await supabase.storage.from("shop-images").remove(paths);
    const { error } = await supabase.from("shop_models").delete().eq("id", model.id);
    if (error) return setError(error.message);
    onDeleted();
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-4xl bg-paper h-full overflow-y-auto p-6 border-l border-line">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="text-xs text-inksoft">{isNew ? "NOWY PRODUKT" : "PRODUKT SKLEPU"}</div>
            <h2 className="text-lg font-semibold">{draft.name || "Bez nazwy"}</h2>
            {!isNew && model && (
              <a href={`${SHOP_URL}/produkt/${model.slug}`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-teal hover:underline">
                Otwórz w sklepie ↗
              </a>
            )}
          </div>
          <button onClick={onClose} className="px-3 py-1.5 border border-line rounded text-sm">Zamknij</button>
        </div>

        {loading ? (
          <p className="text-sm text-inksoft">Ładowanie…</p>
        ) : (
          <>
            <Section title="PODSTAWOWE">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Nazwa</label>
                  <input value={draft.name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="np. PlayStation 5 Slim" />
                </div>
                <div>
                  <label className={labelCls}>Marka</label>
                  <input value={draft.brand} onChange={(e) => set("brand", e.target.value)} className={inputCls} placeholder="np. Sony" />
                </div>
                <div>
                  <label className={labelCls}>Adres w sklepie</label>
                  <div className="flex items-center gap-1 text-sm">
                    <span className="text-inksoft">/produkt/</span>
                    <input
                      value={draft.slug}
                      onChange={(e) => {
                        setSlugTouched(true);
                        set("slug", slugify(e.target.value));
                      }}
                      className={inputCls}
                    />
                  </div>
                  {!isNew && model && draft.slug !== model.slug && (
                    <p className="text-xs text-rust mt-1">Zmiana adresu psuje stare linki do produktu (np. udostępnione klientom).</p>
                  )}
                </div>
                <div>
                  <label className={labelCls}>Kategoria</label>
                  <select value={draft.category_slug} onChange={(e) => set("category_slug", e.target.value)} className={inputCls}>
                    {categories.map((c) => (
                      <option key={c.slug} value={c.slug}>
                        {c.name}
                        {c.hidden ? " (ukryta)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Nazwa opcji wariantu</label>
                  <input value={draft.option_label} onChange={(e) => set("option_label", e.target.value)} className={inputCls} placeholder="Pamięć (domyślnie) — np. Dysk, Kolor, Platforma, Zestaw" />
                </div>
                <div>
                  <label className={labelCls}>Słowa kluczowe (wyszukiwarka sklepu)</label>
                  <input value={draft.keywords} onChange={(e) => set("keywords", e.target.value)} className={inputCls} placeholder="np. ps5 pad kontroler" />
                </div>
              </div>
              <div className="mt-3">
                <label className={labelCls}>Kolor tła (kafelki i galeria w sklepie)</label>
                <div className="flex gap-2">
                  {SHOP_COLORS.map((c) => (
                    <button
                      key={c.hex}
                      type="button"
                      onClick={() => set("color", c.hex)}
                      title={c.name}
                      aria-label={`Kolor tła: ${c.name}`}
                      aria-pressed={draft.color === c.hex}
                      className={`h-8 w-8 rounded border-2 ${draft.color === c.hex ? "border-ink" : "border-line"}`}
                      style={{ background: c.hex }}
                    />
                  ))}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-5 text-sm">
                <Check label="Opublikowany (widoczny w sklepie)" checked={draft.published} onChange={(v) => set("published", v)} />
                <Check label="Nowość" checked={draft.is_new} onChange={(v) => set("is_new", v)} />
                <Check label="Polecany (baner na stronie głównej)" checked={draft.featured} onChange={(v) => set("featured", v)} />
              </div>
            </Section>

            <Section title="OPIS I CECHY">
              <label className={labelCls}>Opis</label>
              <textarea value={draft.description} onChange={(e) => set("description", e.target.value)} rows={3} className={inputCls} />
              <label className={`${labelCls} mt-3`}>Najważniejsze cechy — jedna w linii</label>
              <textarea value={draft.highlights} onChange={(e) => set("highlights", e.target.value)} rows={4} className={inputCls} placeholder={"Dysk 1 TB SSD\nNapęd Blu-ray"} />
            </Section>

            <Section title="WARIANTY I CENY">
              <div className="border border-line bg-white overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-inksoft border-b border-line">
                      <th className="p-2">{draft.option_label || "Pamięć"}</th>
                      <th className="p-2">Stan wizualny</th>
                      <th className="p-2">SKU</th>
                      <th className="p-2">Cena (zł)</th>
                      <th className="p-2">Cena nowego</th>
                      <th className="p-2" title="Zmiana w zakładce Magazyn">Stan mag.</th>
                      <th className="p-2">Aktywny</th>
                      <th className="p-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr><td colSpan={8} className="p-4 text-center text-inksoft">Brak wariantów — dodaj co najmniej jeden.</td></tr>
                    )}
                    {rows.map((r) => (
                      <tr key={r.key} className={`border-b border-line last:border-b-0 ${r.active ? "" : "text-inksoft"}`}>
                        <td className="p-1.5"><input value={r.option_value} onChange={(e) => updateRow(r.key, { option_value: e.target.value })} className="w-28 border border-line bg-white px-2 py-1 rounded" placeholder="—" /></td>
                        <td className="p-1.5">
                          <select value={r.grade} onChange={(e) => updateRow(r.key, { grade: e.target.value as ShopGrade })} className="border border-line bg-white px-2 py-1 rounded">
                            {SHOP_GRADES.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
                          </select>
                        </td>
                        <td className="p-1.5"><input value={r.sku} onChange={(e) => updateRow(r.key, { sku: e.target.value.toUpperCase() })} className="w-36 border border-line bg-white px-2 py-1 rounded font-mono text-xs" /></td>
                        <td className="p-1.5"><input value={r.price} onChange={(e) => updateRow(r.key, { price: e.target.value.replace(",", ".") })} inputMode="decimal" className="w-20 border border-line bg-white px-2 py-1 rounded text-right" /></td>
                        <td className="p-1.5"><input value={r.old_price} onChange={(e) => updateRow(r.key, { old_price: e.target.value.replace(",", ".") })} inputMode="decimal" className="w-20 border border-line bg-white px-2 py-1 rounded text-right" placeholder="—" /></td>
                        <td className={`p-1.5 text-center font-semibold ${r.stock > 0 ? "" : "text-rust"}`}>{r.stock}</td>
                        <td className="p-1.5 text-center"><input type="checkbox" checked={r.active} onChange={(e) => updateRow(r.key, { active: e.target.checked })} aria-label={`Aktywny ${r.sku}`} /></td>
                        <td className="p-1.5 text-right">
                          <button onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="text-xs text-rust hover:underline">Usuń</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <button onClick={addVariant} className="px-3 py-1.5 border border-line bg-white rounded text-sm font-semibold">+ Dodaj wariant</button>
                <span className="text-xs text-inksoft">Nieaktywny wariant znika ze sklepu. Stan magazynowy zmienia się w zakładce Magazyn.</span>
              </div>
            </Section>

            {error && <div className="mb-4 border border-rust bg-rustsoft text-rust px-3 py-2 text-sm">{error}</div>}
            {notice && <div className="mb-4 border border-teal bg-tealsoft text-teal px-3 py-2 text-sm">{notice}</div>}

            <div className="flex items-center gap-2 mb-8">
              <button onClick={save} disabled={saving} className="px-5 py-2 rounded bg-ink text-paper text-sm font-semibold disabled:opacity-50">
                {saving ? "Zapisywanie…" : isNew ? "Utwórz produkt" : "Zapisz zmiany"}
              </button>
              <button onClick={onClose} className="px-4 py-2 border border-line rounded text-sm font-semibold">Anuluj</button>
              {!isNew && isAdmin && (
                <button onClick={removeModel} className="ml-auto text-sm text-rust hover:underline">Usuń produkt</button>
              )}
            </div>

            {isNew ? (
              <p className="text-sm text-inksoft">Zdjęcia dodasz po utworzeniu produktu.</p>
            ) : (
              model && <ImagesSection model={model} images={images} onChanged={() => load(model.id)} onError={setError} />
            )}

            {!isNew && (
              <Section title="DZIENNIK ZMIAN">
                <div className="border border-line bg-white">
                  {log.length === 0 && <p className="p-3 text-sm text-inksoft">Brak wpisów.</p>}
                  {log.map((e) => (
                    <div key={e.id} className="px-3 py-2 border-b border-line last:border-b-0 text-sm">
                      <div className="text-xs text-inksoft">
                        {new Date(e.at).toLocaleString("pl-PL")} · {e.by_email ? displayNameForEmail(e.by_email, members) : "import / SQL"}
                      </div>
                      <div>
                        {e.action === "created" ? "Dodano" : e.action === "deleted" ? "Usunięto" : "Zmieniono"} {e.entity}
                        {e.entity !== "model" && e.label && <span className="font-mono text-xs"> {e.entity === "zdjęcie" ? e.label.split("/").pop() : e.label}</span>}
                        {e.changes && (
                          <ul className="text-xs text-inksoft mt-0.5">
                            {e.changes.map((c) => (
                              <li key={c.field}>
                                {SHOP_FIELD_LABELS[c.field] ?? c.field}: {fmt(c.from)} → <span className="text-ink">{fmt(c.to)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "tak" : "nie";
  if (Array.isArray(v)) return v.join("; ") || "—";
  const s = String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="text-xs font-semibold text-inksoft mb-2">{title}</h3>
      <div className="border border-line bg-white p-4">{children}</div>
    </section>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/**
 * Przycina przezroczyste marginesy zdjęcia (PNG/WebP z kanałem alfa) — tak jak robiliśmy ręcznie dla pierwszych
 * zdjęć: sklep opiera na tym efekt "produkt wychodzi ponad kolorowy panel" i równe kafelki. Zdjęcie bez
 * przezroczystości (np. JPG) wraca bez zmian.
 */
async function trimTransparent(file: File): Promise<Blob> {
  if (!/png|webp/.test(file.type)) return file;
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1)) return file;
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")!.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return new Promise((res) => out.toBlob((b) => res(b ?? file), "image/png"));
}

function ImagesSection({
  model,
  images,
  onChanged,
  onError,
}: {
  model: ShopModel;
  images: ShopImage[];
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
    if (!list.length) return onError("Dozwolone formaty: PNG, JPG, WebP.");
    setBusy(true);
    try {
      let pos = images.reduce((m, i) => Math.max(m, i.position), -1);
      for (const f of list) {
        const blob = await trimTransparent(f);
        if (blob.size > 5 * 1024 * 1024) throw new Error(`${f.name}: plik po przycięciu ma ponad 5 MB.`);
        const ext = blob.type === "image/png" ? "png" : f.name.split(".").pop()?.toLowerCase() || "jpg";
        const path = `${model.slug}/${Date.now()}-${slugify(f.name.replace(/\.[^.]+$/, "")) || "zdjecie"}.${ext}`;
        const up = await supabase.storage.from("shop-images").upload(path, blob, { contentType: blob.type || f.type, upsert: false });
        if (up.error) throw up.error;
        const url = supabase.storage.from("shop-images").getPublicUrl(path).data.publicUrl;
        const ins = await supabase.from("shop_images").insert({ model_id: model.id, url, storage_path: path, alt: model.name, position: ++pos });
        if (ins.error) {
          await supabase.storage.from("shop-images").remove([path]); // nie zostawiamy osieroconego pliku
          throw ins.error;
        }
      }
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function move(i: number, dir: -1 | 1) {
    const a = images[i];
    const b = images[i + dir];
    if (!a || !b) return;
    await Promise.all([
      supabase.from("shop_images").update({ position: b.position }).eq("id", a.id),
      supabase.from("shop_images").update({ position: a.position }).eq("id", b.id),
    ]);
    onChanged();
  }

  async function saveAlt(img: ShopImage, alt: string) {
    if (alt.trim() === img.alt) return;
    const { error } = await supabase.from("shop_images").update({ alt: alt.trim() }).eq("id", img.id);
    if (error) onError(error.message);
  }

  async function remove(img: ShopImage) {
    if (!confirm("Usunąć to zdjęcie?")) return;
    // Najpierw wiersz (sklep przestaje go pokazywać), potem plik ze Storage. Pliki startowe z repo sklepu nie mają storage_path.
    const { error } = await supabase.from("shop_images").delete().eq("id", img.id);
    if (error) return onError(error.message);
    if (img.storage_path) await supabase.storage.from("shop-images").remove([img.storage_path]);
    onChanged();
  }

  return (
    <Section title="ZDJĘCIA">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          upload(e.dataTransfer.files);
        }}
        className={`border border-dashed rounded px-3 py-3 text-xs text-inksoft flex items-center justify-between gap-3 mb-3 ${over ? "border-teal bg-tealsoft" : "border-line bg-paper"}`}
      >
        <span>
          Przeciągnij zdjęcia tutaj. Najlepiej PNG z przezroczystym tłem — puste marginesy przytniemy automatycznie.
          Pierwsze zdjęcie to miniatura w sklepie.
        </span>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className="px-3 py-1.5 border border-line bg-white rounded font-semibold text-ink disabled:opacity-50 whitespace-nowrap">
          {busy ? "Wysyłanie…" : "Wybierz pliki"}
        </button>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
      </div>
      {images.length === 0 ? (
        <p className="text-sm text-inksoft">Brak zdjęć — sklep pokazuje ilustrację zastępczą.</p>
      ) : (
        <div className="grid grid-cols-4 gap-3">
          {images.map((img, i) => (
            <div key={img.id} className="border border-line rounded overflow-hidden">
              <div className="relative h-32 flex items-center justify-center" style={{ background: model.color }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageSrc(img.url)} alt={img.alt} className="max-h-full max-w-full object-contain p-2" />
                {i === 0 && <span className="absolute left-1 top-1 text-[10px] font-semibold bg-ink text-paper px-1.5 py-0.5 rounded">MINIATURA</span>}
              </div>
              <div className="p-2 space-y-1.5">
                <input defaultValue={img.alt} onBlur={(e) => saveAlt(img, e.target.value)} className="w-full border border-line bg-white px-1.5 py-1 rounded text-xs" placeholder="Opis zdjęcia (dla niewidomych i Google)" />
                <div className="flex items-center justify-between text-xs">
                  <span>
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="px-1.5 disabled:opacity-30" aria-label="Wcześniej">←</button>
                    <button onClick={() => move(i, 1)} disabled={i === images.length - 1} className="px-1.5 disabled:opacity-30" aria-label="Później">→</button>
                  </span>
                  <button onClick={() => remove(img)} className="text-rust hover:underline">Usuń</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
