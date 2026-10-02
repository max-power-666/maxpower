// Kolory osób w tabelach (01.10.2026, wybrane przez właściciela po imieniu) — jasne/pastelowe,
// żeby nie gryzły się z plakietkami statusów. Jedno źródło dla Trade-in (tło wiersza) i Testów
// (plakietka w kolumnie Pracownik). Osoba spoza listy nie ma koloru.
export const COLOR_BY_EMAIL: Record<string, string> = {
  "zuzanna.recoo@gmail.com": "#fde3ec", // Zuzanna — jasny różowy
  "jakubszy.recoo@gmail.com": "#e3f2fd", // Kuba Szymoniak — jasny niebieski
  "jakubgola.recoo@gmail.com": "#f0e3fd", // Kuba Gola — jasny fioletowy
  "adrian.recoo@gmail.com": "#fef6d8", // Adrian — jasny żółty
};

export function colorForUser(email: string | null): string | undefined {
  if (!email) return undefined;
  return COLOR_BY_EMAIL[email.toLowerCase()];
}
