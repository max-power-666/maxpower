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

export function displayNameForEmail(email: string | null | undefined, members: MemberLite[]): string {
  if (!email) return "—";
  const m = members.find((x) => x.email === email);
  return shortName(m?.name) || email;
}
