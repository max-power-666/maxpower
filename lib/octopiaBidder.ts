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
