"use client";

import { useEffect, useState } from "react";
import { applyTheme, effectiveTheme, saveOverride, type Theme } from "@/lib/theme";

// Switch Nowy (jasny, słońce) / Tryb nocny (ciemny, księżyc) — sama kolorystyka, układ ekranów bez zmian.
// Bez ręcznego wyboru motyw idzie automatycznie wg zegara: ciemny 21:00–5:00, jasny poza tym. Ręczne kliknięcie
// obowiązuje tylko do najbliższej zmiany pory (patrz lib/theme.ts), potem automat wraca sam. Stan sprawdzamy co
// minutę oraz przy powrocie do karty (uśpiony komputer/karta w tle nie odpala timerów na czas). Pokazywany na
// ekranie logowania i w stopce paska bocznego (patrz page.tsx).
export default function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>("new");
  const [manualUntil, setManualUntil] = useState<number | null>(null);

  useEffect(() => {
    function sync() {
      const e = effectiveTheme();
      setTheme(e.theme);
      setManualUntil(e.until);
      applyTheme(e.theme);
    }
    sync();
    const id = setInterval(sync, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", sync);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", sync);
    };
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "new" : "dark";
    const until = saveOverride(next);
    setTheme(next);
    setManualUntil(until);
    applyTheme(next);
  }

  const isDark = theme === "dark";
  const status = manualUntil
    ? `wybór ręczny do ${new Date(manualUntil).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}, potem automat`
    : "automatycznie wg pory dnia (21:00–5:00 ciemny)";

  return (
    <button
      onClick={toggle}
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? "Przełącz na motyw jasny" : "Przełącz na tryb nocny"}
      title={`${isDark ? "Tryb nocny" : "Nowy (jasny)"} — ${status}`}
      className="inline-flex items-center gap-1.5 px-1.5 py-1 rounded-full border border-line bg-white"
    >
      <SunIcon active={!isDark} />
      <span className={`relative w-9 h-5 rounded-full transition-colors ${isDark ? "bg-ink" : "bg-line"}`}>
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            isDark ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
      <MoonIcon active={isDark} />
    </button>
  );
}

function SunIcon({ active }: { active: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className={active ? "text-amber" : "text-inksoft opacity-40"}>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 2v2" />
        <path d="M12 20v2" />
        <path d="M4.93 4.93l1.41 1.41" />
        <path d="M17.66 17.66l1.41 1.41" />
        <path d="M2 12h2" />
        <path d="M20 12h2" />
        <path d="M4.93 19.07l1.41-1.41" />
        <path d="M17.66 6.34l1.41-1.41" />
      </g>
    </svg>
  );
}

function MoonIcon({ active }: { active: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className={active ? "text-teal" : "text-inksoft opacity-40"}>
      <path
        d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
