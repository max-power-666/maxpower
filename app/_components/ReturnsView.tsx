"use client";

// Zakładka Zwroty. Na razie tylko szkielet — system zbudujemy krok po kroku.
// Docelowo: rejestr fizycznej obsługi zwrotu (przyjęcie zwróconej paczki, sprawdzenie stanu sprzętu, decyzja
// co dalej — powrót do magazynu / naprawa / utylizacja), wzorem Serwisu/Testów/Trade-in.

export default function ReturnsView() {
  return (
    <div className="border border-line bg-white p-6 max-w-2xl">
      <h2 className="text-sm font-semibold mb-2">Zwroty</h2>
      <p className="text-sm text-inksoft">Ta zakładka jest jeszcze pusta — rejestr obsługi zwrotów będziemy tu budować.</p>
    </div>
  );
}
