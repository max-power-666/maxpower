// Bidder Cdiscount (19.10.2026, Magazyn -> Listingi -> Cdiscount; zadanie ZAD-7): PROPOZYCJE cen — nic nie zmienia samo, zmianę zatwierdza człowiek.
// Cena minimalna (i opcjonalnie maksymalna) jest wpisywana ręcznie per oferta (listing_price_rules). Cdiscount wybiera BuyBox po cenie z dostawą, więc porównujemy sumy
// (cena + najtańsza dostawa); cel to 0,01 € poniżej najtańszego konkurenta — tak samo działa wbudowany automat Cdiscount (offer competition), którego API nie pozwala ustawić.

export type BidderCompetitor = { p: number | null; d: number | null; b?: boolean | null };
export type BidderInput = {
  state: string | null;
  quantity: number | null;
  price: number | null;
  ourDelivery: number; // najtańszy koszt dostawy naszej oferty (0, gdy darmowa)
  bb: boolean | null;
  online?: boolean | null; // czy kanał widzi ofertę jako online (offline = brak BuyBox niezależnie od ceny)
  offlineReason?: string | null;
  competing: BidderCompetitor[];
  bestPrice: number | null; // cena oferty z BuyBox (gdy to nie my)
  bestDelivery: number | null;
  min: number | null;
  max: number | null;
};
export type BidderProposal = { action: "set" | "none" | "warn"; price: number | null; reason: string };

const STEP = 0.01;
const r2 = (n: number) => Math.round(n * 100) / 100;
const f = (n: number) => n.toFixed(2).replace(".", ",");

export function cheapestCompetitorTotal(inp: Pick<BidderInput, "competing" | "bestPrice" | "bestDelivery" | "bb">): number | null {
  const totals: number[] = [];
  for (const c of inp.competing) if (c.p !== null && c.p > 0) totals.push(c.p + (c.d ?? 0));
  if (inp.bb === false && inp.bestPrice !== null && inp.bestPrice > 0) totals.push(inp.bestPrice + (inp.bestDelivery ?? 0));
  return totals.length ? Math.min(...totals) : null;
}

export function bidderProposal(inp: BidderInput): BidderProposal {
  const none = (reason: string): BidderProposal => ({ action: "none", price: null, reason });
  if (inp.state !== "Active" || (inp.quantity ?? 0) <= 0) return none("oferta nieaktywna albo bez stanu");
  if (inp.price === null || inp.price <= 0) return none("brak ceny oferty");
  if (inp.min === null) return none("ustaw cenę minimalną, żeby dostać propozycję");
  if (inp.bb === null) return none("brak danych o BuyBox — odśwież listingi");
  if (inp.online === false) return none(`Cdiscount widzi ofertę jako offline${inp.offlineReason ? `: ${inp.offlineReason.replace(/^Your offer is offline because\s*/i, "")}` : ""} — cena nie ma tu znaczenia, dopóki oferta nie wróci online`);
  const ceiling = inp.max ?? inp.price; // bez ceny max nigdy nie proponujemy podwyżki ponad obecną cenę
  if (inp.price < inp.min - 0.004) return { action: "set", price: r2(inp.min), reason: `cena ${f(inp.price)} jest poniżej ceny minimalnej ${f(inp.min)}` };
  const cheapest = cheapestCompetitorTotal(inp);
  if (cheapest === null) {
    if (inp.bb && inp.max !== null && inp.price < inp.max - 0.004) return { action: "set", price: r2(inp.max), reason: `mamy BuyBox i brak konkurencji — podnosimy do ceny max ${f(inp.max)}` };
    return none(inp.bb ? "mamy BuyBox, brak widocznej konkurencji" : "brak danych o konkurencji — BuyBox zależy od innych czynników");
  }
  const target = r2(cheapest - STEP - inp.ourDelivery); // nasza suma = cena + dostawa ma być o 0,01 niższa od najtańszego konkurenta
  if (inp.bb) {
    const up = Math.min(target, r2(ceiling));
    if (up > inp.price + 0.004 && up >= inp.min) return { action: "set", price: up, reason: `mamy BuyBox, najtańszy konkurent ${f(cheapest)} (z dostawą) — podnosimy do ${f(up)}` };
    return none("mamy BuyBox");
  }
  if (target >= inp.price - 0.004) return none(`najtańszy konkurent ${f(cheapest)} (z dostawą) nie jest tańszy od nas — BuyBox zależy od innych czynników (dostawa, jakość, ocena)`);
  if (target < inp.min - 0.004) return { action: "warn", price: null, reason: `BuyBox poza opłacalnością: aby go zdobyć trzeba ${f(target)}, a cena minimalna to ${f(inp.min)}` };
  return { action: "set", price: target, reason: `nie mamy BuyBox, najtańszy konkurent ${f(cheapest)} (z dostawą) — schodzimy do ${f(target)}` };
}

