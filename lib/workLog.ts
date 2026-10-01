// Wspólne dla rejestrów pracy z Regulaminu premiowania (Serwis, Trade-in):
// interwały podsumowania punktacji i czas trwania czynności (tylko informacyjny).

export type Interval = "today" | "week" | "month";

export const INTERVALS: { key: Interval; label: string }[] = [
  { key: "today", label: "Dziś" },
  { key: "week", label: "Ostatnie 7 dni" },
  { key: "month", label: "Ostatnie 30 dni" },
];

export function rangeStart(interval: Interval): string {
  const d = new Date();
  if (interval === "today") {
    d.setHours(0, 0, 0, 0);
  } else if (interval === "week") {
    d.setDate(d.getDate() - 7);
  } else {
    d.setDate(d.getDate() - 30);
  }
  return d.toISOString();
}

export function fmtDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return "w trakcie";
  const ms = Date.parse(endIso) - Date.parse(startIso);
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} godz. ${m} min` : `${m} min`;
}

// Etykiety typów czynności i statusów — jedno źródło prawdy dla list (Serwis, Testy, Trade-in)
// i karty produktu, żeby log nigdy nie rozjechał się z tym, co widać w tabelach.

export const SERVICE_TASKS = [
  { key: "joycon_pair", label: "Joy-Con, para (Nintendo Switch)", points: 15 },
  { key: "ps4_controller", label: "Kontroler PS4", points: 25 },
  { key: "xbox_controller", label: "Kontroler Xbox One / Xbox One X", points: 35 },
  { key: "ps5_controller", label: "Kontroler PS5 (DualSense)", points: 12 },
  { key: "console_cleaning", label: "Czyszczenie konsoli", points: 45 },
] as const;

export const SERVICE_STATUSES = [
  { key: "w_naprawie", label: "W naprawie" },
  { key: "naprawiony", label: "Naprawiony" },
  { key: "uszkodzony", label: "Uszkodzony" },
] as const;

export const TEST_STATUSES = [
  { key: "w_trakcie", label: "W trakcie" },
  { key: "przetestowane", label: "Przetestowane" },
  { key: "przerwany", label: "Przerwany" },
] as const;

// Rodzaj testu (01.10.2026) — skąd/czemu urządzenie trafiło do testu, wybierane przy rozpoczęciu.
export const TEST_KINDS = [
  { key: "po_dostawie", label: "Po dostawie" },
  { key: "po_serwisie", label: "Po serwisie" },
  { key: "ponowny_z_magazynu", label: "Ponowny test z magazynu" },
  { key: "olx", label: "OLX" },
  { key: "allegro", label: "Allegro" },
  { key: "vinted", label: "Vinted" },
] as const;

// Wynik testu (01.10.2026) — stan urządzenia ustalony podczas testu; niezależny od statusu
// cyklu życia testu (w_trakcie/przetestowane/przerwany) i od punktów (Regulamin §2 ust. 4 —
// punkty liczą się za prawidłowo zakończony test, niezależnie od tego, co test wykazał).
export const TEST_RESULTS = [
  { key: "sprawny", label: "Sprawny" },
  { key: "serwis", label: "Serwis" },
  { key: "rma", label: "RMA" },
  { key: "do_poprawy", label: "Do poprawy" },
  { key: "outlet", label: "Outlet" },
] as const;

export const INTAKE_STATUSES = [
  { key: "w_trakcie", label: "W trakcie" },
  { key: "obsluzona", label: "Obsłużona" },
  { key: "kontroferta", label: "Kontroferta" },
  { key: "ok_dok", label: "Ok. Dok." },
  { key: "problem", label: "Problem" },
] as const;

export function labelFor(list: readonly { key: string; label: string }[], key: string): string {
  return list.find((x) => x.key === key)?.label ?? key;
}
