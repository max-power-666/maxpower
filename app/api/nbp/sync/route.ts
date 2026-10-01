import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { NBP_CURRENCIES, fetchNbpRateRange } from "@/lib/nbp";

// Synchronizuje kursy walut z NBP (tabela A) do nbp_rates. Wywoływane przez: (1) Vercel Cron raz dziennie
// (NBP publikuje raz na dzień roboczy, zwykle ok. południa — patrz vercel.json), (2) przycisk "Odśwież"
// w zakładce NBP. Backfill: pierwszy przebieg (brak wierszy dla danej waluty) pobiera ostatnie 60 dni —
// z zapasem na "kurs z dnia poprzedniego" na początku 30-dniowego okna Przeglądu (lib/overview.ts); kolejne
// przebiegi dociągają tylko od ostatniego zsynchronizowanego dnia.

export const maxDuration = 30;

const BACKFILL_DAYS = 60;

function supabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function isAuthorized(request: Request): Promise<boolean> {
  const header = request.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return true;
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data } = await anon.auth.getUser(token);
  return !!data?.user;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const today = isoDate(new Date());
  const result: Record<string, { from: string; to: string; fetched: number } | { error: string }> = {};

  for (const currency of NBP_CURRENCIES) {
    try {
      const { data: last } = await admin
        .from("nbp_rates")
        .select("rate_date")
        .eq("currency", currency)
        .order("rate_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      const from = last?.rate_date
        ? isoDate(new Date(new Date(last.rate_date).getTime() + 24 * 3600 * 1000))
        : isoDate(new Date(Date.now() - BACKFILL_DAYS * 24 * 3600 * 1000));

      if (from > today) {
        result[currency] = { from, to: today, fetched: 0 };
        continue;
      }

      const rates = await fetchNbpRateRange(currency, from, today);
      if (rates.length > 0) {
        const { error } = await admin
          .from("nbp_rates")
          .upsert(rates.map((r) => ({ currency: r.currency, rate_date: r.rateDate, mid: r.mid })));
        if (error) throw error;
      }
      result[currency] = { from, to: today, fetched: rates.length };
    } catch (e: any) {
      result[currency] = { error: e?.message || "Błąd synchronizacji NBP." };
    }
  }

  return NextResponse.json({ ok: true, result });
}
