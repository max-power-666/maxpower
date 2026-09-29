import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { bmShipConfigFromEnv } from "@/lib/backmarket";
import { mapBmOrder, mapBmToSales, mapBmItems, uniqueBy } from "@/lib/salesOrders";

// Dogrywa NA ŻĄDANIE jedno zamówienie Back Market (GET /ws/orders/{id}) i odświeża jego wiersz w bm_orders/
// sales_orders/sales_order_items — używane z ShippingView.tsx zaraz po nadaniu przesyłki, żeby sprawdzić najświeższy
// stan delivery_note (packing slip). Sprawdzone na żywych danych (29.09.2026, próbka 20 zamówień w stanie "Do
// wysyłki"): delivery_note pojawia się w API DOKŁADNIE w momencie akceptacji, bez opóźnienia po stronie Back
// Marketu — ale zwykły cron (co 15 min) mógł tego jeszcze nie złapać, jeśli akceptacja i nadanie przesyłki
// nastąpiły w krótszym odstępie. Ten route naprawia to na miejscu, zamiast czekać na kolejny przebieg synchronizacji.

export const maxDuration = 30;

export async function POST(request: Request) {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const uid = await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  const b = await request.json().catch(() => null);
  const orderId = typeof b?.orderId === "string" ? b.orderId : "";
  if (!orderId) return NextResponse.json({ error: "Brak numeru zamówienia." }, { status: 400 });

  const cfg = bmShipConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji Back Market (BACKMARKET_AUTH)." }, { status: 500 });

  try {
    const res = await fetch(`${cfg.baseUrl}/ws/orders/${orderId}`, {
      headers: { Accept: "application/json", "Accept-Language": cfg.lang, Authorization: cfg.auth, "User-Agent": cfg.userAgent },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: `Back Market zwrócił błąd (${res.status}): ${text.slice(0, 200)}` }, { status: 502 });
    }
    const order = await res.json();
    if (!order?.order_id) return NextResponse.json({ error: "Back Market nie zwrócił zamówienia." }, { status: 502 });

    const { error: rawErr } = await db.from("bm_orders").upsert(mapBmOrder(order));
    if (rawErr) throw new Error(`Błąd zapisu do Supabase (bm_orders): ${rawErr.message}`);
    const { error: salesErr } = await db.from("sales_orders").upsert(mapBmToSales(order));
    if (salesErr) throw new Error(`Błąd zapisu do Supabase (sales_orders): ${salesErr.message}`);
    const items = uniqueBy(mapBmItems(order), (i) => i.item_key);
    if (items.length > 0) {
      const { error: itemsErr } = await db.from("sales_order_items").upsert(items);
      if (itemsErr) throw new Error(`Błąd zapisu do Supabase (sales_order_items): ${itemsErr.message}`);
    }

    return NextResponse.json({ ok: true, deliveryNote: order.delivery_note || null });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się odświeżyć zamówienia." }, { status: 502 });
  }
}