// Najtańszy koszt dostawy naszej oferty z details.delivery_modes (listingi Cdiscount: [{c, d (dni), p (koszt)}])
export function ourDeliveryCost(details: any): number {
  const modes: any[] = Array.isArray(details?.delivery_modes) ? details.delivery_modes : [];
  const costs = modes.map((m) => Number(m?.p)).filter((n) => Number.isFinite(n) && n >= 0);
  return costs.length ? Math.min(...costs) : 0;
}

// ---- Automat (19.10.2026): cron stosuje propozycje bidderu sam, ale tylko dla ofert, którym ktoś JAWNIE włączył tryb automatu ----
// Tryby (listing_price_rules.auto_mode): "off" (domyślnie), "raise" (tylko podwyżki — cena wraca w górę, gdy konkurencja przestaje się wyprzedawać) i "both" (podwyżki i obniżki w poszukiwaniu BuyBox).
// Bezpieczniki: oferty z włączonym wbudowanym automatem Cdiscount pomijamy (walczyłyby o cenę), podwyżka musi być wyraźna (min. 1 €) i jest ograniczona do +20% na jeden przebieg,
// ta sama oferta nie jest ruszana częściej niż co 45 min, a cena zawsze mieści się w naszych granicach min/max (pilnuje też serwer przy zapisie).
export type AutoMode = "off" | "raise" | "both";
export const AUTO_MODES: { key: AutoMode; label: string; hint: string }[] = [
  { key: "off", label: "ręcznie", hint: "Bidder tylko proponuje; zmianę zatwierdzasz sam" },
  { key: "raise", label: "auto: podwyżki", hint: "Co 15 min sam podnosi cenę (do 0,01 € poniżej najtańszego konkurenta, nie wyżej niż max), gdy mamy BuyBox. Obniżki zatwierdzasz sam" },
  { key: "both", label: "auto: pełny", hint: "Co 15 min sam podnosi i obniża cenę w granicach min/max (0,01 € poniżej najtańszego konkurenta)" },
];
export const AUTO_MIN_RAISE = 1;
export const AUTO_MAX_RAISE_PCT = 20;
export const AUTO_COOLDOWN_MS = 45 * 60_000;

export type AutoCandidate = {
  externalId: string;
  state: string | null;
  quantity: number | null;
  price: number | null;
  details: any;
  rule: { min: number | null; max: number | null; autoMode: AutoMode };
  lastAutoAt: number | null; // czas ostatniej udanej zmiany automatu (ms)
};
export type AutoChange = { externalId: string; price: number; reason: string };

export function selectAutoChanges(cands: AutoCandidate[], now: number): { changes: AutoChange[]; skipped: { externalId: string; why: string }[] } {
  const changes: AutoChange[] = [];
  const skipped: { externalId: string; why: string }[] = [];
  for (const c of cands) {
    const skip = (why: string) => skipped.push({ externalId: c.externalId, why });
    if (c.rule.autoMode === "off") continue;
    const ob = c.details?.octopia;
    if (!ob) { skip("brak danych kanału"); continue; }
    if (ob.comp === true) { skip("włączony wbudowany automat Cdiscount (zarządza ceną)"); continue; }
    if (c.lastAutoAt !== null && now - c.lastAutoAt < AUTO_COOLDOWN_MS) { skip("niedawno zmieniana przez automat"); continue; }
    const p = bidderProposal({ state: c.state, quantity: c.quantity, price: c.price, ourDelivery: ourDeliveryCost(c.details), bb: ob.bb ?? null, online: ob.online ?? null, offlineReason: ob.offlineReason ?? null, competing: ob.competing || [], bestPrice: ob.bestPrice ?? null, bestDelivery: ob.bestDelivery ?? null, min: c.rule.min, max: c.rule.max });
    if (p.action !== "set" || p.price === null || c.price === null) continue;
    let price = p.price;
    if (price > c.price) {
      if (price - c.price < AUTO_MIN_RAISE - 0.004) { skip("podwyżka mniejsza niż 1 €"); continue; }
      price = Math.min(price, Math.round(c.price * (1 + AUTO_MAX_RAISE_PCT / 100) * 100) / 100); // jeden przebieg nie podnosi ceny o więcej niż 20%
      if (c.rule.max !== null) price = Math.min(price, c.rule.max);
      if (price <= c.price + 0.004) continue;
    } else if (c.rule.autoMode !== "both") continue; // tryb "tylko podwyżki" nie obniża
    changes.push({ externalId: c.externalId, price, reason: `automat (${c.rule.autoMode === "both" ? "pełny" : "podwyżki"}): ${p.reason}` });
  }
  return { changes, skipped };
}
