import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";
import { requireRole } from "@/lib/serverAuth";
import { detectOwnTaxNo, mapCostInvoice } from "@/lib/costInvoices";

// Finanse -> Faktury kosztowe (14.10.2026): pobiera z Fakturowni faktury kosztowe (wydatki, GET /invoices.json?income=no — także te, które Fakturownia
// sama ściąga z KSeF) do tabeli cost_invoices. Cron co 3 h (vercel.json) i przycisk "Odśwież z Fakturowni" (Admin/Manager/Księgowa). IDEMPOTENTNE (upsert po id
// dokumentu). Pierwszy przebieg pobiera od 01.01.2026, kolejne ostatnie 120 dni (Fakturownia nie ma filtra "zmienione od", a faktura może zmienić status płatności).
// Nie testowane na żywym API z tego środowiska (lokalny token jest odrzucany) — mapowanie wg dokumentacji i tolerancyjne, cała odpowiedź zapisuje się w `raw`.

export const maxDuration = 60;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const FIRST_FROM = "2026-01-01";
const PER_PAGE = 100;
const MAX_PAGES = 60;

export async function GET(request: Request) {
  const db = admin();
  const authorized = await isAuthorized(request).then(async (a) => {
    if (!a) return false;
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return true;
    return !!(await requireRole(request, db, ["Admin", "Manager", "Księgowa"]));
  });
  if (!authorized) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  const domain = process.env.FAKTUROWNIA_DOMAIN;
  const token = process.env.FAKTUROWNIA_API_TOKEN;
  if (!domain || !token) return NextResponse.json({ error: "Brak FAKTUROWNIA_DOMAIN / FAKTUROWNIA_API_TOKEN w zmiennych środowiskowych." }, { status: 500 });

  const fail = async (message: string, status = 500) => {
    await db.from("cost_invoices_sync_meta").upsert({ id: 1, last_error: message });
    return NextResponse.json({ error: message }, { status });
  };

  try {
    const { count: existing, error: cErr } = await db.from("cost_invoices").select("fakturownia_id", { count: "exact", head: true });
    if (cErr) {
      if (cErr.code === "42P01" || cErr.code === "PGRST205") return NextResponse.json({ error: "Brak tabeli cost_invoices — uruchom supabase/cost-invoices.sql w Supabase." }, { status: 500 });
      throw new Error(cErr.message);
    }
    const today = new Date().toISOString().slice(0, 10);
    const since = !existing ? FIRST_FROM : new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
    const all: Record<string, unknown>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url =
        `https://${domain}.fakturownia.pl/invoices.json?api_token=${encodeURIComponent(token)}&income=no&period=more` +
        `&date_from=${since}&date_to=${today}&per_page=${PER_PAGE}&page=${page}`;
      const res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!res.ok) {
        const body = await res.text();
        return fail(`Fakturownia odpowiedziała ${res.status}: ${body.slice(0, 180).replace(/api_token=[^&"\s]+/g, "api_token=***")}`, 502);
      }
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) return fail("Nieoczekiwana odpowiedź Fakturowni (to nie lista faktur).", 502);
      all.push(...(data as Record<string, unknown>[]));
      if (data.length < PER_PAGE) break;
    }
    // tylko faktury kosztowe (income = 0 / no / false); dokument bez tego pola zakładamy za kosztowy, bo pytaliśmy o income=no
    const costs = all.filter((i) => {
      const v = String(i.income ?? "").toLowerCase();
      return v === "" || v === "0" || v === "no" || v === "false";
    });
    const own = detectOwnTaxNo(costs);
    const rows = costs.map((i) => mapCostInvoice(i, domain, own)).filter((r): r is NonNullable<typeof r> => r !== null);
    // jedna operacja upsert nie może zawierać dwóch wierszy o tym samym kluczu
    const byId = new Map(rows.map((r) => [r.fakturownia_id, r]));
    const unique = Array.from(byId.values());
    for (let i = 0; i < unique.length; i += 200) {
      const { error } = await db.from("cost_invoices").upsert(unique.slice(i, i + 200), { onConflict: "fakturownia_id" });
      if (error) throw new Error(error.message);
    }
    await db.from("cost_invoices_sync_meta").upsert({ id: 1, last_synced_at: new Date().toISOString(), last_count: unique.length, last_error: null });
    return NextResponse.json({
      ok: true,
      from: since,
      fetched: all.length,
      saved: unique.length,
      ksef: unique.filter((r) => r.from_ksef).length,
      ownTaxNo: own.taxNo ? `${own.taxNo.slice(0, 3)}…` : null,
      supplierSide: own.side === "seller" ? "buyer_*" : "seller_*",
    });
  } catch (e: any) {
    return fail(e?.message || "Błąd pobierania faktur kosztowych.");
  }
}
