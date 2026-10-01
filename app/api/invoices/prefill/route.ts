import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { buildInvoiceBuyerPrefill } from "@/lib/invoices";

// Wstępne wypełnienie formularza "Wystaw fakturę" (zakładka Faktury) — czyta surowe dane zamówienia z tabeli
// kanału (bm_orders/refurbed_orders/allegro_orders/octopia_orders/erli_orders) i oddaje gotowe pola nabywcy, żeby
// InvoicesView.tsx nie musiało powtarzać tej logiki po stronie przeglądarki. Back Market/refurbed/Allegro/Octopia/
// Erli czytają dane FAKTUROWE (billing_address/invoice_address/invoice.address/user.invoiceAddress), nie adres
// dostawy, gdzie takie osobne pole istnieje — patrz komentarz w buildInvoiceBuyerPrefill (lib/invoices.ts) dla
// pełnego uzasadnienia różnicy. Amazon (bez obsługi — PII niedostępne przez SP-API) oddaje puste pola, pracownik
// wypełnia ręcznie.

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function GET(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  const url = new URL(request.url);
  const marketplace = url.searchParams.get("marketplace") || "";
  const externalId = url.searchParams.get("externalId") || "";
  if (!marketplace || !externalId) return NextResponse.json({ error: "Brak marketplace/numeru zamówienia." }, { status: 400 });

  let raw: any = null;
  let customerEmail: string | null = null;
  if (marketplace === "backmarket") {
    const { data } = await db.from("bm_orders").select("*").eq("order_id", Number(externalId)).maybeSingle();
    raw = data;
  } else if (marketplace === "refurbed") {
    const { data } = await db.from("refurbed_orders").select("raw, customer_email").eq("id", externalId).maybeSingle();
    raw = data?.raw ?? null;
    customerEmail = data?.customer_email ?? null;
  } else if (marketplace === "octopia") {
    const { data } = await db.from("octopia_orders").select("raw").eq("id", externalId).maybeSingle();
    raw = data?.raw ?? null;
  } else if (marketplace === "allegro") {
    const { data } = await db.from("allegro_orders").select("raw").eq("id", externalId).maybeSingle();
    raw = data?.raw ?? null;
  } else if (marketplace === "erli") {
    const { data } = await db.from("erli_orders").select("raw").eq("id", externalId).maybeSingle();
    raw = data?.raw ?? null;
  }
  // Amazon: raw zostaje null celowo — buildInvoiceBuyerPrefill i tak odda puste pola (PII niedostępne przez SP-API).

  const buyer = buildInvoiceBuyerPrefill(marketplace, raw, customerEmail);

  const { data: items } = await db
    .from("sales_order_items")
    .select("item_key, sku, name, serial_number, price, currency")
    .eq("marketplace", marketplace)
    .eq("external_id", externalId)
    .order("position", { ascending: true });

  return NextResponse.json({ ok: true, buyer, items: items || [] });
}
