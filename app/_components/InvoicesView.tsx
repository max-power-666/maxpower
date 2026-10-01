"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { type MemberLite } from "@/lib/displayName";
import { MARKETPLACES } from "@/lib/salesOrders";
import { INVOICE_STATUSES, invoiceStatusStyle, type InvoiceBuyerPrefill } from "@/lib/invoices";
import SalesOrderCard from "./SalesOrderCard";

// Zakładka Faktury (01.10.2026): lista zamówień gotowych do faktury (numer seryjny/IMEI na każdej pozycji +
// numer przesyłki — widok invoices_ready_orders, supabase/invoices.sql) i lista już wystawionych faktur, w
// układzie zbliżonym do dawnego podglądu faktur w Apilo (Numer dokumentu / Powiązane zamówienie / Data
// wystawienia / Data sprzedaży / Nabywca / Kwota brutto / Status dokumentu). Wystawienie faktury jest RĘCZNE
// (przycisk "Wystaw fakturę" otwiera formularz z podglądem danych nabywcy — serwer waliduje warunki jeszcze raz,
// patrz app/api/invoices/create).

type ReadyOrder = { marketplace: string; external_id: string; order_date: string | null; tracking_number: string | null };
type InvoiceRow = {
  id: number;
  marketplace: string;
  external_id: string;
  number: string | null;
  issue_date: string | null;
  sell_date: string | null;
  buyer_name: string | null;
  total_gross: number | null;
  currency: string | null;
  status: string;
};

const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const btnPrimary = "bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50";
const inputCls = "w-full border border-line bg-white px-2 py-2 rounded text-sm";
const labelCls = "text-xs font-semibold text-inksoft block mb-1";

function marketplaceLabel(key: string) {
  return MARKETPLACES.find((m) => m.key === key)?.label ?? key;
}
function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("pl-PL");
}
function fmtMoney(n: number | null, currency: string | null) {
  if (n == null) return "—";
  return `${Number(n).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || ""}`.trim();
}

