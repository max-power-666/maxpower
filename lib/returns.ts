// Zwroty (22.10.2026, na prośbę właściciela): rejestr przyjętych zwrotów prowadzony dotąd w arkuszu. Kolumny na start takie same jak w arkuszu.
// Wartości list to zwykły tekst w bazie (jak role) — dodanie pozycji to wpis tutaj, bez SQL.
import { MARKETPLACES } from "./salesOrders";
import { skuCategoryOf } from "./skuParts";

export const RETURN_KINDS = [
  { key: "zwrot", label: "Zwrot" },
  { key: "reklamacja", label: "Reklamacja" },
  { key: "gwarancja", label: "Gwarancja" },
] as const;

export const RETURN_FINAL_STATUSES = [
  { key: "zwrot_srodkow", label: "Zwrot środków" },
  { key: "naprawione_odeslane", label: "Naprawione, odesłane" },
  { key: "wymiana", label: "Wymiana" },
  { key: "odeslane", label: "Odesłane" },
  { key: "wstrzymane", label: "Wstrzymane" },
] as const;

// Pigułki filtra listy (22.10.2026): grupy wg statusu końcowego
export const RETURN_GROUPS = [
  { key: "all", label: "Wszystkie", statuses: null },
  { key: "odstapienie", label: "Przetworzone odstąpienie", statuses: ["zwrot_srodkow"] },
  { key: "reklamacje", label: "Przetworzone reklamacje", statuses: ["naprawione_odeslane", "odeslane", "wymiana"] },
  { key: "wstrzymane", label: "Wstrzymane", statuses: ["wstrzymane"] },
  { key: "bez_statusu", label: "Bez statusu", statuses: [] },
] as const;
export type ReturnGroupKey = (typeof RETURN_GROUPS)[number]["key"];

// PROWIZJA (lista rozwijana jak w arkuszu, 22.10.2026) — zgłaszanie prowizji od zwrotu marketplace'owi
export const RETURN_COMMISSION = [
  { key: "prowizja", label: "Prowizja" },
  { key: "odzyskana", label: "Odzyskana" },
  { key: "odrzucona", label: "Odrzucona" },
  { key: "bez_prowizji", label: "Bez prowizji" },
  { key: "do_zgloszenia", label: "Do zgłoszenia" },
  { key: "zgloszona", label: "Zgłoszona" },
] as const;
export const RETURN_COMMISSION_COLORS: Record<string, { bg: string; fg: string }> = {
  prowizja: { bg: "#e4d9f5", fg: "#5b2fa0" },
  odzyskana: { bg: "#2f7a4d", fg: "#ffffff" },
  odrzucona: { bg: "#b3261e", fg: "#ffffff" },
  bez_prowizji: { bg: "#e9ecef", fg: "#374151" },
  do_zgloszenia: { bg: "#fcd9bd", fg: "#9a4a0a" },
  zgloszona: { bg: "#f4a77a", fg: "#5a2a05" },
};

// Kolory plakietek (para tło/tekst) — jak plakietki marketplace'ów, stała paleta niezależna od motywu
export const RETURN_FINAL_COLORS: Record<string, { bg: string; fg: string }> = {
  zwrot_srodkow: { bg: "#fbdcdc", fg: "#b42318" },
  naprawione_odeslane: { bg: "#d9f2df", fg: "#1a7a3a" },
  wymiana: { bg: "#e3ecf9", fg: "#2a6bb5" },
  odeslane: { bg: "#e9ecef", fg: "#4b5563" },
  wstrzymane: { bg: "#fff1c9", fg: "#8a5a00" },
};
export const RETURN_PLATFORM_COLORS: Record<string, { bg: string; fg: string }> = {
  backmarket: { bg: "#e3ecf9", fg: "#2a6bb5" },
  refurbed: { bg: "#d6f1ee", fg: "#0f766e" },
  erli: { bg: "#fde8d7", fg: "#c2570c" },
  allegro: { bg: "#fde3ec", fg: "#b4235f" },
  octopia: { bg: "#e4e1f7", fg: "#4b3fa8" },
  amazon: { bg: "#f5b301", fg: "#3b2a00" },
  swopify: { bg: "#e9ecef", fg: "#4b5563" },
};

// Platformy do wyboru w zwrotach (bez wycofanego Apilo); "inna" dla zwrotów spoza naszych kanałów
export const RETURN_PLATFORMS = [...MARKETPLACES.filter((m) => m.key !== "apilo").map((m) => ({ key: m.key as string, label: m.label as string })), { key: "inna", label: "Inna" }];
export const platformLabel = (key: string | null | undefined) => RETURN_PLATFORMS.find((p) => p.key === key)?.label ?? (key || "—");

// Grupa produktu jak w arkuszu (PlayStation, iPhone, Samsung, Asus…) — podpowiedź z SKU albo nazwy; można zmienić ręcznie
export const RETURN_PRODUCTS = ["PlayStation", "Xbox", "Nintendo", "iPhone", "iPad", "Samsung", "Asus", "Aparat", "Macbook", "Watch", "Audio", "Inne"] as const;

export function guessReturnProduct(name: string | null | undefined, sku: string | null | undefined): string {
  const n = (name || "").toLowerCase();
  const cat = skuCategoryOf(sku);
  if (cat === "APARAT" || /\b(canon|nikon|sony a|reflex|eos|lumix)\b/.test(n)) return "Aparat";
  if (/playstation|\bps[45]\b/.test(n) || /^PS\d/.test(cat)) return "PlayStation";
  if (/xbox/.test(n) || /^X(O|S|SX|SS|OX|OS)/.test(cat)) return "Xbox";
  if (/switch|nintendo/.test(n) || /^NS|^NDS/.test(cat)) return "Nintendo";
  if (/iphone/.test(n) || /^IP/.test(cat)) return "iPhone";
  if (/ipad/.test(n) || /^ID/.test(cat)) return "iPad";
  if (/macbook/.test(n) || /^MB/.test(cat)) return "Macbook";
  if (/watch/.test(n) || /^(AW|SGW)/.test(cat)) return "Watch";
  if (/samsung|galaxy/.test(n) || /^SG/.test(cat)) return "Samsung";
  if (/asus|rog/.test(n)) return "Asus";
  return "Inne";
}

// Wynik wyszukiwania po numerze seryjnym (api/returns/lookup)
export type ReturnLookup = {
  found: boolean;
  source?: "zamowienie" | "towar" | "trade-in" | "testy";
  platform?: string;
  orderId?: string;
  customerName?: string;
  product?: string;
  sku?: string;
  productName?: string;
  byOrder?: boolean; // wpisano numer zamówienia (nie numer seryjny)
  serial?: string; // numer seryjny pozycji, gdy zamówienie ma jedną pozycję
  items?: { serial: string; sku: string; name: string; product: string }[]; // pozycje zamówienia
  note?: string;
};
