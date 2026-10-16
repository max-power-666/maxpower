// Średnia prowizja Allegro i Erli z faktur kosztowych (16.10.2026, na prośbę właściciela — "zacząć liczyć marżę dla allegro i erli; faktury z KSeF z 3 ostatnich miesięcy dla każdego z marketplaceów,
// na tej podstawie uśredniona prowizja"). Źródło: faktury kosztowe pobrane z Fakturowni (cost_invoices) od Allegro sp. z o.o. i ERLI S.A., sprzedaż: zamówienia z naszej bazy.
//  - Stawka = SUMA faktur netto z 3 ostatnich kompletnych miesięcy ÷ SUMA sprzedaży (cena brutto pozycji zamówień liczonych jako sprzedaż, w PLN) z tych samych miesięcy. Prowizja marketplace'u jest
//    naliczana od ceny brutto, więc stawka jest wprost mnożnikiem ceny sprzedaży brutto w Marży (tak jak stawki Back Market).
//  - Miesiąc faktury = miesiąc rozliczenia z numeru faktury (Allegro: .../2026/09, Erli: FV-A-2026-08-...), a nie data wystawienia (faktury za miesiąc przychodzą 1.–3. dnia następnego).
//  - Allegro: liczymy tylko miesięczną fakturę opłat dla Polski w PLN (seria "/PL/N/PLN/"). Pomijamy małe faktury zaliczkowe/korekty (serie P, NP, NC — razem poniżej 2% kwoty), faktury w walutach i
//    krajach innych niż PL (CZ, SK, HU — marginalne) oraz faktury "FV26-…"/"ET26-…" (kwoty okrągłe 220/660/1100 zł brutto — wyglądają na doładowania Allegro Ads, czyli reklamę, nie prowizję;
//    wyświetlamy je osobno jako pominięte).
//  - Erli: dwie miesięczne faktury, FV-A-… i FV-P-… — liczymy obie razem (koszty marketplace'u), a w tabeli pokazujemy każdą osobno; faktury nie mają opisu pozycji w naszej bazie, więc nie wiemy, która
//    to dokładnie prowizja, a która np. opłata za przesyłki — dlatego nazywamy wynik "prowizją i opłatami".
//  - Miesiąc jest kompletny, gdy ma wszystkie wymagane faktury (Allegro: seria N; Erli: A i P) i sprzedaż; w oknie bierzemy 3 najnowsze kompletne miesiące przed bieżącym.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCountedOrder } from "./salesOrders";
import { warsawDate } from "./nbp";

export const FEE_MARKETPLACES = ["allegro", "erli"] as const;
export type FeeMarketplace = (typeof FEE_MARKETPLACES)[number];
export const FEE_WINDOW_MONTHS = 3;

export type FeeInvoiceRow = { number: string | null; issue_date: string | null; price_net: number | string | null; supplier_name: string | null; supplier_tax_no?: string | null; currency: string | null };
export type FeeClass = { marketplace: FeeMarketplace; series: string; ym: string | null; include: boolean; why: string };

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function classifyFeeInvoice(inv: FeeInvoiceRow): FeeClass | null {
  const name = (inv.supplier_name || "").toLowerCase();
  const number = (inv.number || "").trim();
  if (/erli/.test(name)) {
    const m = number.match(/^FV-([AP])-(\d{4})-(\d{2})-/i);
    if (!m) return { marketplace: "erli", series: "?", ym: null, include: false, why: "numer faktury Erli w nieznanym formacie" };
    return { marketplace: "erli", series: m[1].toUpperCase(), ym: `${m[2]}-${m[3]}`, include: (inv.currency || "PLN").toUpperCase() === "PLN", why: "" };
  }
  if (/allegro/.test(name)) {
    const m = number.match(/^\d+\/([A-Z]{2})\/([A-Z]{1,2})\/([A-Z]{3})\/(\d{4})\/(\d{2})$/);
    if (!m) {
      return { marketplace: "allegro", series: number.startsWith("FV") || number.startsWith("ET") ? "FV" : "?", ym: null, include: false, why: "faktura spoza serii opłat (prawdopodobnie Allegro Ads / doładowanie) — nie jest prowizją" };
    }
    const [, country, series, cur, y, mo] = m;
    const ym = `${y}-${mo}`;
    if (country !== "PL" || cur !== "PLN") return { marketplace: "allegro", series, ym, include: false, why: `faktura ${country}/${cur} — poza sprzedażą w PLN (marginalna)` };
    if (series !== "N") return { marketplace: "allegro", series, ym, include: false, why: `seria ${series} (faktura zaliczkowa/korekta) — drobne kwoty, pominięte` };
    return { marketplace: "allegro", series, ym, include: true, why: "" };
  }
  return null;
}

