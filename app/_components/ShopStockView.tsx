"use client";

// Recoo Sklep → Magazyn. Na razie szkielet — następny krok po zakładce Produkty.
// Decyzja właściciela (30.09.2026): stan to RĘCZNY licznik przy wariancie (shop_variants.stock),
// bez powiązania z numerami seryjnymi z Fakturowni.

export default function ShopStockView() {
  return (
    <div className="border border-line bg-white p-6 max-w-2xl">
      <h2 className="text-sm font-semibold mb-2">Magazyn sklepu</h2>
      <p className="text-sm text-inksoft">
        Tu będzie lista wariantów ze stanem do ręcznej zmiany (przyjęcie, korekta, sprzedaż poza sklepem), z dziennikiem zmian.
        Stan każdego wariantu widać już teraz w zakładce Produkty (tylko do odczytu).
      </p>
    </div>
  );
}
