import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { expandToRows, validateImport } from "@/lib/partsInvoice";

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
  let withEmail = true;
  for (let i = 0; i < rows.length; i += 200) {
    let chunk: Record<string, unknown>[] = rows.slice(i, i + 200);
    if (!withEmail) chunk = chunk.map(({ created_by_email, ...rest }) => rest);
    let { error } = await db.from("service_parts").insert(chunk);
    if (error && error.code === "42703" && withEmail) {
      // kolumna created_by_email (service-parts.sql) jeszcze nie istnieje — zapis bez niej
      withEmail = false;
      ({ error } = await db.from("service_parts").insert(chunk.map(({ created_by_email, ...rest }) => rest)));
    }
    if (error) {
      return NextResponse.json({ error: `Zapis przerwany po ${i} z ${rows.length} wierszy: ${error.message}${i > 0 ? " — część wierszy już jest w bazie, sprawdź listę przed ponowieniem." : ""}` }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, saved: rows.length, items: d.items.length });
}
