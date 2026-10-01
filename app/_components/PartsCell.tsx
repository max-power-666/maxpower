"use client";

import InlineEditCell from "./InlineEditCell";

// Numery seryjne części wykorzystanych w naprawie (Serwis) — dowolna liczba, często zero, czasem kilka.
// W odróżnieniu od Padów w Trade-in (liczba -> tyle wygenerowanych pól) tu wprost przyciski +/- przy
// KAŻDYM polu: "+" dokłada kolejne puste pole zaraz pod tym, "-" usuwa to pole. Dodanie/usunięcie pola
// zapisuje całą tablicę od razu; sama treść pola zapisuje się dopiero przy wyjściu z niego/Enterem
// (InlineEditCell) — żeby nie zapisywać przy każdym naciśnięciu klawisza.
export default function PartsCell({
  values,
  onSave,
}: {
  values: string[] | null;
  onSave: (next: string[]) => void;
}) {
  const list = values ?? [];

  function setAt(i: number, v: string | null) {
    const next = [...list];
    next[i] = v ?? "";
    onSave(next);
  }
  function addAfter(i: number) {
    const next = [...list];
    next.splice(i + 1, 0, "");
    onSave(next);
  }
  function removeAt(i: number) {
    onSave(list.filter((_, idx) => idx !== i));
  }

  if (list.length === 0) {
    return (
      <button onClick={() => onSave([""])} title="Dodaj część" className="text-teal text-xs font-semibold px-2 py-1 border border-line rounded hover:bg-tealsoft">
        + część
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {list.map((v, i) => (
        <div key={i} className="flex items-center gap-1">
          <InlineEditCell value={v || null} placeholder="Numer seryjny części" className="w-40 font-mono" onSave={(val) => setAt(i, val)} />
          <button onClick={() => addAfter(i)} title="Dodaj kolejną część" className="text-teal text-xs font-bold w-5 h-5 shrink-0 flex items-center justify-center rounded hover:bg-tealsoft">
            +
          </button>
          <button onClick={() => removeAt(i)} title="Usuń część" className="text-rust text-xs font-bold w-5 h-5 shrink-0 flex items-center justify-center rounded hover:bg-rustsoft">
            −
          </button>
        </div>
      ))}
    </div>
  );
}
