// Recoo Sklep: grupy zdjęć (21.10.2026, na prośbę właściciela — "zdjęcia będą się powtarzać: klasa A/B/C i pamięć 500 GB / 1 TB to to samo
// zdjęcie"). Stan to wariant w obrębie produktu (wspólna galeria już jest), a produkty różniące się tylko pojemnością dysku albo grą w zestawie
// dostają ten sam klucz grupy — zdjęcie wgrane do jednego produktu kopiujemy do pozostałych z grupy (ERP: edytor produktu; nowe produkty
// z "Odśwież oferty" dostają zdjęcia grupy automatycznie). Klucz liczony z nazwy produktu w sklepie:
//  - konsole: bez pojemności ("500 GB", "1 TB") i bez wszystkiego od " + " (gry w zestawie); kolor i edycja limitowana zostają,
//  - smartwatche: bez "Bluetooth" / "Bluetooth + Cellular" (wygląd ten sam), rozmiar i kolor zostają,
//  - aparaty i pozostałe: cała nazwa (inny obiektyw = inne zdjęcie).
export function imageGroupKey(name: string, category: string): string {
  let s = (name || "").normalize("NFC").trim();
  if (category === "konsole") {
    s = s.split(" + ")[0].replace(/\s\d+(?:[.,]\d+)?\s?(GB|TB)\b/gi, "");
  } else if (category === "smartwatche") {
    s = s.replace(/\bBluetooth(\s\+\sCellular)?\s?/gi, "");
  }
  return `${category}|${s.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

// Zdjęcia do dopisania produktowi: te z galerii źródłowej, których adresu jeszcze nie ma (kolejne kopiowanie niczego nie dubluje).
export type GroupImage = { url: string; storage_path: string | null; alt: string; option_value: string | null; position: number };
export function imagesToCopy(source: GroupImage[], target: { url: string; position: number }[]): GroupImage[] {
  const have = new Set(target.map((t) => t.url));
  let pos = target.reduce((m, t) => Math.max(m, t.position), -1);
  return [...source]
    .sort((a, b) => a.position - b.position)
    .filter((s) => !have.has(s.url))
    .map((s) => ({ ...s, position: ++pos }));
}
