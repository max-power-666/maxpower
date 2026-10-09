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

/* ---------------- załączniki ---------------- */

export const BACKLOG_BUCKET = "backlog-attachments";
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // tyle samo co limit bucketu w backlog.sql
export const MAX_ATTACHMENTS_PER_ITEM = 10;

// Te same typy co w bucketcie (backlog.sql) — sprawdzamy je przed wysłaniem, żeby błąd był czytelny.
export const ALLOWED_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
export const ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_TYPES.join(",");

export const isImageType = (mime: string | null | undefined) => !!mime && mime.startsWith("image/");

export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Nazwa do ścieżki w Storage: tylko bezpieczne znaki (polskie litery i spacje zamieniamy), z zachowanym rozszerzeniem.
export function safeFileName(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "plik").slice(-80);
}

// Wklejone ze schowka zrzuty ekranu mają nazwę "image.png" — nadajemy czytelną, z datą.
export function pastedFileName(file: File, now: Date = new Date()): string {
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const p = (n: number) => String(n).padStart(2, "0");
  return `zrzut-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}

// Zwraca listę problemów (pusta = wszystko w porządku). `existing` to liczba już dodanych załączników zadania.
export function validateAttachments(files: { name: string; size: number; type: string }[], existing: number): string[] {
  const problems: string[] = [];
  if (existing + files.length > MAX_ATTACHMENTS_PER_ITEM) {
    problems.push(`Do zadania można dodać maksymalnie ${MAX_ATTACHMENTS_PER_ITEM} załączników.`);
  }
  for (const f of files) {
    if (f.size > MAX_ATTACHMENT_BYTES) problems.push(`„${f.name}” jest za duży (${formatSize(f.size)}, limit ${formatSize(MAX_ATTACHMENT_BYTES)}).`);
    else if (!ALLOWED_ATTACHMENT_TYPES.includes(f.type)) problems.push(`„${f.name}”: ten typ pliku nie jest obsługiwany (dozwolone: obrazy, PDF, TXT, CSV, DOCX, XLSX).`);
  }
  return problems;
}

/* ---------------- uproszczony Backlog: wiadomości (10.10.2026) ---------------- */

const TITLE_MAX = 150;

// Wiadomość -> pola tabeli: title = pierwsza linia (do 150 znaków), description = pełna treść, gdy jest dłuższa niż tytuł (kilka linii albo ucięta); w przeciwnym razie pusta.
export function messageToFields(message: string): { title: string; description: string } {
  const text = message.trim();
  const firstLine = text.split(/\r?\n/)[0].trim();
  const title = firstLine.length > TITLE_MAX ? firstLine.slice(0, TITLE_MAX - 1).trimEnd() + "…" : firstLine;
  return { title, description: text === title ? "" : text };
}

// Treść do wyświetlenia: nowe wiadomości (opis zaczyna się od tytułu albo go nie ma) -> sama treść bez nagłówka; stare zadania z osobnym tytułem i opisem -> tytuł (pogrubiony) + opis.
export function backlogMessage(item: { title: string; description: string }): { head: string; body: string } {
  const title = item.title ?? "";
  const description = item.description ?? "";
  if (!description) return { head: "", body: title };
  const stem = title.replace(/…$/, "");
  if (description.startsWith(stem)) return { head: "", body: description };
  return { head: title, body: description };
}
