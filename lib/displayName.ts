// Skrócona forma imienia i nazwiska do logów i list ("Maksymilian Jonkisz" -> "Maksymilian J.").
// Pełne imię i nazwisko (members.name) ustawia Admin w Zespole; dopóki go nie ma, pokazujemy e-mail.

export type MemberLite = { email: string; name?: string | null };

export function shortName(fullName: string | null | undefined): string {
  if (!fullName) return "";
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

// Imię + pierwsze `letters` liter nazwiska ("Jakub Szymoniak", 2 -> "Jakub Sz."); gdy nazwisko jest krótsze, całe nazwisko bez kropki.
function shortNameWithLetters(fullName: string, letters: number): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  const last = parts[parts.length - 1];
  return last.length <= letters ? `${parts[0]} ${last}` : `${parts[0]} ${last.slice(0, letters)}.`;
}

// Skrócone imię do list i logów. Gdy dwie osoby miałyby to samo skrócenie ("Jakub S."), dokładamy kolejne litery nazwiska, aż się rozróżnią
// ("Jakub Sk." i "Jakub Sz.") — porównanie z `members` (listą przekazywaną przez wywołującego, bez rozróżniania wielkości liter).
export function displayNameForEmail(email: string | null | undefined, members: MemberLite[]): string {
  if (!email) return "—";
  const m = members.find((x) => x.email === email);
  const base = shortName(m?.name);
  if (!m || !m.name || !base) return base || email;
  const key = (v: string) => v.toLowerCase();
  const rivals = members.filter((x) => x.email !== email && x.name && key(shortName(x.name)) === key(base));
  if (rivals.length === 0) return base;
  const surnameLen = m.name.trim().split(/\s+/).pop()!.length;
  for (let n = 2; n <= surnameLen; n++) {
    const cand = shortNameWithLetters(m.name, n);
    if (!rivals.some((r) => key(shortNameWithLetters(r.name!, n)) === key(cand))) return cand;
  }
  return m.name.trim(); // identyczne nazwiska — pełne imię i nazwisko
}
