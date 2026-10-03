import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { parseCsv } from "@/lib/csv";

// Wgranie faktury tygodniowej Back Market (CSV "invoice_YYYYMMDD-EU-H-NNNNNNNN.csv", kolumny: invoice_key, value_date, sku, order_id,
// designation, amount, currency) do bm_invoice_lines — podstawa DOKŁADNEJ prowizji BM per zamówienie i średnich stawek (lib/margin.ts).
// Ponowne wgranie tego samego pliku jest bezpieczne: wiersze mają klucz (invoice_ref, line_no), upsert nie dubluje. Admin i Manager.

export const maxDuration = 60;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const EXPECTED = ["invoice_key", "value_date", "sku", "order_id", "designation", "amount", "currency"];

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  const body = await request.json().catch(() => null);
  const filename = String(body?.filename || "");
  const csv = typeof body?.csv === "string" ? body.csv : "";
  const m = /(\d{8}-EU-[A-Za-z]-\d+)/.exec(filename);
  if (!m) return NextResponse.json({ error: "Nazwa pliku powinna zawierać numer faktury, np. invoice_20260915-EU-H-10047685.csv." }, { status: 400 });
  const invoiceRef = m[1];

  const table = parseCsv(csv);
  if (table.length < 2) return NextResponse.json({ error: "Plik jest pusty." }, { status: 400 });
  const header = table[0].map((h) => h.trim().toLowerCase());
  if (EXPECTED.some((h, i) => header[i] !== h)) {
    return NextResponse.json({ error: `Nieoczekiwane kolumny. Oczekiwane: ${EXPECTED.join(", ")}.` }, { status: 400 });
  }

  const email = (await db.auth.admin.getUserById(uid)).data.user?.email ?? null;
  const records: Record<string, unknown>[] = [];
  for (let i = 1; i < table.length; i++) {
    const [invoice_key, value_date, sku, order_id, designation, amount, currency] = table[i];
    const n = Number(amount);
    if (!invoice_key?.trim() || !Number.isFinite(n)) continue;
    records.push({
      invoice_ref: invoiceRef,
      line_no: i,
      invoice_key: invoice_key.trim(),
      value_date: value_date?.trim() || null,
      sku: sku?.trim() || null,
      order_id: order_id?.trim() || null,
      designation: designation?.trim() || null,
      amount: n,
      currency: currency?.trim() || null,
      uploaded_by_email: email,
    });
  }
  if (records.length === 0) return NextResponse.json({ error: "Nie znaleziono żadnych poprawnych wierszy." }, { status: 400 });

  for (let i = 0; i < records.length; i += 500) {
    const { error } = await db.from("bm_invoice_lines").upsert(records.slice(i, i + 500), { onConflict: "invoice_ref,line_no" });
    if (error) return NextResponse.json({ error: `Błąd zapisu: ${error.message}. Czy uruchomiono supabase/margin.sql?` }, { status: 500 });
  }
  const orders = new Set(records.map((r) => r.order_id).filter(Boolean)).size;
  return NextResponse.json({ ok: true, invoiceRef, lines: records.length, orders });
}
