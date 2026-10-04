// Wspólne dla route'ów UPS (tylko serwer): adres nadawcy z ustawień i odbiorca z formularza w formie wymaganej przez UPS.
import type { admin } from "./parcelServer";
import type { ParsedShipment } from "./shipmentInput";
import type { UpsAddress } from "./ups";

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
