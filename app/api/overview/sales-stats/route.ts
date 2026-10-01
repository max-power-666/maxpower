import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isCountedOrder } from "@/lib/salesOrders";
import { NBP_CURRENCIES, convertToPln, type NbpRate } from "@/lib/nbp";

// Dane dla Przeglądu (OverviewSalesDashboard.tsx): zamówienia z ostatnich ~35 dni (zapas na strefę czasu
// przeglądarki — "ostatnie 30 dni" liczy sam klient, lib/overview.ts), już przeliczone na PLN, z pominięciem
// zamówień nieliczonych (anulowane/zwrócone/nieopłacone — ten sam isCountedOrder co kafelki Zamówienia
// dzisiaj/wczoraj w SalesOrdersHub.tsx, nie osobna, druga definicja). Dostępne dla każdej zalogowanej osoby
// (Przegląd to wspólna strona startowa, widoczna dla wszystkich ról).

export const maxDuration = 30;

const WINDOW_DAYS = 35; // bufor ponad 30 dni dla stref czasu; klient i tak przelicza dokładnie "ostatnie 30 dni"

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function isAuthorized(request: Request): Promise<boolean> {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data } = await anon.auth.getUser(token);
  return !!data?.user;
}

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  }

  const db = admin();
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

  // Paginacja: PostgREST domyślnie tnie na 1000 wierszy, a w oknie 35 dni może być więcej zamówień.
  const orders: { marketplace: string; external_id: string; order_date: string | null; status: string; total_value: number | null; currency: string | null }[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await db
      .from("sales_order_values")
      .select("marketplace, external_id, order_date, status, total_value, currency")
      .gte("order_date", since)
      .order("order_date", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) return NextResponse.json({ error: `Błąd odczytu zamówień: ${error.message}` }, { status: 500 });
    orders.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  // Kursy NBP dla znalezionych walut obcych, z zapasem dzień wcześniej (zasada "kurs z dnia poprzedniego" —
  // pierwszy dzień okna też musi mieć do czego sięgnąć wstecz).
  const rateFrom = new Date(Date.now() - (WINDOW_DAYS + 5) * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const ratesByCurrency: Record<string, NbpRate[]> = {};
  for (const currency of NBP_CURRENCIES) {
    const { data } = await db.from("nbp_rates").select("currency, rate_date, mid").eq("currency", currency).gte("rate_date", rateFrom);
    ratesByCurrency[currency] = (data || []).map((r) => ({ currency: r.currency, rateDate: r.rate_date, mid: Number(r.mid) }));
  }

  let missingRate = 0;
  const rows: { marketplace: string; order_date: string; value_pln: number }[] = [];
  for (const o of orders) {
    if (!o.order_date || o.total_value === null) continue;
    if (!isCountedOrder(o.marketplace, o.status)) continue;
    const valuePln = convertToPln(Number(o.total_value), o.currency, o.order_date.slice(0, 10), ratesByCurrency);
    if (valuePln === null) {
      missingRate += 1;
      continue;
    }
    rows.push({ marketplace: o.marketplace, order_date: o.order_date, value_pln: valuePln });
  }

  return NextResponse.json({ ok: true, rows, missingRate });
}
