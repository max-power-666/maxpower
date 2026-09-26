// Backlog: wspólne stałe (typy, priorytety, statusy, obszary) i etykiety — jedno źródło dla listy, karty i logu zmian.

export const BACKLOG_TYPES = [
  { key: "feature", label: "Funkcja" },
  { key: "improvement", label: "Usprawnienie" },
  { key: "bug", label: "Błąd" },
  { key: "task", label: "Zadanie" },
] as const;

// p1 = najpilniejsze. Etykiety jak w przykładzie zespołu (P1/P2/P3), z opisem.
export const BACKLOG_PRIORITIES = [
  { key: "p1", label: "P1 · Pilne" },
  { key: "p2", label: "P2 · Ważne" },
  { key: "p3", label: "P3 · Kiedyś" },
] as const;

export const BACKLOG_STATUSES = [
  { key: "backlog", label: "Backlog" },
  { key: "todo", label: "Do zrobienia" },
  { key: "in_progress", label: "W toku" },
  { key: "review", label: "Do sprawdzenia" },
  { key: "done", label: "Zrobione" },
] as const;

// Moduły aplikacji, których może dotyczyć zadanie. Lista tylko w kodzie — nowy obszar nie wymaga zmian w bazie.
export const BACKLOG_AREAS = [
  "Magazyn",
  "Zamówienia",
  "Trade-in",
  "Bidder",
  "Serwis",
  "Testy",
  "Zespół",
  "Wysyłka",
  "Inne",
] as const;

export type BacklogType = (typeof BACKLOG_TYPES)[number]["key"];
export type BacklogPriority = (typeof BACKLOG_PRIORITIES)[number]["key"];
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number]["key"];

export const backlogLabel = (list: readonly { key: string; label: string }[], key: string) => list.find((x) => x.key === key)?.label ?? key;

// Kolejność na liście: aktywne przed zrobionymi, potem priorytet (P1 najpierw), potem od najnowszych.
export function compareBacklog(
  a: { status: string; priority: string; created_at: string },
  b: { status: string; priority: string; created_at: string }
): number {
  const doneA = a.status === "done" ? 1 : 0;
  const doneB = b.status === "done" ? 1 : 0;
  if (doneA !== doneB) return doneA - doneB;
  if (a.priority !== b.priority) return a.priority < b.priority ? -1 : 1;
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

export const backlogCode = (id: number) => `ZAD-${id}`;
