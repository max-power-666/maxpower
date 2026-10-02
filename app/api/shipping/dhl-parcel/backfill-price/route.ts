import { NextResponse } from "next/server";
import { requireRole } from "@/lib/serverAuth";
import { dhlParcelConfigFromEnv, dhlParcelPrice, PARCEL_PRODUCTS } from "@/lib/dhlParcel";
import { dhlCharge, parcelQuoteTotal } from "@/lib/shipping";
import { parseQuotedCharges } from "@/lib/shipmentInput";
import { admin, loadShipper } from "@/lib/parcelServer";

// Dopisanie BRAKUJĄCEJ ceny do już nadanej przesyłki DHL Parcel (02.10.2026) — np. gdy nadano ją ze starej,
// nieodświeżonej karty przeglądarki, która nie przekazała ceny z wyceny, więc `shipments.charges` zostało puste.
// DHL24 nie zwraca ceny przy tworzeniu, więc pytamy o wycenę (getPrice) dla ZAPISANEJ trasy i paczki — to wycena z
// chwili wywołania, nie z chwili nadania (przy zmianie cennika/dopłaty paliwowej może minimalnie się różnić).
// Nigdy nie nadpisuje istniejącej ceny, nie rusza przesyłek anulowanych ani innych przewoźników.

const ROLES = ["Admin", "Manager", "Zamówienia"];

export async function POST(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ROLES))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = dhlParcelConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji DHL Parcel (zmienne środowiskowe)." }, { status: 400 });

  const b = await request.json().catch(() => null);
  const id = Number(b?.id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Brak id przesyłki." }, { status: 400 });

  const { data: row } = await db.from("shipments").select("id, carrier, product_code, receiver, package, charges, cancelled_at").eq("id", id).maybeSingle();
  if (!row || row.carrier !== "dhl_parcel") return NextResponse.json({ error: "Nie ma takiej przesyłki DHL Parcel." }, { status: 404 });
  if (row.cancelled_at) return NextResponse.json({ error: "Ta przesyłka została anulowana." }, { status: 409 });
  if (dhlCharge(row.charges)) return NextResponse.json({ error: "Ta przesyłka ma już zapisaną cenę." }, { status: 409 });
  if (!PARCEL_PRODUCTS.some((p) => p.code === row.product_code)) return NextResponse.json({ error: "Nieznany produkt przesyłki." }, { status: 400 });

  const shipper = await loadShipper(db);
  if (!shipper) return NextResponse.json({ error: "Brak danych nadawcy (tabela shipping_settings)." }, { status: 500 });
  const r = row.receiver ?? {};
  const packages = (Array.isArray(row.package) ? row.package : [row.package]).filter(Boolean);
  if (!r.countryCode || packages.length === 0) return NextResponse.json({ error: "Brak zapisanych danych odbiorcy lub paczki." }, { status: 400 });

  const q = await dhlParcelPrice(cfg, {
    product: row.product_code,
    shipper,
    receiver: { country: r.countryCode, name: r.company || r.name, postalCode: r.postalCode, city: r.city, street: r.street, houseNumber: r.houseNumber, apartmentNumber: r.apartment },
    packages: packages.map((p: any) => ({ weight: p.weight, length: p.length, width: p.width, height: p.height })),
  });
  if (!q.ok || q.price === null) return NextResponse.json({ error: `DHL nie zwrócił ceny: ${q.error ?? "brak danych"}` }, { status: 422 });

  const total = parcelQuoteTotal(q.price, q.fuelSurcharge);
  const charges = parseQuotedCharges({ price: total, currency: "PLN" }, { price: total, currency: "PLN" });
  // Warunek na pustym `charges` w samym UPDATE — dwa równoległe kliknięcia nie nadpiszą się nawzajem.
  const { error } = await db.from("shipments").update({ charges }).eq("id", id).or("charges.is.null,charges.eq.[]");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, price: total, currency: "PLN" });
}
