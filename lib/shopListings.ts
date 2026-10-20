// Listingi -> pigułka "Sklep" (21.10.2026, na prośbę właściciela): lista dostępnych ofert Back Market z trzech kategorii sklepu — konsole do gier, aparaty fotograficzne i smartwatche Samsung.
// SKU ofert Back Market są niespójne (kody magazynowe, nazwy robocze z grą w SKU, numery produktów aparatów), więc kategorię rozpoznajemy głównie po TYTULE oferty (francuskim, jak na Back Market),
// a SKU jest dodatkową wskazówką (aparaty: ocena "(3/5)" na końcu — ten sam znacznik co w Magazynie, `lib/skuParts.ts`; smartwatche Samsung: SKU zaczyna się od SGW).
export const SHOP_CATEGORIES = [
  { key: "konsole", label: "Konsole do gier" },
  { key: "aparaty", label: "Aparaty fotograficzne" },
  { key: "smartwatche", label: "Smartwatche Samsung" },
] as const;
export type ShopCategory = (typeof SHOP_CATEGORIES)[number]["key"];

const ACCESSORY = /^(manette|joystick|c[aâ]ble|casque|chargeur|housse|[ée]tui|coque|support|volant|clavier|souris)\b/i;
const SAMSUNG_WATCH = /^samsung\b.*\bwatch/i;
const CAMERA_SKU = /\(\s*\d\s*\/\s*\d\s*\)\s*$|\s\d\/\d\s*$/; // "237387 (3/5)" albo "3122434 3/5"
const CAMERA_TITLE = /^(reflex|compact|bridge|hybride)\b/i;
const CONSOLE_TITLE = /^(playstation\s*(2|3|4|5|vita|portable)\b|ps[2345]\b|xbox(\s+(360|one|series))?\b|switch\b|nintendo\s*(switch|ds|3ds|wii)|wii\b|steam deck|rog ally)/i;

export function shopCategory(title: string | null | undefined, sku: string | null | undefined): ShopCategory | null {
  const t = (title || "").trim();
  const s = (sku || "").trim();
  if (ACCESSORY.test(t)) return null;
  if (SAMSUNG_WATCH.test(t) || /^SGW/i.test(s)) return "smartwatche";
  if (CAMERA_SKU.test(s) || CAMERA_TITLE.test(t)) return "aparaty";
  if (CONSOLE_TITLE.test(t)) return "konsole";
  return null;
}
