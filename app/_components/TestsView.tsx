"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { colorForUser } from "@/lib/userColors";
import InlineEditCell from "./InlineEditCell";
import ProductCardDrawer from "./ProductCardDrawer";
import { INTERVALS, TEST_STATUSES as STATUSES, TEST_KINDS, TEST_RESULTS, TEST_KIND_COLORS, TEST_RESULT_COLORS, fmtDuration, rangeStart, type Interval } from "@/lib/workLog";

// Rejestr testów urządzeń wg Regulaminu premiowania (§2, 12.10.2026, zaktualizowany 01.10.2026):
// 15 pkt flat za prawidłowo przetestowane urządzenie (wartość ustawia default w bazie). Stare
// wpisy sprzed aktualizacji regulaminu mają migawkę 200/13 (≈15,38) — nie przeliczane wstecz.
// Jeden wiersz = jeden test z cyklem życia w statusie. Punkty do podsumowania liczą się tylko dla
// "przetestowane" (§2 ust. 4). "Czas" jest tylko informacyjny — regulamin liczy wydajność jako
// punkty / godziny przepracowane (§4). Nie liczy premii w zł (wymaga ewidencji czasu pracy).

type StatusKey = (typeof STATUSES)[number]["key"];
const STATUS_STYLE: Record<StatusKey, string> = {
  w_trakcie: "bg-ambersoft text-amber",
  przetestowane: "bg-tealsoft text-teal",
  przerwany: "bg-rustsoft text-rust",
};

type TestKindKey = (typeof TEST_KINDS)[number]["key"];
type TestResultKey = (typeof TEST_RESULTS)[number]["key"];

