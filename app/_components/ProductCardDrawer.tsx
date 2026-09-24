"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { escapeLike } from "@/lib/search";
import { SERVICE_STATUSES, SERVICE_TASKS, TEST_STATUSES, labelFor } from "@/lib/workLog";

// Karta produktu po numerze seryjnym. Nie ma własnej tabeli — składa się z tego, co system już wie
// o tym numerze: stan z Fakturowni, testy (test_log), naprawy (service_log) i obsługa paczki
// Trade-in (buyback_order_intake). Log to wszystkie te zdarzenia w kolejności czasu.
// Numery łączymy bez rozróżniania wielkości liter, ale muszą być wpisane identycznie w każdym module.

type StockRow = {
  name: string | null;
  category_name: string;
  description: string | null;
  purchase_price_gross: number;
  product_created_at: string | null;
};
type TestRow = { employee_email: string | null; status: string; notes: string | null; started_at: string; finished_at: string | null };
type ServiceRow = {
  employee_email: string | null;
  task_type: string;
  status: string;
  notes: string | null;
  started_at: string;
  finished_at: string | null;
};
type FieldChange = { field: string; from: string | null; to: string | null };
type IntakeRow = {
  order_public_id: string;
  history: { action: "created" | "edited"; by_email: string | null; at: string; changes?: FieldChange[] }[] | null;
};
type OrderRow = {
  order_public_id: string;
  status: string;
  market: string | null;
  product_title: string | null;
  original_price: number | null;
  original_price_currency: string | null;
};
type Event = { at: string; text: string; details?: string[] };

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtMoney(n: number | null, currency: string | null) {
  if (n === null || n === undefined) return null;
  return Number(n).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + (currency || "");
}

function Row({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 px-3 py-2 border-b border-line last:border-b-0 text-sm">
      <span className="text-inksoft">{label}</span>
      <span className={`font-semibold text-right ${mono ? "font-mono" : ""}`}>{value || "—"}</span>
    </div>
  );
}

