// Motyw kolorystyczny UI — dwa warianty (Nowy = jasny, Tryb nocny = ciemny) przełączane atrybutem data-theme na
// <html> (CSS zmienne w globals.css), bez zmiany układu ekranów. Domyślnie AUTOMATYCZNIE wg pory dnia (21:00–5:00
// = ciemny) — dopóki ktoś ręcznie nie przełączy switcha, wtedy zapamiętujemy jawny wybór w localStorage (per
// przeglądarkę/stanowisko, nie w bazie — ten sam wzorzec co magazyn-view/shipping-direct-print) i on ma pierwszeństwo
// przed zegarem, aż do kolejnego ręcznego przełączenia.
export const THEME_STORAGE_KEY = "erp-theme";
export const THEMES = ["new", "dark"] as const;
export type Theme = (typeof THEMES)[number];

const NIGHT_START_HOUR = 21; // 21:00
const NIGHT_END_HOUR = 5; // 5:00

export function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

// Automatyczny motyw wg aktualnej godziny (lokalny czas przeglądarki) — używany, dopóki nikt nie wybrał ręcznie.
export function autoTheme(now: Date = new Date()): Theme {
  const h = now.getHours();
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR ? "dark" : "new";
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

// null = brak jawnego wyboru (tryb automatyczny wg zegara).
export function loadStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage niedostępny (np. tryb prywatny) — wybór po prostu nie przetrwa odświeżenia
  }
}