export type FeeSales = { marketplace: FeeMarketplace; ym: string; gmv: number; orders: number };
export type FeeMonth = { ym: string; net: number; gmv: number; orders: number; pct: number | null; complete: boolean; missing: string; invoices: { number: string; series: string; net: number }[] };
export type FeeRateResult = {
  marketplace: FeeMarketplace;
  pct: number | null; // uśredniona stawka (% ceny sprzedaży brutto); null = brak kompletnych miesięcy
  window: string[]; // miesiące użyte do średniej
  windowNet: number;
  windowGmv: number;
  months: FeeMonth[]; // ostatnie miesiące (malejąco)
  excluded: { number: string; issueDate: string | null; net: number; currency: string; why: string }[];
  note: string;
};

const REQUIRED: Record<FeeMarketplace, string[]> = { allegro: ["N"], erli: ["A", "P"] };

export function computeFeeRates(invoices: FeeInvoiceRow[], sales: FeeSales[], now: Date = new Date()): Record<FeeMarketplace, FeeRateResult> {
  const currentYm = warsawDate(now.toISOString()).slice(0, 7);
  const out = {} as Record<FeeMarketplace, FeeRateResult>;
  for (const mp of FEE_MARKETPLACES) {
    const byMonth = new Map<string, FeeMonth & { series: Set<string> }>();
    const excluded: FeeRateResult["excluded"] = [];
    const month = (ym: string) => {
      let m = byMonth.get(ym);
      if (!m) byMonth.set(ym, (m = { ym, net: 0, gmv: 0, orders: 0, pct: null, complete: false, missing: "", invoices: [], series: new Set() }));
      return m;
    };
    for (const inv of invoices) {
      const c = classifyFeeInvoice(inv);
      if (!c || c.marketplace !== mp) continue;
      if (!c.include || !c.ym) {
        excluded.push({ number: inv.number || "(bez numeru)", issueDate: inv.issue_date, net: num(inv.price_net), currency: (inv.currency || "PLN").toUpperCase(), why: c.why || "poza zakresem" });
        continue;
      }
      const m = month(c.ym);
      m.net += num(inv.price_net);
      m.series.add(c.series);
      m.invoices.push({ number: inv.number || "", series: c.series, net: num(inv.price_net) });
    }
    for (const s of sales) if (s.marketplace === mp) {
      const m = month(s.ym);
      m.gmv = s.gmv;
      m.orders = s.orders;
    }
    const months = [...byMonth.values()].filter((m) => m.ym < currentYm).sort((a, b) => b.ym.localeCompare(a.ym));
    for (const m of months) {
      const miss = REQUIRED[mp].filter((s) => !m.series.has(s));
      if (miss.length) m.missing = `brak faktury ${miss.join("/")}`;
      else if (m.gmv <= 0) m.missing = "brak sprzedaży w bazie";
      m.complete = m.missing === "";
      m.pct = m.complete ? (m.net / m.gmv) * 100 : null;
      m.net = Math.round(m.net * 100) / 100;
    }
    const window = months.filter((m) => m.complete).slice(0, FEE_WINDOW_MONTHS);
    const windowNet = window.reduce((s, m) => s + m.net, 0);
    const windowGmv = window.reduce((s, m) => s + m.gmv, 0);
    out[mp] = {
      marketplace: mp,
      pct: window.length > 0 && windowGmv > 0 ? (windowNet / windowGmv) * 100 : null,
      window: window.map((m) => m.ym),
      windowNet: Math.round(windowNet * 100) / 100,
      windowGmv: Math.round(windowGmv * 100) / 100,
      months: months.slice(0, 6).map(({ series, ...m }) => m),
      excluded: excluded.sort((a, b) => (b.issueDate || "").localeCompare(a.issueDate || "")).slice(0, 40),
      note: window.length < FEE_WINDOW_MONTHS ? `Do średniej dostępnych jest tylko ${window.length} kompletnych miesięcy (cel: ${FEE_WINDOW_MONTHS}).` : "",
    };
  }
  return out;
}

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

