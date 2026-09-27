// Wspólne dla route'ów DHL Parcel (tylko serwer): klient Supabase z service_role i adres nadawcy z ustawień w formie wymaganej przez DHL24.

import { createClient } from "@supabase/supabase-js";
import { splitStreet } from "./shipping";
import type { ParcelAddress } from "./dhlParcel";

export const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// DHL24 wymaga ulicy i numeru domu w osobnych polach — nadawcę (ustawienia trzymają "ul. Karola Olszewskiego 20") rozdzielamy tak samo jak odbiorców.
export async function loadShipper(db: ReturnType<typeof admin>): Promise<ParcelAddress | null> {
  const { data: s } = await db.from("shipping_settings").select("*").eq("id", 1).maybeSingle();
  if (!s) return null;
  const sp = splitStreet(s.street);
  return {
    name: s.shipper_company,
    postalCode: s.postal_code.replace(/\D/g, "") || s.postal_code, // DHL24 przyjmuje polskie kody bez myślnika (np. 25663)
    city: s.city,
    street: sp.street,
    houseNumber: sp.houseNumber,
    contactPerson: s.shipper_name,
    contactPhone: String(s.phone).replace(/\s+/g, ""),
    contactEmail: s.email ?? undefined,
  };
}

// Numer przesyłki DHL24 (shipmentId) jest jednocześnie numerem do śledzenia.
export const parcelTrackingUrl = (id: string) => `https://www.dhl.com/pl-pl/home/tracking.html?tracking-id=${encodeURIComponent(id)}`;
