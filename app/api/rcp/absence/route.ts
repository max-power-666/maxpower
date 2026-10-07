import { NextResponse } from "next/server";
import { rcpAdmin, rcpCaller } from "@/lib/rcpServer";
import { workdaysBetween } from "@/lib/holidays";
import { ACTIVE_STATUSES, absenceKind, datesOverlap, leaveUsage, type Absence } from "@/lib/rcpAbsence";
import { warsawDay } from "@/lib/rcp";

// Wnioski urlopowe i nieobecności (07.10.2026). Zapis wyłącznie tu (tabela rcp_absences nie ma polityk zapisu).
//  create     — każdy zalogowany z rolą składa wniosek dla siebie (status "oczekuje"); sprawdza nakładanie się i roczny limit (gdy Admin go ustawił),
//  withdraw   — autor wycofuje własny nierozpatrzony wniosek,
//  create_for — Admin/Manager wpisuje nieobecność za pracownika (od razu "zaakceptowany", np. L4); przekroczenie limitu to tylko ostrzeżenie,
//  decide     — Admin/Manager akceptuje/odrzuca wniosek (odrzucenie wymaga powodu; Manager nie rozpatruje własnych wniosków),
//  cancel     — Admin/Manager anuluje zaakceptowaną nieobecność (wymaga powodu).
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const nowIso = () => new Date().toISOString();
const err = (message: string, status = 400) => NextResponse.json({ error: message }, { status });

