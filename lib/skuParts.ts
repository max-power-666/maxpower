// Części SKU (07.10.2026): "Kategoria z SKU" i "Klasa". Zwykłe SKU: KATEGORIA-POJEMNOŚĆ-KOLOR-KLASA (XSX-1TB-BK-B). SKU APARATÓW wyglądają inaczej: "237387 (3/5)" —
// numer produktu i ocena stanu w nawiasie z ukośnikiem (3/5, 5/5). Stałym elementem jest "(n/5)" na końcu, więc po nim rozpoznajemy aparat: kategoria = "APARAT", klasa = "3/5".
// Wzorzec to nawias z ukośnikiem NA KOŃCU, a nie sam ukośnik — inaczej łapałyby się zwykłe SKU z pamięcią typu SGS22U51-12/256-E. To samo wyliczenie jest w widokach SQL
// (inventory.sql, margin.sql, ai.sql) — zmieniając regułę, zmień wszystkie.
export const CAMERA_CATEGORY = "APARAT";
const CAMERA_RE = /\(\s*(\d+)\s*\/\s*(\d+)\s*\)\s*$/;

export const isCameraSku = (sku: string | null | undefined): boolean => CAMERA_RE.test(sku || "");

export function skuCategoryOf(sku: string | null | undefined): string {
  const s = (sku || "").trim();
  if (!s) return "";
  if (isCameraSku(s)) return CAMERA_CATEGORY;
  return s.split("-")[0].trim().toUpperCase();
}

// Klasa: dla aparatów ocena z nawiasu ("3/5"); dla pozostałych ostatni człon z samych liter po myślniku (jak sku_class w widokach magazynowych), inaczej "".
export function skuClassOf(sku: string | null | undefined): string {
  const s = (sku || "").trim();
  const cam = CAMERA_RE.exec(s);
  if (cam) return `${cam[1]}/${cam[2]}`;
  const m = /-([A-Za-z]+)$/.exec(s);
  return m ? m[1] : "";
}
