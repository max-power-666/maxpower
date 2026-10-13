// Korekty RCP (13.10.2026): pole datetime-local w formularzu pokazuje i wysyła tylko minuty, a odcinki w bazie mają sekundy (rejestrowane zegarem serwera).
// Przy poprawie wpisu "Początek 15:09" szedł więc jako 15:09:00 i nakładał się o kilka sekund na poprzedni odcinek, który kończył się o 15:09:05
// ("Ten czas nakłada się na inny wpis tej osoby"). Dlatego (1) nakładanie liczymy na pełnych minutach, (2) wartość niezmieniona z dokładnością do minuty
// zostaje z oryginalnymi sekundami (nie jest "zmianą" i nie trafia do historii).
export const floorMinute = (ms: number): number => Math.floor(ms / 60_000) * 60_000;

// Czy [s, e) nakłada się na [os, oe) — na pełnych minutach; e/oe = Infinity dla trwającego odcinka.
export function overlapsByMinute(s: number, e: number, os: number, oe: number): boolean {
  const fl = (v: number) => (Number.isFinite(v) ? floorMinute(v) : v);
  return fl(os) < fl(e) && fl(oe) > fl(s);
}

// Wartość z formularza vs aktualna w bazie: gdy różnią się tylko sekundami, zachowujemy oryginał.
export function keepIfSameMinute(sentIso: string, currentIso: string | null): string {
  if (!currentIso) return sentIso;
  return floorMinute(Date.parse(sentIso)) === floorMinute(Date.parse(currentIso)) ? new Date(currentIso).toISOString() : sentIso;
}
