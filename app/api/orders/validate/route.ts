import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { bmShipConfigFromEnv, bmAcceptOrder } from "@/lib/backmarket";

// Akceptuje zamówienie u marketplace'u, gdy zespół przestawia "Nasz status" na "w realizacji" w Zamówieniach
// (SalesOrdersHub.tsx, changeOurStatus) — sygnał "bierzemy się za to" odpowiada akcji "zaakceptuj zamówienie"
// po stronie kanału. Dziś tylko Back Market (POST /ws/orders/{id}, new_state: 2 — patrz lib/backmarket.ts);
// inne marketplace'y (refurbed, Erli, Allegro, Octopia, Apilo, Amazon) nie mają tu jeszcze odpowiednika, więc
// route po prostu nic dla nich nie robi (nie błąd).
//
// Nigdy nie failuje twardo: "Nasz status" już się zmienił w bazie, zanim to wywołanie w ogóle wystartuje, więc
// błąd akceptacji jest tylko ostrzeżeniem w UI (SalesOrdersHub pokazuje je, ale nie cofa zmiany statusu).

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
