import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAuthorized } from "@/lib/buyback";
import { requireRole } from "@/lib/serverAuth";
import { warsawMidnightUtcMs } from "@/lib/points";
import type { NbpRate } from "@/lib/nbp";
import { BUYBACK_GOODS_FROM, BUYBACK_PAID_STATUSES, buildBuybackGoods, refreshPatch, type BbIntake, type BbOrder } from "@/lib/goodsBuyback";

// Towar -> Skup (14.10.2026): dopisuje do rejestru towaru opłacone zamówienia Buyback (VALIDATED / PAID / MONEY_TRANSFERED) z datą płatności od BUYBACK_GOODS_FROM
// i uzupełnia wiersze automatyczne (numer seryjny i SKU z Trade-in -> Wprowadzanie, kurs NBP, Serwis z części). Cron co 15 min (po synchronizacji zamówień) albo ręcznie
// (Admin/Manager/Księgowa). IDEMPOTENTNE: jedno zamówienie = najwyżej jeden wiersz automatyczny (unikalny indeks), wiersze z arkusza (source = 'arkusz') nigdy nie są ruszane,
// a wiersz automatyczny jest tylko UZUPEŁNIANY — niczego niepustego nie nadpisujemy (lib/goodsBuyback.ts: refreshPatch). Reguły liczenia: lib/goodsBuyback.ts.

export const maxDuration = 60;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function GET(request: Request) {
  const db = admin();
  const ok = (await isAuthorized(request).then(async (a) => {
    if (!a) return false;
    // zalogowany użytkownik musi mieć rolę z dostępem (sekret crona przechodzi)
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return true;
    return !!(await requireRole(request, db, ["Admin", "Manager", "Księgowa"]));
  }));
  if (!ok) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  try {
    const [y, m, d] = BUYBACK_GOODS_FROM.split("-").map(Number);
    const fromIso = new Date(warsawMidnightUtcMs(y, m, d)).toISOString();

    const orders = await fetchAll<BbOrder & { status: string }>((a, b) =>
      db
        .from("buyback_orders")
        .select("order_public_id, status, payment_date, creation_date, market, sku, product_title, original_price, original_price_currency, counter_offer_price")
        .in("status", BUYBACK_PAID_STATUSES)
        .or(`payment_date.gte.${fromIso},and(payment_date.is.null,creation_date.gte.${fromIso})`)
        .order("order_public_id")
        .range(a, b)
    );
    const ids = orders.map((o) => o.order_public_id);

    const existing = new Map<string, Record<string, unknown>>();
    const intake = new Map<string, NonNullable<BbIntake>>();
    for (const part of chunks(ids, 100)) {
      const { data: g, error: ge } = await db
        .from("goods_register")
        .select("id, order_no, source, serial, name, category, country, nbp_rate, price_pln, pcc, commission, commission_pcc, costs, total_pln")
        .eq("kind", "trade_in")
        .in("order_no", part);
      if (ge) throw new Error(ge.message);
      for (const r of g || []) existing.set(String(r.order_no), r as Record<string, unknown>);
      const { data: it, error: ie } = await db.from("buyback_order_intake").select("order_public_id, serial_number, sku").in("order_public_id", part);
      if (ie) throw new Error(ie.message);
      for (const r of it || []) intake.set(String(r.order_public_id), { serial_number: r.serial_number as string | null, sku: r.sku as string | null });
    }

    const rateRows = await fetchAll<{ currency: string; rate_date: string; mid: number | string }>((a, b) => db.from("nbp_rates").select("currency, rate_date, mid").range(a, b));
    const rates: Record<string, NbpRate[]> = {};
    for (const r of rateRows) (rates[r.currency] ||= []).push({ currency: r.currency, rateDate: r.rate_date, mid: Number(r.mid) });

    // Serwis = koszt części przypisanych do numeru seryjnego (jak w Marży: pole z kilkoma numerami dzieli koszt po równo, "Demontaż" nie jest kosztem)
    const serviceBySerial = new Map<string, number>();
    const parts = await fetchAll<{ device_ref: string | null; price_pln: number | string | null; status: string | null }>((a, b) =>
      db.from("service_parts").select("device_ref, price_pln, status").not("device_ref", "is", null).order("id").range(a, b)
    ).catch(() => []);
    for (const p of parts) {
      if (p.price_pln === null || p.price_pln === undefined || (p.status || "").toLowerCase().startsWith("demonta")) continue;
      const tokens = (p.device_ref || "").split(/[\s,;]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
      for (const t of tokens) serviceBySerial.set(t, (serviceBySerial.get(t) || 0) + Number(p.price_pln) / tokens.length);
    }

    const toInsert: Record<string, unknown>[] = [];
    let updated = 0;
    let skippedSheet = 0;
    let unchanged = 0;
    let noRate = 0;
    let noSerial = 0;
    for (const o of orders) {
      const it = intake.get(o.order_public_id) ?? null;
      const serial = (it?.serial_number || "").trim().toUpperCase();
      const built = buildBuybackGoods(o, it, rates, serial ? serviceBySerial.get(serial) ?? null : null);
      if (built.price_pln === null) noRate++;
      if (!serial) noSerial++;
      const ex = existing.get(o.order_public_id);
      if (!ex) {
        toInsert.push({ kind: "trade_in", source: "buyback", created_by_email: "Buyback (auto)", ...built });
        continue;
      }
      if (ex.source !== "buyback") {
        skippedSheet++; // zamówienie jest już w arkuszu — wiersz zamrożony
        continue;
      }
      const patch = refreshPatch(ex, built);
      if (Object.keys(patch).length === 0) {
        unchanged++;
        continue;
      }
      const { error } = await db.from("goods_register").update(patch).eq("id", ex.id as number);
      if (error) throw new Error(error.message);
      updated++;
    }

    let created = 0;
    for (const batch of chunks(toInsert, 100)) {
      const { error } = await db.from("goods_register").insert(batch);
      if (!error) {
        created += batch.length;
        continue;
      }
      if (error.code !== "23505") throw new Error(error.message);
      for (const row of batch) {
        // równoległy przebieg dopisał to zamówienie — pomijamy tylko duplikat
        const r = await db.from("goods_register").insert(row);
        if (!r.error) created++;
        else if (r.error.code !== "23505") throw new Error(r.error.message);
      }
    }

    return NextResponse.json({ ok: true, from: BUYBACK_GOODS_FROM, candidates: orders.length, created, updated, unchanged, skippedSheet, noRate, noSerial });
  } catch (e: any) {
    const msg = e?.message || "Błąd synchronizacji Skupu.";
    // brak kolumn (nieuruchomiony supabase/goods-buyback.sql) — czytelny komunikat zamiast surowego błędu bazy
    if (/source|commission/.test(msg) && /column|schema cache/i.test(msg)) return NextResponse.json({ error: "Brak kolumn source/commission — uruchom supabase/goods-buyback.sql w Supabase." }, { status: 500 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
