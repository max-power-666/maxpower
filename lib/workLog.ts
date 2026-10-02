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

// Punkty wg Regulaminu premiowania z 12.10.2026 (tabela §2 ust. 6, zaktualizowana 01.10.2026):
// czyszczenie konsoli obniżone z 45 do 40 pkt, doszły "Kontroler Xbox Series S/X" (25 pkt) i
// "Trudne konsole" (60 pkt, czynności serwisowe wymagające zaawansowanych napraw, czas
// normatywny 60 min). Stare wpisy w service_log zachowują swoją migawkę punktów sprzed zmiany.
export const SERVICE_TASKS = [
  { key: "joycon_pair", label: "Joy-Con, para (Nintendo Switch)", points: 15 },
  { key: "ps4_controller", label: "Kontroler PS4", points: 25 },
  { key: "xbox_controller", label: "Kontroler Xbox One / Xbox One X", points: 35 },
  { key: "xbox_series_controller", label: "Kontroler Xbox Series S/X", points: 25 },
  { key: "ps5_controller", label: "Kontroler PS5 (DualSense)", points: 12 },
  { key: "console_cleaning", label: "Czyszczenie konsoli", points: 40 },
  { key: "difficult_console", label: "Trudne konsole", points: 60 },
] as const;

export const SERVICE_STATUSES = [
  { key: "w_naprawie", label: "W naprawie" },
  { key: "oczekuje_na_czesci", label: "Oczekuje na części" },
  { key: "naprawiony", label: "Naprawiony" },
  { key: "uszkodzony", label: "Uszkodzony" },
] as const;

// Statusy, które NIE są zakończeniem naprawy (finished_at zostaje null, praca jest tylko
// wstrzymana, nie skończona) — "w_naprawie" i "oczekuje_na_czesci" (01.10.2026).
export const SERVICE_ACTIVE_STATUSES: string[] = ["w_naprawie", "oczekuje_na_czesci"];

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

// Kolory plakietek w Testach (kolumny Rodzaj testu / Wynik, 02.10.2026) — para tło/tekst, jasne
// pastele jak plakietki marketplace'ów (stała paleta niezależna od motywu).
export const TEST_KIND_COLORS: Record<string, { bg: string; fg: string }> = {
  po_dostawie: { bg: "#e3ecf9", fg: "#2a6bb5" },
  po_serwisie: { bg: "#e6e6fb", fg: "#4c4fc4" },
  ponowny_z_magazynu: { bg: "#e9ecef", fg: "#4b5563" },
  olx: { bg: "#d6f1ee", fg: "#0f766e" },
  allegro: { bg: "#fde8d7", fg: "#c2570c" },
  vinted: { bg: "#fde3ec", fg: "#b4235f" },
};

export const TEST_RESULT_COLORS: Record<string, { bg: string; fg: string }> = {
  sprawny: { bg: "#dff3e3", fg: "#1f7a3a" },
  serwis: { bg: "#f0e3fd", fg: "#7a3fb5" },
  rma: { bg: "#fde1e1", fg: "#b42318" },
  do_poprawy: { bg: "#fef6d8", fg: "#8a6d00" },
  outlet: { bg: "#dcf1fb", fg: "#0b6a8f" },
};
