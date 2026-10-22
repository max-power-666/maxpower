// Powiadomienia o nowych zamówieniach na webhook (Make, 20.10.2026). Cron co minutę (app/api/orders/webhook-notify):
//  - kandydaci: (a) zamówienia z bazy z ostatnich 14 dni, liczone jako sprzedaż (isCountedOrder — bez anulowanych i nieopłaconych), wszystkie kanały (baza odświeża się co 15 min),
//    (b) "szybka ścieżka" Back Market i refurbed: świeże zamówienia pytane wprost w API (ta sama co synchronizacja stanów), więc powiadomienie idzie po ok. minucie;
//  - każde zamówienie raz (order_webhook_sent: wpis powstaje PRZED wysyłką; błąd = ponowienie w kolejnych przebiegach, do 5 prób);
//  - pierwszy przebieg to "baseline": zamówienia z ostatnich 14 dni są tylko oznaczane jako obsłużone, nic nie jest wysyłane.
// Payload: marketplace + numer zamówienia (order_id, od 22.10.2026) + pozycje (sku, ilość, cena, waluta) — bez danych klienta.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCountedOrder } from "./salesOrders";
import { fetchBmRecent, fetchRefurbedRecent, type FastItem } from "./stockSyncServer";
import { buildWebhookPayload, sendWebhook, type WebhookItem } from "./orderWebhook";

const LOOKBACK_DAYS = 14;
const MAX_SENDS_PER_RUN = 25;
const MAX_ATTEMPTS = 5;
const STUCK_MS = 5 * 60_000; // wpis "sending" starszy niż 5 min = przerwany przebieg, można ponowić

type Candidate = { marketplace: string; external_id: string; items: WebhookItem[] };
export type WebhookRunSummary = { ran: boolean; reason?: string; baseline?: number; candidates: number; sent: number; failed: number; errors: string[]; dryRun?: boolean; samples?: unknown[] };

const k = (marketplace: string, id: string) => `${marketplace}|${id}`;

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// Zamówienia z bazy z ostatnich 14 dni, liczone jako sprzedaż (bez pozycji — te dociągamy tylko dla niewysłanych).
async function dbCountedOrders(db: SupabaseClient<any, any, any>): Promise<{ marketplace: string; external_id: string }[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = await fetchAll<{ marketplace: string; external_id: string; status: string }>((from, to) =>
    db.from("sales_orders").select("marketplace, external_id, status").gte("order_date", since).neq("marketplace", "apilo").order("external_id").range(from, to),
  );
  return rows.filter((r) => isCountedOrder(r.marketplace, r.status)).map((r) => ({ marketplace: r.marketplace, external_id: r.external_id }));
}

async function dbItems(db: SupabaseClient<any, any, any>, orders: { marketplace: string; external_id: string }[]): Promise<Map<string, WebhookItem[]>> {
  const out = new Map<string, WebhookItem[]>();
  const byMp = new Map<string, string[]>();
  for (const o of orders) byMp.set(o.marketplace, [...(byMp.get(o.marketplace) ?? []), o.external_id]);
  for (const [mp, ids] of byMp) {
    for (let i = 0; i < ids.length; i += 100) {
      const rows = await fetchAll<{ external_id: string; item_key: string; sku: string | null; price: number | string | null; currency: string | null; position: number | null }>((from, to) =>
        db.from("sales_order_items").select("external_id, item_key, sku, price, currency, position").eq("marketplace", mp).in("external_id", ids.slice(i, i + 100)).order("external_id").order("item_key").range(from, to),
      );
      for (const r of rows.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
        const list = out.get(k(mp, r.external_id)) ?? [];
        list.push({ sku: r.sku, price: r.price === null ? null : Number(r.price), currency: r.currency });
        out.set(k(mp, r.external_id), list);
      }
    }
  }
  return out;
}

function fromFast(items: FastItem[]): Candidate[] {
  const m = new Map<string, Candidate>();
  for (const it of items) {
    if (!isCountedOrder(it.marketplace, it.order_status)) continue;
    const key = k(it.marketplace, it.external_id);
    const c = m.get(key) ?? { marketplace: it.marketplace, external_id: it.external_id, items: [] };
    c.items.push({ sku: it.sku ?? null, price: it.price ?? null, currency: it.currency ?? null });
    m.set(key, c);
  }
  return [...m.values()];
}

