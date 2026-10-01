import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { createFakturowniaInvoice, fakturowniaConfigFromEnv, type InvoiceBuyerPrefill, type InvoicePosition } from "@/lib/invoices";

// Wystawia fakturę VAT w Fakturowni dla zamówienia, które ma już numer przesyłki i numer seryjny/IMEI na KAŻDEJ
// pozycji (patrz widok invoices_ready_orders w supabase/invoices.sql). Jawny przycisk "Wystaw fakturę" na liście
// w zakładce Faktury — RĘCZNY wyzwalacz, świadoma decyzja właściciela (01.10.2026): to prawdziwy dokument
// księgowo-podatkowy, nie generujemy go automatycznie bez przeglądu człowieka. Serwer NIE ufa przeglądarce —
// warunki (przesyłka + numery seryjne) są sprawdzane tu jeszcze raz, nawet jeśli UI pokazało to zamówienie z
// listy "gotowe do faktury".

export const maxDuration = 30;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Zamówienia"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  const cfg = fakturowniaConfigFromEnv();
  if (!cfg) return NextResponse.json({ error: "Brak FAKTUROWNIA_DOMAIN / FAKTUROWNIA_API_TOKEN w .env.local" }, { status: 500 });

  const b = await request.json().catch(() => null);
  const marketplace = typeof b?.marketplace === "string" ? b.marketplace : "";
  const externalId = typeof b?.externalId === "string" ? b.externalId : "";
  if (!marketplace || !externalId) return NextResponse.json({ error: "Brak marketplace/numeru zamówienia." }, { status: 400 });

  const buyerInput = b?.buyer || {};
  const buyer: InvoiceBuyerPrefill = {
    name: String(buyerInput.name || "").trim(),
    company: String(buyerInput.company || "").trim(),
    street: String(buyerInput.street || "").trim(),
    houseNumber: String(buyerInput.houseNumber || "").trim(),
    apartment: String(buyerInput.apartment || "").trim(),
    postalCode: String(buyerInput.postalCode || "").trim(),
    city: String(buyerInput.city || "").trim(),
    countryCode: String(buyerInput.countryCode || "").trim().toUpperCase(),
    taxNo: String(buyerInput.taxNo || "").trim(),
  };
  if (!(buyer.name || buyer.company)) return NextResponse.json({ error: "Podaj nabywcę: imię i nazwisko albo nazwę firmy." }, { status: 400 });
  if (!buyer.street || !buyer.postalCode || !buyer.city || buyer.countryCode.length !== 2) {
    return NextResponse.json({ error: "Uzupełnij adres nabywcy: ulica, kod pocztowy, miasto i dwuliterowy kod kraju." }, { status: 400 });
  }

  // Istniejąca faktura — sprawdzamy jawnie, żeby dać czytelny komunikat zamiast surowego błędu unikalności z bazy.
  const { data: existing } = await db.from("invoices").select("id, number").eq("marketplace", marketplace).eq("external_id", externalId).maybeSingle();
  if (existing) return NextResponse.json({ error: `To zamówienie ma już fakturę: ${existing.number || existing.id}.` }, { status: 409 });

  const { data: order, error: orderErr } = await db
    .from("sales_orders")
    .select("marketplace, external_id, order_date, tracking_number")
    .eq("marketplace", marketplace)
    .eq("external_id", externalId)
    .maybeSingle();
  if (orderErr) return NextResponse.json({ error: `Błąd odczytu zamówienia: ${orderErr.message}` }, { status: 500 });
  if (!order) return NextResponse.json({ error: "Nie ma takiego zamówienia." }, { status: 404 });
  if (!order.tracking_number) return NextResponse.json({ error: "Zamówienie nie ma jeszcze numeru przesyłki." }, { status: 400 });

  const { data: items, error: itemsErr } = await db
    .from("sales_order_items")
    .select("item_key, sku, serial_number, price, currency")
    .eq("marketplace", marketplace)
    .eq("external_id", externalId)
    .order("position", { ascending: true });
  if (itemsErr) return NextResponse.json({ error: `Błąd odczytu pozycji: ${itemsErr.message}` }, { status: 500 });
  if (!items || items.length === 0) return NextResponse.json({ error: "Zamówienie nie ma żadnych pozycji." }, { status: 400 });
  const missingSerial = items.filter((i) => !i.serial_number || !String(i.serial_number).trim());
  if (missingSerial.length > 0) {
    return NextResponse.json({ error: `Brakuje numeru seryjnego/IMEI na ${missingSerial.length} z ${items.length} pozycji.` }, { status: 400 });
  }

  const positions: InvoicePosition[] = items.map((i) => ({
    name: i.sku ? `Produkt ${i.sku}` : "Produkt",
    code: i.sku,
    additionalInfo: i.serial_number ? `Nr seryjny/IMEI: ${i.serial_number}` : null,
    totalPriceGross: Number(i.price) || 0,
    currency: i.currency || "PLN",
  }));

  const sellDate = order.order_date ? String(order.order_date).slice(0, 10) : todayIso();
  const issueDate = todayIso();

  try {
    const invoice = await createFakturowniaInvoice(cfg, buyer, positions, { sellDate, issueDate, orderNumber: externalId });
    const byEmail = (await db.auth.admin.getUserById(uid)).data.user?.email ?? null;

    const { data: saved, error: saveErr } = await db
      .from("invoices")
      .insert({
        marketplace,
        external_id: externalId,
        fakturownia_id: invoice.id,
        number: invoice.number,
        issue_date: invoice.issueDate,
        sell_date: invoice.sellDate,
        buyer_name: buyer.company || buyer.name,
        buyer_tax_no: buyer.taxNo || null,
        buyer_country: buyer.countryCode,
        total_gross: invoice.totalGross,
        currency: invoice.currency,
        created_by_user_id: uid,
        created_by_email: byEmail,
      })
      .select("id, number")
      .single();
    if (saveErr) {
      // Faktura w Fakturowni już istnieje i jest prawdziwa — nie chcemy jej "zgubić" przez błąd zapisu u nas.
      return NextResponse.json({
        ok: true,
        warning: `Faktura ${invoice.number} została wystawiona w Fakturowni, ale nie udało się jej zapisać w bazie: ${saveErr.message}. Numer faktury: ${invoice.number}.`,
        number: invoice.number,
      });
    }

    // Log zmian w zamówieniu dopisuje front-end (InvoicesView.tsx) po sukcesie, tym samym wzorcem co
    // "Zaakceptuj zamówienie" w SalesOrderCard.tsx (supabase.rpc z sesji przeglądarki, by_email ze session.user.email).
    return NextResponse.json({ ok: true, id: saved.id, number: invoice.number });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Nie udało się wystawić faktury w Fakturowni." }, { status: 502 });
  }
}
