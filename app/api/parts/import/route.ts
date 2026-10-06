import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { codeRanges, expandToRows, validateImport } from "@/lib/partsInvoice";

// Zapis zaakceptowanych pozycji do service_parts (Serwis -> Części -> "Importuj z faktury", 06.10.2026). Tabela nie ma polityki insert
// (dane zakupowe są niezmienne dla zalogowanych), więc zapisuje serwer. Serwer waliduje wszystko jeszcze raz i pilnuje duplikatów faktury.

export const maxDuration = 60;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin", "Manager", "Serwis", "Kierownik serwisu"]);
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const body = await request.json().catch(() => null);
  const v = validateImport(body);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });
  const d = v.data;

  // Ta sama faktura tego dostawcy już w bazie? Bez potwierdzenia (force) nie dublujemy.
  if (d.invoiceNo && body?.force !== true) {
    let q = db.from("service_parts").select("id", { count: "exact", head: true }).ilike("invoice_no", d.invoiceNo.replace(/[%_\\]/g, "\\$&"));
    if (d.supplier) q = q.ilike("supplier", d.supplier.replace(/[%_\\]/g, "\\$&"));
    const { count, error } = await q;
    if (error && error.code === "42P01") return NextResponse.json({ error: "Brak tabeli części — uruchom supabase/service-parts.sql." }, { status: 500 });
    if ((count ?? 0) > 0) return NextResponse.json({ duplicate: true, count, error: `Faktura ${d.invoiceNo} ${d.supplier ? `(${d.supplier}) ` : ""}jest już w bazie (${count} wierszy).` }, { status: 409 });
  }

  const { data: u } = await db.auth.admin.getUserById(uid);
  const rows = expandToRows(d, u?.user?.email ?? null);
  // Kody części nadaje baza (service_parts_import: kolejno, atomowo, razem z zapisem wierszy w jednej transakcji).
  const { data: codes, error } = await db.rpc("service_parts_import", { p_rows: rows });
  if (error) {
    const missing = error.code === "PGRST202" || error.code === "42883" || /service_parts_import/.test(error.message) && /could not find|does not exist/i.test(error.message);
    return NextResponse.json({ error: missing ? "Brak funkcji nadającej kody części — uruchom ponownie supabase/service-parts.sql w Supabase (SQL Editor)." : `Nie udało się zapisać: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, saved: rows.length, items: d.items.length, ranges: codeRanges(d.items, codes as string[]) });
}

// Podgląd pierwszego wolnego kodu (nieblokujący — ostateczne numery nadaje zapis).
export async function GET(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ["Admin", "Manager", "Serwis", "Kierownik serwisu"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const { data, error } = await db.rpc("service_parts_next_code");
  if (error) return NextResponse.json({ ok: true, next: null });
  return NextResponse.json({ ok: true, next: String(data) });
}
