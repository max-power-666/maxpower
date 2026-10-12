// Motyw kolorystyczny UI — dwa warianty (Nowy = jasny, Tryb nocny = ciemny) przełączane atrybutem data-theme na
// <html> (CSS zmienne w globals.css), bez zmiany układu ekranów. Domyślnie AUTOMATYCZNIE wg pory dnia (21:00–5:00
// = ciemny). Ręczne przełączenie switcha obowiązuje TYLKO do najbliższej zmiany pory (5:00 albo 21:00, czas lokalny
// przeglądarki), potem automat wraca — wcześniej wybór zapisywał się na stałe i raz kliknięty switch wyłączał
// automatykę już na zawsze (12.10.2026, zgłoszone: "nie działa przełączanie na tryb nocny"). Zapis jest per
// przeglądarka/stanowisko w localStorage (nie w bazie), ten sam wzorzec co magazyn-view/shipping-direct-print.
// Skrypt startowy w app/layout.tsx (THEME_INIT_SCRIPT) powtarza tę logikę — zmieniając jedno, zmień drugie.
export const THEME_STORAGE_KEY = "erp-theme-override"; // {"t":"dark","until":<ms>}
export const LEGACY_THEME_KEY = "erp-theme"; // stary, "wieczny" wybór — ignorowany i czyszczony
export const THEMES = ["new", "dark"] as const;
export type Theme = (typeof THEMES)[number];

const NIGHT_START_HOUR = 21; // 21:00
const NIGHT_END_HOUR = 5; // 5:00

export function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

// Automatyczny motyw wg aktualnej godziny (lokalny czas przeglądarki).
export function autoTheme(now: Date = new Date()): Theme {
  const h = now.getHours();
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR ? "dark" : "new";
}

// Najbliższa chwila (ścisłe > now), w której automat zmienia motyw: 5:00 albo 21:00 czasu lokalnego.
export function nextThemeBoundary(now: Date = new Date()): Date {
  for (let d = 0; d <= 1; d++) {
    for (const h of [NIGHT_END_HOUR, NIGHT_START_HOUR]) {
      const c = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, h, 0, 0, 0);
      if (c.getTime() > now.getTime()) return c;
    }
  }
  return new Date(now.getTime() + 24 * 3600 * 1000); // nieosiągalne
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

// Ręczny wybór, o ile jeszcze obowiązuje; null = tryb automatyczny wg zegara.
export function loadOverride(now: number = Date.now()): { theme: Theme; until: number } | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v && isTheme(v.t) && typeof v.until === "number" && v.until > now) return { theme: v.t, until: v.until };
    localStorage.removeItem(THEME_STORAGE_KEY); // wygasł albo uszkodzony
  } catch {
    // localStorage niedostępny albo zły JSON — traktujemy jak brak wyboru
  }
  return null;
}

// Motyw wynikający z ręcznego wyboru (jeśli ważny) albo z zegara.
export function effectiveTheme(now: Date = new Date()): { theme: Theme; manual: boolean; until: number | null } {
  const o = loadOverride(now.getTime());
  return o ? { theme: o.theme, manual: true, until: o.until } : { theme: autoTheme(now), manual: false, until: null };
}

// Zapamiętuje ręczny wybór do najbliższej zmiany pory. Gdy wybrany motyw i tak jest tym, który da automat,
// nie ma czego pamiętać — zwracamy się do trybu automatycznego.
export function saveOverride(theme: Theme, now: Date = new Date()): number | null {
  try {
    localStorage.removeItem(LEGACY_THEME_KEY);
    if (theme === autoTheme(now)) {
      localStorage.removeItem(THEME_STORAGE_KEY);
      return null;
    }
    const until = nextThemeBoundary(now).getTime();
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ t: theme, until }));
    return until;
  } catch {
    return null; // wybór po prostu nie przetrwa odświeżenia
  }
}
