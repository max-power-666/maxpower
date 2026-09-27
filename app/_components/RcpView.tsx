"use client";

// Zakładka RCP (rejestracja czasu pracy). Na razie tylko szkielet — system zbudujemy krok po kroku.
// Docelowo: rejestrowanie czasu pracy pracowników, z którego da się policzyć wydajność (punkty na godzinę pracy)
// i premię zgodnie z Regulaminem premiowania (patrz CLAUDE.md, punkt o ewidencji godzin pracy).

export default function RcpView() {
  return (
    <div className="border border-line bg-white p-6 max-w-2xl">
      <h2 className="text-sm font-semibold mb-2">Rejestracja czasu pracy (RCP)</h2>
      <p className="text-sm text-inksoft">Ta zakładka jest jeszcze pusta — system rejestrowania czasu pracy będziemy tu budować.</p>
    </div>
  );
}
