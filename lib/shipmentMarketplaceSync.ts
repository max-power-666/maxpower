// Po nadaniu przesyłki DHL zgłasza numer przesyłki z powrotem do marketplace'u, z którego pochodzi zamówienie —
// dziś Back Market i refurbed, jedyne dwa kanały, z których karta zamówienia daje przycisk "Nadaj przesyłkę DHL"
// (patrz buildShipPrefill w lib/shipping.ts). Inne marketplace'y (Erli, Allegro, Octopia, Apilo, Amazon) na razie
// nie mają tego przycisku, więc nic tu dla nich nie robimy.
//
// WAŻNE: to wywołanie nigdy nie cofa ani nie failuje utworzenia przesyłki — w tym momencie przesyłka w DHL już
// istnieje i jest płatna. Błąd zgłoszenia do marketplace'u zapisujemy w shipments.marketplace_sync_error (UI
// pokazuje ostrzeżenie z możliwością ponowienia, route /api/shipping/sync-marketplace), zamiast go przepuszczać
// dalej i tracić informację o już nadanej przesyłce.

import type { SupabaseClient } from "@supabase/supabase-js";
import { bmShipConfigFromEnv, bmMarkOrderShipped, BM_SHIPPER_BY_CARRIER } from "./backmarket";
import { refurbedListCarriers, refurbedMarkItemsShipped } from "./refurbed";

export type ShipmentCarrier = "dhl_express" | "dhl_parcel";

export async function notifyMarketplace(
  db: SupabaseClient<any, any, any>,
  opts: { marketplace: string | null; externalId: string | null; carrier: ShipmentCarrier; trackingNumber: string; trackingUrl: string }
): Promise<{ synced: boolean; error: string | null }> {
  if (!opts.marketplace || !opts.externalId) return { synced: false, error: null }; // przesyłka nie powiązana z zamówieniem — nic do zgłoszenia

  try {
    if (opts.marketplace === "backmarket") {
      const cfg = bmShipConfigFromEnv();
      if (!cfg) return { synced: false, error: "Brak konfiguracji Back Market (BACKMARKET_AUTH) — zgłoś numer przesyłki ręcznie w panelu Back Market." };
      await bmMarkOrderShipped(cfg, {
        orderId: opts.externalId,
        trackingNumber: opts.trackingNumber,
        trackingUrl: opts.trackingUrl,
        shipper: BM_SHIPPER_BY_CARRIER[opts.carrier],
      });
      return { synced: true, error: null };
    }

    if (opts.marketplace === "refurbed") {
      const token = process.env.REFURBED_API_TOKEN;
      if (!token) return { synced: false, error: "Brak konfiguracji refurbed (REFURBED_API_TOKEN) — zgłoś numer przesyłki ręcznie w panelu refurbed." };
      const client = { token, userAgent: process.env.REFURBED_UA || "backmarket@recoo.io" };

      // refurbed oznacza jako wysłane POZYCJE zamówienia, nie samo zamówienie — potrzebujemy ich id z naszej bazy
      // (item_key = numeryczne id pozycji refurbed, mapRefurbedItems nie rozbija ilości > 1 na sztuki).
      const { data: items, error: itemsErr } = await db
        .from("sales_order_items")
        .select("item_key")
        .eq("marketplace", "refurbed")
        .eq("external_id", opts.externalId);
      if (itemsErr) return { synced: false, error: `Nie udało się odczytać pozycji zamówienia: ${itemsErr.message}` };
      const itemIds = (items ?? []).map((i: any) => String(i.item_key));
      if (itemIds.length === 0) return { synced: false, error: "Brak pozycji tego zamówienia w bazie — zgłoś numer przesyłki ręcznie w panelu refurbed." };

      // Nazwa przewoźnika jest tylko kosmetyczna (ładniejszy widok dla klienta) — brak dopasowania nie blokuje zgłoszenia.
      let carrierSlug: string | null = null;
      try {
        const carriers = await refurbedListCarriers(client);
        carrierSlug =
          (opts.carrier === "dhl_express" ? carriers.find((c) => /dhl/i.test(c.name) && /express/i.test(c.name))?.slug : undefined) ??
          carriers.find((c) => /dhl/i.test(c.name))?.slug ??
          null;
      } catch {
        // best-effort — parcel_tracking_url (wymagany) i tak zostanie ustawiony
      }

      const result = await refurbedMarkItemsShipped(client, { itemIds, trackingUrl: opts.trackingUrl, carrierSlug, trackingNumber: opts.trackingNumber });
      if (!result.ok) return { synced: false, error: `Część pozycji nie została zgłoszona (${result.failed.map((f) => `${f.id}: ${f.message}`).join("; ")}).` };
      return { synced: true, error: null };
    }

    return { synced: false, error: null }; // inny marketplace — przycisk "Nadaj przesyłkę DHL" go dziś nie obsługuje
  } catch (e: any) {
    return { synced: false, error: e?.message || "Nie udało się zgłosić numeru przesyłki do marketplace'u." };
  }
}
