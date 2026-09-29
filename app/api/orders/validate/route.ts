import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { bmShipConfigFromEnv, bmAcceptOrder } from "@/lib/backmarket";

// Akceptuje zamówienie u marketplace'u — jawny przycisk "Zaakceptuj zamówienie" na karcie zamówienia
// (SalesOrderCard.tsx, acceptOrder), widoczny przy Back Marketcie w stanie "Do zaakceptowania". Dziś tylko Back
// Market (POST /ws/orders/{id}, new_state: 2 — patrz lib/backmarket.ts); inne marketplace'y (refurbed, Erli,
// Allegro, Octopia, Apilo, Amazon) nie mają tu jeszcze odpowiednika, więc route po prostu nic dla nich nie robi
// (nie błąd). Do 29.09.2026 wywoływane automatycznie przy zmianie "Nasz status" na "w realizacji" — wycofane, bo
// myliło dwie różne rzeczy: naszą wewnętrzną organizację pracy (Nasz status) i realną akcję u marketplace'u.
//
// Nigdy nie failuje twardo: błąd trafia do UI jako komunikat, ale nic wcześniej nie zdążyło się zmienić w naszej
// bazie (w odróżnieniu od poprzedniego mechanizmu, gdzie "Nasz status" już był zmieniony, zanim to wywołanie
// w ogóle wystartowało).

export const maxDuration = 30;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  const b = await request.json().catch(() => null);
  const marketplace = typeof b?.marketplace === "string" ? b.marketplace : "";
  const externalId = typeof b?.externalId === "string" ? b.externalId : "";
  if (!marketplace || !externalId) return NextResponse.json({ error: "Brak marketplace/numeru zamówienia." }, { status: 400 });

  if (marketplace !== "backmarket") {
    return NextResponse.json({ ok: true, validated: false, error: null }); // kanał bez obsługi akceptacji — nic do zrobienia
  }

  const cfg = bmShipConfigFromEnv();
  if (!cfg) return NextResponse.json({ ok: true, validated: false, error: "Brak konfiguracji Back Market (BACKMARKET_AUTH) — zaakceptuj zamówienie ręcznie w panelu Back Market." });

  try {
    await bmAcceptOrder(cfg, { orderId: externalId });
    return NextResponse.json({ ok: true, validated: true, error: null });
  } catch (e: any) {
    return NextResponse.json({ ok: true, validated: false, error: e?.message || "Nie udało się zaakceptować zamówienia w Back Market." });
  }
}
