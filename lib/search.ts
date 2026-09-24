// Wzorzec dla ilike: % i \\ wycinamy, _ zamieniamy na literalne — w LIKE to znaki specjalne.
// Bez dodanych % daje porównanie bez rozróżniania wielkości liter (dokładne dopasowanie numeru).
export function escapeLike(v: string): string {
  return v.replace(/[\\%]/g, "").replace(/_/g, "\\_");
}
