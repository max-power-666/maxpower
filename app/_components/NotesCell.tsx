"use client";

import { useRef, useState } from "react";

// Pole uwag edytowane wprost w wierszu listy (Serwis, Testy, Trade-in). Zapisuje przy wyjściu z pola
// lub Enterem, tylko jeśli tekst faktycznie się zmienił; Escape porzuca zmianę.
export default function NotesCell({ value, onSave }: { value: string | null; onSave: (next: string | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const current = value ?? "";

  function commit() {
    const next = (draft ?? current).trim();
    const skip = cancelled.current;
    cancelled.current = false;
    setDraft(null);
    if (skip || next === current.trim()) return;
    onSave(next || null);
  }

  return (
    <input
      value={draft ?? current}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      placeholder="Dodaj uwagę"
      className="w-56 border border-transparent hover:border-line focus:border-line bg-transparent focus:bg-white px-2 py-1 rounded text-sm"
    />
  );
}