export async function POST(request: Request) {
  const db = rcpAdmin();
  const me = await rcpCaller(request, db);
  if (!me) return err("Brak uprawnień.", 403);
  const isManager = me.role === "Admin" || me.role === "Manager";
  const b = await request.json().catch(() => null);
  const action = typeof b?.action === "string" ? b.action : "";
  const note = typeof b?.note === "string" ? b.note.trim().slice(0, 500) : "";

  // Wspólne: walidacja rodzaju i dat, dni robocze.
  function parseRequest(): { kind: string; from: string; to: string; workdays: number } | NextResponse {
    const kind = String(b?.kind || "");
    if (!absenceKind(kind)) return err("Nieprawidłowy rodzaj nieobecności.");
    const from = String(b?.date_from || "");
    const to = String(b?.date_to || "");
    if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return err("Podaj daty od i do.");
    if (to < from) return err("Data końcowa nie może być wcześniejsza niż początkowa.");
    const today = warsawDay(Date.now());
    const earliest = new Date(Date.parse(today + "T00:00:00Z") - 60 * 86400000).toISOString().slice(0, 10);
    const latest = new Date(Date.parse(today + "T00:00:00Z") + 800 * 86400000).toISOString().slice(0, 10);
    if (from < earliest) return err("Wniosek nie może dotyczyć okresu starszego niż 60 dni — poproś Managera o wpisanie nieobecności.");
    if (to > latest) return err("Data końcowa jest zbyt odległa.");
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 120) return err("Jeden wniosek może obejmować maksymalnie 120 dni.");
    const workdays = workdaysBetween(from, to);
    if (workdays < 1) return err("W wybranym okresie nie ma dni roboczych (weekendy i święta nie liczą się do urlopu).");
    return { kind, from, to, workdays };
  }

  async function ownAbsences(userId: string): Promise<Absence[]> {
    const { data } = await db.from("rcp_absences").select("*").eq("user_id", userId);
    return (data as Absence[]) || [];
  }

  // Sprawdza limit roczny dla urlopów zaliczanych do limitu; zwraca komunikat o przekroczeniu albo null.
  async function limitProblem(userId: string, kind: string, from: string, to: string): Promise<string | null> {
    if (!absenceKind(kind)?.countsAgainstLimit) return null;
    const mine = await ownAbsences(userId);
    for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
      const { data: bal } = await db.from("rcp_leave_balances").select("days_total").eq("user_id", userId).eq("year", year).maybeSingle();
      if (!bal) continue; // limit nieustawiony — bez kontroli
      const { used, pending } = leaveUsage(mine, year);
      const need = workdaysBetween(from, to, year);
      const left = Number(bal.days_total) - used - pending;
      if (need > left) return `Przekroczony limit urlopowy ${year}: wniosek ${need} dni, a zostało ${left} z ${Number(bal.days_total)} (wykorzystano ${used}, oczekuje ${pending}).`;
    }
    return null;
  }

  const insertRow = async (userId: string, email: string, req: { kind: string; from: string; to: string; workdays: number }, status: string, historyNote: string) => {
    const t = nowIso();
    const row: Record<string, unknown> = {
      user_id: userId, user_email: email, kind: req.kind, date_from: req.from, date_to: req.to, workdays: req.workdays, note: note || null, status, created_by_email: me.email,
      history: [{ at: t, by_email: me.email, event: historyNote }],
    };
    if (status === "zaakceptowany") {
      row.decided_by_email = me.email;
      row.decided_at = t;
    }
    return db.from("rcp_absences").insert(row).select("id").single();
  };
  const dbError = (e: { code?: string; message: string }) => err(e.code === "P0001" ? e.message : e.code === "42P01" ? "Brak tabel nieobecności — uruchom supabase/rcp.sql w Supabase." : e.message, e.code === "P0001" ? 409 : 500);

  if (action === "create") {
    const req = parseRequest();
    if (req instanceof NextResponse) return req;
    const mine = await ownAbsences(me.uid);
    if (mine.some((a) => ACTIVE_STATUSES.includes(a.status) && datesOverlap({ date_from: req.from, date_to: req.to }, a))) return err("Masz już wniosek lub nieobecność w tym terminie.", 409);
    const problem = await limitProblem(me.uid, req.kind, req.from, req.to);
    if (problem) return err(problem, 409);
    const { data, error } = await insertRow(me.uid, me.email, req, "oczekuje", "Złożono wniosek");
    if (error) return dbError(error);
    return NextResponse.json({ ok: true, id: (data as { id: number }).id, workdays: req.workdays });
  }

  if (action === "withdraw") {
    const id = Number(b?.id);
    const { data: a } = await db.from("rcp_absences").select("*").eq("id", id).maybeSingle();
    if (!a || a.user_id !== me.uid) return err("Nie znaleziono wniosku.", 404);
    if (a.status !== "oczekuje") return err("Wycofać można tylko wniosek, który czeka na rozpatrzenie.", 409);
    const { error } = await db.from("rcp_absences").update({ status: "wycofany", history: [...(a.history || []), { at: nowIso(), by_email: me.email, event: "Wycofano wniosek" }] }).eq("id", id);
    return error ? dbError(error) : NextResponse.json({ ok: true });
  }

  if (!isManager) return err("Brak uprawnień.", 403);

  if (action === "create_for") {
    const req = parseRequest();
    if (req instanceof NextResponse) return req;
    const userId = String(b?.user_id || "");
    const { data: member } = await db.from("members").select("email").eq("user_id", userId).maybeSingle();
    if (!member) return err("Nie znaleziono pracownika.");
    const mine = await ownAbsences(userId);
    if (mine.some((a) => ACTIVE_STATUSES.includes(a.status) && datesOverlap({ date_from: req.from, date_to: req.to }, a))) return err("Ta osoba ma już nieobecność w tym terminie.", 409);
    const warning = await limitProblem(userId, req.kind, req.from, req.to);
    const { data, error } = await insertRow(userId, member.email as string, req, "zaakceptowany", "Wpisano nieobecność (Manager/Admin)");
    if (error) return dbError(error);
    return NextResponse.json({ ok: true, id: (data as { id: number }).id, workdays: req.workdays, warning });
  }

  if (action === "decide") {
    const id = Number(b?.id);
    const decision = String(b?.decision || "");
    if (!["zaakceptowany", "odrzucony"].includes(decision)) return err("Nieprawidłowa decyzja.");
    if (decision === "odrzucony" && note.length < 3) return err("Podaj powód odrzucenia.");
    const { data: a } = await db.from("rcp_absences").select("*").eq("id", id).maybeSingle();
    if (!a) return err("Nie znaleziono wniosku.", 404);
    if (a.status !== "oczekuje") return err("Ten wniosek został już rozpatrzony.", 409);
    if (a.user_id === me.uid && me.role !== "Admin") return err("Własnego wniosku nie rozpatrujesz — zrobi to Admin.", 403);
    const t = nowIso();
    const { error } = await db.from("rcp_absences").update({ status: decision, decided_by_email: me.email, decided_at: t, decision_note: note || null, history: [...(a.history || []), { at: t, by_email: me.email, event: decision === "zaakceptowany" ? "Zaakceptowano" : "Odrzucono", note }] }).eq("id", id);
    return error ? dbError(error) : NextResponse.json({ ok: true });
  }

  if (action === "cancel") {
    const id = Number(b?.id);
    if (note.length < 3) return err("Podaj powód anulowania.");
    const { data: a } = await db.from("rcp_absences").select("*").eq("id", id).maybeSingle();
    if (!a || a.status !== "zaakceptowany") return err("Anulować można tylko zaakceptowaną nieobecność.", 409);
    const t = nowIso();
    const { error } = await db.from("rcp_absences").update({ status: "anulowany", decided_by_email: me.email, decided_at: t, decision_note: note, history: [...(a.history || []), { at: t, by_email: me.email, event: "Anulowano", note }] }).eq("id", id);
    return error ? dbError(error) : NextResponse.json({ ok: true });
  }

  return err("Nieznana akcja.");
}
