import { NextResponse } from "next/server";
import { requireRole } from "@/lib/serverAuth";
import { upsConfigFromEnv, upsRate, UpsError, UPS_DEFAULT_SERVICE } from "@/lib/ups";
import { parseShipmentBody, parseExtraPackages } from "@/lib/shipmentInput";
import { admin } from "@/lib/parcelServer";
import { loadUpsShipper, parseUpsCod, upsReceiver } from "@/lib/upsServer";

// UPS — konfiguracja i WYCENA (Rating API, Shop). Tylko Admin, Manager i Zamówienia.
//  GET  -> { configured, env }: czy są dane dostępowe i które środowisko UPS jest aktywne (test / production).
//  POST -> usługi UPS dostępne na tej trasie dla konta z cenami (wynegocjowanymi, jeśli konto je ma). Niczego nie tworzy i nic nie kosztuje.
// Client ID/Secret i numer konta zostają na serwerze.

export const maxDuration = 60;
const ROLES = ["Admin", "Manager", "Zamówienia"];

export async function GET(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ROLES))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = upsConfigFromEnv();
  return NextResponse.json({ configured: !!cfg, env: cfg?.env ?? null });
}

export async function POST(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ROLES))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = upsConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak konfiguracji UPS — ustaw UPS_CLIENT_ID, UPS_CLIENT_SECRET i UPS_ACCOUNT_NUMBER w zmiennych środowiskowych." }, { status: 400 });

  const b = await request.json().catch(() => null);
  const parsed = parseShipmentBody({ ...b, clientRequestId: b?.clientRequestId ?? "00000000-0000-0000-0000-000000000000" });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const extra = parseExtraPackages(b?.extraPackages);
  if (!extra.ok) return NextResponse.json({ error: extra.error }, { status: 400 });
  const shipper = await loadUpsShipper(db);
  if (!shipper) return NextResponse.json({ error: "Brak danych nadawcy (tabela shipping_settings) — uruchom supabase/shipping.sql." }, { status: 500 });

  const { receiver, pack } = parsed.value;
  const cod = parseUpsCod(b?.cod, receiver.countryCode, shipper.countryCode);
  if (!cod.ok) return NextResponse.json({ error: cod.error }, { status: 400 });
  try {
    const quotes = await upsRate(cfg, { shipper, receiver: upsReceiver(receiver), packages: [pack, ...extra.value], cod: cod.value });
    quotes.sort((a, b2) => a.price - b2.price);
    return NextResponse.json({ ok: true, env: cfg.env, defaultService: UPS_DEFAULT_SERVICE, quotes });
  } catch (e: any) {
    const status = e instanceof UpsError && e.status && e.status >= 400 && e.status < 500 ? 422 : 502;
    return NextResponse.json({ error: e.message || "Błąd połączenia z UPS." }, { status });
  }
}
