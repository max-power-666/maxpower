// Recoo Sklep <- oferty Back Market (21.10.2026, na prośbę właściciela): produkty sklepu powstają z aktywnych ofert BM z pigułki Listingi -> Sklep
// (konsole, aparaty, smartwatche Samsung — `shopCategory`). PRODUKT = tytuł oferty bez stanu (przetłumaczony z francuskiego), WARIANT = stan
// wizualny (ocena BM). Kilka ofert o tym samym tytule i stanie trafia do JEDNEGO wariantu (ilość = suma ofert). Tu są tylko czyste funkcje
// (bez bazy i API) — serwer: lib/shopBmServer.ts.
import { shopCategory, type ShopCategory } from "./shopListings";

export type BmLiveOffer = { id: string; sku: string | null; title: string | null; quantity: number; price: number | null; currency: string | null; grade: string | null };
export type ShopGradeKey = "jak-nowy" | "bardzo-dobry" | "dobry" | "zadowalajacy";

// Ocena BM -> stan w sklepie (A/B/C jak w katalogu konsol; zgodne z końcówkami SKU ofert: EXCELLENT/VERY_GOOD = A, GOOD = B, FAIR/STALLONE = C).
export const BM_GRADE_TO_SHOP: Record<string, ShopGradeKey> = {
  PREMIUM: "jak-nowy",
  EXCELLENT: "bardzo-dobry",
  VERY_GOOD: "bardzo-dobry",
  GOOD: "dobry",
  FAIR: "zadowalajacy",
  STALLONE: "zadowalajacy",
};

const COLORS: [string, string][] = [
  ["Blanc/Blanc", "Biały"], ["Noir/Argent", "Czarny/Srebrny"], ["Rouge/Bleu", "Czerwony/Niebieski"], ["Gris/Gris", "Szary"], ["Bleu/Gris", "Niebieski/Szary"],
  ["Bleu/Jaune", "Niebieski/Żółty"], ["Vert/Rose", "Zielony/Różowy"], ["Mauve/Orange", "Fioletowy/Pomarańczowy"],
  ["Noir", "Czarny"], ["Blanc", "Biały"], ["Gris", "Szary"], ["Rouge", "Czerwony"], ["Bleu", "Niebieski"], ["Jaune", "Żółty"],
  ["Vert", "Zielony"], ["Argent", "Srebrny"], ["Rose", "Różowy"],
];
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function storage(t: string) {
  return t.replace(/\b1000\s?(GB|Go)\b/g, "1 TB").replace(/\b(\d+)\s?(GB|Go)\b/g, "$1 GB");
}
// Kolory tłumaczymy tylko w segmentach " - Kolor" (nazwy gier zostają).
function colors(t: string) {
  const parts = t.split(" - ");
  for (let i = 1; i < parts.length; i++) {
    let seg = parts[i];
    for (const [fr, pl] of COLORS) seg = seg.replace(new RegExp(`^${escapeRx(fr)}(?=$|\\s|\\b)`), pl);
    parts[i] = seg;
  }
  return parts.join(" - ");
}
function cleanConsole(t: string) {
  let s = storage(t);
  s = s.replace(/ - Edition limitée (Standard|N\/A)(?= \+|$)/g, "");
  s = s.replace(/Edition limitée/g, "Edycja limitowana");
  return colors(s).trim();
}
const CAM_BRANDS: [string, RegExp][] = [
  ["Canon", /\bEOS\b|Canon/], ["Nikon", /Nikon|\bD\d{4}\b|\bD\d{3}\b/], ["Panasonic", /Lumix|Panasonic/],
  ["Sony", /Sony|Alpha|\bA\d{4}\b|Cyber-shot/], ["Olympus", /OM-D|Olympus/],
];
function cleanCamera(t: string): { brand: string; name: string } {
  const s = t.trim().replace(/^(Reflex|Compact|Bridge|Hybride|Autre)\s+(-\s+)?/, "");
  const plus = s.indexOf(" + ");
  let body = plus >= 0 ? s.slice(0, plus) : s;
  let lens = plus >= 0 ? s.slice(plus + 3) : "";
  body = colors(storage(body)).replace(/\s*-\s*(Czarny|Biały|Czarny\/Srebrny|Srebrny)\s+(Nikon|Canon|Sony)$/, " - $1");
  const brand = CAM_BRANDS.find(([, rx]) => rx.test(s))?.[0] ?? "";
  let model = body.replace(/^(Canon|Nikon|Sony|Panasonic)\s+/, "");
  if (brand === "Panasonic" && !model.toLowerCase().startsWith("lumix")) model = "Lumix " + model;
  let name: string;
  if (lens) {
    lens = lens.trim().replace(/^(Objectif\s+)?((Canon|Nikon|Sony|Panasonic|Lumix)\s+)+/, "");
    const m = lens.match(/^(.*?)\s+(f\/[\d.,]+[-–][\d.,]+|f\/[\d.,]+)\s*$/); // zdublowana przysłona na końcu
    const norm = (x: string) => x.toLowerCase().replace(/–/g, "-").replace(/,/g, ".");
    if (m && norm(m[1]).includes(norm(m[2]))) lens = m[1];
    lens = lens.replace(/Zoom Lens /g, "");
    name = `${brand} ${model} + obiektyw ${lens}`;
  } else name = `${brand} ${model} (body)`;
  return { brand, name: name.replace(/\s{2,}/g, " ").trim() };
}
const consoleBrand = (t: string) => (t.startsWith("PlayStation") ? "Sony" : t.startsWith("Xbox") ? "Microsoft" : "Nintendo");

