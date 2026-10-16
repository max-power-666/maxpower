// Strategia cenowa "Do wystawienia" (16.10.2026) — czysta logika, bez sieci. Cel: MAKSYMALNA marża przy zachowaniu opłacalności i szansy na BuyBox.
//  - Dolna granica (floor) = najwyższa z "cen minimalnych" (zysk 20%) wśród sztuk z tym SKU — żadna sztuka nie schodzi poniżej celu.
//  - Górna granica (ceiling) = najwyższa z "cen maksymalnych" (zysk 25%) w grupie.
//  - Mamy BuyBox -> trzymamy cenę (nie obniżamy bez powodu); poniżej floor podnosimy (ostrzeżenie — możemy stracić BuyBox).
//  - Nie mamy BuyBox, cena do wygrania znana: schodzimy do ceny do wygrania (minus ewentualne undercut), ale NIGDY poniżej floor; gdy cena do wygrania jest poniżej floor — BuyBox jest
//    poza opłacalnością: ustawiamy floor i ostrzegamy (decyzję, czy walczyć dalej, podejmuje człowiek).
//  - Brak danych o BuyBox: cena w widełkach [floor, ceiling] zostaje, poza widełkami wracamy do najbliższej granicy; brak ceny oferty -> ceiling (start od góry).
export type StrategyInput = { floorEur: number; ceilingEur: number; currentEur: number | null; won: boolean | null; priceToWinEur: number | null; undercutEur: number };
export type StrategyAction = "hold" | "lower" | "raise";
export type StrategyResult = { targetEur: number; action: StrategyAction; reason: string; warning: string | null };

export function decidePrice(i: StrategyInput): StrategyResult {
  const floor = Math.ceil(i.floorEur);
  const ceiling = Math.max(floor, Math.ceil(i.ceilingEur));
  const cur = i.currentEur;
  const mk = (target: number, reason: string, warning: string | null = null): StrategyResult => {
    const t = Math.round(target);
    return { targetEur: t, action: cur === null ? "raise" : t > cur + 0.004 ? "raise" : t < cur - 0.004 ? "lower" : "hold", reason, warning };
  };
  if (cur === null) return mk(ceiling, "brak ceny w ofercie — start od górnej granicy widełek");
  if (i.won === true) {
    if (cur < floor) return mk(floor, "mamy BuyBox, ale cena jest poniżej dolnej granicy opłacalności", "Podniesienie ceny może odebrać BuyBox.");
    return mk(cur, "mamy BuyBox — trzymamy cenę");
  }
  if (i.won === false && i.priceToWinEur !== null) {
    const toWin = Math.floor(i.priceToWinEur - i.undercutEur);
    if (toWin < floor) return mk(floor, `cena do wygrania BuyBox (${i.priceToWinEur} €) jest poniżej dolnej granicy opłacalności (${floor} €)`, "Wygranie BuyBox przy tej cenie dałoby zysk poniżej celu — zostajemy przy dolnej granicy.");
    if (cur > toWin) return mk(toWin, `nasza cena jest wyższa niż cena do wygrania BuyBox (${i.priceToWinEur} €)`);
    return mk(cur, "cena jest już na poziomie ceny do wygrania BuyBox — bez zmiany");
  }
  if (cur < floor) return mk(floor, "cena jest poniżej dolnej granicy opłacalności", "Obecna cena daje zysk poniżej celu.");
  if (cur > ceiling) return mk(ceiling, "cena jest powyżej górnej granicy widełek (brak danych o BuyBox)");
  return mk(cur, "cena mieści się w widełkach — bez zmiany");
}
