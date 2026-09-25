"use client";

import InlineEditCell from "./InlineEditCell";

// Pola na numery seryjne padów: jedno pole na każdy pad (Pady = 2 -> dwa pola). Skaner kończy numer
// Enterem — pole się zapisuje, a fokus przechodzi na kolejny pad. Wspólne dla Trade-in i Zamówień.

export const MAX_PADS = 20; // tyle pól na numery padów pokazujemy maksymalnie

export default function PadSerialsCell({
  count,
  values,
  onSave,
}: {
  count: number | null;
  values: string[] | null;
  onSave: (index: number, value: string | null) => void;
}) {
  const n = Math.min(count ?? 0, MAX_PADS);
  if (n <= 0) return <span className="text-inksoft px-2">—</span>;

  function focusNextOnEnter(ev: React.KeyboardEvent<HTMLDivElement>) {
    if (ev.key !== "Enter") return;
    const inputs = Array.from(ev.currentTarget.querySelectorAll("input"));
    inputs[inputs.indexOf(ev.target as HTMLInputElement) + 1]?.focus();
  }

  return (
    <div className="flex flex-col gap-1" onKeyDown={focusNextOnEnter}>
      {Array.from({ length: n }, (_, i) => (
        <InlineEditCell
          key={i}
          value={values?.[i] || null}
          placeholder={`Pad ${i + 1}`}
          className="w-48 font-mono"
          onSave={(v) => onSave(i, v)}
        />
      ))}
    </div>
  );
}