export default function ProductCardDrawer({
  serial,
  members,
  onClose,
}: {
  serial: string;
  members: MemberLite[];
  onClose: () => void;
}) {
  const [stock, setStock] = useState<StockRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const pattern = escapeLike(serial.trim());
        const [stockRes, testRes, serviceRes, intakeRes] = await Promise.all([
          supabase
            .from("fakturownia_stock_cache")
            .select("name, category_name, description, purchase_price_gross, product_created_at")
            .ilike("name", pattern),
          supabase
            .from("test_log")
            .select("employee_email, status, notes, started_at, finished_at")
            .ilike("serial_number", pattern),
          supabase
            .from("service_log")
            .select("employee_email, task_type, status, notes, started_at, finished_at")
            .ilike("device_ref", pattern),
          supabase.from("buyback_order_intake").select("order_public_id, history").ilike("serial_number", pattern),
        ]);
        for (const r of [stockRes, testRes, serviceRes, intakeRes]) if (r.error) throw r.error;

        const stockRows = (stockRes.data as StockRow[]) || [];
        const tests = (testRes.data as TestRow[]) || [];
        const services = (serviceRes.data as ServiceRow[]) || [];
        const intakes = (intakeRes.data as IntakeRow[]) || [];

        const orderIds = Array.from(
          new Set([...stockRows.map((s) => s.description), ...intakes.map((i) => i.order_public_id)].filter((x): x is string => !!x))
        );
        let orderRows: OrderRow[] = [];
        if (orderIds.length > 0) {
          const { data, error: orderErr } = await supabase
            .from("buyback_orders")
            .select("order_public_id, status, market, product_title, original_price, original_price_currency")
            .in("order_public_id", orderIds);
          if (orderErr) throw orderErr;
          orderRows = (data as OrderRow[]) || [];
        }

        const who = (email: string | null) => displayNameForEmail(email, members);
        const list: Event[] = [];
        for (const s of stockRows) {
          if (s.product_created_at) list.push({ at: s.product_created_at, text: "Dodano do magazynu (Fakturownia)" });
        }
        for (const t of tests) {
          list.push({
            at: t.started_at,
            text: `Test rozpoczęty przez ${who(t.employee_email)}`,
            details: t.notes ? [`Uwagi: ${t.notes}`] : undefined,
          });
          if (t.finished_at) list.push({ at: t.finished_at, text: `Test zakończony: ${labelFor(TEST_STATUSES, t.status)}` });
        }
        for (const sv of services) {
          const task = labelFor(SERVICE_TASKS, sv.task_type);
          list.push({
            at: sv.started_at,
            text: `Serwis (${task}) rozpoczęty przez ${who(sv.employee_email)}`,
            details: sv.notes ? [`Uwagi: ${sv.notes}`] : undefined,
          });
          if (sv.finished_at) {
            list.push({ at: sv.finished_at, text: `Serwis (${task}) zakończony: ${labelFor(SERVICE_STATUSES, sv.status)}` });
          }
        }
        for (const it of intakes) {
          for (const h of it.history || []) {
            list.push({
              at: h.at,
              text: `Trade-in ${it.order_public_id}: ${h.action === "created" ? "obsługa paczki rozpoczęta" : "edytowano"} przez ${who(h.by_email)}`,
              details: h.changes?.map((c) => `${c.field}: „${c.from || "—"}” → „${c.to || "—"}”`),
            });
          }
        }
        list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

        if (cancelled) return;
        setStock(stockRows);
        setOrders(orderRows);
        setEvents(list);
      } catch (e: any) {
        if (!cancelled) setError(`Nie udało się wczytać karty: ${e.message || e}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial]);

  const nothingFound = !loading && !error && stock.length === 0 && orders.length === 0 && events.length === 0;

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg bg-paper h-full overflow-y-auto p-6 border-l border-line">
        <div className="flex justify-between items-start mb-1">
          <div>
            <div className="text-xs text-inksoft">KARTA PRODUKTU</div>
            <h2 className="text-lg font-semibold font-mono">{serial}</h2>
          </div>
          <button onClick={onClose} className="text-inksoft text-lg">✕</button>
        </div>

        {loading && <p className="text-inksoft text-sm mt-4">Wczytywanie…</p>}
        {error && <p className="text-rust text-xs mt-4">{error}</p>}
        {nothingFound && <p className="text-inksoft text-sm mt-4">Brak danych o tym numerze seryjnym.</p>}

        {!loading && !error && (
          <>
            {stock.length > 0 && (
              <div className="mt-6">
                <h3 className="text-xs font-semibold text-inksoft mb-2">MAGAZYN (FAKTUROWNIA)</h3>
                {stock.map((s, i) => (
                  <div key={i} className="border border-line bg-white mb-2">
                    <Row label="Kategoria" value={s.category_name} />
                    <Row label="Zamówienie" value={s.description} mono />
                    <Row label="Cena zakupu brutto" value={fmtMoney(s.purchase_price_gross, "zł")} />
                    <Row label="Dodano" value={s.product_created_at ? fmtDateTime(s.product_created_at) : null} />
                  </div>
                ))}
              </div>
            )}

            {orders.length > 0 && (
              <div className="mt-6">
                <h3 className="text-xs font-semibold text-inksoft mb-2">ZAMÓWIENIE TRADE-IN</h3>
                {orders.map((o) => (
                  <div key={o.order_public_id} className="border border-line bg-white mb-2">
                    <Row label="Numer zamówienia" value={o.order_public_id} mono />
                    <Row label="Status" value={o.status} />
                    <Row label="Produkt" value={o.product_title} />
                    <Row label="Rynek" value={o.market} />
                    <Row label="Cena początkowa" value={fmtMoney(o.original_price, o.original_price_currency)} />
                  </div>
                ))}
              </div>
            )}

            {events.length > 0 && (
              <div className="mt-6">
                <h3 className="text-xs font-semibold text-inksoft mb-2">LOG</h3>
                <div className="border border-line bg-white p-3 text-sm">
                  {events.map((ev, i) => (
                    <div key={i} className="mb-2 last:mb-0">
                      <div>
                        <span className="font-mono text-inksoft mr-1">{i + 1}.</span>
                        {ev.text}, {fmtDateTime(ev.at)}
                      </div>
                      {!!ev.details?.length && (
                        <ul className="ml-6 list-disc text-xs text-inksoft">
                          {ev.details.map((d, j) => (
                            <li key={j}>{d}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
