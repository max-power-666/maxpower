"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { escapeLike } from "@/lib/search";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { takePrefill, usePrefillListener } from "@/lib/searchPrefill";
import {
  RETURN_KINDS, RETURN_FINAL_STATUSES, RETURN_FINAL_COLORS, RETURN_PLATFORMS, RETURN_PLATFORM_COLORS, RETURN_PRODUCTS, platformLabel, type ReturnLookup,
} from "@/lib/returns";
import InlineEditCell from "./InlineEditCell";
import ProductCardDrawer from "./ProductCardDrawer";

// Zwroty (22.10.2026, na prośbę właściciela): rejestr przyjętych zwrotów w miejsce arkusza. Wprowadzanie jak w Testach/Trade-in: pierwszy wpisujesz numer seryjny
// (skaner + Enter), a platforma, numer zamówienia, SKU, produkt i imię i nazwisko kupującego podpowiadają się z naszych danych (api/returns/lookup) — każde pole można poprawić.
// Kolumny na start jak w arkuszu. Punktów za zwroty (regulamin: 17 pkt) tu NIE liczymy — nie było takiej prośby.

type Row = {
  id: number;
  created_by_email: string | null;
  received_at: string;
  return_kind: string | null;
  customer_name: string | null;
  platform: string | null;
  order_id: string | null;
  product: string | null;
  sku: string | null;
  serial_number: string | null;
  client_comment: string | null;
  can_do: boolean;
  final_status: string | null;
  correction_number: string | null;
  replaced_imei: string | null;
  check_notes: string | null;
  commission: number | null;
};

