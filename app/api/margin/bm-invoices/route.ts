import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";

// Lista zaimportowanych faktur Back Market (zakładka Marża -> "Faktury BM", 08.10.2026): jedna faktura = jeden plik CSV wgrany przez /api/margin/bm-invoice.
// Agregujemy bm_invoice_lines po invoice_ref (liczba wierszy i zamówień, okres, sumy wg rodzaju opłaty, kto i kiedy wgrał). Admin i Manager.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

type Line = { invoice_ref: string; invoice_key: string; order_id: string | null; value_date: string | null; amount: number | string; currency: string | null; uploaded_by_email: string | null; uploaded_at: string };

export async function GET(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ["Admin", "Manager"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  const lines: Line[] = [];
  for (let from = 0; from < 200_000; from += 1000) {
    const { data, error } = await db
      .from("bm_invoice_lines")
      .select("invoice_ref, invoice_key, order_id, value_date, amount, currency, uploaded_by_email, uploaded_at")
      .order("id")
      .range(from, from + 999);
    if (error) return NextResponse.json({ error: `${error.message}. Czy uruchomiono supabase/margin.sql?` }, { status: 500 });
    lines.push(...((data as Line[]) || []));
    if (!data || data.length < 1000) break;
  }

  const byRef = new Map<string, { invoiceRef: string; lines: number; orders: Set<string>; firstDate: string | null; lastDate: string | null; uploadedAt: string; uploadedBy: string | null; currency: string | null; sums: Record<string, number> }>();
  for (const l of lines) {
    let inv = byRef.get(l.invoice_ref);
    if (!inv) byRef.set(l.invoice_ref, (inv = { invoiceRef: l.invoice_ref, lines: 0, orders: new Set(), firstDate: null, lastDate: null, uploadedAt: l.uploaded_at, uploadedBy: l.uploaded_by_email, currency: l.currency, sums: {} }));
    inv.lines++;
    if (l.order_id) inv.orders.add(l.order_id);
    if (l.value_date) {
      if (!inv.firstDate || l.value_date < inv.firstDate) inv.firstDate = l.value_date;
      if (!inv.lastDate || l.value_date > inv.lastDate) inv.lastDate = l.value_date;
    }
    if (l.uploaded_at > inv.uploadedAt) {
      inv.uploadedAt = l.uploaded_at; // ostatnie wgranie tego pliku
      inv.uploadedBy = l.uploaded_by_email;
    }
    inv.sums[l.invoice_key] = (inv.sums[l.invoice_key] || 0) + Number(l.amount);
  }
  // numer faktury zaczyna się od daty (YYYYMMDD-EU-...), więc malejąco = najnowsze pierwsze
  const invoices = Array.from(byRef.values())
    .map((i) => ({ invoiceRef: i.invoiceRef, lines: i.lines, orders: i.orders.size, firstDate: i.firstDate, lastDate: i.lastDate, uploadedAt: i.uploadedAt, uploadedBy: i.uploadedBy, currency: i.currency, sums: i.sums }))
    .sort((a, b) => b.invoiceRef.localeCompare(a.invoiceRef));
  return NextResponse.json({ ok: true, invoices });
}
