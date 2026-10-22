import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { addAreaRows, lastMonths, monthRange, type EmployeeMonth, type PointRow } from "@/lib/points";
import { summarizeDays, type RcpSegment } from "@/lib/rcp";
import { isYmd, ymdRange } from "@/lib/period";

// Podsumowanie punktacji pracowników (zakładka Punktacja, 06.10.2026) — Admin i Manager (też po stronie serwera, nie tylko ukrycie zakładki).
// Ostatnie 6 miesięcy kalendarzowych wg czasu polskiego, punkty z Serwisu ("naprawiony"), Testów ("przetestowane") i Trade-in (obsłużona/kontroferta/ok. dok./problem)
// wg DATY PIERWSZEGO ZALICZENIA (points_awarded_at — zmiana statusu nie przesuwa punktów; przed uruchomieniem SQL awaryjnie finished_at).

export const maxDuration = 60;
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const POINTS_STATUSES_TRADEIN = ["obsluzona", "kontroferta", "ok_dok", "problem"];

type Src = { table: string; emailCol: string; extra: string; filter: (q: any) => any; area: "service" | "tests" | "tradein" };
const SOURCES: Src[] = [
  { table: "service_log", emailCol: "employee_email", extra: "task_type", filter: (q) => q.eq("status", "naprawiony"), area: "service" },
  { table: "test_log", emailCol: "employee_email", extra: "", filter: (q) => q.eq("status", "przetestowane").neq("test_kind", "inwentaryzacja"), area: "tests" },
  { table: "buyback_order_intake", emailCol: "entered_by_email", extra: "", filter: (q) => q.in("status", POINTS_STATUSES_TRADEIN), area: "tradein" },
];

async function fetchRows(db: ReturnType<typeof admin>, s: Src, col: string, from: string, to: string): Promise<{ rows?: PointRow[]; missingColumn?: boolean }> {
  const out: PointRow[] = [];
  for (let off = 0; ; off += 1000) {
    const sel = [s.emailCol, "points", col, s.extra].filter(Boolean).join(", ");
    const { data, error } = await s.filter(db.from(s.table).select(sel)).gte(col, from).lt(col, to).order("id").range(off, off + 999);
    if (error) {
      if (error.code === "42703") return { missingColumn: true };
      throw new Error(`${s.table}: ${error.message}`);
    }
    for (const r of (data as any[]) || []) out.push({ email: r[s.emailCol], points: r.points, at: r[col], task: s.extra ? r[s.extra] : null });
    if (!data || data.length < 1000) break;
  }
  return { rows: out };
}

// Godziny pracy z RCP (09.10.2026) per pracownik i miesiąc (wg czasu polskiego): czas pracy = praca + wyjścia służbowe + prace administracyjne; do pkt/h bierzemy czas BEZ administracji
// (workMs − adminMs). Brak tabel RCP albo brak wpisów danej osoby = brak godzin (UI pokazuje "—"). RCP działa od 06.10.2026, więc wcześniejsze miesiące nie mają godzin.
async function fetchHours(db: ReturnType<typeof admin>, from: string, to: string, bucketOf: (day: string) => string | null = (d) => d.slice(0, 7)): Promise<Record<string, Record<string, { workMs: number; adminMs: number }>> | null> {
  const segs: RcpSegment[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db
      .from("rcp_segments")
      .select("user_email, kind, area, started_at, ended_at, needs_review")
      .lt("started_at", to)
      .or(`ended_at.is.null,ended_at.gte.${from}`)
      .order("id")
      .range(off, off + 999);
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205") return null;
      throw new Error(`rcp_segments: ${error.message}`);
    }
    segs.push(...((data as unknown as RcpSegment[]) || []));
    if (!data || data.length < 1000) break;
  }
  const byEmail = new Map<string, RcpSegment[]>();
  for (const s of segs) {
    const e = (s.user_email || "").trim().toLowerCase();
    if (!e) continue;
    byEmail.set(e, [...(byEmail.get(e) ?? []), s]);
  }
  const now = Date.now();
  const out: Record<string, Record<string, { workMs: number; adminMs: number }>> = {};
  for (const [email, list] of byEmail) {
    const perMonth: Record<string, { workMs: number; adminMs: number }> = {};
    for (const d of summarizeDays(list, now).values()) {
      const m = bucketOf(d.day);
      if (!m) continue;
      const cur = (perMonth[m] ??= { workMs: 0, adminMs: 0 });
      cur.workMs += d.workMs;
      cur.adminMs += d.adminMs;
    }
    out[email] = perMonth;
  }
  return out;
}