export function slugify(s: string) {
  return s
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}
// SKU sklepu musi pasować do ^[A-Z0-9+-]+$ (supabase/shop.sql) — oryginalne SKU BM bywa ze spacjami, nawiasami, małymi literami.
export function shopSkuFrom(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9+]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-?\+-?/g, "+")
    .replace(/-{2,}/g, "-");
}
// Cena w zł: cena BM × kurs, w górę do pełnych …9 zł.
export function shopPricePln(eur: number, rate: number) {
  const x = eur * rate;
  return Math.ceil((x + 1) / 10) * 10 - 1;
}

// Tło karty produktu: domyślnie białe dla wszystkich (21.10.2026, decyzja właściciela — kolor ustawia ręcznie w wybranych ofertach).
const DEFAULT_BG = "#FFFFFF";

export type OfferPlan = {
  offer: BmLiveOffer;
  category: ShopCategory;
  brand: string;
  name: string;
  modelSlug: string;
  color: string;
  grade: ShopGradeKey;
  sku: string; // oczyszczone SKU oferty (kandydat na SKU wariantu)
};

// Plan dla jednej oferty; null = oferta spoza kategorii sklepu (akcesoria, inne marki) albo bez tytułu/oceny.
export function planOffer(o: BmLiveOffer): OfferPlan | null {
  const title = (o.title || "").replace(/[​‌‍﻿]/g, "").trim();
  const category = shopCategory(title, o.sku);
  if (!category || !title) return null;
  const grade = BM_GRADE_TO_SHOP[(o.grade || "").toUpperCase()];
  if (!grade) return null;
  let brand: string, name: string, color: string;
  if (category === "konsole") {
    brand = consoleBrand(title);
    name = cleanConsole(title);
    color = DEFAULT_BG;
  } else if (category === "aparaty") {
    ({ brand, name } = cleanCamera(title));
    color = DEFAULT_BG;
  } else {
    brand = "Samsung";
    name = colors(title.replace(/^Samsung\s+/, ""));
    color = DEFAULT_BG;
  }
  const modelSlug = slugify(category === "aparaty" ? name : `${brand} ${name}`);
  const sku = shopSkuFrom(o.sku || `BM-${o.id}`) || `BM-${o.id.slice(0, 8).toUpperCase()}`;
  return { offer: o, category, brand, name, modelSlug, color, grade, sku };
}

// Ilość wariantu = suma ilości jego ofert, które są aktywne (online, ilość > 0); oferta, której nie ma na liście aktywnych, liczy się jako 0.
export function variantQuantities(sources: { variant_id: string; external_id: string }[], live: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sources) out.set(s.variant_id, (out.get(s.variant_id) ?? 0) + (live.get(s.external_id) ?? 0));
  return out;
}
