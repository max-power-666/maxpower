import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { mapOrder } from "@/lib/buybackOrders";

// Waliduje zamówienie BuyBack w Back Market: PUT /ws/buyback/v1/orders/{id}/validate
// (https://api.backmarket.dev, "Validate BuyBack order" — bez body, zwraca zamówienie ze statusem VALIDATED).
// To operacja NIEODWRACALNA i prowadzi do wypłaty dla klienta, więc:
//  - wołać ją może tylko zalogowany użytkownik (token w Authorization; sekret crona NIE wystarcza),
//  - serwer sam sprawdza, że paczka jest zarejestrowana i ma numer seryjny, SKU i pady — nie ufa przeglądarce,
//  - jeśli zamówienie jest już zwalidowane (ponowna próba po błędzie zapisu statusu), nie woła API drugi raz.
// Wywołuje ją TradeInHub przy zmianie statusu paczki na "Obsłużona", po potwierdzeniu ostrzeżenia.

export const maxDuration = 60;

const ALREADY_VALIDATED = ["VALIDATED", "PAID", "MONEY_TRANSFERED"];

export async function POST(request: Request) {
  if (!process.env.BACKMARKET_AUTH || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Brak konfiguracji serwera (BACKMARKET_AUTH / SUPABASE_SERVICE_ROLE_KEY)." }, { status: 500 });
  }

  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data: userData } = token ? await anon.auth.getUser(token) : { data: null };
  if (!userData?.user) return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const orderId = typeof body?.orderPublicId === "string" ? body.orderPublicId.trim() : "";
  if (!orderId) return NextResponse.json({ error: "Brak numeru zamówienia." }, { status: 400 });

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const [{ data: intake, error: intakeErr }, { data: order, error: orderErr }] = await Promise.all([
    admin.from("buyback_order_intake").select("serial_number, sku, pads").eq("order_public_id", orderId).maybeSingle(),
    admin.from("buyback_orders").select("status").eq("order_public_id", orderId).maybeSingle(),
  ]);
  if (intakeErr || orderErr) {
    return NextResponse.json({ error: `Błąd odczytu z Supabase: ${(intakeErr || orderErr)!.message}` }, { status: 500 });
  }
  if (!intake) return NextResponse.json({ error: "Ta paczka nie jest zarejestrowana w zakładce Wprowadzanie." }, { status: 409 });
  if (!order) return NextResponse.json({ error: "Nie ma takiego zamówienia w zsynchronizowanych." }, { status: 404 });

  const missing: string[] = [];
  if (!intake.serial_number?.trim()) missing.push("numer seryjny");
  if (!intake.sku?.trim()) missing.push("SKU");
  if (intake.pads === null || intake.pads === undefined) missing.push("pady");
  if (missing.length > 0) {
    return NextResponse.json({ error: `Nie można zwalidować — uzupełnij: ${missing.join(", ")}.` }, { status: 409 });
  }

  if (ALREADY_VALIDATED.includes(order.status)) {
    return NextResponse.json({ ok: true, alreadyValidated: true, status: order.status });
  }

  const baseUrl = process.env.BACKMARKET_BASE_URL || "https://www.backmarket.fr";
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/ws/buyback/v1/orders/${encodeURIComponent(orderId)}/validate`, {
      method: "PUT",
      headers: {
        Accept: "application/json, application/problem+json",
        "Content-Type": "application/json",
        "Accept-Language": process.env.BACKMARKET_LANG || "fr-fr",
        Authorization: process.env.BACKMARKET_AUTH,
        "User-Agent": process.env.BACKMARKET_UA || "backmarket@recoo.io",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    return NextResponse.json({ error: `Nie udało się połączyć z Back Market: ${e.message || e}` }, { status: 502 });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j.detail || j.message || j.title || detail;
    } catch {
      /* odpowiedź nie jest JSON-em — zostaje surowy tekst */
    }
    return NextResponse.json(
      { error: `Back Market odrzucił walidację (${res.status})${detail ? `: ${detail}` : ""}. Zamówienie NIE zostało zwalidowane.` },
      { status: 502 }
    );
  }

  // Walidacja przeszła — odśwież wiersz zamówienia, żeby lista i karta od razu pokazały nowy status.
  const validated = await res.json().catch(() => null);
  if (validated?.orderPublicId) {
    await admin.from("buyback_orders").upsert(mapOrder(validated));
  }
  return NextResponse.json({ ok: true, alreadyValidated: false, status: validated?.status ?? "VALIDATED" });
}
