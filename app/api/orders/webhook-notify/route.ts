import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/buyback";
import { admin } from "@/lib/parcelServer";
import { runOrderWebhook } from "@/lib/orderWebhookServer";

// Powiadomienia o nowych zamówieniach na webhook Make (20.10.2026). GET = cron co minutę (Bearer CRON_SECRET) albo zalogowany użytkownik; ?dry=1 pokazuje, co zostałoby wysłane (nic nie wysyła i nie zapisuje).
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  try {
    return NextResponse.json(await runOrderWebhook(admin(), { dryRun: dry }));
  } catch (e: any) {
    return NextResponse.json({ ran: false, error: String(e?.message || e) }, { status: 500 });
  }
}
