"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import InlineEditCell from "./InlineEditCell";
import ProductCardDrawer from "./ProductCardDrawer";
import PartsImportDialog from "./PartsImportDialog";
import type { Session } from "@supabase/supabase-js";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { escapeLike } from "@/lib/search";

// Serwis -> Części (04.10.2026, na prośbę właściciela): rejestr części do napraw z ceną zakupu i przypisanym numerem seryjnym/IMEI urządzenia.
// Dane zakupowe (nazwa, cena, faktura) pochodzą z arkusza parts.numbers i są tylko do odczytu; zespół zmienia przypisanie urządzenia, status i
// uwagi o użyciu (trigger service_parts_guard w bazie pilnuje reszty). Ceny netto z PLN z arkusza zasilają koszt serwisu w zakładce Marża.

type Part = {
  id: number;
  received_at: string | null;
  invoice_no: string | null;
  supplier: string | null;
  status: string | null;
  name: string | null;
  part_code: string | null;
  price_net: number | null;
  currency: string | null;
  price_pln: number | null;
  device_ref: string | null;
  usage_notes: string | null;
  updated_at: string | null;
  updated_by_email: string | null;
};

const COLS = "id, received_at, invoice_no, supplier, status, name, part_code, price_net, currency, price_pln, device_ref, usage_notes, updated_at, updated_by_email";
const PAGE_SIZES = [25, 50, 100];
const FILTERS = [
  { key: "all", label: "Wszystkie" },
  { key: "assigned", label: "Przypisane" },
  { key: "free", label: "Nieprzypisane" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const fmt = (n: number | null, d = 2) => (n === null ? "—" : n.toLocaleString("pl-PL", { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtDate = (iso: string | null) => (iso ? new Date(iso + "T12:00:00").toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—");
const STATUS_STYLE: Record<string, string> = {
  "Dotarło": "bg-tealsoft text-teal",
  "Demontaż": "bg-[#e3ecf9] text-[#2a6bb5]",
  "Reklamacja": "bg-ambersoft text-amber",
  "Zareklamowane": "bg-ambersoft text-amber",
  "Uszkodzony": "bg-rustsoft text-rust",
};

export default function PartsView({ members, session }: { members: MemberLite[]; session: Session }) {
  const [rows, setRows] = useState<Part[]>([]);
  const [total, setTotal] = useState(0);
  const [sum, setSum] = useState<{ pln: number; count: number; freePln: number; freeCount: number } | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [openSerial, setOpenSerial] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  function applyFilters<T extends { or: (f: string) => T; not: (c: string, o: string, v: unknown) => T; is: (c: string, v: null) => T }>(q: T): T {
    if (search) {
      const pat = `"%${escapeLike(search).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}%"`;
      q = q.or(["name", "part_code", "device_ref", "invoice_no", "supplier", "usage_notes"].map((c) => `${c}.ilike.${pat}`).join(","));
    }
    if (filter === "assigned") q = q.not("device_ref", "is", null);
    else if (filter === "free") q = q.is("device_ref", null);
    return q;
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const from = (page - 1) * pageSize;
      const { data, error: err, count } = await applyFilters(supabase.from("service_parts").select(COLS, { count: "exact" }) as any)
        .order("received_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .range(from, from + pageSize - 1);
      if (cancelled) return;
      if (err) {
        if (err.code === "PGRST103" && page > 1) setPage(1);
        else setError(err.code === "42P01" || /service_parts/.test(err.message) ? "Brak tabeli części — uruchom supabase/service-parts.sql w Supabase i załaduj dane z arkusza." : `Nie udało się wczytać części: ${err.message}`);
      } else {
        setError("");
        setRows((data as Part[]) || []);
        setTotal(count ?? 0);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, search, filter, reload]);

  // Suma cen (PLN netto) dla CAŁEGO wyniku filtra — osobne zapytanie stronicowane po 1000, liczone tylko przy zmianie filtrów.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let pln = 0;
      let count = 0;
      let freePln = 0; // części DOSTĘPNE = bez przypisanego numeru seryjnego/IMEI urządzenia (08.10.2026)
      let freeCount = 0;
      for (let from = 0; ; from += 1000) {
        const { data, error: err } = await applyFilters(supabase.from("service_parts").select("price_pln, device_ref") as any).order("id").range(from, from + 999);
        if (err) return;
        for (const r of (data as { price_pln: number | null; device_ref: string | null }[]) || []) {
          const free = !r.device_ref || !r.device_ref.trim();
          if (r.price_pln !== null) {
            pln += Number(r.price_pln);
            if (free) freePln += Number(r.price_pln);
          }
          count++;
          if (free) freeCount++;
        }
        if (!data || data.length < 1000) break;
      }
      if (!cancelled) setSum({ pln, count, freePln, freeCount });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filter, reload]);

  async function saveField(id: number, patch: Partial<Pick<Part, "usage_notes">>) {
    setError("");
    const { error: err } = await supabase.from("service_parts").update(patch).eq("id", id);
    if (err) setError(`Nie udało się zapisać: ${err.message}`);
    else setReload((n) => n + 1);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Szukaj: nazwa, kod, numer seryjny/IMEI, faktura, dostawca"
          className="w-96 border border-line bg-white px-3 py-2 rounded text-sm"
        />
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => { setFilter(f.key); setPage(1); }} className={pill(filter === f.key)}>{f.label}</button>
        ))}
        <label className="text-xs text-inksoft ml-2">Pokaż</label>
        <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} className="border border-line bg-white px-2 py-1.5 rounded text-sm font-semibold">
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <button onClick={() => setImporting(true)} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold">+ Importuj z faktury</button>
        <div className="flex items-center gap-3 text-xs text-inksoft ml-auto">
          <span>{total.toLocaleString("pl-PL")} części · strona {Math.min(page, totalPages)} z {totalPages}</span>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || loading} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold text-ink disabled:opacity-40">‹ Poprzednia</button>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages || loading} className="bg-white border border-line px-3 py-1.5 rounded text-sm font-semibold text-ink disabled:opacity-40">Następna ›</button>
        </div>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <div className="bg-white border border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Data przyjęcia</th>
              <th className="p-3">Nazwa części</th>
              <th className="p-3">Kod</th>
              <th className="p-3">Dostawca / faktura</th>
              <th className="p-3 text-right">Cena netto</th>
              <th className="p-3 text-right">Cena netto PLN</th>
              <th className="p-3">Status</th>
              <th className="p-3" title="Wpisywany w Serwis → Naprawy (kolumna Części) — tu tylko do odczytu">Numer seryjny / IMEI urządzenia</th>
              <th className="p-3">Uwagi</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && !error && (
              <tr><td colSpan={9} className="p-6 text-center text-inksoft text-sm">{search || filter !== "all" ? "Brak wyników." : "Brak części — załaduj dane z arkusza."}</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 align-top">
                <td className="p-3 text-xs whitespace-nowrap">{fmtDate(r.received_at)}</td>
                <td className="p-3 max-w-xs">{r.name || "—"}</td>
                <td className="p-3 font-mono text-xs">{r.part_code || "—"}</td>
                <td className="p-3 text-xs">
                  <div>{r.supplier || "—"}</div>
                  {r.invoice_no && <div className="text-inksoft font-mono">{r.invoice_no}</div>}
                </td>
                <td className="p-3 text-right font-mono whitespace-nowrap">{r.price_net === null ? "—" : `${fmt(Number(r.price_net))} ${r.currency || ""}`}</td>
                <td className="p-3 text-right font-mono font-semibold whitespace-nowrap">{fmt(r.price_pln === null ? null : Number(r.price_pln))}</td>
                <td className="p-3">
                  {r.status ? <span className={`px-2 py-0.5 rounded text-xs font-semibold ${STATUS_STYLE[r.status] || "bg-paper text-inksoft"}`}>{r.status}</span> : <span className="text-inksoft">—</span>}
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-sm">{r.device_ref || <span className="text-inksoft">—</span>}</span>
                    {r.device_ref && !/[\s,;]/.test(r.device_ref) && (
                      <button onClick={() => setOpenSerial(r.device_ref!)} title="Otwórz kartę produktu" className="text-teal shrink-0">↗</button>
                    )}
                  </div>
                  {r.updated_by_email && <div className="text-[10px] text-inksoft mt-0.5" title={r.updated_at || ""}>zmienił: {displayNameForEmail(r.updated_by_email, members)}</div>}
                </td>
                <td className="p-3">
                  <InlineEditCell value={r.usage_notes} placeholder="Uwagi" className="w-56" multiline onSave={(v) => saveField(r.id, { usage_notes: v })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border border-line border-t-0 bg-white px-4 py-3 flex flex-wrap items-center gap-x-8 gap-y-1 text-sm">
        <span className="text-xs font-semibold text-inksoft">PODSUMOWANIE WYNIKU — wszystkie strony</span>
        <span>Części: <span className="font-mono font-semibold">{sum ? sum.count.toLocaleString("pl-PL") : "…"}</span></span>
        <span title="Części bez przypisanego numeru seryjnego/IMEI urządzenia">Dostępne: <span className="font-mono font-semibold">{sum ? sum.freeCount.toLocaleString("pl-PL") : "…"}</span></span>
        <span title="Suma cen netto części dostępnych (bez przypisanego numeru seryjnego/IMEI)">Wartość dostępnych (netto PLN): <span className="font-mono font-bold">{sum ? `${fmt(sum.freePln)} zł` : "…"}</span></span>
      </div>
      <p className="text-[11px] text-inksoft mt-3 max-w-4xl">
        Cena netto PLN to cena jednostkowa części. Części przypisane do numeru seryjnego wchodzą do kosztu serwisu w zakładce Marża (części przyjęte do dnia zamówienia, bez wierszy „Demontaż”).
        Dane zakupowe (z arkusza albo z importu faktury) są tylko do odczytu. Numer seryjny/IMEI urządzenia pojawia się automatycznie, gdy serwisant wpisze kod części w naprawie (Naprawy → kolumna „Części”) — dotyczy części z unikalnym kodem; zmieniasz tu tylko uwagi.
      </p>

      {importing && <PartsImportDialog session={session} onClose={() => setImporting(false)} onSaved={() => { setPage(1); setReload((n) => n + 1); }} />}
      {openSerial && <ProductCardDrawer serial={openSerial} members={members} onClose={() => setOpenSerial(null)} />}
    </div>
  );
}
