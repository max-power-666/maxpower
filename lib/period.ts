// Okres podsumowania punktacji i list (Serwis, Testy, Trade-in): kapsułki Dziś / 7 / 30 dni ORAZ dowolny zakres dat (16.10.2026, na prośbę właściciela).
// Zakres "od–do" to dni kalendarzowe WŁĄCZNIE wg czasu polskiego (jak miesiące w Punktacji): od północy dnia "od" do północy po dniu "do".
import { rangeStart, type Interval } from "./workLog";
import { warsawMidnightUtcMs } from "./points";
import { warsawYmd } from "./warsawDate";

export type Period = { kind: Interval } | { kind: "custom"; from: string; to: string };

export const todayYmd = () => warsawYmd(Date.now());
export const isYmd = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v; // odrzuca nieistniejące dni (30.02)
};

// Domyślny zakres po kliknięciu "Zakres": ostatnie 7 dni włącznie z dziś.
export function defaultRange(): { from: string; to: string } {
  const to = todayYmd();
  const [y, m, d] = to.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, d - 6)).toISOString().slice(0, 10);
  return { from, to };
}
export const defaultCustomPeriod = (): Period => ({ kind: "custom", ...defaultRange() });

// Zakres dni [od, do] włącznie -> chwile UTC [from, to) (do = północ po dniu "do"). Odwrócone daty są zamieniane miejscami.
export function ymdRange(fromYmd: string, toYmd: string): { from: string; to: string } {
  const [a, b] = fromYmd <= toYmd ? [fromYmd, toYmd] : [toYmd, fromYmd];
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  const next = new Date(Date.UTC(y2, m2 - 1, d2 + 1));
  return {
    from: new Date(warsawMidnightUtcMs(y1, m1, d1)).toISOString(),
    to: new Date(warsawMidnightUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())).toISOString(),
  };
}

// Granice okresu: kapsułki kończą się "teraz" (to = null), zakres własny ma koniec wyłączny.
export function periodBounds(p: Period): { from: string; to: string | null } {
  if (p.kind === "custom") return ymdRange(p.from, p.to);
  return { from: rangeStart(p.kind), to: null };
}

export const periodKey = (p: Period) => (p.kind === "custom" ? `custom:${p.from}:${p.to}` : p.kind);

// Zapytanie o wiersze zaliczone w okresie (kolumna z datą zaliczenia).
export function inPeriod<Q extends { gte: (c: string, v: string) => Q; lt: (c: string, v: string) => Q }>(q: Q, col: string, p: Period): Q {
  const { from, to } = periodBounds(p);
  const r = q.gte(col, from);
  return to ? r.lt(col, to) : r;
}

// Filtr .or() listy: rozpoczęte lub zakończone w okresie oraz — dla kapsułek, które kończą się "teraz" — wciąż trwające (bez daty zakończenia).
// W zakresie własnym trwających nie dokładamy (dotyczyłyby dzisiaj, a nie wybranego okresu).
export function orInPeriod(startCol: string, endCol: string, p: Period): string {
  const { from, to } = periodBounds(p);
  if (!to) return `${startCol}.gte.${from},${endCol}.gte.${from},${endCol}.is.null`;
  return `and(${startCol}.gte.${from},${startCol}.lt.${to}),and(${endCol}.gte.${from},${endCol}.lt.${to})`;
}

// Czytanie wszystkich wierszy zapytania stronami po 1000 (PostgREST obcina odpowiedź) — dłuższy zakres własny łatwo przekracza 1000 zaliczeń.
export async function fetchAllPaged<T>(make: () => any): Promise<{ data: T[] | null; error: any }> {
  const out: T[] = [];
  for (let off = 0; off < 100_000; off += 1000) {
    const { data, error } = await make().order("id").range(off, off + 999);
    if (error) return { data: null, error };
    out.push(...((data as T[]) || []));
    if (!data || data.length < 1000) break;
  }
  return { data: out, error: null };
}
