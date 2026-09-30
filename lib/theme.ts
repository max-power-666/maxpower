// Motyw kolorystyczny UI — trzy warianty przełączane atrybutem data-theme na <html> (CSS zmienne w globals.css),
// bez zmiany układu ekranów. Wybór zapisany w localStorage (per przeglądarkę/stanowisko, nie w bazie — ten sam
// wzorzec co magazyn-view/shipping-direct-print).
export const THEME_STORAGE_KEY = "erp-theme";
export const THEMES = ["default", "new", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  default: "Obecny",
  new: "Nowy",
  dark: "Tryb nocny",
};

export function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

export function loadStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(v) ? v : "default";
  } catch {
    return "default";
  }
}

export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage niedostępny (np. tryb prywatny) — motyw po prostu nie przetrwa odświeżenia
  }
}
