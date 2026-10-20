// Wspólne, serwerowe ładowanie i liczenie marży (używają go route'y margin/list i margin/summary — jedna definicja, te same liczby w zakładce Marża i na Przeglądzie).
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCountedOrder } from "@/lib/salesOrders";
import { computeMargin, deriveBmRates, bmOrderExtras, inPeriod, MARGIN_MARKETPLACES, type BmLine, type BmRates, type MarginDbRow, type MarginResult, type ServicePart, type LaborEntry, LABOR_MAX_HOURS, laborKey } from "@/lib/margin";
import type { NbpRate } from "@/lib/nbp";
import { loadFeeRates, type FeeRateResult } from "@/lib/feeRates";

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

// Części z Serwis -> Części przypisane do urządzeń, zgrupowane po numerze seryjnym (WIELKIE litery). Brak tabeli (nieuruchomione service-parts.sql) = pusta mapa.
// Od 16.10.2026 (przyspieszenie zakładki Marża) pobieramy TYLKO części przypisane do numerów sprzedanych sztuk z bieżącego wyniku (zamiast całej tabeli, ~12 tys. wierszy), plus ewentualne wiersze
// z kilkoma numerami w jednym polu (rozdzielone spacją/przecinkiem/średnikiem — dziś żadnych nie ma, ale kod to obsługuje).
async function loadPartsBySerial(db: SupabaseClient<any, any, any>, serials: string[]): Promise<{ map: Map<string, ServicePart[]>; available: boolean }> {
  const map = new Map<string, ServicePart[]>();
  type PartRow = { id: number; device_ref: string; name: string | null; price_pln: number | string | null; received_at: string | null; status: string | null };
  const SEL = "id, device_ref, name, price_pln, received_at, status";
  try {
    const byId = new Map<number, PartRow>();
    const chunks: string[][] = [];
    for (let i = 0; i < serials.length; i += 200) chunks.push(serials.slice(i, i + 200));
    // numery w service_parts.device_ref są zapisane WIELKIMI literami i bez spacji (trigger service_parts_guard + import) — dokładne dopasowanie .in() jest szybkie (ilike w pętli było ~10x wolniejsze)
    const runChunk = async (chunk: string[]) => {
      const { data, error } = await db.from("service_parts").select(SEL).in("device_ref", chunk).limit(5000);
      if (error) throw new Error(error.message);
      for (const r of (data as PartRow[]) || []) byId.set(r.id, r);
    };
    for (let i = 0; i < chunks.length; i += 6) await Promise.all(chunks.slice(i, i + 6).map(runChunk));
    const multi = await db.from("service_parts").select(SEL).or('device_ref.like."*,*",device_ref.like."* *",device_ref.like."*;*"').limit(5000);
    if (multi.error) throw new Error(multi.error.message);
    for (const r of (multi.data as PartRow[]) || []) byId.set(r.id, r);
    const want = new Set(serials);
    for (const r of [...byId.values()].sort((x, y) => x.id - y.id)) {
      const tokens = (r.device_ref || "").split(/[\s,;]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
      for (const t of tokens) {
        if (!want.has(t)) continue;
        const list = map.get(t) ?? [];
        list.push({ name: r.name, pln: r.price_pln === null ? null : Number(r.price_pln), receivedAt: r.received_at, status: r.status, share: 1 / tokens.length });
        map.set(t, list);
      }
    }
    return { map, available: true };
  } catch (e: any) {
    // brak tabeli (nieuruchomione service-parts.sql) = serwis 0 jak dotąd; każdy INNY błąd ma być widoczny, a nie po cichu zerować koszt serwisu (błąd z 16.10.2026: zapytanie o wiele numerów miało zły zapis)
    if (/service_parts/.test(String(e?.message)) && /does not exist|schema cache|42P01|PGRST205/.test(String(e?.message))) return { map, available: false };
    throw e;
  }
}

// Koszty pracy (20.10.2026): zakończone wpisy z Serwisu (naprawy), Testów i Trade-in (obsługa paczek) dla numerów sprzedanych sztuk × koszt godziny pracownika z tabeli płac (payroll_rates:
// (kwota z umowy + składki pracodawcy) ÷ godziny, ostatni okres danej osoby). Brak tabeli płac (nieuruchomione payroll-rates.sql) = null i koszty pracy nie są liczone.
async function loadLaborBySerial(db: SupabaseClient<any, any, any>, keys: Set<string>): Promise<Map<string, LaborEntry[]> | undefined> {
  const norm = (n: string | null | undefined) => (n || "").trim().toLowerCase().replace(/\s+/g, " ");
  const pay = await db.from("payroll_rates").select("period, person_name, hours, payout, employer_costs").order("period", { ascending: false });
  if (pay.error) return undefined; // brak tabeli albo brak dostępu — bez stawek nie liczymy
  const rateByName = new Map<string, number>(); // pierwszy (najnowszy okres) wygrywa
  for (const r of (pay.data as { person_name: string; hours: number | string; payout: number | string; employer_costs: number | string | null }[]) || []) {
    const k = norm(r.person_name);
    const h = Number(r.hours);
    if (!rateByName.has(k) && h > 0) rateByName.set(k, (Number(r.payout) + Number(r.employer_costs || 0)) / h);
  }
  const mem = await db.from("members").select("email, name");
  const byEmail = new Map<string, { name: string; rate: number | null }>();
  for (const m of (mem.data as { email: string | null; name: string | null }[]) || []) {
    if (!m.email) continue;
    const full = (m.name || "").trim();
    const parts = full.split(/\s+/);
    const short = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : full || m.email;
    byEmail.set(m.email.toLowerCase(), { name: short, rate: rateByName.get(norm(m.name)) ?? null });
  }
  const map = new Map<string, LaborEntry[]>();
  const add = (area: LaborEntry["area"], serial: string | null, email: string | null, startedAt: string | null, finishedAt: string | null, pausedSeconds = 0) => {
    const key = laborKey(serial);
    if (!key || !keys.has(key) || !startedAt || !finishedAt) return;
    const raw = (Date.parse(finishedAt) - Date.parse(startedAt)) / 3_600_000 - pausedSeconds / 3600;
    if (!(raw > 0)) return;
    const who = email ? byEmail.get(email.toLowerCase()) : undefined;
    const list = map.get(key) ?? [];
    list.push({ area, who: who?.name ?? email ?? null, startedAt, hours: Math.min(raw, LABOR_MAX_HOURS), rawHours: raw, costPerHour: who?.rate ?? null });
    map.set(key, list);
  };
  const [svc, tst, intake] = await Promise.all([
    fetchAll<{ device_ref: string | null; employee_email: string | null; started_at: string | null; finished_at: string | null; paused_seconds: number | null }>((f, t) => db.from("service_log").select("device_ref, employee_email, started_at, finished_at, paused_seconds").order("id").range(f, t)).catch(() => []),
    fetchAll<{ serial_number: string | null; employee_email: string | null; started_at: string | null; finished_at: string | null }>((f, t) => db.from("test_log").select("serial_number, employee_email, started_at, finished_at").order("id").range(f, t)).catch(() => []),
    fetchAll<{ serial_number: string | null; entered_by_email: string | null; entered_at: string | null; finished_at: string | null }>((f, t) => db.from("buyback_order_intake").select("serial_number, entered_by_email, entered_at, finished_at").order("order_public_id").range(f, t)).catch(() => []),
  ]);
  for (const r of svc) add("serwis", r.device_ref, r.employee_email, r.started_at, r.finished_at, r.paused_seconds || 0);
  for (const r of tst) add("testy", r.serial_number, r.employee_email, r.started_at, r.finished_at);
  for (const r of intake) add("trade_in", r.serial_number, r.entered_by_email, r.entered_at, r.finished_at);
  return map;
}

export type MarginRange = { from: string; to: string } | null;
type Loaded = { results: MarginResult[]; bmRates: BmRates | null; invoiceCount: number; purchasesCount: number; feeRates: Record<string, FeeRateResult> | null };
// Pamięć podręczna wyniku (16.10.2026): przejście na kolejną stronę / zmiana filtra w Marży woła serwer ponownie, a liczenie trwa kilka sekund — wynik trzymamy w pamięci instancji przez 60 s
// (klucz = zakres dat) i z całego okresu wyprowadzamy zakresy. Przycisk "Odśwież" w Marży pomija pamięć (fresh). Po zmianie ceny w Towarze zmiana widoczna najpóźniej po minucie.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; data: Loaded }>();
const rangeKey = (r: MarginRange) => (r ? `${r.from}|${r.to}` : "all");
const dayBefore = (ymd: string, delta: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + delta * 86_400_000).toISOString();

export async function loadMarginResults(db: SupabaseClient<any, any, any>, opts: { range?: MarginRange; fresh?: boolean } = {}): Promise<Loaded> {
  const range = opts.range ?? null;
  const now = Date.now();
  if (!opts.fresh) {
    const hit = cache.get(rangeKey(range));
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.data;
    const all = cache.get("all");
    if (range && all && now - all.at < CACHE_TTL_MS) return { ...all.data, results: all.data.results.filter((r) => inPeriod(r.orderDate, range)) };
  }
  const [rowsRaw, rateRows, lines] = await Promise.all([
    // zakres dat zawężamy już w bazie (widok margin_items liczy się dla każdego wiersza osobno, więc mniej wierszy = szybciej); dokładny podział na dni wg czasu polskiego robi potem inPeriod,
    // dlatego zapas po dobie z każdej strony (strefa czasowa)
    fetchAll<MarginDbRow>((from, to) => {
      let q = db.from("margin_items").select("*").in("marketplace", [...MARGIN_MARKETPLACES]);
      if (range) q = q.gte("order_date", dayBefore(range.from, -1)).lt("order_date", dayBefore(range.to, 2));
      return q.order("order_id").order("position").range(from, to);
    }),
    fetchAll<{ currency: string; rate_date: string; mid: number | string }>((from, to) => db.from("nbp_rates").select("currency, rate_date, mid").in("currency", ["EUR", "DKK", "CZK"]).range(from, to)),
    fetchAll<BmLine & { invoice_ref: string }>((from, to) => db.from("bm_invoice_lines").select("invoice_ref, invoice_key, order_id, amount, sku, designation").order("id").range(from, to)).catch(() => [] as (BmLine & { invoice_ref: string })[]),
  ]);
  // Allegro: tylko sprzedaż do Polski w PLN (16.10.2026, na prośbę właściciela — zagranicznej sprzedaży w HUF/CZK/EUR już nie prowadzimy); starsze zamówienia zagraniczne nie wchodzą do Marży
  const counted = rowsRaw.filter((r) => isCountedOrder(r.marketplace, r.status) && (r.marketplace !== "allegro" || (String(r.currency || "PLN").toUpperCase() === "PLN" && (!r.country_code || r.country_code.toUpperCase() === "PL"))));
  const [parts, purchases, fees, labor] = await Promise.all([
    loadPartsBySerial(db, Array.from(new Set(counted.map((r) => (r.serial_number || "").trim().toUpperCase()).filter(Boolean)))),
    // ile pozycji ma rejestr Towar (źródło cen zakupu od 14.10.2026) — gdy 0, zakładka podpowiada, że ceny zakupu są puste
    db.from("goods_register").select("id", { count: "exact", head: true }),
    // średnie stawki prowizji Allegro/Erli z faktur kosztowych (tylko gdy w wyniku są pozycje tych kanałów); błąd tego liczenia nie psuje reszty marży
    counted.some((r) => r.marketplace === "allegro" || r.marketplace === "erli") ? loadFeeRates(db).catch(() => null) : Promise.resolve(null),
    loadLaborBySerial(db, new Set(counted.map((r) => laborKey(r.serial_number)).filter(Boolean))).catch(() => undefined),
  ]);
  const toRates = (cur: string): NbpRate[] => rateRows.filter((r) => r.currency === cur).map((r) => ({ currency: r.currency, rateDate: r.rate_date, mid: Number(r.mid) }));
  const bmRates = deriveBmRates(lines);
  const feeRates: Record<string, { pct: number; window: string[] }> = {};
  if (fees) for (const r of Object.values(fees.rates)) if (r.pct !== null) feeRates[r.marketplace] = { pct: r.pct, window: r.window };
  const ctx = { eurRates: toRates("EUR"), dkkRates: toRates("DKK"), czkRates: toRates("CZK"), bmRates, bmOrderExtras: bmOrderExtras(lines), partsBySerial: parts.available ? parts.map : undefined, laborBySerial: labor, feeRates };
  // tylko zamówienia, które liczą się jako sprzedaż (bez anulowanych/zwróconych/nieopłaconych — ten sam isCountedOrder co Przegląd)
  const results = counted.map((r) => computeMargin(r, ctx)).filter((r) => inPeriod(r.orderDate, range));
  const data: Loaded = { results, bmRates, invoiceCount: new Set(lines.map((l) => l.invoice_ref)).size, purchasesCount: purchases.count ?? 0, feeRates: fees ? fees.rates : null };
  cache.set(rangeKey(range), { at: now, data });
  return data;
}

export type MarginAgg = { count: number; withMargin: number; sale: number; margin: number; incomplete: number };
export const emptyAgg = (): MarginAgg => ({ count: 0, withMargin: 0, sale: 0, margin: 0, incomplete: 0 });

// Agregat marży: liczone tylko pozycje z policzoną marżą (sprzedaż i marża sumowane po TYCH SAMYCH pozycjach, żeby procent był spójny); incomplete = z ostrzeżeniami.
export function aggregateMargin(results: MarginResult[]): MarginAgg {
  const a = emptyAgg();
  for (const r of results) {
    a.count += 1;
    if (r.marginPln === null || r.salePln === null) continue;
    a.withMargin += 1;
    a.sale += r.salePln;
    a.margin += r.marginPln;
    if (r.flags.length > 0) a.incomplete += 1;
  }
  return a;
}
