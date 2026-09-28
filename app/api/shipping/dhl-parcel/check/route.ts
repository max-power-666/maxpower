import { NextResponse } from "next/server";
import { requireRole } from "@/lib/serverAuth";
import { dhlParcelConfigFromEnv, dhlParcelIsSandbox, dhlParcelPrice, dhlParcelVersion, PARCEL_PRODUCTS } from "@/lib/dhlParcel";
import { parseShipmentBody } from "@/lib/shipmentInput";
import { admin, loadShipper } from "@/lib/parcelServer";

// DHL Parcel (DHL24 WebAPI2) — konfiguracja i WYCENA. Tylko Admin, Manager i Zamówienia.
//  GET  -> { configured, sandbox, version }: czy są dane dostępowe i czy usługa DHL odpowiada (getVersion nie wymaga logowania).
//  POST -> wycena (getPrice) produktów międzynarodowych z PARCEL_PRODUCTS (lib/dhlParcel.ts) dla wpisanej trasy i paczki.
// Wycena niczego nie tworzy i nic nie kosztuje. Hasło i numer SAP zostają na serwerze.

const ROLES = ["Admin", "Manager", "Zamówienia"];

export async function GET(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ROLES))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = dhlParcelConfigFromEnv();
  if (!cfg) return NextResponse.json({ configured: false });
  let version: string | null = null;
  try {
    version = await dhlParcelVersion(cfg);
  } catch {
    /* usługa chwilowo nie odpowiada — pokażemy to jako brak wersji */
  }
  return NextResponse.json({ configured: true, sandbox: dhlParcelIsSandbox(cfg), version });
}

export async function POST(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ROLES))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = dhlParcelConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji DHL Parcel — ustaw DHL_PARCEL_USERNAME, DHL_PARCEL_PASSWORD i DHL_PARCEL_SAP w zmiennych środowiskowych." }, { status: 400 });

  const b = await request.json().catch(() => null);
  const parsed = parseShipmentBody({ ...b, clientRequestId: b?.clientRequestId ?? "00000000-0000-0000-0000-000000000000" });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const shipper = await loadShipper(db);
  if (!shipper) return NextResponse.json({ error: "Brak danych nadawcy (tabela shipping_settings) — uruchom supabase/shipping.sql." }, { status: 500 });

  const { receiver, pack } = parsed.value;
  const quotes = await Promise.all(
    PARCEL_PRODUCTS.map((p) =>
      dhlParcelPrice(cfg, {
        product: p.code,
        shipper,
        receiver: { country: receiver.countryCode, name: receiver.company || receiver.name, postalCode: receiver.postalCode, city: receiver.city, street: receiver.street, houseNumber: receiver.houseNumber, apartmentNumber: receiver.apartment },
        package: pack,
      }).then((q) => ({ ...q, name: p.name }))
    )
  );
  // Błąd autoryzacji dotyczy wszystkich produktów — pokazujemy go wprost zamiast tabeli samych "niedostępny".
  if (quotes.every((q) => !q.ok && /autoryz|hasł|klucz|username|password|access|nieprawid/i.test(q.error ?? ""))) {
    return NextResponse.json({ error: `DHL Parcel odrzucił dane logowania: ${quotes[0].error}` }, { status: 422 });
  }
  return NextResponse.json({ ok: true, sandbox: dhlParcelIsSandbox(cfg), quotes });
}
