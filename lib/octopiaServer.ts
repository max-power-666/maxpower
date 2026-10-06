import type { SupabaseClient } from "@supabase/supabase-js";
import { mapOctopiaItems, mapOctopiaOrder, mapOctopiaToSales, uniqueBy } from "./salesOrders";

// Zapis zamówień Octopia do octopia_orders / sales_orders / sales_order_items — wspólny dla synchronizacji (orders/octopia-sync)
// i odświeżenia pojedynczego zamówienia po akcji (akceptacja, zgłoszenie przesyłki).
export async function saveOctopiaOrders(admin: SupabaseClient<any, any, any>, all: any[]) {
  const orders = uniqueBy(all, (o) => String(o.orderId));
  const { error: rawErr } = await admin.from("octopia_orders").upsert(orders.map(mapOctopiaOrder));
  if (rawErr) throw new Error(`Błąd zapisu do Supabase (octopia_orders): ${rawErr.message}`);
  const { error: salesErr } = await admin.from("sales_orders").upsert(orders.map(mapOctopiaToSales));
  if (salesErr) throw new Error(`Błąd zapisu do Supabase (sales_orders): ${salesErr.message}`);
  const items = uniqueBy(orders.flatMap(mapOctopiaItems), (i) => `${i.external_id}#${i.item_key}`);
  if (items.length > 0) {
    const { error: itemsErr } = await admin.from("sales_order_items").upsert(items);
    if (itemsErr) throw new Error(`Błąd zapisu do Supabase (sales_order_items): ${itemsErr.message}`);
  }
}
