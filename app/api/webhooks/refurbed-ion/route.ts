import { NextResponse } from "next/server";
import { admin } from "@/lib/parcelServer";
import { runStockSync } from "@/lib/stockSyncServer";

// Webhook refurbed ION — Instant Order Notification (16.10.2026): refurbed wysyła POST {"order_id": 1234} w kilka sekund po złożeniu nowego zamówienia (co najmniej raz — obsługa musi być idempotentna;
// ponawia do 2 dni, gdy odpowiedź nie jest 2xx). Przekazujemy tylko numer — dane pobieramy sami (OrderService/GetOrder z naszym tokenem), więc podrobione żądanie nie wstrzyknie żadnych danych;
// co najwyżej wymusi dodatkowe sprawdzenie. Adres z kluczem: https://<domena>/api/webhooks/refurbed-ion?key=<REFURBED_ION_SECRET> (dłuższy losowy ciąg w zmiennej środowiskowej) — należy go przesłać
// na integrations@refurbed.com (refurbed sam ustawia ion_url konta). Skutek: synchronizacja stanów (sprzedaż na refurbed -> mniejsza ilość na Back Market) działa w sekundy, nie w minutę.
export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = process.env.REFURBED_ION_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook nie jest skonfigurowany (brak REFURBED_ION_SECRET)." }, { status: 503 });
  if (new URL(request.url).searchParams.get("key") !== secret) return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  let id = "";
  try {
    const body = await request.json();
    id = String(body?.order_id ?? "").trim();
  } catch {
    /* pusty/niepoprawny JSON — traktujemy jak zwykłe sprawdzenie */
  }
  const result = await runStockSync(admin(), id && /^\d+$/.test(id) ? { refurbedOrderIds: [id] } : {});
  // zawsze 2xx, żeby refurbed nie ponawiał przez 2 dni (zamówienie i tak zostanie wyłapane przez minutowy przebieg)
  return NextResponse.json({ ok: true, ran: result.ran, applied: result.applied, errors: result.errors.length });
}
