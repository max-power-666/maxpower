// Serwis -> Zapotrzebowanie (08.10.2026): statusy i numer zlecenia. Tabela service_requests, patrz supabase/service-requests.sql.
export const REQUEST_STATUSES = [
  { key: "nowe", label: "Nowe" },
  { key: "przyjete", label: "Przyjęte" },
  { key: "w_realizacji", label: "W realizacji" },
  { key: "zrobione", label: "Zrobione" },
  { key: "odrzucone", label: "Odrzucone" },
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number]["key"];
export const REQUEST_STATUS_LABEL = Object.fromEntries(REQUEST_STATUSES.map((s) => [s.key, s.label])) as Record<RequestStatus, string>;
// Statusy "do zrobienia" — pokazywane domyślnie ("Aktywne").
export const ACTIVE_REQUEST_STATUSES: RequestStatus[] = ["nowe", "przyjete", "w_realizacji"];
export const requestCode = (id: number) => `ZAP-${id}`;
// Role serwisantów (przyjmują zlecenia i zmieniają status) — lustro is_service_staff() w bazie.
export const SERVICE_STAFF_ROLES = ["Admin", "Manager", "Serwis", "Kierownik serwisu"];
