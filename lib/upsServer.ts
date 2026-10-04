// Wspólne dla route'ów UPS (tylko serwer): adres nadawcy z ustawień i odbiorca z formularza w formie wymaganej przez UPS.
import type { admin } from "./parcelServer";
import type { ParsedShipment } from "./shipmentInput";
import { UPS_COD_MAX, UPS_COD_MIN, type UpsAddress, type UpsCod } from "./ups";

export async function loadUpsShipper(db: ReturnType<typeof admin>): Promise<UpsAddress | null> {
  const { data: s } = await db.from("shipping_settings").select("*").eq("id", 1).maybeSingle();
  if (!s) return null;
  return {
    name: s.shipper_company,
    attentionName: s.shipper_name,
    phone: String(s.phone),
    email: s.email ?? undefined,
    street: s.street,
    city: s.city,
    postalCode: s.postal_code,
    countryCode: s.country_code,
  };
}

export function upsReceiver(r: ParsedShipment["receiver"]): UpsAddress {
  const number = `${r.houseNumber}${r.apartment ? `/${r.apartment}` : ""}`;
  return {
    name: r.company || r.name,
    attentionName: r.name,
    phone: r.phone,
    email: r.email,
    street: `${r.street} ${number}`.trim(),
    city: r.city,
    postalCode: r.postalCode,
    countryCode: r.countryCode,
  };
}

// Pobranie z formularza: tylko przesyłki krajowe PL→PL, kwota w PLN. Zwraca null, gdy pobrania nie zażądano.
export function parseUpsCod(raw: unknown, receiverCountry: string, shipperCountry: string): { ok: true; value: UpsCod | null } | { ok: false; error: string } {
  const c = raw as { amount?: unknown } | null | undefined;
  if (c === undefined || c === null) return { ok: true, value: null };
  if (receiverCountry.toUpperCase() !== "PL" || shipperCountry.toUpperCase() !== "PL") return { ok: false, error: "Pobranie UPS jest dostępne tylko dla przesyłek krajowych (Polska → Polska)." };
  const amount = Math.round(Number(c.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount < UPS_COD_MIN || amount > UPS_COD_MAX) return { ok: false, error: `Kwota pobrania musi mieścić się w przedziale ${UPS_COD_MIN}–${UPS_COD_MAX} zł.` };
  return { ok: true, value: { amount, currency: "PLN" } };
}
