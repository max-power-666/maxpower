import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Bidder cen skupu Back Market — przeniesiony ze starego programu "Buyback Bidder"
// (bidder-runner.js). Logika wyceny SKU jest ta sama:
//   1. ustaw 10 € na wszystkich rynkach (żeby API pokazało prawdziwe price_to_win,
//      a nie naszą obecną ofertę),
//   2. pobierz konkurencję,
//   3. cena = min(price_to_win, cena max) per rynek,
//   4. ustaw ją; przy błędzie przywróć ostatnio ustawione ceny.
//
// Różnica: funkcja na Vercelu ma limit czasu, a pełny przebieg (~180 SKU × ~3 s)
// trwa ok. 9 minut. Dlatego przebieg jest dzielony na "ticki": cron co minutę woła
// bidderTick(), który przetwarza tyle SKU, ile zmieści w TICK_BUDGET_MS, i kończy.
// Kursorem przebiegu jest buyback_skus.last_attempt_at < run.started_at.

export const MARKETS = ["DE", "ES", "FR", "IT"] as const;
type Market = (typeof MARKETS)[number];

const REQUEST_TIMEOUT_MS = 45_000;
const SLEEP_BETWEEN_SKUS_MS = 2_000;
// Nowy SKU zaczynamy tylko przed upływem budżetu. Najgorszy przypadek jednego SKU to
// 3 zapytania × 45 s, więc 120 s + 137 s mieści się w maxDuration = 300 s trasy.
const TICK_BUDGET_MS = 120_000;
const LOCK_MS = 300_000;
const LOG_RETENTION_DAYS = 7;

type SkuRow = {
  sku: string;
  listing_id: string;
  max_price: number | null;
  last_set: Record<string, number> | null;
  in_progress_since: string | null;
};

type Run = { id: number; source: string; started_at: string; updated: number; failed: number };

export function supabaseAdmin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

// Vercel Cron wysyła "Authorization: Bearer <CRON_SECRET>"; przyciski w aplikacji
// wysyłają token zalogowanego użytkownika Supabase.
export async function isAuthorized(request: Request): Promise<boolean> {
  const header = request.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return true;
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data } = await anon.auth.getUser(token);
  return !!data?.user;
}

/* ---------------- API Back Market ---------------- */

function bmConfig() {
  const auth = process.env.BACKMARKET_AUTH;
  if (!auth) throw new Error("Brak BACKMARKET_AUTH w zmiennych środowiskowych");
  return {
    auth,
    lang: process.env.BACKMARKET_LANG || "fr-fr",
    ua: process.env.BACKMARKET_UA || "backmarket@recoo.io",
    baseUrl: process.env.BACKMARKET_BASE_URL || "https://www.backmarket.fr",
  };
}

async function bmFetch(path: string, init: RequestInit = {}) {
  const { auth, lang, ua, baseUrl } = bmConfig();
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": lang,
        Authorization: auth,
        "User-Agent": ua,
      },
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError") throw new Error(`Timeout po ${REQUEST_TIMEOUT_MS / 1000} s`);
    throw err;
  }
}

export type Competitor = {
  market: string;
  price?: { amount: string; currency: string } | null;
  price_to_win?: { amount: string; currency: string } | null;
};

