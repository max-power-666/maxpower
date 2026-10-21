// Kolory osób w tabelach (01.10.2026, wybrane przez właściciela po imieniu) — jasne/pastelowe,
// żeby nie gryzły się z plakietkami statusów. Kolory to zmienne CSS (app/globals.css), więc w trybie nocnym
// tło jest ciemne, a tekst zostaje czytelny (21.10.2026 — wcześniej jasne tło przy jasnym tekście trybu nocnego). Jedno źródło dla Trade-in (tło wiersza) i Testów
// (plakietka w kolumnie Pracownik). Osoba spoza listy nie ma koloru.
export const COLOR_BY_EMAIL: Record<string, string> = {
  "zuzanna.recoo@gmail.com": "var(--user-pink)", // Zuzanna — jasny różowy
  "jakubszy.recoo@gmail.com": "var(--user-blue)", // Kuba Szymoniak — jasny niebieski
  "jakubgola.recoo@gmail.com": "var(--user-purple)", // Kuba Gola — jasny fioletowy
  "adrian.recoo@gmail.com": "var(--user-yellow)", // Adrian — jasny żółty
};

export function colorForUser(email: string | null): string | undefined {
  if (!email) return undefined;
  return COLOR_BY_EMAIL[email.toLowerCase()];
}
