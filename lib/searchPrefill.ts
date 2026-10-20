"use client";

import { useEffect } from "react";

// Wyszukiwarka globalna (20.10.2026): kliknięcie wyniku przenosi do widoku z wpisaną frazą w jego własnej wyszukiwarce. Fraza leży w sessionStorage pod kluczem widoku
// i jest zużywana przy montowaniu widoku (takePrefill) albo — gdy widok jest już otwarty — przez zdarzenie "search-prefill" (usePrefillListener).
const KEY = (view: string) => `search-prefill:${view}`;

export function setPrefill(view: string, q: string): void {
  try {
    sessionStorage.setItem(KEY(view), q);
  } catch {
    /* brak sessionStorage */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("search-prefill", { detail: { view } }));
}

export function takePrefill(view: string): string {
  try {
    const v = sessionStorage.getItem(KEY(view));
    if (v !== null) sessionStorage.removeItem(KEY(view));
    return v ?? "";
  } catch {
    return "";
  }
}

// Gdy widok jest już zamontowany, a wyszukiwarka globalna wpisze mu frazę — odbieramy ją tu.
export function usePrefillListener(view: string, apply: (q: string) => void): void {
  useEffect(() => {
    const onEvt = (e: Event) => {
      if ((e as CustomEvent).detail?.view !== view) return;
      const q = takePrefill(view);
      if (q) apply(q);
    };
    window.addEventListener("search-prefill", onEvt);
    return () => window.removeEventListener("search-prefill", onEvt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
}