export async function runOrderWebhook(db: SupabaseClient<any, any, any>, opts: { dryRun?: boolean; fetchImpl?: typeof fetch } = {}): Promise<WebhookRunSummary> {
  const url = process.env.MAKE_ORDER_WEBHOOK_URL;
  const empty = { candidates: 0, sent: 0, failed: 0, errors: [] as string[] };
  if (!url && !opts.dryRun) return { ran: false, reason: "Brak zmiennej MAKE_ORDER_WEBHOOK_URL.", ...empty };

  const st = await db.from("order_webhook_state").select("baseline_done").eq("id", 1).maybeSingle();
  if (st.error) return { ran: false, reason: /order_webhook/.test(st.error.message) ? "Brak tabel — uruchom supabase/order-webhook.sql." : st.error.message, ...empty };
  const baselineDone = !!st.data?.baseline_done;

  // Zamówienia z bazy (wszystkie kanały) + szybka ścieżka BM/refurbed.
  const dbOrders = await dbCountedOrders(db);
  const errors: string[] = [];

  if (!baselineDone && !opts.dryRun) {
    // pierwszy przebieg: oznaczamy istniejące zamówienia jako obsłużone (bez wysyłki) — historia nie trafia na webhook
    for (let i = 0; i < dbOrders.length; i += 500) {
      const { error } = await db.from("order_webhook_sent").upsert(dbOrders.slice(i, i + 500).map((o) => ({ ...o, status: "baseline" })), { onConflict: "marketplace,external_id", ignoreDuplicates: true });
      if (error) return { ran: false, reason: error.message, ...empty };
    }
    await db.from("order_webhook_state").update({ baseline_done: true, baseline_at: new Date().toISOString() }).eq("id", 1);
    return { ran: true, baseline: dbOrders.length, ...empty };
  }

  const fast = await Promise.all([fetchBmRecent().catch((e) => (errors.push(`Back Market: ${e.message}`), [] as FastItem[])), fetchRefurbedRecent([]).catch((e) => (errors.push(`refurbed: ${e.message}`), [] as FastItem[]))]);
  const fastCands = fromFast(fast.flat());

  // Co już obsłużone (wysłane / baseline / w trakcie / porzucone) albo do ponowienia (failed, przerwane "sending").
  const sentRows = await fetchAll<{ marketplace: string; external_id: string; status: string; attempts: number; updated_at: string }>((from, to) =>
    db.from("order_webhook_sent").select("marketplace, external_id, status, attempts, updated_at").gte("created_at", new Date(Date.now() - 45 * 86_400_000).toISOString()).order("external_id").range(from, to),
  );
  const sentMap = new Map(sentRows.map((r) => [k(r.marketplace, r.external_id), r]));
  const retryable = (r: { status: string; attempts: number; updated_at: string }) => r.attempts < MAX_ATTEMPTS && (r.status === "failed" || (r.status === "sending" && Date.now() - Date.parse(r.updated_at) > STUCK_MS));

  const todoDb = dbOrders.filter((o) => {
    const r = sentMap.get(k(o.marketplace, o.external_id));
    return !r || retryable(r);
  });
  const dbItemsMap = todoDb.length ? await dbItems(db, todoDb) : new Map<string, WebhookItem[]>();
  const cands = new Map<string, Candidate>();
  for (const o of todoDb) {
    const items = dbItemsMap.get(k(o.marketplace, o.external_id));
    if (items && items.length) cands.set(k(o.marketplace, o.external_id), { ...o, items });
  }
  for (const c of fastCands) {
    const r = sentMap.get(k(c.marketplace, c.external_id));
    if (!r || retryable(r)) cands.set(k(c.marketplace, c.external_id), c); // świeże dane z API mają pierwszeństwo (cena/SKU od razu)
  }
  const list = [...cands.values()];

  if (opts.dryRun) return { ran: true, dryRun: true, candidates: list.length, sent: 0, failed: 0, errors, samples: list.slice(0, 5).map((c) => buildWebhookPayload(c.marketplace, c.items, c.external_id)) };

  let sent = 0;
  let failed = 0;
  for (const c of list.slice(0, MAX_SENDS_PER_RUN)) {
    const key = k(c.marketplace, c.external_id);
    const prev = sentMap.get(key);
    // rezerwacja: nowy wpis albo przejęcie wpisu do ponowienia — dzięki temu dwa równoległe przebiegi nie wyślą tego samego zamówienia
    let attempts = 0;
    if (!prev) {
      const ins = await db.from("order_webhook_sent").upsert({ marketplace: c.marketplace, external_id: c.external_id, status: "sending" }, { onConflict: "marketplace,external_id", ignoreDuplicates: true }).select("external_id");
      if (ins.error) {
        errors.push(ins.error.message);
        continue;
      }
      if (!ins.data || ins.data.length === 0) continue; // ktoś nas ubiegł
    } else {
      attempts = prev.attempts;
      const upd = await db.from("order_webhook_sent").update({ status: "sending", updated_at: new Date().toISOString() }).eq("marketplace", c.marketplace).eq("external_id", c.external_id).eq("status", prev.status).eq("updated_at", prev.updated_at).select("external_id");
      if (upd.error || !upd.data || upd.data.length === 0) continue;
    }
    const res = await sendWebhook(url!, buildWebhookPayload(c.marketplace, c.items, c.external_id), opts.fetchImpl);
    attempts += 1;
    if (res.ok) {
      sent += 1;
      await db.from("order_webhook_sent").update({ status: "sent", attempts, last_error: null, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("marketplace", c.marketplace).eq("external_id", c.external_id);
    } else {
      failed += 1;
      errors.push(`${c.marketplace} ${c.external_id}: ${res.error}`);
      await db.from("order_webhook_sent").update({ status: attempts >= MAX_ATTEMPTS ? "abandoned" : "failed", attempts, last_error: res.error, updated_at: new Date().toISOString() }).eq("marketplace", c.marketplace).eq("external_id", c.external_id);
    }
  }
  return { ran: true, candidates: list.length, sent, failed, errors };
}
