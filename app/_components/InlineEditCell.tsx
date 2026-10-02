"use client";

import { useEffect, useRef, useState } from "react";

// Pole tekstowe edytowane wprost w wierszu listy (uwagi, numer seryjny). Zapisuje przy wyjściu z pola
// lub Enterem, tylko jeśli tekst faktycznie się zmienił; Escape porzuca zmianę.
// `multiline` (01.10.2026, Serwis -> Uwagi): zamiast jednowierszowego inputa, który obcina długi
// tekst, renderuje textarea zawijający tekst i rosnący w pionie do treści — Enter nie zapisuje
// (wstawia nową linię), zapis dalej przy wyjściu z pola/Escape jak w trybie jednowierszowym.
export default function InlineEditCell({
  value,
  onSave,
  placeholder = "Dodaj uwagę",
  className = "w-56",
  multiline = false,
  readOnly = false,
}: {
  value: string | null;
  onSave: (next: string | null) => void;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  // Zablokowany wiersz (np. Serwis poza statusem "w naprawie", 02.10.2026): zwykły tekst zamiast pola, żeby nic
  // nie dało się zmienić przez przypadek.
  readOnly?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const current = value ?? "";
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function commit() {
    const next = (draft ?? current).trim();
    const skip = cancelled.current;
    cancelled.current = false;
    setDraft(null);
    if (skip || next === current.trim()) return;
    onSave(next || null);
  }

  useEffect(() => {
    if (!multiline || !textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
  }, [multiline, draft, current]);

  if (readOnly) {
    return (
      <span className={`${className} inline-block px-2 py-1 text-sm text-inksoft whitespace-pre-wrap break-words align-top`}>
        {current || "—"}
      </span>
    );
  }

  if (multiline) {
    return (
      <textarea
        ref={textareaRef}
        value={draft ?? current}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        rows={1}
        className={`${className} border border-transparent hover:border-line focus:border-line bg-transparent focus:bg-white px-2 py-1 rounded text-sm resize-none overflow-hidden whitespace-pre-wrap break-words`}
      />
    );
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
