import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { addAreaRows, lastMonths, monthRange, type EmployeeMonth, type PointRow } from "@/lib/points";

// Podsumowanie punktacji pracowników (zakładka Punktacja, 06.10.2026) — TYLKO Admin (też po stronie serwera, nie tylko ukrycie zakładki).
// Ostatnie 6 miesięcy kalendarzowych wg czasu polskiego, punkty z Serwisu ("naprawiony"), Testów ("przetestowane") i Trade-in (obsłużona/kontroferta/ok. dok./problem)
// wg DATY PIERWSZEGO ZALICZENIA (points_awarded_at — zmiana statusu nie przesuwa punktów; przed uruchomieniem SQL awaryjnie finished_at).

export const maxDuration = 60;
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const POINTS_STATUSES_TRADEIN = ["obsluzona", "kontroferta", "ok_dok", "problem"];

type Src = { table: string; emailCol: string; extra: string; filter: (q: any) => any; area: "service" | "tests" | "tradein" };
const SOURCES: Src[] = [
  { table: "service_log", emailCol: "employee_email", extra: "task_type", filter: (q) => q.eq("status", "naprawiony"), area: "service" },
  { table: "test_log", emailCol: "employee_email", extra: "", filter: (q) => q.eq("status", "przetestowane"), area: "tests" },
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

export async function GET(request: Request) {
  const db = admin();
  if (!(await requireRole(request, db, ["Admin"]))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const months = lastMonths(6);
  const from = monthRange(months[0]).from;
  const to = monthRange(months[months.length - 1]).to;
  try {
    const acc = new Map<string, Record<string, EmployeeMonth>>();
    let usedFallback = false;
    for (const s of SOURCES) {
      let res = await fetchRows(db, s, "points_awarded_at", from, to);
      if (res.missingColumn) {
        usedFallback = true; // SQL z points_awarded_at jeszcze nie uruchomiony — liczymy po finished_at
        res = await fetchRows(db, s, "finished_at", from, to);
      }
      addAreaRows(acc, s.area, res.rows || [], months);
    }
    const employees = Array.from(acc.entries()).map(([email, byMonth]) => ({ email, months: byMonth }));
    return NextResponse.json({ ok: true, months, employees, fallbackDate: usedFallback });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Błąd liczenia punktacji." }, { status: 500 });
  }
}
