// Hurtowa zmiana ceny max w Bidderze (03.10.2026) — czysta logika planu zmian, osobno od UI, żeby dało się ją przetestować.

export function parseDelta(raw: string): number | null {
  const n = Number(raw.trim().replace(",", ".").replace(/^\+/, ""));
  return raw.trim() !== "" && Number.isFinite(n) && n !== 0 ? Math.round(n * 100) / 100 : null;
}

export type BulkRow = { sku: string; max_price: number | string | null };

// Nowa cena max = obecna + delta (delta może być ujemna). Pomijamy: SKU bez ceny max (nie ma do czego dodać), takie, którym
// wyszłoby <= 0, i takie z niezapisaną edycją w wierszu (draft różny od zapisanej ceny) — żeby nie zmieniać tego, czego
// użytkownik w tym momencie nie widzi.
export function planBulkChange(rows: BulkRow[], delta: number, drafts: Record<string, string>) {
  const plan: { sku: string; from: number; to: number }[] = [];
  let noMax = 0;
  let tooLow = 0;
  let unsaved = 0;
  for (const s of rows) {
    if (drafts[s.sku] !== undefined && drafts[s.sku] !== String(s.max_price ?? "")) { unsaved++; continue; }
    if (!(Number(s.max_price) > 0)) { noMax++; continue; }
    const to = Math.round((Number(s.max_price) + delta) * 100) / 100;
    if (to <= 0) { tooLow++; continue; }
    plan.push({ sku: s.sku, from: Number(s.max_price), to });
  }
  return { plan, noMax, tooLow, unsaved };
}
