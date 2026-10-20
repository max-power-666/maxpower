// Zamówienia -> Zapotrzebowanie (08.10.2026): statusy i numer zlecenia. Tabela service_requests, patrz supabase/service-requests.sql.
export const REQUEST_STATUSES = [
  { key: "nowe", label: "Nowe" },
  { key: "przyjete", label: "Przyjęte" },
  { key: "w_realizacji", label: "W realizacji" },
  { key: "zrobione", label: "Zrobione" },
  { key: "odrzucone", label: "Odrzucone" },
  { key: "brak_w_serwisie", label: "Brak w serwisie" },
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number]["key"];
export const REQUEST_STATUS_LABEL = Object.fromEntries(REQUEST_STATUSES.map((s) => [s.key, s.label])) as Record<RequestStatus, string>;
// Statusy zamknięte odmownie (15.10.2026): "Brak w serwisie" (serwis nie ma żądanej rzeczy) trafia do widoku "Odrzucone" razem z "Odrzucone"; etykieta zostaje własna.
export const REJECTED_REQUEST_STATUSES: RequestStatus[] = ["odrzucone", "brak_w_serwisie"];
// Statusy "do zrobienia" — pokazywane domyślnie ("Aktywne").
export const ACTIVE_REQUEST_STATUSES: RequestStatus[] = ["nowe", "przyjete", "w_realizacji"];
export const REQUEST_PRIORITIES = [
  { key: "wysoki", label: "Wysoki", rank: 0 },
  { key: "sredni", label: "Średni", rank: 1 },
  { key: "niski", label: "Niski", rank: 2 },
] as const;
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number]["key"];
export const REQUEST_PRIORITY_LABEL = Object.fromEntries(REQUEST_PRIORITIES.map((p) => [p.key, p.label])) as Record<RequestPriority, string>;
export const REQUEST_PRIORITY_RANK = Object.fromEntries(REQUEST_PRIORITIES.map((p) => [p.key, p.rank])) as Record<RequestPriority, number>;
export const requestCode = (id: number) => `ZAP-${id}`;
// Role serwisantów (przyjmują zlecenia i zmieniają status) — lustro is_service_staff() w bazie.
export const SERVICE_STAFF_ROLES = ["Admin", "Manager", "Księgowa", "Serwis", "Kierownik serwisu"];
// Edycja treści i priorytetu (13.10.2026) — lustro service_requests_guard w bazie: Admin i Manager zawsze; autor własnego zlecenia, dopóki jest aktywne;
// role realizujące zlecenia (Serwis, Kierownik serwisu) nie edytują, nawet własnych.
// Usuwanie zleceń (13.10.2026 hurtowe; od 15.10.2026 "miękkie" — widok "Usunięte" z możliwością przywrócenia) — lustro can_delete_service_requests() w bazie:
// Admin, Kierownik serwisu i Zamówienia. Wiersz dostaje deleted_at/deleted_by_email (ustawia trigger), nie jest kasowany.
export const REQUEST_DELETE_ROLES = ["Admin", "Kierownik serwisu", "Zamówienia"];
export const REQUEST_EDITOR_ROLES = ["Admin", "Manager", "Księgowa"];
export const REQUEST_NO_EDIT_ROLES = ["Serwis", "Kierownik serwisu"];
export function canEditRequest(role: string, isAuthor: boolean, status: RequestStatus): boolean {
  if (REQUEST_EDITOR_ROLES.includes(role)) return true;
  if (REQUEST_NO_EDIT_ROLES.includes(role)) return false;
  return isAuthor && ACTIVE_REQUEST_STATUSES.includes(status);
}
