// Faktury kosztowe z Fakturowni (14.10.2026): mapowanie odpowiedzi GET /invoices.json?income=no na wiersz tabeli cost_invoices.
// Dokumentacja Fakturowni (github.com/fakturownia/api) opisuje wydatki skąpo — pola KSeF (gov_id) nie są w niej opisane dla faktur kosztowych — dlatego
// mapowanie jest tolerancyjne, a CAŁA odpowiedź trafia też do kolumny raw (można poprawić mapowanie bez ponownego pobierania z Fakturowni).
// Uwaga: na fakturach kosztowych pola seller_* i buyer_* są "odwrócone" względem sprzedaży — dokument sprzedawcy (dostawcy) to buyer_*, a nasza firma to seller_*;
// żeby nie polegać wyłącznie na tej regule, dostawcą jest strona, której NIP NIE jest NIP-em naszej firmy (najczęstszy NIP wśród pobranych faktur).

export type CostInvoiceRow = {
  fakturownia_id: number;
  number: string | null;
  kind: string | null;
  issue_date: string | null;
  sell_date: string | null;
  payment_to: string | null;
  paid_date: string | null;
  paid: boolean;
  status: string | null;
  supplier_name: string | null;
  supplier_tax_no: string | null;
  price_net: number | null;
  price_tax: number | null;
  price_gross: number | null;
  currency: string | null;
  accounting_kind: string | null;
  ksef_number: string | null;
  from_ksef: boolean;
  description: string | null;
  url: string | null;
  raw: unknown;
};

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
const date = (v: unknown): string | null => {
  const s = str(v);
  const m = s && /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
};
const digits = (v: unknown) => (str(v) || "").replace(/\D/g, "");

// Numer KSeF ma postać NIP(10)-RRRRMMDD-skrót(12-16 znaków hex)-CRC(2), np. 5213741812-20260105-ABC123DEF456-7A.
export const KSEF_NUMBER_RE = /^\d{10}-\d{8}-[0-9A-Fa-f]{6,}-[0-9A-Fa-f]{2}$/;

export function ksefNumberOf(inv: Record<string, unknown>): string | null {
  for (const k of ["gov_id", "ksef_number", "ksef_reference_number", "ksef_id", "gov_reference_number"]) {
    const v = str(inv[k]);
    if (v) return v;
  }
  return null;
}

// Własny NIP: najczęstszy NIP po stronie seller_* albo buyer_* wśród pobranych faktur kosztowych (wszystkie są wystawione na naszą firmę).
export function detectOwnTaxNo(invoices: Record<string, unknown>[]): { taxNo: string | null; side: "seller" | "buyer" } {
  const count = (f: string) => {
    const m = new Map<string, number>();
    for (const i of invoices) {
      const t = digits(i[f]);
      if (t) m.set(t, (m.get(t) || 0) + 1);
    }
    const best = Array.from(m.entries()).sort((a, b) => b[1] - a[1])[0];
    return best ? { taxNo: best[0], n: best[1] } : { taxNo: null, n: 0 };
  };
  const s = count("seller_tax_no");
  const b = count("buyer_tax_no");
  // reguła z dokumentacji: na kosztowych nasza firma to seller_*; wygrywa strona z wyraźnie częstszym powtarzającym się NIP-em
  if (b.n > s.n * 1.5 && b.n >= 5) return { taxNo: b.taxNo, side: "buyer" };
  return { taxNo: s.taxNo, side: "seller" };
}

export function mapCostInvoice(inv: Record<string, unknown>, domain: string, own: { side: "seller" | "buyer" }): CostInvoiceRow | null {
  const id = Number(inv.id);
  if (!Number.isFinite(id)) return null;
  const supplierPrefix = own.side === "seller" ? "buyer" : "seller";
  const ksef = ksefNumberOf(inv);
  const paidDate = date(inv.paid_date);
  const status = str(inv.status);
  const paidFlag = status === "paid" || (num(inv.paid) !== null && num(inv.paid)! > 0 && num(inv.price_gross) !== null && num(inv.paid)! >= num(inv.price_gross)!) || !!paidDate;
  return {
    fakturownia_id: id,
    number: str(inv.number),
    kind: str(inv.kind),
    issue_date: date(inv.issue_date),
    sell_date: date(inv.sell_date),
    payment_to: date(inv.payment_to),
    paid_date: paidDate,
    paid: paidFlag,
    status,
    supplier_name: str(inv[`${supplierPrefix}_name`]),
    supplier_tax_no: str(inv[`${supplierPrefix}_tax_no`]),
    price_net: num(inv.price_net),
    price_tax: num(inv.price_tax),
    price_gross: num(inv.price_gross),
    currency: str(inv.currency),
    accounting_kind: str(inv.accounting_kind),
    ksef_number: ksef,
    from_ksef: !!ksef && KSEF_NUMBER_RE.test(ksef),
    description: str(inv.description),
    url: `https://${domain}.fakturownia.pl/invoices/${id}`,
    raw: inv,
  };
}
