import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { DhlExpressError, dhlExpressConfigFromEnv, dhlListProducts, type ProductQuery } from "@/lib/dhlExpress";

// Sprawdzenie połączenia z DHL Express (MyDHL API) — tylko Admin i Manager.
//  GET  -> { configured, env }: czy zmienne środowiskowe są ustawione i które środowisko DHL jest aktywne (test / production).
//  POST -> lista produktów DHL Express dostępnych dla jednej paczki na wskazanej trasie na NASZYM koncie (m.in. Economy Select
//          i jego dokładny kod). Nic nie tworzy i nie kosztuje — to zapytanie tylko do odczytu.
// Numer konta i klucze zostają na serwerze; do przeglądarki nie trafiają.

const ROLES = ["Admin", "Manager"];

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function GET(request: Request) {
  if (!(await requireRole(request, admin(), ROLES))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = dhlExpressConfigFromEnv();
  return NextResponse.json({ configured: !!cfg, env: cfg?.env ?? null });
}

const num = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const text = (v: unknown, max = 60) => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);

export async function POST(request: Request) {
  if (!(await requireRole(request, admin(), ROLES))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const cfg = dhlExpressConfigFromEnv();
  if (!cfg) {
    return NextResponse.json(
      { error: "Brak konfiguracji DHL Express — ustaw DHL_EXPRESS_API_KEY, DHL_EXPRESS_API_SECRET i DHL_EXPRESS_ACCOUNT w zmiennych środowiskowych." },
      { status: 400 }
    );
  }

  const b = await request.json().catch(() => null);
  const destCountry = typeof b?.destinationCountryCode === "string" ? b.destinationCountryCode.trim().toUpperCase() : "";
  const query: Partial<ProductQuery> = {
    originCountryCode: "PL",
    originCityName: text(b?.originCityName) ?? undefined,
    originPostalCode: text(b?.originPostalCode, 12) ?? undefined,
    destinationCountryCode: /^[A-Z]{2}$/.test(destCountry) ? destCountry : undefined,
    destinationCityName: text(b?.destinationCityName) ?? undefined,
    destinationPostalCode: text(b?.destinationPostalCode, 12) ?? undefined,
    weight: num(b?.weight, 0.1, 70) ?? undefined,
    length: num(b?.length, 1, 300) ?? undefined,
    width: num(b?.width, 1, 300) ?? undefined,
    height: num(b?.height, 1, 300) ?? undefined,
    isCustomsDeclarable: b?.isCustomsDeclarable === true,
    plannedShippingDate: new Date().toISOString().slice(0, 10),
  };
  const missing = (["originCityName", "destinationCountryCode", "destinationCityName", "weight", "length", "width", "height"] as const).filter((k) => query[k] === undefined);
  if (missing.length > 0) {
    return NextResponse.json({ error: `Uzupełnij poprawnie: ${missing.join(", ")}.` }, { status: 400 });
  }

  try {
    const result = await dhlListProducts(cfg, query as ProductQuery);
    return NextResponse.json({ ok: true, env: cfg.env, ...result });
  } catch (e: any) {
    const status = e instanceof DhlExpressError && e.status && e.status >= 400 && e.status < 500 ? 422 : 502;
    return NextResponse.json({ error: e.message || "Błąd połączenia z DHL Express." }, { status });
  }
}
