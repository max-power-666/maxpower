"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

// Zakładka Trade-in: panel biddera cen skupu Back Market (dawny program "Buyback Bidder").
// Sam bidder działa na serwerze (lib/buyback.ts, cron Vercela) — tu tylko czytamy
// jego stan z Supabase, edytujemy ceny max / ignorowanie i zlecamy przebiegi.

const MARKETS = ["DE", "ES", "FR", "IT"] as const;
// Kolejność stała (skill dataviz, zwalidowana): kolor idzie za rynkiem, nie za pozycją.
const MARKET_COLORS: Record<string, string> = { DE: "#2a78d6", ES: "#eb6834", FR: "#1baf7a", IT: "#eda100" };

type Settings = { enabled: boolean; interval_minutes: number; run_requested_at: string | null; lock_until: string | null };
type Sku = {
  sku: string;
  listing_id: string;
  product_id: string | null;
  max_price: number | null;
  ignored: boolean;
  last_set: Record<string, number> | null;
  last_run_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
};
type Run = { id: number; source: string; status: string; started_at: string; finished_at: string | null; total: number; updated: number; failed: number };
type LogRow = { id: number; at: string; level: string; sku: string | null; message: string };
type HistoryRow = { market: string; price: number; price_to_win: number | null; at: string };
type Competitor = { market: string; price?: { amount: string } | null; price_to_win?: { amount: string } | null };

type Filter = "withMax" | "noMax" | "ignored" | "errors" | "all";