export default function InvoicesView({ session, members }: { session: Session; members: MemberLite[] }) {
  const [tab, setTab] = useState<"ready" | "issued">("ready");
  const [ready, setReady] = useState<ReadyOrder[]>([]);
  const [issued, setIssued] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openOrder, setOpenOrder] = useState<{ marketplace: string; externalId: string } | null>(null);
  const [issueFor, setIssueFor] = useState<ReadyOrder | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      if (tab === "ready") {
        const { data, error: err } = await supabase
          .from("invoices_ready_orders")
          .select("marketplace, external_id, order_date, tracking_number")
          .order("order_date", { ascending: false })
          .limit(200);
        if (err) throw err;
        setReady((data as ReadyOrder[]) || []);
      } else {
        const { data, error: err } = await supabase
          .from("invoices")
          .select("id, marketplace, external_id, number, issue_date, sell_date, buyer_name, total_gross, currency, status")
          .order("created_at", { ascending: false })
          .limit(200);
        if (err) throw err;
        setIssued((data as InvoiceRow[]) || []);
      }
    } catch (e: any) {
      setError(`Nie udało się wczytać: ${e.message || e}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const channel = supabase
      .channel("invoices-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "invoices" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "sales_order_items" }, () => tab === "ready" && load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => setTab("ready")} className={pill(tab === "ready")}>Do wystawienia</button>
        <button onClick={() => setTab("issued")} className={pill(tab === "issued")}>Wystawione</button>
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      {tab === "ready" && (
        <div className="border border-line bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-inksoft border-b border-line">
                <th className="p-3">Kanał</th>
                <th className="p-3">Numer zamówienia</th>
                <th className="p-3">Data zamówienia</th>
                <th className="p-3">Numer przesyłki</th>
                <th className="p-3 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {!loading && ready.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-inksoft text-sm">
                    Brak zamówień gotowych do faktury — potrzebny numer seryjny/IMEI na każdej pozycji i numer przesyłki.
                  </td>
                </tr>
              )}
              {ready.map((o) => (
                <tr key={`${o.marketplace}-${o.external_id}`} className="border-b border-line last:border-b-0 hover:bg-paper">
                  <td className="p-3">{marketplaceLabel(o.marketplace)}</td>
                  <td className="p-3">
                    <button onClick={() => setOpenOrder({ marketplace: o.marketplace, externalId: o.external_id })} className="font-semibold text-teal hover:underline">
                      {o.external_id}
                    </button>
                  </td>
                  <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDate(o.order_date)}</td>
                  <td className="p-3 font-mono text-xs">{o.tracking_number}</td>
                  <td className="p-3 text-right">
                    <button onClick={() => setIssueFor(o)} className="text-xs font-semibold text-teal hover:underline">
                      Wystaw fakturę →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "issued" && (
        <div className="border border-line bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-inksoft border-b border-line">
                <th className="p-3">Numer dokumentu</th>
                <th className="p-3">Powiązane zamówienie</th>
                <th className="p-3">Data wystawienia</th>
                <th className="p-3">Data sprzedaży</th>
                <th className="p-3">Nabywca</th>
                <th className="p-3 text-right">Kwota brutto</th>
                <th className="p-3">Status dokumentu</th>
              </tr>
            </thead>
            <tbody>
              {!loading && issued.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-inksoft text-sm">Brak wystawionych faktur.</td>
                </tr>
              )}
              {issued.map((inv) => (
                <tr key={inv.id} className="border-b border-line last:border-b-0 hover:bg-paper">
                  <td className="p-3 font-semibold">{inv.number || "—"}</td>
                  <td className="p-3">
                    <button onClick={() => setOpenOrder({ marketplace: inv.marketplace, externalId: inv.external_id })} className="text-teal hover:underline">
                      {marketplaceLabel(inv.marketplace)} {inv.external_id}
                    </button>
                  </td>
                  <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDate(inv.issue_date)}</td>
                  <td className="p-3 text-xs text-inksoft whitespace-nowrap">{fmtDate(inv.sell_date)}</td>
                  <td className="p-3">{inv.buyer_name || "—"}</td>
                  <td className="p-3 text-right font-mono">{fmtMoney(inv.total_gross, inv.currency)}</td>
                  <td className="p-3">
                    <span className={`text-xs font-semibold px-2 py-1 rounded-full ${invoiceStatusStyle(inv.status)}`}>
                      {INVOICE_STATUSES.find((s) => s.key === inv.status)?.label ?? inv.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openOrder && (
        <SalesOrderCard marketplace={openOrder.marketplace} externalId={openOrder.externalId} session={session} members={members} onClose={() => setOpenOrder(null)} />
      )}

      {issueFor && (
        <IssueInvoiceDrawer
          order={issueFor}
          session={session}
          onClose={() => setIssueFor(null)}
          onIssued={() => {
            setIssueFor(null);
            load();
          }}
        />
      )}
    </div>
  );
}

type ItemPreview = { item_key: string; sku: string | null; name: string | null; serial_number: string | null; price: number | null; currency: string | null };

const emptyBuyer: InvoiceBuyerPrefill = {
  name: "", company: "", street: "", houseNumber: "", apartment: "", postalCode: "", city: "", countryCode: "", taxNo: "",
};

function IssueInvoiceDrawer({
  order,
  session,
  onClose,
  onIssued,
}: {
  order: ReadyOrder;
  session: Session;
  onClose: () => void;
  onIssued: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [buyer, setBuyer] = useState<InvoiceBuyerPrefill>(emptyBuyer);
  const [items, setItems] = useState<ItemPreview[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const headers = { Authorization: `Bearer ${session.access_token}` };
        const res = await fetch(`/api/invoices/prefill?marketplace=${encodeURIComponent(order.marketplace)}&externalId=${encodeURIComponent(order.external_id)}`, { headers });
        const data = await res.json();
        if (!res.ok || data?.error) throw new Error(data?.error || "Nie udało się wczytać danych zamówienia.");
        setBuyer(data.buyer);
        setItems(data.items || []);
      } catch (e: any) {
        setError(e.message || "Błąd wczytywania.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.marketplace, order.external_id]);

  function set<K extends keyof InvoiceBuyerPrefill>(key: K, value: string) {
    setBuyer((b) => ({ ...b, [key]: value }));
  }

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const headers = { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
      const res = await fetch("/api/invoices/create", {
        method: "POST",
        headers,
        body: JSON.stringify({ marketplace: order.marketplace, externalId: order.external_id, buyer }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) throw new Error(data?.error || "Nie udało się wystawić faktury.");
      await supabase.rpc("sales_order_add_log", {
        p_marketplace: order.marketplace,
        p_external_id: order.external_id,
        p_entry: {
          action: "edited",
          by_email: session.user.email ?? null,
          at: new Date().toISOString(),
          changes: [{ field: "faktura", from: null, to: `Wystawiono fakturę ${data.number || ""}` }],
        },
      });
      onIssued();
    } catch (e: any) {
      setError(e.message || "Błąd wystawiania faktury.");
    } finally {
      setSubmitting(false);
    }
  }

  const missingAddress = !loading && (!buyer.street || !buyer.postalCode || !buyer.city || !buyer.countryCode);

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg bg-paper h-full overflow-y-auto p-6 border-l border-line">
        <div className="flex justify-between items-start mb-4">
          <div>
            <div className="text-xs text-inksoft">WYSTAW FAKTURĘ</div>
            <h2 className="text-lg font-semibold">{order.external_id}</h2>
          </div>
          <button onClick={onClose} className="text-inksoft text-lg">✕</button>
        </div>

        {loading && <p className="text-inksoft text-sm">Wczytywanie…</p>}

        {!loading && (
          <>
            {missingAddress && (
              <p className="text-amber text-xs mb-3 bg-ambersoft p-2 rounded">
                Ten kanał nie przekazuje pełnego adresu nabywcy (albo zamówienie go nie ma) — uzupełnij dane poniżej ręcznie przed wystawieniem.
              </p>
            )}

            <h3 className="text-xs font-semibold text-inksoft mb-2">POZYCJE</h3>
            <div className="border border-line bg-white mb-4">
              {items.map((it) => (
                <div key={it.item_key} className="p-2 border-b border-line last:border-b-0 text-sm flex justify-between gap-3">
                  <span>
                    {it.name || <span className="font-mono">{it.sku || "—"}</span>}
                    <span className="text-inksoft text-xs block">Numer seryjny: {it.serial_number || "—"}</span>
                  </span>
                  <span className="font-mono font-semibold whitespace-nowrap">{fmtMoney(it.price, it.currency)}</span>
                </div>
              ))}
            </div>

            <h3 className="text-xs font-semibold text-inksoft mb-2">NABYWCA</h3>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className={labelCls}>Imię i nazwisko</label>
                <input value={buyer.name} onChange={(e) => set("name", e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Firma (gdy faktura na firmę)</label>
                <input value={buyer.company} onChange={(e) => set("company", e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>NIP</label>
                <input value={buyer.taxNo} onChange={(e) => set("taxNo", e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Kraj (2 litery)</label>
                <input value={buyer.countryCode} onChange={(e) => set("countryCode", e.target.value.toUpperCase())} maxLength={2} className={inputCls} />
              </div>
              <div className="col-span-2">
                <label className={labelCls}>Ulica</label>
                <input value={buyer.street} onChange={(e) => set("street", e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Numer domu</label>
                <input value={buyer.houseNumber} onChange={(e) => set("houseNumber", e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Numer lokalu</label>
                <input value={buyer.apartment} onChange={(e) => set("apartment", e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Kod pocztowy</label>
                <input value={buyer.postalCode} onChange={(e) => set("postalCode", e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Miasto</label>
                <input value={buyer.city} onChange={(e) => set("city", e.target.value)} className={inputCls} />
              </div>
            </div>

            {error && <p className="text-rust text-xs mb-3">{error}</p>}

            <button onClick={submit} disabled={submitting} className={btnPrimary}>
              {submitting ? "Wystawianie…" : "Wystaw fakturę"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
