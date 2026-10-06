"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";

// Import części z faktury zakupu (Serwis -> Części, 06.10.2026): plik -> odczyt (model Claude, /api/parts/parse-invoice) -> lista do
// poprawienia i akceptacji -> zapis do service_parts (/api/parts/import). Nic nie trafia do bazy bez kliknięcia "Zapisz".
// Można też zacząć od pustej listy ("Dodaj ręcznie"). Jedna pozycja z ilością N zapisze się jako N wierszy (jedna sztuka = jeden wiersz).

type Row = { key: number; name: string; supplierCode: string; quantity: string; currency: string; priceNet: string; rate: string; pricePln: string; note: string | null };
type Header = { supplier: string; invoiceNo: string; invoiceDate: string; receivedAt: string };

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
const toNum = (s: string) => {
  const n = Number(s.trim().replace(/\s/g, "").replace(",", "."));
  return s.trim() !== "" && Number.isFinite(n) ? n : null;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const inp = "border border-line bg-white px-2 py-1 rounded text-sm w-full";
let keySeq = 1;

export default function PartsImportDialog({ session, onClose, onSaved }: { session: Session; onClose: () => void; onSaved: () => void }) {
  const [stage, setStage] = useState<"pick" | "parsing" | "review" | "saving" | "done">("pick");
  const [nextCode, setNextCode] = useState<string | null>(null);
  const [ranges, setRanges] = useState<{ name: string; quantity: number; first: string; last: string }[]>([]);
  const [error, setError] = useState("");
  const [dupInfo, setDupInfo] = useState("");
  const [fileName, setFileName] = useState("");
  const [header, setHeader] = useState<Header>({ supplier: "", invoiceNo: "", invoiceDate: "", receivedAt: today() });
  const [rows, setRows] = useState<Row[]>([]);
  const [docNotes, setDocNotes] = useState<string | null>(null);
  const [rateNote, setRateNote] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const auth = { Authorization: `Bearer ${session.access_token}` };

  useEffect(() => {
    fetch("/api/parts/import", { headers: auth }).then((r) => r.json()).then((d) => setNextCode(d?.next ?? null)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const blankRow = (currency = "PLN"): Row => ({ key: keySeq++, name: "", supplierCode: "", quantity: "1", currency, priceNet: "", rate: currency === "PLN" ? "1" : "", pricePln: "", note: null });

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError("");
    setFileName(file.name);
    setStage("parsing");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/parts/parse-invoice", { method: "POST", headers: auth, body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw new Error(data?.error || "Nie udało się odczytać faktury.");
      const inv = data.invoice;
      const rate: number | null = data.rate?.rate ?? null;
      setHeader({ supplier: inv.supplier || "", invoiceNo: inv.invoiceNo || "", invoiceDate: inv.invoiceDate || "", receivedAt: today() });
      setDocNotes(inv.notes || null);
      setRateNote(inv.currency === "PLN" ? "" : rate ? `Kurs NBP ${inv.currency} z ${data.rate.rateDate} (ostatni dzień roboczy przed datą faktury).` : `Nie znaleziono kursu NBP dla ${inv.currency} — wpisz kurs ręcznie.`);
      setRows(
        (inv.items as any[]).map((it) => {
          const net = it.priceNet as number | null;
          return {
            key: keySeq++,
            name: it.name,
            supplierCode: it.partCode || "",
            quantity: String(it.quantity),
            currency: inv.currency,
            priceNet: net === null ? "" : String(net),
            rate: rate ? String(rate) : "",
            pricePln: net !== null && rate ? String(r2(net * rate)) : "",
            note: it.note || null,
          };
        })
      );
      if (inv.items.length === 0) setError("Nie znaleziono pozycji w tym pliku — dodaj je ręcznie albo spróbuj innego pliku.");
      setStage("review");
    } catch (e: any) {
      setError(e.message || "Nie udało się odczytać faktury.");
      setStage("pick");
    }
  }

  function startManual() {
    setError("");
    setFileName("");
    setRows([blankRow()]);
    setStage("review");
  }

  function patchRow(key: number, patch: Partial<Row>, recalc = false) {
    setRows((rs) =>
      rs.map((r) => {
        if (r.key !== key) return r;
        const n = { ...r, ...patch };
        if (recalc) {
          const net = toNum(n.priceNet);
          const rate = n.currency === "PLN" ? 1 : toNum(n.rate);
          n.pricePln = net !== null && rate !== null ? String(r2(net * rate)) : "";
        }
        return n;
      })
    );
  }

  async function changeCurrency(key: number, currencyRaw: string) {
    const currency = currencyRaw.toUpperCase().slice(0, 3);
    patchRow(key, { currency, rate: currency === "PLN" ? "1" : "" }, true);
    if (currency.length === 3 && currency !== "PLN" && header.invoiceDate) {
      const res = await fetch(`/api/parts/rate?currency=${currency}&date=${header.invoiceDate}`, { headers: auth }).then((r) => r.json()).catch(() => null);
      const rate = res?.rate?.rate;
      if (rate) patchRow(key, { rate: String(rate) }, true);
    }
  }

  const issues = rows.map((r) => {
    const out: string[] = [];
    if (!r.name.trim()) out.push("brak nazwy");
    const q = toNum(r.quantity);
    if (q === null || !Number.isInteger(q) || q < 1 || q > 100) out.push("ilość 1–100");
    if (toNum(r.pricePln) === null) out.push("brak ceny PLN");
    return out;
  });
  const blocking = rows.some((r, i) => issues[i].some((x) => x !== "brak ceny PLN"));
  const noPrice = rows.filter((_, i) => issues[i].includes("brak ceny PLN")).length;
  const pieces = rows.reduce((s, r) => s + (toNum(r.quantity) ?? 0), 0);
  const totalPln = rows.reduce((s, r) => s + (toNum(r.pricePln) ?? 0) * (toNum(r.quantity) ?? 0), 0);

  async function save(force = false) {
    if (noPrice > 0 && !force && !confirm(`${noPrice} poz. nie ma ceny w PLN — taka część nie zwiększy kosztu serwisu w Marży (dostanie ostrzeżenie ⚠). Zapisać mimo to?`)) return;
    setError("");
    setDupInfo("");
    setStage("saving");
    try {
      const res = await fetch("/api/parts/import", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          force,
          supplier: header.supplier || null,
          invoiceNo: header.invoiceNo || null,
          invoiceDate: header.invoiceDate || null,
          receivedAt: header.receivedAt || null,
          items: rows.map((r) => ({ name: r.name, supplierCode: r.supplierCode || null, quantity: toNum(r.quantity), currency: r.currency || "PLN", priceNet: toNum(r.priceNet), nbpRate: r.currency === "PLN" ? 1 : toNum(r.rate), pricePln: toNum(r.pricePln) })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data?.duplicate) {
        setDupInfo(data.error);
        setStage("review");
        return;
      }
      if (!res.ok || data?.error) throw new Error(data?.error || "Nie udało się zapisać.");
      onSaved();
      setRanges(data.ranges || []);
      setStage("done");
    } catch (e: any) {
      setError(e.message || "Nie udało się zapisać.");
      setStage("review");
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-start justify-center z-50 overflow-y-auto p-4" onClick={(e) => e.target === e.currentTarget && stage !== "saving" && onClose()}>
      <div className="w-full max-w-6xl bg-paper border border-line p-6 my-6">
        <div className="flex justify-between items-start mb-4">
          <div>
            <div className="text-xs text-inksoft">SERWIS → CZĘŚCI</div>
            <h2 className="text-lg font-semibold">Importuj części z faktury</h2>
          </div>
          <button onClick={onClose} disabled={stage === "saving"} className="text-inksoft text-lg">✕</button>
        </div>

        {error && <p className="text-rust text-sm mb-3">{error}</p>}

        {(stage === "pick" || stage === "parsing") && (
          <div>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (stage === "pick") onFile(e.dataTransfer.files?.[0]);
              }}
              className="border-2 border-dashed border-line bg-white rounded p-10 text-center"
            >
              {stage === "parsing" ? (
                <p className="text-sm text-inksoft">Odczytuję „{fileName}”… (zwykle 10–40 s)</p>
              ) : (
                <>
                  <p className="text-sm mb-3">Przeciągnij tu plik faktury zakupu albo wybierz go z dysku.</p>
                  <button onClick={() => fileInput.current?.click()} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold">Wybierz plik</button>
                  <input ref={fileInput} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.csv,.txt,.tsv,.xml,.json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
                  <p className="text-xs text-inksoft mt-3">PDF, zdjęcie (JPG/PNG/WebP) albo CSV/TXT, do 3,5 MB. Excela zapisz jako PDF lub CSV.</p>
                </>
              )}
            </div>
            {stage === "pick" && (
              <p className="text-xs text-inksoft mt-3">
                Nic nie zapisze się w bazie, dopóki nie sprawdzisz i nie zaakceptujesz listy.{" "}
                <button onClick={startManual} className="text-teal font-semibold hover:underline">Dodaj pozycje ręcznie →</button>
              </p>
            )}
          </div>
        )}

        {stage === "done" && (
          <div>
            <p className="text-sm font-semibold text-teal mb-3">Zapisano {ranges.reduce((n, x) => n + x.quantity, 0)} szt. w częściach. Nadane kody:</p>
            <div className="bg-white border border-line">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-inksoft border-b border-line"><th className="p-2">Nazwa części</th><th className="p-2 text-right">Szt.</th><th className="p-2">Kody (do naklejenia na sztukach)</th></tr></thead>
                <tbody>
                  {ranges.map((x, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      <td className="p-2">{x.name}</td>
                      <td className="p-2 text-right font-mono">{x.quantity}</td>
                      <td className="p-2 font-mono font-semibold">{x.quantity > 1 ? `${x.first} – ${x.last}` : x.first}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => navigator.clipboard?.writeText(ranges.map((x) => `${x.name}\t${x.quantity > 1 ? `${x.first}-${x.last}` : x.first}`).join("\n"))}
                className="bg-white border border-line px-4 py-2 rounded text-sm font-semibold"
              >
                Kopiuj listę
              </button>
              <button onClick={onClose} className="bg-ink text-paper px-5 py-2 rounded text-sm font-semibold">Zamknij</button>
            </div>
          </div>
        )}

        {(stage === "review" || stage === "saving") && (
          <div>
            {fileName && <p className="text-xs text-inksoft mb-3">Odczytano z pliku „{fileName}”. <b>Sprawdź każdą pozycję</b> — odczyt bywa nieidealny (zwłaszcza ze zdjęć).</p>}
            {docNotes && <p className="text-xs text-amber mb-3">Uwaga z odczytu: {docNotes}</p>}
            {dupInfo && (
              <div className="border border-amber bg-ambersoft text-sm p-3 mb-3 rounded">
                {dupInfo} <button onClick={() => save(true)} className="font-semibold underline ml-1">Zapisz mimo to</button>
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <label className="text-xs font-semibold text-inksoft">Dostawca<input value={header.supplier} onChange={(e) => setHeader({ ...header, supplier: e.target.value })} className={inp + " mt-1 font-normal"} /></label>
              <label className="text-xs font-semibold text-inksoft">Numer faktury<input value={header.invoiceNo} onChange={(e) => setHeader({ ...header, invoiceNo: e.target.value })} className={inp + " mt-1 font-mono font-normal"} /></label>
              <label className="text-xs font-semibold text-inksoft">Data faktury<input type="date" value={header.invoiceDate} onChange={(e) => setHeader({ ...header, invoiceDate: e.target.value })} className={inp + " mt-1 font-normal"} /></label>
              <label className="text-xs font-semibold text-inksoft">Data przyjęcia<input type="date" value={header.receivedAt} onChange={(e) => setHeader({ ...header, receivedAt: e.target.value })} className={inp + " mt-1 font-normal"} /></label>
            </div>
            {rateNote && <p className="text-xs text-inksoft mb-2">{rateNote}</p>}

            <div className="bg-white border border-line overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-inksoft border-b border-line">
                    <th className="p-2 w-8">#</th>
                    <th className="p-2">Nazwa części</th>
                    <th className="p-2 w-36" title="Kod/symbol z faktury — zapisze się w uwagach. Własny, unikalny kod każdej sztuki nadaje system.">Kod dostawcy</th>
                    <th className="p-2 w-16">Ilość</th>
                    <th className="p-2 w-20">Waluta</th>
                    <th className="p-2 w-28">Cena netto / szt.</th>
                    <th className="p-2 w-24">Kurs NBP</th>
                    <th className="p-2 w-28">Netto PLN / szt.</th>
                    <th className="p-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.key} className={`border-b border-line last:border-0 align-top ${issues[i].some((x) => x !== "brak ceny PLN") ? "bg-rustsoft" : ""}`}>
                      <td className="p-2 text-xs text-inksoft">{i + 1}</td>
                      <td className="p-2">
                        <input value={r.name} onChange={(e) => patchRow(r.key, { name: e.target.value })} className={inp} />
                        {r.note && <div className="text-[10px] text-amber mt-0.5">{r.note}</div>}
                        {issues[i].length > 0 && <div className="text-[10px] text-rust mt-0.5">{issues[i].join(", ")}</div>}
                      </td>
                      <td className="p-2"><input value={r.supplierCode} onChange={(e) => patchRow(r.key, { supplierCode: e.target.value })} className={inp + " font-mono"} placeholder="opcjonalnie" /></td>
                      <td className="p-2"><input value={r.quantity} onChange={(e) => patchRow(r.key, { quantity: e.target.value })} inputMode="numeric" className={inp + " text-right"} /></td>
                      <td className="p-2"><input value={r.currency} onChange={(e) => changeCurrency(r.key, e.target.value)} className={inp + " uppercase"} /></td>
                      <td className="p-2"><input value={r.priceNet} onChange={(e) => patchRow(r.key, { priceNet: e.target.value }, true)} inputMode="decimal" className={inp + " text-right font-mono"} /></td>
                      <td className="p-2"><input value={r.currency === "PLN" ? "1" : r.rate} disabled={r.currency === "PLN"} onChange={(e) => patchRow(r.key, { rate: e.target.value }, true)} inputMode="decimal" className={inp + " text-right font-mono disabled:opacity-50"} /></td>
                      <td className="p-2"><input value={r.pricePln} onChange={(e) => patchRow(r.key, { pricePln: e.target.value })} inputMode="decimal" className={inp + " text-right font-mono font-semibold"} /></td>
                      <td className="p-2"><button onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} title="Usuń pozycję" className="text-rust">✕</button></td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={9} className="p-4 text-center text-inksoft text-sm">Brak pozycji.</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-4 mt-3">
              <button onClick={() => setRows((rs) => [...rs, blankRow(rs[rs.length - 1]?.currency || "PLN")])} className="text-teal text-sm font-semibold hover:underline">+ Dodaj pozycję</button>
              <button onClick={() => { setStage("pick"); setRows([]); setError(""); setDupInfo(""); }} disabled={stage === "saving"} className="text-inksoft text-sm hover:underline">Wczytaj inny plik</button>
              <div className="ml-auto text-sm text-right">
                <div>
                  <span className="text-inksoft">Pozycji: </span><b>{rows.length}</b> · <span className="text-inksoft">sztuk (wierszy w bazie): </span><b>{pieces}</b> · <span className="text-inksoft">wartość netto: </span><b className="font-mono">{r2(totalPln).toLocaleString("pl-PL", { minimumFractionDigits: 2 })} zł</b>
                </div>
                {noPrice > 0 && <div className="text-xs text-amber">{noPrice} poz. bez ceny w PLN</div>}
              </div>
              <button onClick={() => save(false)} disabled={stage === "saving" || rows.length === 0 || blocking} className="bg-ink text-paper px-5 py-2 rounded text-sm font-semibold disabled:opacity-50">
                {stage === "saving" ? "Zapisywanie…" : `Zapisz ${pieces} szt. w częściach`}
              </button>
            </div>
            <p className="text-[11px] text-inksoft mt-3 max-w-3xl">
              Cena „netto PLN / szt.” to cena jednostkowa bez VAT — ta, która liczy się do kosztu serwisu w Marży. Pozycja z ilością większą niż 1 zapisze się jako tyle samo wierszy (każdą sztukę przypisujesz potem do urządzenia osobno).
              Nowe części dostają status „Dotarło” i <b>własny, unikalny kod</b> (kolejne numery serii 10xxxxxx{nextCode ? <>, od <span className="font-mono">{nextCode}</span></> : null}) — kod z faktury zostaje w uwagach. Ostateczne numery nadaje zapis i pokaże je po zapisaniu.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