function fmtPrice(n: number | string | null | undefined) {
  if (n === null || n === undefined || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const cents = Number.isInteger(v) ? 0 : 2;
  return "€" + v.toLocaleString("pl-PL", { minimumFractionDigits: cents, maximumFractionDigits: cents });
}

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDuration(from: string, to: string | null) {
  const s = Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const btnPrimary = "bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50";
const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

export default function TradeInView({ session }: { session: Session }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sub, setSub] = useState<"skus" | "runs">("skus");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("withMax");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [openSku, setOpenSku] = useState<Sku | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    loadAll();
    const channel = supabase
      .channel("tradein-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "buyback_runs" }, () => {
        loadRuns();
        loadSkus();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "buyback_settings" }, () => loadSettings())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAll() {
    await Promise.all([loadSettings(), loadSkus(), loadRuns()]);
  }
  async function loadSettings() {
    const { data, error } = await supabase.from("buyback_settings").select("*").eq("id", 1).maybeSingle();
    if (error) setLoadError("Brak tabel Trade-in w bazie — uruchom supabase/tradein.sql w Supabase (SQL Editor).");
    setSettings((data as Settings) ?? null);
  }
  async function loadSkus() {
    const { data } = await supabase.from("buyback_skus").select("*").order("sku");
    setSkus((data as Sku[]) || []);
  }
  async function loadRuns() {
    const { data } = await supabase.from("buyback_runs").select("*").order("started_at", { ascending: false }).limit(30);
    setRuns((data as Run[]) || []);
  }

  const activeRun = runs[0]?.status === "running" ? runs[0] : null;
  const lastRun = runs[0] ?? null;
  const pending = !!settings?.run_requested_at && !activeRun;

  // Na produkcji przebieg popycha cron Vercela co minutę. Lokalnie (npm run dev) crona
  // nie ma — dlatego w trybie dev otwarta zakładka sama woła tick, dopóki przebieg trwa.
  useEffect(() => {
    if (process.env.NODE_ENV !== "development" || (!activeRun && !pending)) return;
    const t = setInterval(() => {
      fetch("/api/tradein/bidder", { headers: { Authorization: `Bearer ${session.access_token}` } }).then(() => {
        loadRuns();
        loadSkus();
      });
    }, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, pending, session.access_token]);

  function flash(msg: string) {
    setMessage(msg);
    setTimeout(() => setMessage(""), 3500);
  }

  async function runNow() {
    setRunBusy(true);
    try {
      const res = await fetch("/api/tradein/bidder", { method: "POST", headers: { Authorization: `Bearer ${session.access_token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Błąd uruchomienia");
      flash(data.reason === "locked" ? "Bidder właśnie pracuje — przebieg zlecony, ruszy w ciągu minuty." : "Przebieg uruchomiony.");
    } catch (e: any) {
      flash(e.message);
    } finally {
      setRunBusy(false);
      loadAll();
    }
  }

  async function toggleEnabled() {
    if (!settings) return;
    const enabled = !settings.enabled;
    if (enabled && !confirm("Włączyć automatyczny bidder? Będzie zmieniał ceny skupu na Back Markecie co " + settings.interval_minutes + " min.\n\nUpewnij się, że stary program Buyback Bidder na Macu jest wyłączony — inaczej oba będą nadpisywać sobie ceny.")) return;
    await supabase.from("buyback_settings").update({ enabled }).eq("id", 1);
    loadSettings();
  }

  async function saveMax(sku: string) {
    const raw = (drafts[sku] ?? "").trim().replace(",", ".");
    const value = raw === "" ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      flash(`Nieprawidłowa cena dla ${sku}.`);
      return;
    }
    const { error } = await supabase.from("buyback_skus").update({ max_price: value, updated_at: new Date().toISOString() }).eq("sku", sku);
    if (error) return flash(`Błąd zapisu: ${error.message}`);
    setSkus((prev) => prev.map((s) => (s.sku === sku ? { ...s, max_price: value } : s)));
    setDrafts(({ [sku]: _, ...rest }) => rest);
    flash(`Zapisano ${sku}.`);
  }

  async function toggleIgnored(s: Sku) {
    const { error } = await supabase.from("buyback_skus").update({ ignored: !s.ignored, updated_at: new Date().toISOString() }).eq("sku", s.sku);
    if (error) return flash(`Błąd zapisu: ${error.message}`);
    setSkus((prev) => prev.map((x) => (x.sku === s.sku ? { ...x, ignored: !s.ignored } : x)));
  }

  const hasMax = (s: Sku) => Number(s.max_price) > 0;
  const inBidding = skus.filter((s) => hasMax(s) && !s.ignored);
  const counts: Record<Filter, number> = {
    withMax: inBidding.length,
    noMax: skus.filter((s) => !hasMax(s)).length,
    ignored: skus.filter((s) => s.ignored).length,
    errors: skus.filter((s) => s.last_error).length,
    all: skus.length,
  };

  const visible = useMemo(() => {
    const q = search.trim().toUpperCase();
    return skus.filter((s) => {
      if (q && !s.sku.toUpperCase().includes(q)) return false;
      if (filter === "withMax") return hasMax(s) && !s.ignored;
      if (filter === "noMax") return !hasMax(s);
      if (filter === "ignored") return s.ignored;
      if (filter === "errors") return !!s.last_error;
      return true;
    });
  }, [skus, search, filter]);

  const progress = activeRun ? skus.filter((s) => s.last_attempt_at && s.last_attempt_at >= activeRun.started_at).length : 0;

  if (loadError) {
    return <div className="border border-line bg-white p-10 text-center text-sm text-rust">{loadError}</div>;
  }

  return (
    <div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-line border border-line mb-6">
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">AUTOMATYCZNY BIDDER</div>
          <div className="flex items-center gap-3">
            <span className={`text-xs font-semibold px-2 py-1 rounded-full ${settings?.enabled ? "bg-tealsoft text-teal" : "bg-rustsoft text-rust"}`}>
              {settings?.enabled ? `Włączony · co ${settings.interval_minutes} min` : "Wyłączony"}
            </span>
            <button onClick={toggleEnabled} disabled={!settings} className="text-xs underline text-inksoft">
              {settings?.enabled ? "wyłącz" : "włącz"}
            </button>
          </div>
        </div>
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">OSTATNI PRZEBIEG</div>
          {activeRun ? (
            <div className="text-3xl font-bold font-mono">
              {progress}/{activeRun.total}
              <span className="text-xs font-sans font-semibold ml-2 px-2 py-1 rounded-full bg-ambersoft text-amber align-middle">w toku</span>
            </div>
          ) : (
            <div className="text-3xl font-bold font-mono">{lastRun ? fmtDateTime(lastRun.finished_at || lastRun.started_at) : "—"}</div>
          )}
        </div>
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">SKU W WYCENIE</div>
          <div className="text-3xl font-bold font-mono">{inBidding.length}</div>
        </div>
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">BŁĘDY (OSTATNI PRZEBIEG)</div>
          <div className={`text-3xl font-bold font-mono ${lastRun?.failed ? "text-rust" : ""}`}>{lastRun ? lastRun.failed : "—"}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex gap-2">
          <button onClick={() => setSub("skus")} className={pill(sub === "skus")}>Ceny SKU</button>
          <button onClick={() => setSub("runs")} className={pill(sub === "runs")}>Przebiegi i log</button>
        </div>
        <div className="flex items-center gap-3">
          {message && <span className="text-xs text-inksoft">{message}</span>}
          {pending && <span className="text-xs text-inksoft">przebieg zlecony, czeka na start…</span>}
          <button onClick={runNow} disabled={runBusy || !!activeRun} className={btnPrimary}>
            {activeRun ? "Przebieg trwa…" : runBusy ? "Uruchamianie…" : "Uruchom teraz"}
          </button>
        </div>
      </div>

      {sub === "skus" && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Szukaj SKU, np. XSX-1TB-A"
              className="border border-line bg-white px-3 py-2 rounded text-sm w-64"
            />
            {(
              [
                ["withMax", "W wycenie"],
                ["noMax", "Bez ceny max"],
                ["ignored", "Ignorowane"],
                ["errors", "Z błędem"],
                ["all", "Wszystkie"],
              ] as [Filter, string][]
            ).map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)} className={pill(filter === k)}>
                {label} <span className="font-mono opacity-70">{counts[k]}</span>
              </button>
            ))}
          </div>

          <div className="border border-line bg-white overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-inksoft border-b border-line">
                  <th className="p-3">SKU</th>
                  <th className="p-3">Cena max</th>
                  {MARKETS.map((m) => (
                    <th key={m} className="p-3 text-right">{m}</th>
                  ))}
                  <th className="p-3">Ostatnio</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-center">Ignoruj</th>
                </tr>
              </thead>
              <tbody>
                {skus.length === 0 && (
                  <tr><td colSpan={9} className="p-6 text-center text-inksoft text-sm">Brak SKU — zaimportuj katalog skryptem scripts/import-buyback.mjs.</td></tr>
                )}
                {skus.length > 0 && visible.length === 0 && (
                  <tr><td colSpan={9} className="p-6 text-center text-inksoft text-sm">Nic nie pasuje do filtra.</td></tr>
                )}
                {visible.map((s) => {
                  const draft = drafts[s.sku];
                  const dirty = draft !== undefined && draft !== String(s.max_price ?? "");
                  return (
                    <tr key={s.sku} className={`border-b border-line last:border-b-0 hover:bg-paper ${s.ignored ? "text-inksoft" : ""}`}>
                      <td className="p-3">
                        <button onClick={() => setOpenSku(s)} className="font-mono font-semibold hover:underline">{s.sku}</button>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <input
                            inputMode="decimal"
                            value={draft ?? (s.max_price ?? "")}
                            onChange={(e) => setDrafts({ ...drafts, [s.sku]: e.target.value })}
                            onKeyDown={(e) => e.key === "Enter" && dirty && saveMax(s.sku)}
                            placeholder="—"
                            className="w-20 border border-line bg-white px-2 py-1 rounded font-mono text-sm"
                          />
                          {dirty && (
                            <button onClick={() => saveMax(s.sku)} className="text-xs font-semibold px-2 py-1 rounded bg-ink text-paper">Zapisz</button>
                          )}
                        </div>
                      </td>
                      {MARKETS.map((m) => (
                        <td key={m} className="p-3 text-right font-mono">{fmtPrice(s.last_set?.[m])}</td>
                      ))}
                      <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(s.last_run_at)}</td>
                      <td className="p-3">
                        {s.last_error ? (
                          <span title={s.last_error} className="text-xs font-semibold px-2 py-1 rounded-full bg-rustsoft text-rust">błąd</span>
                        ) : s.last_run_at ? (
                          <span className="text-xs font-semibold px-2 py-1 rounded-full bg-tealsoft text-teal">OK</span>
                        ) : (
                          <span className="text-xs text-inksoft">—</span>
                        )}
                      </td>
                      <td className="p-3 text-center">
                        <input type="checkbox" checked={s.ignored} onChange={() => toggleIgnored(s)} className="accent-ink" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {sub === "runs" && <RunsView runs={runs} />}

      {openSku && <SkuDrawer sku={openSku} session={session} onClose={() => setOpenSku(null)} />}
    </div>
  );
}

/* ---------------- przebiegi i log ---------------- */

function RunsView({ runs }: { runs: Run[] }) {
  const [selected, setSelected] = useState<number | null>(runs[0]?.id ?? null);
  const [logRows, setLogRows] = useState<LogRow[]>([]);
  const [onlyProblems, setOnlyProblems] = useState(false);

  useEffect(() => {
    if (selected === null && runs[0]) setSelected(runs[0].id);
  }, [runs, selected]);

  useEffect(() => {
    if (selected === null) return;
    supabase
      .from("buyback_log")
      .select("id, at, level, sku, message")
      .eq("run_id", selected)
      .order("at")
      .limit(2000)
      .then(({ data }) => setLogRows((data as LogRow[]) || []));
  }, [selected, runs]);

  const shown = onlyProblems ? logRows.filter((r) => r.level !== "info") : logRows;

  return (
    <div className="grid xl:grid-cols-2 gap-6">
      <div className="border border-line bg-white overflow-x-auto self-start">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Start</th>
              <th className="p-3">Źródło</th>
              <th className="p-3">Status</th>
              <th className="p-3 text-right">OK</th>
              <th className="p-3 text-right">Błędy</th>
              <th className="p-3">Czas</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-inksoft text-sm">Jeszcze nie było żadnego przebiegu.</td></tr>
            )}
            {runs.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelected(r.id)}
                className={`border-b border-line last:border-b-0 cursor-pointer ${selected === r.id ? "bg-paper" : "hover:bg-paper"}`}
              >
                <td className="p-3 whitespace-nowrap">{fmtDateTime(r.started_at)}</td>
                <td className="p-3 text-inksoft">{r.source === "manual" ? "ręcznie" : "cron"}</td>
                <td className="p-3">
                  <span className={`text-xs font-semibold px-2 py-1 rounded-full ${r.status === "running" ? "bg-ambersoft text-amber" : "bg-tealsoft text-teal"}`}>
                    {r.status === "running" ? "w toku" : "zakończony"}
                  </span>
                </td>
                <td className="p-3 text-right font-mono">{r.updated}</td>
                <td className={`p-3 text-right font-mono ${r.failed ? "text-rust font-semibold" : ""}`}>{r.failed}</td>
                <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDuration(r.started_at, r.finished_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-inksoft">LOG PRZEBIEGU</h2>
          <label className="text-xs text-inksoft flex items-center gap-2">
            <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} className="accent-ink" />
            tylko ostrzeżenia i błędy
          </label>
        </div>
        <div className="border border-line bg-white max-h-[560px] overflow-y-auto">
          {shown.length === 0 && <div className="p-6 text-center text-inksoft text-sm">Brak wpisów.</div>}
          {shown.map((r) => (
            <div key={r.id} className="flex gap-3 px-3 py-1.5 border-b border-line last:border-b-0 text-xs">
              <span className="font-mono text-inksoft shrink-0">{fmtTime(r.at)}</span>
              <span className={`font-semibold shrink-0 w-12 ${r.level === "error" ? "text-rust" : r.level === "warn" ? "text-amber" : "text-inksoft"}`}>
                {r.level === "error" ? "BŁĄD" : r.level === "warn" ? "UWAGA" : "info"}
              </span>
              {r.sku && <span className="font-mono font-semibold shrink-0">{r.sku}</span>}
              <span className={`break-words min-w-0 ${r.level === "error" ? "text-rust" : ""}`}>{r.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- panel SKU: konkurencja + historia ---------------- */

const RANGES = [
  { k: "1d", label: "24 h", ms: 86_400_000 },
  { k: "7d", label: "7 dni", ms: 7 * 86_400_000 },
  { k: "30d", label: "30 dni", ms: 30 * 86_400_000 },
  { k: "all", label: "Wszystko", ms: 0 },
];

function SkuDrawer({ sku, session, onClose }: { sku: Sku; session: Session; onClose: () => void }) {
  const [competitors, setCompetitors] = useState<Competitor[] | null>(null);
  const [compError, setCompError] = useState("");
  const [compLoading, setCompLoading] = useState(false);
  const [compAt, setCompAt] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [range, setRange] = useState("7d");

  async function loadCompetitors() {
    setCompLoading(true);
    setCompError("");
    try {
      const res = await fetch(`/api/tradein/competitors?listing_id=${encodeURIComponent(sku.listing_id)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Błąd pobierania");
      setCompetitors(data);
      setCompAt(new Date().toISOString());
    } catch (e: any) {
      setCompError(e.message);
    } finally {
      setCompLoading(false);
    }
  }

  useEffect(() => {
    loadCompetitors();
    supabase
      .from("buyback_price_history")
      .select("market, price, price_to_win, at")
      .eq("sku", sku.sku)
      .order("at")
      .limit(5000)
      .then(({ data }) => setHistory((data as HistoryRow[]) || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sku.sku]);

  const rangeMs = RANGES.find((r) => r.k === range)!.ms;
  const from = rangeMs ? Date.now() - rangeMs : history.length ? Date.parse(history[0].at) : Date.now() - 86_400_000;
  const changes = history.filter((h) => Date.parse(h.at) >= from).slice().reverse();

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-2xl bg-paper h-full overflow-y-auto p-6 border-l border-line">
        <div className="flex justify-between items-start mb-1">
          <h2 className="text-lg font-semibold font-mono">{sku.sku}</h2>
          <button onClick={onClose} className="text-inksoft text-lg">✕</button>
        </div>
        <p className="text-xs text-inksoft font-mono mb-6">listing {sku.listing_id}</p>

        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-inksoft">KONKURENCJA — NA ŻYWO Z BACK MARKET</h3>
          <div className="flex items-center gap-3">
            {compAt && <span className="text-xs text-inksoft">{fmtTime(compAt)}</span>}
            <button onClick={loadCompetitors} disabled={compLoading} className="bg-white border border-line px-3 py-1 rounded text-xs font-semibold disabled:opacity-50">
              {compLoading ? "Pobieranie…" : "Odśwież"}
            </button>
          </div>
        </div>
        {compError && <p className="text-rust text-xs mb-2">{compError}</p>}
        <div className="border border-line bg-white mb-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-inksoft border-b border-line">
                <th className="p-3">Rynek</th>
                <th className="p-3 text-right">Cena do wygrania</th>
                <th className="p-3 text-right">Cena BackBox</th>
                <th className="p-3 text-right">Nasza (ostatnio)</th>
                <th className="p-3 text-right">Max</th>
              </tr>
            </thead>
            <tbody>
              {MARKETS.map((m) => {
                const c = competitors?.find((x) => x.market === m);
                return (
                  <tr key={m} className="border-b border-line last:border-b-0">
                    <td className="p-3 font-semibold">
                      <span className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-sm inline-block" style={{ background: MARKET_COLORS[m] }} />
                        {m}
                      </span>
                    </td>
                    <td className="p-3 text-right font-mono">{competitors ? fmtPrice(c?.price_to_win?.amount) : "…"}</td>
                    <td className="p-3 text-right font-mono">{competitors ? fmtPrice(c?.price?.amount) : "…"}</td>
                    <td className="p-3 text-right font-mono">{fmtPrice(sku.last_set?.[m])}</td>
                    <td className="p-3 text-right font-mono text-inksoft">{fmtPrice(sku.max_price)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-inksoft mb-6">
          Podgląd tylko czyta dane. „Cena do wygrania” liczy się względem naszej aktualnej oferty.
        </p>

        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-inksoft">HISTORIA NASZYCH CEN</h3>
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button key={r.k} onClick={() => setRange(r.k)} className={`text-xs font-semibold px-3 py-1 rounded-full border ${range === r.k ? "bg-ink text-paper border-ink" : "bg-white border-line"}`}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div className="border border-line bg-white p-4 mb-4">
          <PriceChart history={history} from={from} />
        </div>

        <div className="border border-line bg-white max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-xs text-inksoft border-b border-line">
                <th className="p-2 pl-3">Zmiana</th>
                <th className="p-2">Rynek</th>
                <th className="p-2 text-right">Nasza cena</th>
                <th className="p-2 pr-3 text-right">Do wygrania</th>
              </tr>
            </thead>
            <tbody>
              {changes.length === 0 && (
                <tr><td colSpan={4} className="p-4 text-center text-inksoft text-xs">Brak zmian ceny w tym okresie.</td></tr>
              )}
              {changes.map((h, i) => (
                <tr key={i} className="border-b border-line last:border-b-0">
                  <td className="p-2 pl-3 text-xs text-inksoft whitespace-nowrap">{fmtDateTime(h.at)}</td>
                  <td className="p-2 font-semibold">{h.market}</td>
                  <td className="p-2 text-right font-mono">{fmtPrice(h.price)}</td>
                  <td className="p-2 pr-3 text-right font-mono text-inksoft">{fmtPrice(h.price_to_win)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ---------------- wykres historii (schodkowy — cena obowiązuje do następnej zmiany) ---------------- */

function PriceChart({ history, from }: { history: HistoryRow[]; from: number }) {
  const W = 600, H = 220, L = 44, R = 12, T = 10, B = 26;
  const to = Date.now();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);

  // Dla każdego rynku: punkty zmian; ostatnia cena sprzed okna "wchodzi" na jego początek.
  const series = MARKETS.map((m) => {
    const rows = history.filter((h) => h.market === m).map((h) => ({ t: Date.parse(h.at), v: Number(h.price) }));
    const before = rows.filter((p) => p.t < from).pop();
    const inside = rows.filter((p) => p.t >= from);
    const pts = [...(before ? [{ t: from, v: before.v }] : []), ...inside];
    return { m, pts };
  }).filter((s) => s.pts.length > 0);

  if (series.length === 0) {
    return <div className="h-40 flex items-center justify-center text-sm text-inksoft">Brak danych w tym okresie.</div>;
  }

  const values = series.flatMap((s) => s.pts.map((p) => p.v));
  let minV = Math.min(...values), maxV = Math.max(...values);
  if (minV === maxV) { minV -= 10; maxV += 10; }
  const pad = (maxV - minV) * 0.08;
  minV = Math.max(0, minV - pad); maxV += pad;

  const x = (t: number) => L + ((t - from) / Math.max(to - from, 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - minV) / (maxV - minV)) * (H - T - B);
  const ticks = [0, 1, 2, 3].map((i) => minV + ((maxV - minV) * i) / 3);

  const path = (pts: { t: number; v: number }[]) => {
    let d = `M${x(pts[0].t)},${y(pts[0].v)}`;
    for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].t)} V${y(pts[i].v)}`;
    return d + ` H${x(to)}`;
  };
  const valueAt = (pts: { t: number; v: number }[], t: number) => pts.filter((p) => p.t <= t).pop()?.v ?? null;

  function onMove(e: React.MouseEvent) {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < L || px > W - R) return setHoverT(null);
    setHoverT(from + ((px - L) / (W - L - R)) * (to - from));
  }

  const hoverVals = hoverT !== null ? series.map((s) => ({ m: s.m, v: valueAt(s.pts, hoverT) })).filter((s) => s.v !== null) : [];
  const tipLeft = hoverT !== null && x(hoverT) > W / 2;

  return (
    <div>
      <div className="relative">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" onMouseMove={onMove} onMouseLeave={() => setHoverT(null)}>
          {ticks.map((v, i) => (
            <g key={i}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#C7CCB9" strokeWidth={1} strokeDasharray={i === 0 ? undefined : "2 3"} />
              <text x={L - 6} y={y(v) + 3} textAnchor="end" className="fill-inksoft" style={{ fontSize: 10 }}>{Math.round(v)}</text>
            </g>
          ))}
          <text x={L} y={H - 8} className="fill-inksoft" style={{ fontSize: 10 }}>{fmtDateTime(new Date(from).toISOString())}</text>
          <text x={W - R} y={H - 8} textAnchor="end" className="fill-inksoft" style={{ fontSize: 10 }}>teraz</text>
          {series.map((s) => (
            <path key={s.m} d={path(s.pts)} fill="none" stroke={MARKET_COLORS[s.m]} strokeWidth={2} strokeLinejoin="round" />
          ))}
          {hoverT !== null && (
            <g>
              <line x1={x(hoverT)} x2={x(hoverT)} y1={T} y2={H - B} stroke="#57614F" strokeWidth={1} />
              {hoverVals.map((h) => (
                <circle key={h.m} cx={x(hoverT)} cy={y(h.v!)} r={4} fill={MARKET_COLORS[h.m]} stroke="#fff" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
        {hoverT !== null && hoverVals.length > 0 && (
          <div
            className="absolute top-2 pointer-events-none bg-white border border-line rounded px-3 py-2 text-xs shadow-sm"
            style={tipLeft ? { right: `${((W - x(hoverT)) / W) * 100 + 2}%` } : { left: `${(x(hoverT) / W) * 100 + 2}%` }}
          >
            <div className="text-inksoft mb-1">{fmtDateTime(new Date(hoverT).toISOString())}</div>
            {hoverVals.map((h) => (
              <div key={h.m} className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: MARKET_COLORS[h.m] }} />
                <span className="font-semibold w-6">{h.m}</span>
                <span className="font-mono">{fmtPrice(h.v)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex gap-4 mt-2 text-xs">
        {series.map((s) => (
          <span key={s.m} className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm inline-block" style={{ background: MARKET_COLORS[s.m] }} />
            <span className="font-semibold">{s.m}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
