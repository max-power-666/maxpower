"use client";

import { useRef, useState } from "react";

// Pole tekstowe edytowane wprost w wierszu listy (uwagi, numer seryjny). Zapisuje przy wyjściu z pola
// lub Enterem, tylko jeśli tekst faktycznie się zmienił; Escape porzuca zmianę.
export default function InlineEditCell({
  value,
  onSave,
  placeholder = "Dodaj uwagę",
  className = "w-56",
}: {
  value: string | null;
  onSave: (next: string | null) => void;
  placeholder?: string;
  className?: string;
}) {
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
      placeholder={placeholder}
      className={`${className} border border-transparent hover:border-line focus:border-line bg-transparent focus:bg-white px-2 py-1 rounded text-sm`}
    />
  );
}
