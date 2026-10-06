// Backoffice sklepu Recoo (przełącznik "Recoo Sklep" w pasku bocznym). Dane: supabase/shop.sql.
// Te same pojęcia co w sklepie (repo recoo-sklep, lib/catalog.ts): model → warianty (opcja × stan wizualny).

export const SHOP_URL = process.env.NEXT_PUBLIC_SHOP_URL || "https://recoo-sklep.vercel.app";

export type ShopGrade = "jak-nowy" | "bardzo-dobry" | "dobry" | "zadowalajacy";

export const SHOP_GRADES: { value: ShopGrade; label: string; short: string }[] = [
  { value: "jak-nowy", label: "Jak nowy", short: "A+" },
  { value: "bardzo-dobry", label: "Bardzo dobry", short: "A" },
  { value: "dobry", label: "Dobry", short: "B" },
  // Klasy A/B/C = klasy z Katalogu konsol (bardzo dobry / dobry / zadowalający).
  { value: "zadowalajacy", label: "Zadowalający", short: "C" },
];

export function gradeLabel(g: string) {
  return SHOP_GRADES.find((x) => x.value === g)?.label ?? g;
}

export type ShopCategory = { slug: string; name: string; tagline: string; hidden: boolean; sort: number };

export type ShopModel = {
  id: string;
  slug: string;
  name: string;
  brand: string;
  category_slug: string;
  description: string;
  highlights: string[];
  option_label: string | null;
  color: string;
  keywords: string;
  is_new: boolean;
  featured: boolean;
  published: boolean;
  sort: number;
  updated_at: string;
};

export type ShopVariant = {
  id: string;
  model_id: string;
  sku: string;
  option_value: string | null;
  grade: ShopGrade;
  price: number;
  old_price: number | null;
  stock: number;
  active: boolean;
  sort: number;
};

export type ShopImage = {
  id: string;
  model_id: string;
  url: string;
  storage_path: string | null;
  alt: string;
  position: number;
  /** Wartość opcji, dla której pokazujemy zdjęcie (np. "Biały"); null/brak = wspólne dla wszystkich wariantów. */
  option_value?: string | null;
};

/** Separator wymiarów opcji wariantu — ten sam co w sklepie (lib/catalog.ts): "1 TB · Biały · 1 pad" przy nazwie "Dysk · Kolor · Pady". */
export const OPTION_SEPARATOR = " · ";

/** Nazwy wymiarów opcji z nazwy opcji modelu ("Dysk · Kolor · Pady" -> 3 wymiary; puste = jeden, "Pamięć"). */
export function optionDims(optionLabel: string): string[] {
  const parts = (optionLabel.trim() || "Pamięć").split(OPTION_SEPARATOR).map((x) => x.trim());
  return parts.length > 1 ? parts : [parts[0] || "Pamięć"];
}

/** Rozbija wartość opcji na części wg liczby wymiarów (brakujące = puste). */
export function splitOption(value: string, n: number): string[] {
  if (n <= 1) return [value];
  const parts = value ? value.split(OPTION_SEPARATOR) : []; // bez trim: pole w edycji może chwilowo kończyć się spacją
  return Array.from({ length: n }, (_, i) => parts[i] ?? "");
}

/** Skleja części z powrotem (bez obcinania spacji — to robi normalizeOption przy zapisie); same puste części = brak opcji. */
export function joinOption(parts: string[]): string {
  return parts.some((x) => x.trim()) ? parts.join(OPTION_SEPARATOR) : "";
}

/** Opcja do zapisu: każda część bez spacji na brzegach. */
export function normalizeOption(value: string): string {
  return value.split(OPTION_SEPARATOR.trim()).map((x) => x.trim()).join(OPTION_SEPARATOR).trim();
}

/** Wybory "Pokazuj dla" zdjęcia: każda wartość każdego wymiaru, w kolejności występowania w wariantach. */
export function imageOptionChoices(optionLabel: string, values: string[]): { value: string; label: string }[] {
  const dims = optionDims(optionLabel);
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  dims.forEach((dim, i) => {
    for (const v of values) {
      const part = splitOption(v, dims.length)[i]?.trim();
      if (!part || seen.has(part)) continue;
      seen.add(part);
      out.push({ value: part, label: `${dim}: ${part}` });
    }
  });
  return out;
}

export type ShopLogEntry = {
  id: number;
  entity: string;
  action: "created" | "edited" | "deleted";
  label: string | null;
  changes: { field: string; from: unknown; to: unknown }[] | null;
  by_email: string | null;
  at: string;
};

/** Tła kafelków: jasne odcienie kolorystyki dodatkowej z księgi znaku (takie same jak w sklepie) + biały. */
export const SHOP_COLORS: { hex: string; name: string }[] = [
  { hex: "#E1F0FE", name: "niebieski" },
  { hex: "#E7EBFA", name: "fiolet" },
  { hex: "#E3FCEE", name: "mięta" },
  { hex: "#D9F8EF", name: "zieleń" },
  { hex: "#FDECF0", name: "róż" },
  { hex: "#F1F2F3", name: "szary" },
  { hex: "#FFFFFF", name: "biały" }, // w sklepie dostaje cienką ramkę, żeby nie zlał się z białą stroną
];

/** Adres zdjęcia do podglądu w ERP: pliki startowe leżą w repo sklepu ("/produkty/..."), nowe — w Storage (pełny URL). */
export function imageSrc(url: string) {
  return url.startsWith("/") ? `${SHOP_URL}${url}` : url;
}

/** "PlayStation 5 Slim" -> "playstation-5-slim" (bez polskich znaków). */
export function slugify(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/gi, "l")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Ta sama zasada co w sklepie: PREFIKS-OPCJA-STAN, wielkie litery, bez spacji i polskich znaków ("PS5S-1TB-A+"). */
export function skuFor(prefix: string, option: string | null, grade: ShopGrade) {
  const short = SHOP_GRADES.find((g) => g.value === grade)?.short ?? grade;
  return `${prefix}-${option ?? "-"}-${short}`
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/gi, "L")
    .toUpperCase()
    .replace(/[^A-Z0-9+-]/g, "");
}

/** Prefiks SKU z nazwy modelu: "Xbox Series X" -> "XSX" (pierwsze litery słów i cyfry), max 8 znaków. */
export function skuPrefixFor(name: string) {
  const words = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const p = words.map((w) => (/^\d+$/.test(w) ? w : w[0])).join("");
  return (p || "SKU").slice(0, 8);
}

const pln = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 });
export function formatPln(v: number | null | undefined) {
  return v === null || v === undefined ? "—" : pln.format(v);
}

/** Etykiety pól do dziennika zmian. */
export const SHOP_FIELD_LABELS: Record<string, string> = {
  name: "Nazwa",
  slug: "Adres (slug)",
  brand: "Marka",
  category_slug: "Kategoria",
  description: "Opis",
  highlights: "Cechy",
  option_label: "Nazwa opcji",
  color: "Kolor tła",
  keywords: "Słowa kluczowe",
  is_new: "Nowość",
  featured: "Polecany",
  published: "Opublikowany",
  sort: "Kolejność",
  sku: "SKU",
  option_value: "Opcja",
  grade: "Stan",
  price: "Cena",
  old_price: "Cena nowego",
  stock: "Stan magazynowy",
  active: "Aktywny",
};
