import { NextResponse } from "next/server";
import { rcpAdmin, rcpCaller } from "@/lib/rcpServer";
import { RCP_KIND_LABEL } from "@/lib/rcp";

// Korekty czasu pracy (Admin i Manager): poprawa odcinka albo dodanie brakującego. Każda zmiana wymaga uzasadnienia i zostaje w history odcinka (kto, kiedy, co z czego na co);
// odcinek po korekcie nie jest już "do sprawdzenia". Usuwanie to osobna operacja tylko dla Admina (polityka delete + audit_delete w bazie).
export const dynamic = "force-dynamic";

const KINDS = Object.keys(RCP_KIND_LABEL);
const iso = (v: unknown): string | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export async function POST(request: Request) {
  const db = rcpAdmin();
  const me = await rcpCaller(request, db);
  if (!me || !["Admin", "Manager"].includes(me.role)) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const b = await request.json().catch(() => null);
  const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
  if (reason.length < 3) return NextResponse.json({ error: "Podaj uzasadnienie korekty." }, { status: 400 });
  const now = Date.now();

  // Wspólna walidacja i kontrola nakładania się odcinków tej samej osoby.
  async function overlaps(userId: string, startIso: string, endIso: string | null, exceptId?: number): Promise<boolean> {
    const { data } = await db.from("rcp_segments").select("id, started_at, ended_at").eq("user_id", userId);
    const s = Date.parse(startIso);
    const e = endIso ? Date.parse(endIso) : Infinity;
    return ((data as { id: number; started_at: string; ended_at: string | null }[]) || []).some((o) => {
      if (o.id === exceptId) return false;
      const os = Date.parse(o.started_at);
      const oe = o.ended_at ? Date.parse(o.ended_at) : Infinity;
      return os < e && oe > s;
    });
  }

  if (b?.action === "add") {
    const userId = typeof b.user_id === "string" ? b.user_id : "";
    const { data: member } = await db.from("members").select("email").eq("user_id", userId).maybeSingle();
    if (!member) return NextResponse.json({ error: "Nie znaleziono pracownika." }, { status: 400 });
    const kind = String(b.kind || "");
    if (!KINDS.includes(kind)) return NextResponse.json({ error: "Nieprawidłowy rodzaj." }, { status: 400 });
    const start = iso(b.started_at);
    const end = iso(b.ended_at);
    if (!start || !end) return NextResponse.json({ error: "Podaj początek i koniec." }, { status: 400 });
    if (Date.parse(end) <= Date.parse(start)) return NextResponse.json({ error: "Koniec musi być po początku." }, { status: 400 });
    if (Date.parse(end) > now + 5 * 60_000) return NextResponse.json({ error: "Koniec nie może być w przyszłości." }, { status: 400 });
    if (await overlaps(userId, start, end)) return NextResponse.json({ error: "Ten czas nakłada się na inny wpis tej osoby." }, { status: 409 });
    const history = [{ at: new Date().toISOString(), by_email: me.email, reason, changes: [{ field: "Dodano ręcznie", from: null, to: `${RCP_KIND_LABEL[kind as keyof typeof RCP_KIND_LABEL]} ${start} – ${end}` }] }];
    const { data, error } = await db.from("rcp_segments").insert({ user_id: userId, user_email: member.email, kind, started_at: start, ended_at: end, source: "manual", needs_review: false, history }).select("id").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: (data as { id: number }).id });
  }

  if (b?.action === "update") {
    const id = Number(b.id);
    const { data: cur } = await db.from("rcp_segments").select("*").eq("id", id).maybeSingle();
    if (!cur) return NextResponse.json({ error: "Nie znaleziono wpisu." }, { status: 404 });
    const patch: Record<string, unknown> = {};
    const changes: { field: string; from: string | null; to: string | null }[] = [];
    const set = (field: string, label: string, to: unknown, from: unknown) => {
      if ((to ?? null) !== (from ?? null)) {
        patch[field] = to ?? null;
        changes.push({ field: label, from: from === null || from === undefined ? null : String(from), to: to === null || to === undefined ? null : String(to) });
      }
    };
    if (b.kind !== undefined) {
      if (!KINDS.includes(String(b.kind))) return NextResponse.json({ error: "Nieprawidłowy rodzaj." }, { status: 400 });
      set("kind", "Rodzaj", String(b.kind), cur.kind);
    }
    const start = b.started_at !== undefined ? iso(b.started_at) : (cur.started_at as string);
    const end = b.ended_at !== undefined ? (b.ended_at ? iso(b.ended_at) : null) : (cur.ended_at as string | null);
    if (!start) return NextResponse.json({ error: "Nieprawidłowy początek." }, { status: 400 });
    if (b.ended_at !== undefined && b.ended_at && !end) return NextResponse.json({ error: "Nieprawidłowy koniec." }, { status: 400 });
    if (end && Date.parse(end) <= Date.parse(start)) return NextResponse.json({ error: "Koniec musi być po początku." }, { status: 400 });
    if (end && Date.parse(end) > now + 5 * 60_000) return NextResponse.json({ error: "Koniec nie może być w przyszłości." }, { status: 400 });
    if (Date.parse(start) > now + 5 * 60_000) return NextResponse.json({ error: "Początek nie może być w przyszłości." }, { status: 400 });
    if (cur.ended_at && !end) return NextResponse.json({ error: "Nie da się ponownie otworzyć zakończonego wpisu." }, { status: 400 });
    set("started_at", "Początek", start, new Date(cur.started_at as string).toISOString());
    set("ended_at", "Koniec", end, cur.ended_at ? new Date(cur.ended_at as string).toISOString() : null);
    if (b.note !== undefined) set("note", "Notatka", b.note ? String(b.note).slice(0, 500) : null, cur.note);
    if (changes.length === 0 && !cur.needs_review) return NextResponse.json({ ok: true, unchanged: true });
    if (cur.user_id && (await overlaps(cur.user_id as string, start, end, id))) return NextResponse.json({ error: "Ten czas nakłada się na inny wpis tej osoby." }, { status: 409 });
    patch.needs_review = false;
    patch.history = [...((cur.history as unknown[]) || []), { at: new Date().toISOString(), by_email: me.email, reason, changes }];
    const { error } = await db.from("rcp_segments").update(patch).eq("id", id);
    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "Ta osoba ma już inny trwający wpis." }, { status: 409 });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Nieznana akcja." }, { status: 400 });
}