const COLS = "id, created_by_email, received_at, return_kind, customer_name, platform, order_id, product, sku, serial_number, client_comment, can_do, final_status, correction_number, replaced_imei, check_notes, commission";
const todayYmd = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const fmtDate = (ymd: string) => ymd.split("-").reverse().join(".");
const fmtMoney = (n: number | null) => (n === null ? "" : n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const btnPrimary = "bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50";
const input = "w-full border border-line bg-white px-2 py-2 rounded text-sm";
const label = "text-xs font-semibold text-inksoft block mb-1";

export default function ReturnsView({ session, members, isAdmin }: { session: Session; members: MemberLite[]; isAdmin: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchInput, setSearchInput] = useState(() => takePrefill("returns")); // wyszukiwarka globalna
  usePrefillListener("returns", setSearchInput);
  const [search, setSearch] = useState("");
  const [openSerial, setOpenSerial] = useState<string | null>(null);

  // formularz
  const emptyForm = { serial: "", kind: RETURN_KINDS[0].key as string, platform: "", orderId: "", name: "", product: "", sku: "", comment: "", receivedAt: todayYmd() };
  const [form, setForm] = useState(emptyForm);
  const [lookup, setLookup] = useState<ReturnLookup | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [previous, setPrevious] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const lastLooked = useRef("");

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    load();
    const channel = supabase.channel("returns-log-changes").on("postgres_changes", { event: "*", schema: "public", table: "returns_log" }, () => load()).subscribe();
    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, page, pageSize]);

  async function load() {
    setLoading(true);
    setError("");
    try {
      let q = supabase.from("returns_log").select(COLS, { count: "exact" });
      if (search) {
        const pat = `"%${escapeLike(search).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}%"`;
        q = q.or(["serial_number", "order_id", "customer_name", "sku", "correction_number", "replaced_imei"].map((c) => `${c}.ilike.${pat}`).join(","));
      }
      const { data, error: err, count } = await q.order("received_at", { ascending: false }).order("id", { ascending: false }).range(page * pageSize, page * pageSize + pageSize - 1);
      if (err) throw err;
      setRows((data as Row[]) || []);
      setTotal(count ?? 0);
    } catch (e: any) {
      setError(/returns_log/.test(e?.message || "") ? "Brak tabeli zwrotów — uruchom supabase/returns.sql w Supabase." : `Nie udało się wczytać zwrotów: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  // Podpowiedź danych po numerze seryjnym — nie nadpisuje pól, które już ktoś wpisał ręcznie
  async function doLookup(raw: string) {
    const serial = raw.trim();
    if (serial.length < 3 || serial === lastLooked.current) return;
    lastLooked.current = serial;
    setLookingUp(true);
    setLookup(null);
    try {
      const [res, prev] = await Promise.all([
        fetch(`/api/returns/lookup?serial=${encodeURIComponent(serial)}`, { headers: { Authorization: `Bearer ${session.access_token}` } }).then((r) => r.json()),
        supabase.from("returns_log").select("id", { count: "exact", head: true }).ilike("serial_number", escapeLike(serial)),
      ]);
      setPrevious(prev.count ?? 0);
      const l = res as ReturnLookup;
      setLookup(l);
      if (l.found) {
        setForm((f) => ({
          ...f,
          platform: f.platform || l.platform || "",
          orderId: f.orderId || l.orderId || "",
          name: f.name || l.customerName || "",
          product: f.product || l.product || "",
          sku: f.sku || l.sku || "",
        }));
      }
    } catch {
      setLookup({ found: false, note: "Nie udało się pobrać danych — uzupełnij pola ręcznie." });
    } finally {
      setLookingUp(false);
    }
  }

  async function submit() {
    setFormError("");
    const serial = form.serial.trim().toUpperCase();
    if (!serial) return setFormError("Podaj numer seryjny / IMEI.");
    setSubmitting(true);
    const { error: err } = await supabase.from("returns_log").insert({
      received_at: form.receivedAt || todayYmd(),
      return_kind: form.kind || null,
      customer_name: form.name.trim() || null,
      platform: form.platform || null,
      order_id: form.orderId.trim() || null,
      product: form.product || null,
      sku: form.sku.trim() || null,
      serial_number: serial,
      client_comment: form.comment.trim() || null,
    });
    setSubmitting(false);
    if (err) return setFormError(`Nie udało się zapisać: ${err.message}`);
    setForm({ ...emptyForm, kind: form.kind, receivedAt: form.receivedAt });
    setLookup(null);
    setPrevious(0);
    lastLooked.current = "";
    setPage(0);
    load();
  }

  async function save(row: Row, patch: Partial<Row>, what: string) {
    setError("");
    const { error: err } = await supabase.from("returns_log").update(patch).eq("id", row.id);
    if (err) setError(`Nie udało się zapisać (${what}): ${err.message}`);
    else setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
  }

  async function deleteRow(row: Row) {
    if (!confirm(`Usunąć zwrot „${row.serial_number || row.order_id || row.id}”? Tej operacji nie można cofnąć.`)) return;
    const { data, error: err } = await supabase.from("returns_log").delete().eq("id", row.id).select("id");
    if (err) setError(`Nie udało się usunąć: ${err.message}`);
    else if (!data?.length) setError("Nie usunięto — brak uprawnień (tylko Admin) albo wpis już nie istnieje.");
    else load();
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const th = "p-3 whitespace-nowrap";

  return (
    <div>
      <div className="border border-line bg-white p-4 mb-6">
        <h2 className="text-xs font-semibold text-inksoft mb-3">PRZYJMIJ ZWROT</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
          <div className="md:col-span-2">
            <label className={label}>Numer seryjny / IMEI *</label>
            <input
              value={form.serial}
              onChange={(e) => setForm({ ...form, serial: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doLookup(form.serial); } }}
              onBlur={() => doLookup(form.serial)}
              placeholder="Zeskanuj lub wpisz i naciśnij Enter — resztę podpowiemy"
              className={`${input} font-mono`}
              autoFocus
            />
          </div>
          <div>
            <label className={label}>Data przyjęcia</label>
            <input type="date" value={form.receivedAt} max={todayYmd()} onChange={(e) => setForm({ ...form, receivedAt: e.target.value })} className={input} />
          </div>
          <div>
            <label className={label}>Rodzaj zwrotu</label>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className={input}>
              {RETURN_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </div>
        </div>
        {(lookingUp || lookup || previous > 0) && (
          <div className="text-xs mb-3 space-y-1">
            {lookingUp && <p className="text-inksoft">Szukam danych…</p>}
            {lookup?.found && lookup.source === "zamowienie" && (
              <p className="text-teal">Znaleziono zamówienie {platformLabel(lookup.platform)} {lookup.orderId}{lookup.productName ? ` — ${lookup.productName}` : ""}. Pola poniżej uzupełnione — sprawdź je.</p>
            )}
            {lookup?.found && lookup.source !== "zamowienie" && <p className="text-amber">Znaleziono tylko SKU (źródło: {lookup.source}).</p>}
            {lookup && !lookup.found && <p className="text-inksoft">{lookup.note || "Nie znaleziono tego numeru w zamówieniach ani w magazynie — uzupełnij pola ręcznie."}</p>}
            {lookup?.note && lookup.found && <p className="text-inksoft">{lookup.note}</p>}
            {previous > 0 && <p className="text-amber">Uwaga: ten numer ma już {previous} {previous === 1 ? "zwrot" : "zwroty/zwrotów"} w rejestrze.</p>}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
          <div>
            <label className={label}>Platforma</label>
            <select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} className={input}>
              <option value="">—</option>
              {RETURN_PLATFORMS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>ID zamówienia</label>
            <input value={form.orderId} onChange={(e) => setForm({ ...form, orderId: e.target.value })} className={`${input} font-mono`} />
          </div>
          <div>
            <label className={label}>Imię i nazwisko</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
          </div>
          <div>
            <label className={label}>Produkt</label>
            <select value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })} className={input}>
              <option value="">—</option>
              {RETURN_PRODUCTS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>SKU</label>
            <input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} className={`${input} font-mono`} />
          </div>
          <div className="md:col-span-3">
            <label className={label}>Komentarz klienta</label>
            <input value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} onKeyDown={(e) => e.key === "Enter" && !submitting && submit()} className={input} />
          </div>
        </div>
        {formError && <p className="text-rust text-xs mb-2">{formError}</p>}
        <button onClick={submit} disabled={submitting} className={btnPrimary}>{submitting ? "Zapisywanie…" : "Dodaj zwrot"}</button>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h2 className="text-xs font-semibold text-inksoft">ZWROTY ({total.toLocaleString("pl-PL")})</h2>
        <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Szukaj: numer seryjny, zamówienie, imię i nazwisko, SKU, korekta…" className="border border-line bg-white px-3 py-1.5 rounded text-sm w-96 font-normal" />
        <div className="ml-auto flex items-center gap-2 text-xs text-inksoft">
          <label>Pokaż</label>
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }} className="border border-line bg-white px-2 py-1 rounded">
            {[25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button disabled={page === 0} onClick={() => setPage(page - 1)} className="border border-line px-2 py-1 rounded disabled:opacity-40">Poprzednia</button>
          <span>strona {page + 1} z {pages}</span>
          <button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className="border border-line px-2 py-1 rounded disabled:opacity-40">Następna</button>
        </div>
      </div>
      <div className="border border-line bg-white max-h-[calc(100vh-8rem)] overflow-auto scrollbar-always">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white z-10">
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className={th}>Data przyjęcia</th>
              <th className={th}>Rodzaj zwrotu</th>
              <th className={th}>Imię i nazwisko</th>
              <th className={th}>Platforma</th>
              <th className={th}>ID zamówienia</th>
              <th className={th}>Produkt</th>
              <th className={th}>SKU</th>
              <th className={th}>Numer seryjny / IMEI</th>
              <th className={th}>Komentarz klienta</th>
              <th className={th}>Czy można wykonać</th>
              <th className={th}>Status końcowy</th>
              <th className={th}>Numer korekty</th>
              <th className={th}>IMEI wymienionego</th>
              <th className={th}>Uwagi przy sprawdzaniu</th>
              <th className={`${th} text-right`}>Prowizja</th>
              <th className={th}>Dodał</th>
              {isAdmin && <th className={th}></th>}
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr><td colSpan={16 + (isAdmin ? 1 : 0)} className="p-6 text-center text-inksoft text-sm">{search ? "Brak wyników." : "Brak zwrotów — dodaj pierwszy powyżej."}</td></tr>
            )}
            {rows.map((r) => {
              const pc = r.platform ? RETURN_PLATFORM_COLORS[r.platform] : undefined;
              const fc = r.final_status ? RETURN_FINAL_COLORS[r.final_status] : undefined;
              return (
                <tr key={r.id} className="border-b border-line last:border-b-0 hover:bg-paper align-top">
                  <td className="p-3 text-xs whitespace-nowrap">
                    <input type="date" value={r.received_at} max={todayYmd()} onChange={(e) => e.target.value && save(r, { received_at: e.target.value }, "data")} className="bg-transparent border-none text-xs p-0" title={fmtDate(r.received_at)} />
                  </td>
                  <td className="p-3">
                    <select value={r.return_kind ?? ""} onChange={(e) => save(r, { return_kind: e.target.value || null }, "rodzaj")} className="text-xs border border-line bg-white px-2 py-1 rounded">
                      <option value="">—</option>
                      {RETURN_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                      {r.return_kind && !RETURN_KINDS.some((k) => k.key === r.return_kind) && <option value={r.return_kind}>{r.return_kind}</option>}
                    </select>
                  </td>
                  <td className="p-3"><InlineEditCell value={r.customer_name} placeholder="Imię i nazwisko" className="w-40" onSave={(v) => save(r, { customer_name: v }, "imię i nazwisko")} /></td>
                  <td className="p-3">
                    <select
                      value={r.platform ?? ""}
                      onChange={(e) => save(r, { platform: e.target.value || null }, "platforma")}
                      className={`text-xs px-2 py-1 rounded-full ${pc ? "font-semibold border-none" : "border border-line bg-white"}`}
                      style={pc ? { backgroundColor: pc.bg, color: pc.fg } : undefined}
                    >
                      <option value="">—</option>
                      {RETURN_PLATFORMS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                    </select>
                  </td>
                  <td className="p-3"><InlineEditCell value={r.order_id} placeholder="ID zamówienia" className="w-36 font-mono text-xs" onSave={(v) => save(r, { order_id: v }, "ID zamówienia")} /></td>
                  <td className="p-3">
                    <select value={r.product ?? ""} onChange={(e) => save(r, { product: e.target.value || null }, "produkt")} className="text-xs border border-line bg-white px-2 py-1 rounded">
                      <option value="">—</option>
                      {RETURN_PRODUCTS.map((p) => <option key={p} value={p}>{p}</option>)}
                      {r.product && !(RETURN_PRODUCTS as readonly string[]).includes(r.product) && <option value={r.product}>{r.product}</option>}
                    </select>
                  </td>
                  <td className="p-3"><InlineEditCell value={r.sku} placeholder="SKU" className="w-36 font-mono text-xs" onSave={(v) => save(r, { sku: v }, "SKU")} /></td>
                  <td className="p-3">
                    <div className="flex items-center gap-1">
                      <InlineEditCell value={r.serial_number} placeholder="Numer seryjny" className="w-36 font-mono font-semibold" onSave={(v) => save(r, { serial_number: v ? v.toUpperCase() : null }, "numer seryjny")} />
                      {r.serial_number && <button onClick={() => setOpenSerial(r.serial_number)} title="Otwórz kartę produktu" className="text-teal shrink-0">↗</button>}
                    </div>
                  </td>
                  <td className="p-3"><InlineEditCell value={r.client_comment} placeholder="Komentarz" multiline className="w-56" onSave={(v) => save(r, { client_comment: v }, "komentarz klienta")} /></td>
                  <td className="p-3 text-center"><input type="checkbox" checked={r.can_do} onChange={(e) => save(r, { can_do: e.target.checked }, "czy można wykonać")} /></td>
                  <td className="p-3">
                    <select
                      value={r.final_status ?? ""}
                      onChange={(e) => save(r, { final_status: e.target.value || null }, "status końcowy")}
                      className={`text-xs px-2 py-1 rounded-full ${fc ? "font-semibold border-none" : "border border-line bg-white"}`}
                      style={fc ? { backgroundColor: fc.bg, color: fc.fg } : undefined}
                    >
                      <option value="">—</option>
                      {RETURN_FINAL_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  </td>
                  <td className="p-3"><InlineEditCell value={r.correction_number} placeholder="Nr korekty" className="w-32 font-mono text-xs" onSave={(v) => save(r, { correction_number: v }, "numer korekty")} /></td>
                  <td className="p-3"><InlineEditCell value={r.replaced_imei} placeholder="IMEI" className="w-36 font-mono text-xs" onSave={(v) => save(r, { replaced_imei: v ? v.toUpperCase() : null }, "IMEI wymienionego")} /></td>
                  <td className="p-3"><InlineEditCell value={r.check_notes} placeholder="Uwagi" multiline className="w-56" onSave={(v) => save(r, { check_notes: v }, "uwagi przy sprawdzaniu")} /></td>
                  <td className="p-3 text-right">
                    <InlineEditCell
                      value={r.commission === null ? null : fmtMoney(r.commission)}
                      placeholder="0,00"
                      className="w-24 text-right"
                      onSave={(v) => {
                        if (v === null) return save(r, { commission: null }, "prowizja");
                        const n = Number(v.replace(/\s/g, "").replace(",", "."));
                        if (!Number.isFinite(n)) return setError("Prowizja musi być liczbą.");
                        save(r, { commission: Math.round(n * 100) / 100 }, "prowizja");
                      }}
                    />
                  </td>
                  <td className="p-3 text-xs text-inksoft whitespace-nowrap">{displayNameForEmail(r.created_by_email, members)}</td>
                  {isAdmin && (
                    <td className="p-3 text-right"><button onClick={() => deleteRow(r)} className="text-xs font-semibold text-rust hover:underline">Usuń</button></td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {openSerial && <ProductCardDrawer serial={openSerial} members={members} onClose={() => setOpenSerial(null)} />}
    </div>
  );
}
