import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { IMAGE_TYPES, INVOICE_MAX_BYTES, TEXT_EXTS, parseInvoiceWithClaude } from "@/lib/partsInvoice";
import { nbpRateFor } from "@/lib/partsServer";

// Odczyt faktury zakupu (Serwis -> Części -> "Importuj z faktury", 06.10.2026): plik -> model Claude -> lista pozycji do poprawienia
// i akceptacji w przeglądarce. NIC nie zapisuje w bazie (zapis dopiero po akceptacji: parts/import). Dla walut innych niż PLN dolicza
// kurs średni NBP z ostatniego dnia roboczego PRZED datą faktury (ta sama zasada księgowa co w reszcie aplikacji).

export const maxDuration = 120;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ["Admin", "Manager", "Serwis", "Kierownik serwisu"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Brak ANTHROPIC_API_KEY — odczyt faktur wymaga klucza (ten sam co dla zakładki AI). Dodaj pozycje ręcznie." }, { status: 500 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Brak pliku." }, { status: 400 });
  if (file.size > INVOICE_MAX_BYTES) return NextResponse.json({ error: `Plik jest za duży (${(file.size / 1e6).toFixed(1)} MB, max ${(INVOICE_MAX_BYTES / 1e6).toFixed(1)} MB) — zmniejsz go albo podziel.` }, { status: 413 });

  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());
  let input: { name: string; mediaType: string; base64?: string; text?: string };
  if (ext === "pdf" || file.type === "application/pdf") input = { name: file.name, mediaType: "application/pdf", base64: buf.toString("base64") };
  else if (IMAGE_TYPES[ext]) input = { name: file.name, mediaType: IMAGE_TYPES[ext], base64: buf.toString("base64") };
  else if (TEXT_EXTS.includes(ext)) input = { name: file.name, mediaType: "text/plain", text: buf.toString("utf8").slice(0, 200_000) };
  else return NextResponse.json({ error: "Nieobsługiwany format. Wgraj PDF, zdjęcie (JPG/PNG/WebP) albo CSV/TXT. Pliki Excela zapisz jako PDF lub CSV." }, { status: 415 });

  try {
    const { invoice, usage } = await parseInvoiceWithClaude({ apiKey, model: process.env.AI_MODEL || "claude-sonnet-5-5", file: input });
    const rate = await nbpRateFor(invoice.currency, invoice.invoiceDate);
    return NextResponse.json({ ok: true, invoice, rate, usage });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Nie udało się odczytać faktury." }, { status: 502 });
  }
}
