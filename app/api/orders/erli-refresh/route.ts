import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { erliSearchOrders, type ErliClient } from "@/lib/erli";
import { mapErliOrder, mapErliToSales, mapErliItems, uniqueBy } from "@/lib/salesOrders";

// Dogrywa NA ŻĄDANIE jedno zamówienie Erli (POST /orders/_search, filter field=id) i odświeża jego wiersz w
// erli_orders/sales_orders/sales_order_items — odpowiednik bm-refresh dla Back Marketu. Powód: zwykły cykliczny
// skan idzie kursorem po polu `updated` zamówienia, a stworzenie przesyłki przez naszą integrację Erli — Paczkomaty
// InPost (app/api/shipping/erli/create) NIE musi wcale ruszyć tego pola po stronie Erli (ten sam wzorzec problemu
// co przy zmianie statusu płatności, patrz komentarz w orders/erli-sync/route.ts) — zamówienie z realnie nadaną
// przesyłką mogło więc zostać trwale niewidoczne dla zwykłego skanu. Zgłoszone przez właściciela 30.09.2026
// (kilka zamówień Erli z widocznym numerem przesyłki, wciąż pokazujących stary status). Wołane automatycznie po
// udanym nadaniu przez shipping/erli/create, a także ręcznie przyciskiem "Odśwież status" na karcie zamówienia
// Erli — dla zamówień wysłanych całkiem poza naszą integracją (np. wprost z panelu Erli), gdzie nie mamy żadnego
// momentu, w którym moglibyśmy odświeżyć automatycznie.

export const maxDuration = 30;

export async function POST(request: Request) {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const uid = await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  const b = await request.json().catch(() => null);
  const orderId = typeof b?.orderId === "string" ? b.orderId.trim() : "";
  if (!orderId) return NextResponse.json({ error: "Brak numeru zamówienia." }, { status: 400 });

  if (!process.env.ERLI_API_KEY) return NextResponse.json({ error: "Brak konfiguracji Erli (ERLI_API_KEY)." }, { status: 500 });
  const client: ErliClient = {
    apiKey: process.env.ERLI_API_KEY,
    userAgent: process.env.ERLI_UA || "recoo-erp",
    baseUrl: process.env.ERLI_BASE_URL || undefined,
  };

  try {
    const orders = await erliSearchOrders(client, { filter: { field: "id", operator: "=", value: orderId } });
    const order = orders.find((o) => String(o?.id) === orderId);
    if (!order) return NextResponse.json({ error: "Erli nie zwróciło tego zamówienia." }, { status: 502 });

    const { error: rawErr } = await db.from("erli_orders").upsert(mapErliOrder(order));
    if (rawErr) throw new Error(`Błąd zapisu do Supabase (erli_orders): ${rawErr.message}`);
    const { error: salesErr } = await db.from("sales_orders").upsert(mapErliToSales(order));
    if (salesErr) throw new Error(`Błąd zapisu do Supabase (sales_orders): ${salesErr.message}`);
    const items = uniqueBy(mapErliItems(order), (i) => i.item_key);
    if (items.length > 0) {
      const { error: itemsErr } = await db.from("sales_order_items").upsert(items);
      if (itemsErr) throw new Error(`Błąd zapisu do Supabase (sales_order_items): ${itemsErr.message}`);
    }

    return NextResponse.json({ ok: true, status: mapErliToSales(order).status });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się odświeżyć zamówienia." }, { status: 502 });
  }
}
