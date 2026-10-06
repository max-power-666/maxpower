"use client";

import { useState } from "react";

// Usterki paczki (Trade-in, 06.10.2026): wpisujesz np. "hdmi" i naciskasz Enter — usterka trafia na listę (plakietka z ×), a pole od razu czeka na kolejną.
// Zapis całej tablicy po każdym dodaniu/usunięciu (jak części w Serwisie); duplikaty (bez rozróżniania wielkości liter) są pomijane.

export const MAX_DEFECTS = 20;
export const MAX_DEFECT_LENGTH = 60;

export function normalizeDefect(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, MAX_DEFECT_LENGTH);
}

export default function DefectsCell({
  values,
  onSave,
  readOnly = false,
}: {
  values: string[] | null;
  onSave: (next: string[]) => void;
  readOnly?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const list = values ?? [];

  function add() {
    const d = normalizeDefect(draft);
    setDraft("");
    if (!d || list.length >= MAX_DEFECTS || list.some((x) => x.toLowerCase() === d.toLowerCase())) return;
    onSave([...list, d]);
  }

  return (
    <div className="flex flex-col gap-1 min-w-[10rem]">
      {list.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {list.map((d, i) => (
            <span key={`${d}-${i}`} className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-rustsoft text-rust">
              {d}
              {!readOnly && (
                <button onClick={() => onSave(list.filter((_, idx) => idx !== i))} title="Usuń usterkę" className="leading-none hover:opacity-70">
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {!readOnly && list.length < MAX_DEFECTS && (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={() => draft.trim() && add()}
          placeholder={list.length ? "+ kolejna (Enter)" : "np. hdmi (Enter)"}
          className="w-40 border border-line bg-white px-2 py-1 rounded text-sm"
        />
      )}
      {readOnly && list.length === 0 && <span className="text-inksoft px-2">—</span>}
    </div>
  );
}
