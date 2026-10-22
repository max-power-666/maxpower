// Swopify (kanał ręczny, bez API): zamówienie z przypisanym numerem przesyłki jest WYSŁANE (22.10.2026, na prośbę właściciela — znika z "Nowe").
// Numer przesyłki trafia do zamówienia przy nadaniu z aplikacji (notifyMarketplace); anulowanie przesyłki cofa zamówienie do "Opłacone", o ile nie ma innej aktywnej przesyłki.
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<any, any, any>;
const WHO = "Automat (numer przesyłki)";

async function patchOrder(db: Db, externalId: string, patch: { status: string; tracking_number: string | null }, note: string): Promise<void> {
  const { data: o } = await db.from("sales_orders").select("status, tracking_number, history").eq("marketplace", "swopify").eq("external_id", externalId).maybeSingle();
  if (!o) return;
  const changes: { field: string; from: unknown; to: unknown }[] = [];
  if (o.status !== patch.status) changes.push({ field: "status", from: o.status, to: patch.status });
  if ((o.tracking_number ?? null) !== patch.tracking_number) changes.push({ field: "tracking_number", from: o.tracking_number ?? null, to: patch.tracking_number });
  if (changes.length === 0) return;
  const history = Array.isArray(o.history) ? o.history : [];
  await db
    .from("sales_orders")
    .update({ ...patch, history: [...history, { action: "edited", by_email: WHO, at: new Date().toISOString(), note, changes }] })
    .eq("marketplace", "swopify")
    .eq("external_id", externalId);
}

// Po udanym nadaniu: numer przesyłki + status "Wysłane" (tylko przesyłki produkcyjne, nieanulowane; anulowanego zamówienia nie ruszamy).
export async function markSwopifyShipped(db: Db, externalId: string, trackingNumber: string): Promise<void> {
  const { data: s } = await db.from("shipments").select("environment, cancelled_at").eq("tracking_number", trackingNumber).maybeSingle();
  if (s && (s.cancelled_at || (s.environment && s.environment !== "production"))) return;
  const { data: o } = await db.from("sales_orders").select("status").eq("marketplace", "swopify").eq("external_id", externalId).maybeSingle();
  if (!o || o.status === "CANCELLED") return;
  await patchOrder(db, externalId, { status: "SHIPPED", tracking_number: trackingNumber }, "przesyłka nadana — zamówienie wysłane");
}

// Po anulowaniu przesyłki: gdy zamówienie nie ma innej aktywnej przesyłki produkcyjnej — wraca do "Opłacone" i traci numer przesyłki.
export async function revertSwopifyIfNoShipment(db: Db, shipmentId: number): Promise<void> {
  const { data: s } = await db.from("shipments").select("marketplace, order_external_id, tracking_number").eq("id", shipmentId).maybeSingle();
  if (!s || s.marketplace !== "swopify" || !s.order_external_id) return;
  const { data: others } = await db.from("shipments").select("tracking_number, environment").eq("marketplace", "swopify").eq("order_external_id", s.order_external_id).is("cancelled_at", null).neq("id", shipmentId);
  const active = (others || []).filter((x: any) => !x.environment || x.environment === "production");
  if (active.length > 0) {
    await patchOrder(db, s.order_external_id, { status: "SHIPPED", tracking_number: active[0].tracking_number }, "przesyłka anulowana — zostaje inna aktywna");
    return;
  }
  const { data: o } = await db.from("sales_orders").select("status").eq("marketplace", "swopify").eq("external_id", s.order_external_id).maybeSingle();
  if (!o || o.status === "CANCELLED") return;
  await patchOrder(db, s.order_external_id, { status: "PAID", tracking_number: null }, "przesyłka anulowana — zamówienie wraca do opłaconych");
}