type TestRow = {
  id: number;
  employee_email: string | null;
  serial_number: string;
  sku: string | null;
  status: StatusKey;
  test_kind: TestKindKey;
  result: TestResultKey | null;
  notes: string | null;
  started_at: string;
  finished_at: string | null;
  points: number;
};

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtPoints(n: number | string) {
  return Number(n).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const btnPrimary = "bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50";
const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

export default function TestsView({
  session,
  members,
  isAdmin,
  isAdminOrManager,
}: {
  session: Session;
  members: MemberLite[];
  isAdmin: boolean;
  isAdminOrManager: boolean;
}) {
  const [interval, setInterval] = useState<Interval>("today");
  const [rangeRows, setRangeRows] = useState<{ employee_email: string | null; points: number }[]>([]);
  const [recent, setRecent] = useState<TestRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [serial, setSerial] = useState("");
  const [testKind, setTestKind] = useState<TestKindKey>(TEST_KINDS[0].key);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [openSerial, setOpenSerial] = useState<string | null>(null);

  useEffect(() => {
    load();
    const channel = supabase
      .channel("test-log-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "test_log" }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval]);

  async function load() {
    setLoading(true);
    setError("");
    try {
      // Punkty po points_awarded_at (pierwsze zaliczenie, trigger w bazie) — zmiana statusu nie przesuwa testu do innego dnia. Przed uruchomieniem
      // aktualizacji tests.sql kolumny nie ma — wtedy awaryjnie po finished_at (stare zachowanie).
      const rangeQuery = (col: string) => supabase.from("test_log").select("employee_email, points").eq("status", "przetestowane").gte(col, rangeStart(interval));
      const [rangeRes, { data: recentData, error: recentErr }] = await Promise.all([
        rangeQuery("points_awarded_at"),
        supabase
          .from("test_log")
          .select("id, employee_email, serial_number, sku, status, test_kind, result, notes, started_at, finished_at, points")
          .order("started_at", { ascending: false })
          .limit(50),
      ]);
      let { data: rangeData, error: rangeErr } = rangeRes;
      if (rangeErr && rangeErr.code === "42703") ({ data: rangeData, error: rangeErr } = await rangeQuery("finished_at"));
      if (rangeErr) throw rangeErr;
      if (recentErr) throw recentErr;
      setRangeRows(rangeData || []);
      setRecent((recentData as TestRow[]) || []);
    } catch (e: any) {
      setError(`Nie udało się wczytać testów: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  const summary = useMemo(() => {
    const totals = new Map<string, { count: number; points: number }>();
    for (const r of rangeRows) {
      const key = r.employee_email || "—";
      const entry = totals.get(key) || { count: 0, points: 0 };
      entry.count += 1;
      entry.points += Number(r.points) || 0;
      totals.set(key, entry);
    }
    return Array.from(totals.entries())
      .map(([email, v]) => ({ email, ...v }))
      .sort((a, b) => b.points - a.points);
  }, [rangeRows]);

  async function submit() {
    setFormError("");
    const value = serial.trim().toUpperCase();
    if (!value) {
      setFormError("Podaj numer seryjny urządzenia.");
      return;
    }
    setSubmitting(true);
    try {
      const { error: err } = await supabase.from("test_log").insert({
        employee_user_id: session.user.id,
        employee_email: session.user.email,
        serial_number: value,
        test_kind: testKind,
        status: "w_trakcie",
      });
      if (err) {
        if (err.code === "23505" || err.message.includes("duplicate key")) {
          throw new Error(`Urządzenie ${value} ma już trwający test (w trakcie) — sprawdź listę poniżej.`);
        }
        throw err;
      }
      setSerial("");
    } catch (e: any) {
      setFormError(e.message || "Błąd zapisu.");
    } finally {
      setSubmitting(false);
    }
  }

  // Usuwanie tylko dla Admina (polityka w bazie: is_admin(); każde usunięcie trafia do deleted_records).
  async function deleteRow(row: TestRow) {
    if (!confirm(`Usunąć wpis „${row.serial_number}”? Tej operacji nie można cofnąć.`)) return;
    const { data, error: err } = await supabase.from("test_log").delete().eq("id", row.id).select("id");
    if (err) setError(`Nie udało się usunąć: ${err.message}`);
    else if (!data?.length) setError("Nie usunięto — brak uprawnień (tylko Admin) albo wpis już nie istnieje.");
    else await load();
  }

  async function saveNotes(row: TestRow, notes: string | null) {
    const { error: err } = await supabase.from("test_log").update({ notes }).eq("id", row.id);
    if (err) setError(`Nie udało się zapisać uwag: ${err.message}`);
  }

  // Numer seryjny można poprawić po rozpoczęciu testu (02.10.2026). Kolumna jest NOT NULL, a indeks blokuje dwa trwające
  // testy tego samego urządzenia — oba przypadki dostają czytelny komunikat zamiast surowego błędu bazy.
  async function saveSerial(row: TestRow, next: string | null) {
    const value = (next ?? "").trim().toUpperCase();
    if (!value) return setError("Numer seryjny nie może być pusty.");
    if (value === row.serial_number) return;
    setError("");
    const { error: err } = await supabase.from("test_log").update({ serial_number: value }).eq("id", row.id);
    if (err) {
      if (err.code === "23505" || err.message.includes("duplicate key")) {
        return setError(`Urządzenie ${value} ma już trwający test (w trakcie) — numeru nie zmieniono.`);
      }
      setError(`Nie udało się zapisać numeru seryjnego: ${err.message}`);
    }
  }

  async function saveSku(row: TestRow, sku: string | null) {
    const { error: err } = await supabase.from("test_log").update({ sku }).eq("id", row.id);
    if (err) setError(`Nie udało się zapisać SKU: ${err.message}`);
  }

  async function saveTestKind(row: TestRow, testKind: TestKindKey) {
    const { error: err } = await supabase.from("test_log").update({ test_kind: testKind }).eq("id", row.id);
    if (err) setError(`Nie udało się zapisać rodzaju testu: ${err.message}`);
  }

  async function saveResult(row: TestRow, result: TestResultKey | "") {
    const { error: err } = await supabase.from("test_log").update({ result: result || null }).eq("id", row.id);
    if (err) setError(`Nie udało się zapisać wyniku: ${err.message}`);
  }

  async function changeStatus(row: TestRow, status: StatusKey) {
    if (status === row.status) return;
    const { error: err } = await supabase
      .from("test_log")
      .update({ status, finished_at: status === "w_trakcie" ? null : new Date().toISOString() })
      .eq("id", row.id);
    if (err) {
      setError(
        err.code === "23505"
          ? `Nie można zmienić statusu: to urządzenie ma już inny aktywny wpis.`
          : `Nie udało się zmienić statusu: ${err.message}`
      );
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-inksoft">PODSUMOWANIE PUNKTACJI (przetestowane)</h2>
        <div className="flex gap-2">
          {INTERVALS.map((i) => (
            <button key={i.key} onClick={() => setInterval(i.key)} className={pill(interval === i.key)}>{i.label}</button>
          ))}
        </div>
      </div>
      <div className="border border-line bg-white mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Pracownik</th>
              <th className="p-3 text-right">Liczba testów</th>
              <th className="p-3 text-right">Punkty</th>
            </tr>
          </thead>
          <tbody>
            {!loading && summary.length === 0 && (
              <tr><td colSpan={3} className="p-6 text-center text-inksoft text-sm">Brak zakończonych testów w tym okresie.</td></tr>
            )}
            {summary.map((s) => (
              <tr key={s.email} className="border-b border-line last:border-b-0">
                <td className="p-3 font-semibold">{displayNameForEmail(s.email, members)}</td>
                <td className="p-3 text-right font-mono">{s.count}</td>
                <td className="p-3 text-right font-mono font-semibold">{fmtPoints(s.points)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <div className="border border-line bg-white p-4 mb-6">
        <h2 className="text-xs font-semibold text-inksoft mb-3">ROZPOCZNIJ TEST</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <div className="md:col-span-2">
            <label className="text-xs font-semibold text-inksoft block mb-1">Numer seryjny *</label>
            <input
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !submitting && submit()}
              className="w-full border border-line bg-white px-2 py-2 rounded text-sm font-mono"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-inksoft block mb-1">Rodzaj testu</label>
            <select
              value={testKind}
              onChange={(e) => setTestKind(e.target.value as TestKindKey)}
              className="w-full border border-line bg-white px-2 py-2 rounded text-sm"
            >
              {TEST_KINDS.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </div>
        </div>
        {formError && <p className="text-rust text-xs mb-2">{formError}</p>}
        <button onClick={submit} disabled={submitting} className={btnPrimary}>
          {submitting ? "Zapisywanie…" : "Rozpocznij test"}
        </button>
      </div>

      <h2 className="text-xs font-semibold text-inksoft mb-2">OSTATNIE TESTY</h2>
      <div className="border border-line bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Rozpoczęto</th>
              <th className="p-3">Pracownik</th>
              <th className="p-3">Numer seryjny</th>
              <th className="p-3">SKU</th>
              <th className="p-3">Rodzaj testu</th>
              <th className="p-3">Status</th>
              <th className="p-3">Wynik</th>
              <th className="p-3">Uwagi</th>
              {isAdminOrManager && <th className="p-3">Czas</th>}
              <th className="p-3 text-right">Punkty</th>
              {isAdmin && <th className="p-3"></th>}
            </tr>
          </thead>
          <tbody>
            {!loading && recent.length === 0 && (
              <tr><td colSpan={9 + (isAdminOrManager ? 1 : 0) + (isAdmin ? 1 : 0)} className="p-6 text-center text-inksoft text-sm">Brak testów — rozpocznij pierwszy powyżej.</td></tr>
            )}
            {recent.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-paper">
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(r.started_at)}</td>
                <td className="p-3">
                  <span
                    className="inline-block text-xs font-semibold px-2 py-1 rounded-full bg-paper text-ink"
                    style={{ backgroundColor: colorForUser(r.employee_email), color: colorForUser(r.employee_email) ? "#1f2937" : undefined }}
                  >
                    {displayNameForEmail(r.employee_email, members)}
                  </span>
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-1">
                    <InlineEditCell
                      value={r.serial_number}
                      placeholder="Numer seryjny"
                      className="w-36 font-mono font-semibold"
                      onSave={(next) => saveSerial(r, next)}
                    />
                    <button onClick={() => setOpenSerial(r.serial_number)} title="Otwórz kartę produktu" className="text-teal shrink-0">↗</button>
                  </div>
                </td>
                <td className="p-3">
                  <InlineEditCell value={r.sku} placeholder="SKU" className="w-32 font-mono" onSave={(next) => saveSku(r, next)} />
                </td>
                <td className="p-3">
                  <select
                    value={r.test_kind}
                    onChange={(e) => saveTestKind(r, e.target.value as TestKindKey)}
                    className="text-xs font-semibold px-2 py-1 rounded-full border-none"
                    style={{ backgroundColor: TEST_KIND_COLORS[r.test_kind]?.bg, color: TEST_KIND_COLORS[r.test_kind]?.fg }}
                  >
                    {TEST_KINDS.map((t) => (
                      <option key={t.key} value={t.key}>{t.label}</option>
                    ))}
                  </select>
                </td>
                <td className="p-3">
                  <select
                    value={r.status}
                    onChange={(e) => changeStatus(r, e.target.value as StatusKey)}
                    className={`text-xs font-semibold px-2 py-1 rounded-full border-none ${STATUS_STYLE[r.status]}`}
                  >
                    {STATUSES.map((s) => (
                      <option key={s.key} value={s.key}>{s.label}</option>
                    ))}
                  </select>
                </td>
                <td className="p-3">
                  <select
                    value={r.result ?? ""}
                    onChange={(e) => saveResult(r, e.target.value as TestResultKey | "")}
                    className={`text-xs px-2 py-1 rounded-full ${r.result ? "font-semibold border-none" : "border border-line bg-white"}`}
                    style={r.result ? { backgroundColor: TEST_RESULT_COLORS[r.result]?.bg, color: TEST_RESULT_COLORS[r.result]?.fg } : undefined}
                  >
                    <option value="">—</option>
                    {TEST_RESULTS.map((t) => (
                      <option key={t.key} value={t.key}>{t.label}</option>
                    ))}
                  </select>
                </td>
                <td className="p-3"><InlineEditCell value={r.notes} onSave={(n) => saveNotes(r, n)} multiline className="w-64" /></td>
                {isAdminOrManager && <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDuration(r.started_at, r.finished_at)}</td>}
                <td className="p-3 text-right font-mono font-semibold">{r.status === "przetestowane" ? fmtPoints(r.points) : "—"}</td>
                {isAdmin && (
                  <td className="p-3 text-right">
                    <button onClick={() => deleteRow(r)} className="text-xs font-semibold text-rust hover:underline">
                      Usuń
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openSerial && <ProductCardDrawer serial={openSerial} members={members} onClose={() => setOpenSerial(null)} />}
    </div>
  );
}