// Sprzedaż Allegro i Erli: zamówienia liczone jako sprzedaż (isCountedOrder), tylko pozycje w PLN, miesiąc wg czasu polskiego z daty zamówienia.
export async function loadMarketplaceSales(db: SupabaseClient<any, any, any>, sinceYmd: string): Promise<FeeSales[]> {
  const out: FeeSales[] = [];
  for (const mp of FEE_MARKETPLACES) {
    const orders = await fetchAll<{ external_id: string; order_date: string | null; status: string }>((from, to) =>
      db.from("sales_orders").select("external_id, order_date, status").eq("marketplace", mp).gte("order_date", `${sinceYmd}T00:00:00Z`).order("external_id").range(from, to)
    );
    const items = await fetchAll<{ external_id: string; item_key: string; price: number | string | null; currency: string | null }>((from, to) =>
      db.from("sales_order_items").select("external_id, item_key, price, currency").eq("marketplace", mp).order("external_id").order("item_key").range(from, to)
    );
    const byOrder = new Map<string, number>();
    for (const it of items) {
      if (it.price === null || (it.currency || "PLN").toUpperCase() !== "PLN") continue;
      byOrder.set(it.external_id, (byOrder.get(it.external_id) ?? 0) + Number(it.price));
    }
    const agg = new Map<string, { gmv: number; orders: number }>();
    for (const o of orders) {
      if (!o.order_date || !isCountedOrder(mp, o.status)) continue;
      const v = byOrder.get(o.external_id);
      if (v === undefined) continue;
      const ym = warsawDate(o.order_date).slice(0, 7);
      const a = agg.get(ym) ?? { gmv: 0, orders: 0 };
      a.gmv += v;
      a.orders += 1;
      agg.set(ym, a);
    }
    for (const [ym, a] of agg) out.push({ marketplace: mp, ym, gmv: Math.round(a.gmv * 100) / 100, orders: a.orders });
  }
  return out;
}

// Pełne wyliczenie (serwer): faktury z ostatnich ~9 miesięcy + sprzedaż. Brak tabeli faktur kosztowych (nieuruchomione cost-invoices.sql) = puste stawki z komunikatem.
export async function loadFeeRates(db: SupabaseClient<any, any, any>, now: Date = new Date()): Promise<{ rates: Record<FeeMarketplace, FeeRateResult>; error: string | null }> {
  const since = new Date(now.getTime() - 270 * 86_400_000).toISOString().slice(0, 10);
  let invoices: FeeInvoiceRow[] = [];
  let error: string | null = null;
  try {
    invoices = await fetchAll<FeeInvoiceRow>((from, to) =>
      db.from("cost_invoices").select("number, issue_date, price_net, supplier_name, supplier_tax_no, currency").or("supplier_name.ilike.%allegro%,supplier_name.ilike.%erli%").gte("issue_date", since).order("fakturownia_id").range(from, to)
    );
  } catch (e: any) {
    error = /cost_invoices/.test(String(e?.message)) ? "Brak faktur kosztowych — uruchom supabase/cost-invoices.sql i pobierz faktury w Finanse -> Faktury kosztowe." : String(e?.message || e);
  }
  const sales = await loadMarketplaceSales(db, since);
  return { rates: computeFeeRates(invoices, sales, now), error };
}
