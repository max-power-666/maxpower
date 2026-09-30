"use client";

import { useEffect, useState } from "react";
import { applyTheme, loadStoredTheme, saveTheme, THEMES, THEME_LABELS, type Theme } from "@/lib/theme";

// Przełącznik motywu kolorystycznego (Obecny / Nowy / Tryb nocny) — sama kolorystyka (CSS zmienne w globals.css),
// układ ekranów bez zmian. Pokazywany na ekranie logowania i w stopce paska bocznego, żeby był dostępny zarówno
// przed, jak i po zalogowaniu (localStorage przetrwa między nimi, więc wybór sprzed logowania też się utrzyma).
export default function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>("default");

  useEffect(() => {
    setTheme(loadStoredTheme());
  }, []);

  function pick(t: Theme) {
    setTheme(t);
    saveTheme(t);
    applyTheme(t);
  }

  return (
    <div className={compact ? "flex flex-col gap-1" : "flex flex-col items-center gap-1.5"}>
      {!compact && <div className="text-[11px] text-inksoft uppercase tracking-wide">Wygląd</div>}
      <div className={`flex gap-1 ${compact ? "flex-col" : ""}`}>
        {THEMES.map((t) => (
          <button
            key={t}
            onClick={() => pick(t)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              theme === t ? "bg-ink text-paper border-ink" : "bg-white border-line text-inksoft hover:text-ink"
            }`}
          >
            {THEME_LABELS[t]}
          </button>
        ))}
      </div>
    </div>
  );
}
