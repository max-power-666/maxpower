// Koszty dodatkowe zakupu Trade-in (skup od osób prywatnych przez Back Market) — wg Regulaminu Back Market "EU Sellers T&Cs"
// (wersja z marca 2026), Część IV, art. 15.1 "Trade-in":
//  - prowizja Back Market: 10% (netto) od CAŁKOWITEJ kwoty zapłaconej przez Refurbishera (z podatkami i kosztami przesyłki) — czyli
//    od ceny, jaką płacimy klientowi; dla zamówień z kontrofertą liczymy od ceny PO kontrofercie (decyzja właściciela, 03.10.2026);
//  - opłata logistyczna Trade-in (stała, w EUR) zależna od kraju magazynu sprzedawcy i kategorii produktu. Nasz magazyn jest w Polsce, czyli
//    według regulaminu "inne kraje" (nie FR/ES/DE): smartfony i audio 12,90 €, MacBooki i konsole do gier 15,90 €, tablety 13,90 €.
// Obie pozycje są podane w regulaminie jako kwoty bez podatku (VAT nie jest tu doliczany). Back Market pobiera je przy wypłacie dla klienta
// (po odebraniu i zwalidowaniu produktu), a faktura zbiorcza przychodzi raz w miesiącu — to SZACUNEK z regulaminu, nie faktura.
// Poza zakresem: opłata 7,50 € za "Trade-in Chargeback" (tylko gdy płatność Refurbishera zostanie odrzucona).

// PCC (podatek od czynności cywilnoprawnych) przy zakupie używanej rzeczy od OSOBY PRYWATNEJ (decyzja właściciela, 03.10.2026): wartość rynkowa do 1000 zł
// włącznie — zwolnione; powyżej 1000 zł — 2% CAŁEJ wartości (nie tylko nadwyżki ponad 1000 zł). Wartością jest dla nas cena zapłacona klientowi (po kontrofercie)
// przeliczona na PLN kursem NBP z dnia poprzedniego względem wypłaty (jak reszta kosztów). Dotyczy wyłącznie zakupów z Trade-in (od osób prywatnych), nie
// sztuk kupowanych od firm (np. faktury "VAT marża").
export const PCC_RATE = 0.02;
export const PCC_THRESHOLD_PLN = 1000;
export function pccFromValuePln(valuePln: number): number {
  return valuePln > PCC_THRESHOLD_PLN ? Math.round(valuePln * PCC_RATE * 100) / 100 : 0;
}

export type TradeInCategory = "phones_audio" | "consoles_laptops" | "tablets";

export const TRADEIN_COMMISSION_RATE = 0.1;
// Region opłat logistycznych wg lokalizacji naszego magazynu (Polska = "other"; FR/ES/DE mają niższe stawki dla smartfonów i konsol).
export const TRADEIN_LOGISTICS_REGION: "fr_es_de" | "other" = "other";

export const TRADEIN_LOGISTICS_EUR: Record<"fr_es_de" | "other", Record<TradeInCategory, number>> = {
  fr_es_de: { phones_audio: 11.9, consoles_laptops: 14.9, tablets: 13.9 },
  other: { phones_audio: 12.9, consoles_laptops: 15.9, tablets: 13.9 },
};

export const TRADEIN_CATEGORY_LABELS: Record<TradeInCategory, string> = {
  phones_audio: "smartfony i audio",
  consoles_laptops: "konsole i MacBooki",
  tablets: "tablety",
};

// Kategoria wg regulaminu z nazwy produktu BM (główny sygnał — SKU bywa puste albo "None"), a gdy nazwa nic nie mówi, z prefiksu SKU.
// Konsole przenośne (Steam Deck, ROG Ally, Onexplayer, Anbernic) i gogle VR (Meta Quest) wrzucone do kategorii konsol — regulamin ich nie wymienia
// wprost; stawka "MacBooki i konsole" jest ta sama co dla laptopów, więc to najbliższy odpowiednik.
export function tradeInCategory(title: string | null | undefined, sku: string | null | undefined): TradeInCategory | null {
  const t = (title || "").toLowerCase();
  if (/\b(ipad|galaxy tab|surface)\b|\btab s\d/.test(t)) return "tablets";
  if (/playstation|xbox|nintendo|\bswitch\b|steam deck|rog ally|onexplayer|anbernic|oculus|meta quest|\bvita\b|\b3ds\b|\bds\b|macbook|laptop|legion go/.test(t)) return "consoles_laptops";
  if (/iphone|galaxy (s|z|a|note)\d?|pixel|oppo|oneplus|xiaomi|airpods|homepod|bose|marshall|headphone|earbud|\bbeats\b|\bjbl\b|smartphone|casque/.test(t)) return "phones_audio";
  const p = (sku || "").split("-")[0].toUpperCase();
  if (!p || p === "NONE") return null;
  if (/^(ID|SGT)/.test(p)) return "tablets";
  if (/^(PS|XS|XO|NS|N3DS|NNDS|NDS|VSD|VVSD|MOQ|ASA|ONEX|MB)/.test(p)) return "consoles_laptops";
  if (/^(IP|SGS|SGZ|S2|GP|OF|APM|APP|AHP|B7|MARSH|QC)/.test(p)) return "phones_audio";
  return null;
}

export type TradeInCosts = {
  base: number; // cena do wyliczeń: PO kontrofercie, a gdy jej nie było — cena początkowa
  commission: number;
  logistics: number | null; // null: nieznana kategoria albo waluta inna niż EUR (stawki w regulaminie są w EUR)
  extra: number | null; // koszty dodatkowe razem w EUR (prowizja + logistyka + PCC w przeliczeniu na EUR), null gdy logistyki nie da się policzyć
  total: number | null; // koszt całkowity = cena + koszty dodatkowe
  category: TradeInCategory | null;
  valuePln: number | null; // cena do wyliczeń w PLN (podstawa PCC) — null, gdy nie podano kursu
  pccPln: number | null; // PCC w PLN (0 przy wartości do 1000 zł) — null, gdy nie podano kursu EUR/PLN
  pccEur: number | null; // PCC przeliczone z powrotem na EUR tym samym kursem (do sumowania z resztą kosztów w EUR)
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeTradeInCosts(o: {
  originalPrice: number | null | undefined;
  counterOfferPrice: number | null | undefined;
  currency: string | null | undefined;
  title: string | null | undefined;
  sku: string | null | undefined;
  eurRate?: number | null; // PLN za 1 EUR (NBP z dnia poprzedniego względem wypłaty) — bez niego nie liczymy PCC (podstawa jest w PLN)
}): TradeInCosts | null {
  const base = o.counterOfferPrice ?? o.originalPrice;
  if (base === null || base === undefined || !Number.isFinite(Number(base))) return null;
  const price = Number(base);
  const category = tradeInCategory(o.title, o.sku);
  const eur = (o.currency || "EUR").toUpperCase() === "EUR";
  const logistics = category && eur ? TRADEIN_LOGISTICS_EUR[TRADEIN_LOGISTICS_REGION][category] : null;
  const commission = round2(price * TRADEIN_COMMISSION_RATE);
  const rate = o.eurRate && o.eurRate > 0 && eur ? o.eurRate : null;
  const valuePln = rate === null ? null : round2(price * rate);
  const pccPln = valuePln === null ? null : pccFromValuePln(valuePln);
  const pccEur = pccPln === null || rate === null ? null : round2(pccPln / rate);
  const extra = logistics === null ? null : round2(commission + logistics + (pccEur ?? 0));
  return { base: price, commission, logistics, extra, total: extra === null ? null : round2(price + extra), category, valuePln, pccPln, pccEur };
}