export async function GET(request: Request) {
  const db = admin();
  // Admin, Manager i Księgowa widzą wszystkich; Kierownik serwisu (22.10.2026, na prośbę właściciela) tylko serwisantów (rola Serwis) i siebie.
  let allowedEmails: Set<string> | null = null;
  if (!(await requireRole(request, db, ["Admin", "Manager", "Księgowa"]))) {
    const leadId = await requireRole(request, db, ["Kierownik serwisu"]);
    if (!leadId) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
    const { data: ms, error: mErr } = await db.from("members").select("email, role, user_id");
    if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 });
    allowedEmails = new Set((ms || []).filter((m: any) => m.email && (m.role === "Serwis" || m.user_id === leadId)).map((m: any) => String(m.email).toLowerCase()));
  }
  // Dowolny zakres dat (16.10.2026): ?from=YYYY-MM-DD&to=YYYY-MM-DD (dni włącznie, czas polski, max 366 dni) — wynik pod jednym kluczem "range" zamiast 6 miesięcy.
  const url = new URL(request.url);
  const qFrom = url.searchParams.get("from");
  const qTo = url.searchParams.get("to");
  const custom = qFrom !== null || qTo !== null;
  let dayFrom = "";
  let dayTo = "";
  if (custom) {
    if (!isYmd(qFrom) || !isYmd(qTo)) return NextResponse.json({ error: "Podaj zakres dat w formacie RRRR-MM-DD." }, { status: 400 });
    [dayFrom, dayTo] = qFrom <= qTo ? [qFrom, qTo] : [qTo, qFrom];
    if ((Date.parse(`${dayTo}T00:00:00Z`) - Date.parse(`${dayFrom}T00:00:00Z`)) / 86_400_000 > 365) return NextResponse.json({ error: "Zakres może obejmować maksymalnie 366 dni." }, { status: 400 });
  }
  const months = custom ? ["range"] : lastMonths(6);
  const { from, to } = custom ? ymdRange(dayFrom, dayTo) : { from: monthRange(months[0]).from, to: monthRange(months[months.length - 1]).to };
  try {
    const acc = new Map<string, Record<string, EmployeeMonth>>();
    let usedFallback = false;
    for (const s of SOURCES) {
      let res = await fetchRows(db, s, "points_awarded_at", from, to);
      if (res.missingColumn) {
        usedFallback = true; // SQL z points_awarded_at jeszcze nie uruchomiony — liczymy po finished_at
        res = await fetchRows(db, s, "finished_at", from, to);
      }
      addAreaRows(acc, s.area, res.rows || [], months, custom ? () => "range" : undefined);
    }
    const hours = await fetchHours(db, from, to, custom ? (d) => (d >= dayFrom && d <= dayTo ? "range" : null) : undefined);
    const employees = Array.from(acc.entries()).filter(([email]) => !allowedEmails || allowedEmails.has(String(email).toLowerCase())).map(([email, byMonth]) => ({ email, months: byMonth, hours: hours?.[email] ?? {} }));
    return NextResponse.json({ ok: true, months, employees, fallbackDate: usedFallback, hasHours: hours !== null, ...(custom ? { custom: { from: dayFrom, to: dayTo } } : {}) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Błąd liczenia punktacji." }, { status: 500 });
  }
}