export async function fetchCompetitors(listingId: string): Promise<Competitor[]> {
  const resp = await bmFetch(`/ws/buyback/v1/competitors/${encodeURIComponent(listingId)}`);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`GET competitors ${resp.status}: ${text.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("GET competitors zwrócił nie-JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("GET competitors: nieoczekiwany format odpowiedzi");
  return parsed as Competitor[];
}

async function putListingPrices(listingId: string, prices: Partial<Record<Market, number>>) {
  const body = {
    prices: Object.fromEntries(
      Object.entries(prices).map(([m, amount]) => [m, { amount: Number(amount).toFixed(2), currency: "EUR" }])
    ),
  };
  const resp = await bmFetch(`/ws/buyback/v1/listings/${encodeURIComponent(listingId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PUT listing ${resp.status}: ${text.slice(0, 200)}`);
  }
}

/* ---------------- tick ---------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type TickResult =
  | { ok: false; reason: "locked" }
  | { ok: true; idle: true }
  | { ok: true; idle: false; runId: number; processed: number; remaining: number; finished: boolean };

export async function bidderTick(opts: { requestRun?: boolean } = {}): Promise<TickResult> {
  const db = supabaseAdmin();
  const startedAt = Date.now();

  if (opts.requestRun) {
    await db.from("buyback_settings").update({ run_requested_at: new Date().toISOString() }).eq("id", 1);
  }

  // Blokada: tylko jeden tick naraz (odpowiednik bidder.lock). Wygasa sama po LOCK_MS,
  // więc ubita funkcja nie blokuje biddera na zawsze.
  const nowIso = new Date().toISOString();
  const { data: locked, error: lockError } = await db
    .from("buyback_settings")
    .update({ lock_until: new Date(startedAt + LOCK_MS).toISOString() })
    .eq("id", 1)
    .or(`lock_until.is.null,lock_until.lt.${nowIso}`)
    .select("enabled, interval_minutes, run_requested_at");
  if (lockError) throw new Error(`Supabase: ${lockError.message}`);
  if (!locked || locked.length === 0) return { ok: false, reason: "locked" };
  const settings = locked[0] as { enabled: boolean; interval_minutes: number; run_requested_at: string | null };

  try {
    let run = await getActiveRun(db);
    await recoverInterrupted(db, run?.id ?? null);

    if (!run) {
      const { data: last } = await db
        .from("buyback_runs")
        .select("started_at")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const intervalMs = (settings.interval_minutes || 15) * 60_000;
      const due = settings.enabled && (!last || Date.now() - Date.parse(last.started_at) >= intervalMs);
      const requested = !!settings.run_requested_at;
      if (!due && !requested) return { ok: true, idle: true };

      const { count } = await targetsQuery(db, null, { head: true });
      const { data: created, error } = await db
        .from("buyback_runs")
        .insert({ source: requested ? "manual" : "cron", total: count ?? 0 })
        .select("id, source, started_at, updated, failed")
        .single();
      if (error) throw new Error(`Supabase: ${error.message}`);
      run = created as Run;
      await db.from("buyback_settings").update({ run_requested_at: null }).eq("id", 1);
      await log(db, run.id, "info", null, `Start przebiegu (${run.source}), SKU do wyceny: ${count ?? 0}`);
    }

    let updated = 0;
    let failed = 0;
    let processed = 0;
    const { data: targets, error: tErr } = await targetsQuery(db, run.started_at);
    if (tErr) throw new Error(`Supabase: ${tErr.message}`);
    const queue = (targets as SkuRow[]) || [];

    for (const sku of queue) {
      if (Date.now() - startedAt > TICK_BUDGET_MS) break;
      if (processed > 0) await sleep(SLEEP_BETWEEN_SKUS_MS);
      const ok = await processSku(db, run.id, sku);
      processed += 1;
      if (ok) updated += 1;
      else failed += 1;
    }

    const remaining = queue.length - processed;
    const patch: Record<string, unknown> = { updated: run.updated + updated, failed: run.failed + failed };
    if (remaining === 0) {
      patch.status = "finished";
      patch.finished_at = new Date().toISOString();
    }
    await db.from("buyback_runs").update(patch).eq("id", run.id);
    if (remaining === 0) {
      await log(db, run.id, "info", null, `Koniec przebiegu. Zaktualizowano: ${patch.updated}. Błędy: ${patch.failed}`);
      const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString();
      await db.from("buyback_log").delete().lt("at", cutoff);
    }
    return { ok: true, idle: false, runId: run.id, processed, remaining, finished: remaining === 0 };
  } finally {
    await db.from("buyback_settings").update({ lock_until: null }).eq("id", 1);
  }
}

async function getActiveRun(db: SupabaseClient): Promise<Run | null> {
  const { data } = await db
    .from("buyback_runs")
    .select("id, source, started_at, updated, failed")
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as Run) ?? null;
}

// SKU do wyceny w danym przebiegu: nie ignorowane, z ceną max > 0, jeszcze nie
// próbowane od startu przebiegu (runStartedAt = null -> wszystkie, do liczenia total).
function targetsQuery(db: SupabaseClient, runStartedAt: string | null, countOpts?: { head: true }) {
  let q = countOpts
    ? db.from("buyback_skus").select("sku", { count: "exact", head: true })
    : db.from("buyback_skus").select("sku, listing_id, max_price, last_set, in_progress_since");
  q = q.eq("ignored", false).gt("max_price", 0);
  if (runStartedAt) q = q.or(`last_attempt_at.is.null,last_attempt_at.lt.${runStartedAt}`);
  return q.order("sku");
}

// Jeśli poprzedni tick został ubity w trakcie SKU (między "10 €" a właściwą ceną),
// listing wisiałby z ceną 10 €. Przywracamy ostatnie znane ceny.
async function recoverInterrupted(db: SupabaseClient, runId: number | null) {
  const { data } = await db
    .from("buyback_skus")
    .select("sku, listing_id, last_set")
    .not("in_progress_since", "is", null);
  for (const row of (data as SkuRow[]) || []) {
    try {
      if (row.last_set && Object.keys(row.last_set).length) {
        await putListingPrices(row.listing_id, row.last_set);
        await log(db, runId, "warn", row.sku, "Przerwany w trakcie — przywrócono ostatnie ceny");
      } else {
        await log(db, runId, "error", row.sku, "Przerwany w trakcie, brak ostatnich cen do przywrócenia — listing może mieć 10 €");
      }
    } catch (err: any) {
      await log(db, runId, "error", row.sku, `Przywracanie po przerwaniu nieudane: ${err.message}`);
    }
    await db.from("buyback_skus").update({ in_progress_since: null }).eq("sku", row.sku);
  }
}

async function processSku(db: SupabaseClient, runId: number, row: SkuRow): Promise<boolean> {
  const maxPrice = toNumber(row.max_price);
  const now = new Date().toISOString();
  await db.from("buyback_skus").update({ in_progress_since: now, last_attempt_at: now }).eq("sku", row.sku);

  try {
    // Krok 1: 10 € na wszystkich rynkach
    await putListingPrices(row.listing_id, { FR: 10, DE: 10, ES: 10, IT: 10 });

    // Krok 2: konkurencja
    const competitors = await fetchCompetitors(row.listing_id);

    // Krok 3: min(price_to_win, max) per rynek. Rynek bez price_to_win zostaje na 10 €
    // — tak samo jak w starym bidderze.
    const prices: Partial<Record<Market, number>> = {};
    const ptws: Partial<Record<Market, number>> = {};
    for (const m of MARKETS) {
      const ptw = toNumber(competitors.find((c) => c.market === m)?.price_to_win?.amount);
      if (ptw === null || maxPrice === null) continue;
      ptws[m] = ptw;
      prices[m] = Math.round(Math.min(ptw, maxPrice) * 100) / 100;
    }
    const missing = MARKETS.filter((m) => prices[m] === undefined);

    if (Object.keys(prices).length === 0) {
      await db.from("buyback_skus").update({ in_progress_since: null, last_error: "Brak price_to_win na wszystkich rynkach" }).eq("sku", row.sku);
      await log(db, runId, "warn", row.sku, "Brak price_to_win na wszystkich rynkach — listing zostaje na 10 €");
      return false;
    }

    // Krok 4: właściwe ceny
    await putListingPrices(row.listing_id, prices);

    // Historia: zapisujemy tylko rynki, na których cena się zmieniła
    const prev = row.last_set || {};
    const changed = (Object.keys(prices) as Market[]).filter((m) => toNumber(prev[m]) !== prices[m]);
    if (changed.length) {
      await db.from("buyback_price_history").insert(
        changed.map((m) => ({ sku: row.sku, market: m, price: prices[m], price_to_win: ptws[m] ?? null }))
      );
    }

    await db
      .from("buyback_skus")
      .update({ last_set: prices, last_run_at: new Date().toISOString(), last_error: null, in_progress_since: null })
      .eq("sku", row.sku);
    const summary = MARKETS.map((m) => `${m} ${prices[m] ?? "10 (brak ptw)"}`).join(" · ");
    await log(db, runId, missing.length ? "warn" : "info", row.sku, summary);
    return true;
  } catch (err: any) {
    let msg = err.message || String(err);
    if (row.last_set && Object.keys(row.last_set).length) {
      try {
        await putListingPrices(row.listing_id, row.last_set);
        msg += " — przywrócono ostatnie ceny";
      } catch (restoreErr: any) {
        msg += ` — przywracanie nieudane: ${restoreErr.message}`;
      }
    }
    await db.from("buyback_skus").update({ in_progress_since: null, last_error: msg }).eq("sku", row.sku);
    await log(db, runId, "error", row.sku, msg);
    return false;
  }
}

async function log(db: SupabaseClient, runId: number | null, level: "info" | "warn" | "error", sku: string | null, message: string) {
  await db.from("buyback_log").insert({ run_id: runId, level, sku, message });
}
