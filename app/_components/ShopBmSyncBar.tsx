"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

// Recoo Sklep -> Magazyn: pasek synchronizacji z Back Market (21.10.2026). "Odśwież oferty" dodaje produkty/warianty z nowych aktywnych ofert BM
// (Listingi -> Sklep), "Odśwież ilości" ustawia stany = ilości ofert, a włączona synchronizacja robi to samo automatycznie co 5 minut.
type Settings = {
  enabled: boolean;
  updated_by_email: string | null;
  updated_at: string | null;
  last_qty_at: string | null;
  last_qty_result: any;
  last_offers_at: string | null;
  last_offers_result: any;
};
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const btn = "border border-line bg-white px-2.5 py-1 rounded font-semibold disabled:opacity-50";

function qtyText(r: any) {
  if (!r) return "";
  if (r.error) return `błąd: ${r.error}`;
  return `${r.variants} wariantów, ${r.units} szt., zmieniono ${r.changed}${r.errors?.length ? `; błędy: ${r.errors.join(" | ")}` : ""}`;
}
function offersText(r: any) {
  if (!r) return "";
  if (r.error) return `błąd: ${r.error}`;
  return `${r.inShop} ofert w kategoriach sklepu (z ${r.offers} aktywnych): nowe produkty ${r.newModels}, nowe warianty ${r.newVariants}, nowe powiązania ${r.newLinks}${r.skipped?.length ? `; pominięto: ${r.skipped.join(" | ")}` : ""}`;
}

export default function ShopBmSyncBar({ onChanged }: { onChanged: () => void }) {
  const [st, setSt] = useState<Settings | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<"" | "toggle" | "quantities" | "offers">("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("shop_sync_settings").select("*").eq("id", 1).maybeSingle();
    if (error) return setMissing(true);
    setMissing(false);
    setSt((data as Settings) ?? null);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000); // ostatni przebieg crona widać bez przeładowania strony
    return () => clearInterval(t);
  }, [load]);

  async function post(body: object) {
    const { data: s } = await supabase.auth.getSession();
    const res = await fetch("/api/shop/bm-sync", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token ?? ""}` }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Błąd (${res.status}).`);
    return data;
  }
  async function run(kind: "toggle" | "quantities" | "offers") {
    if (kind === "toggle" && !st?.enabled && !confirm("Włączyć synchronizację ilości z Back Market?\n\nCo 5 minut stan każdego wariantu powiązanego z ofertą BM zostanie ustawiony na ilość tej oferty (ręczne zmiany stanu tych wariantów w Magazynie zostaną nadpisane). Nowe oferty dodajesz przyciskiem \"Odśwież oferty\".")) return;
    setBusy(kind);
    setNote(null);
    try {
      if (kind === "toggle") {
        const r = await post({ action: "toggle", enabled: !st?.enabled });
        setNote({ ok: true, text: r.enabled ? "Synchronizacja włączona — ilości odświeżają się co 5 minut." : "Synchronizacja wyłączona." });
      } else if (kind === "quantities") {
        const r = await post({ action: "quantities" });
        setNote({ ok: !r.errors?.length, text: `Ilości odświeżone: ${qtyText(r)}.` });
      } else {
        const r = await post({ action: "offers" });
        setNote({ ok: !r.skipped?.length, text: `Oferty odświeżone: ${offersText(r)}. Ilości: ${qtyText(r.quantities)}.` });
      }
      await load();
      onChanged();
    } catch (e: any) {
      setNote({ ok: false, text: e.message || String(e) });
    } finally {
      setBusy("");
    }
  }

  if (missing) return <p className="text-xs text-inksoft mb-3">Synchronizacja z Back Market: uruchom supabase/shop-bm-sync.sql w Supabase, żeby ją włączyć.</p>;
  if (!st) return null;
  return (
    <div className="border border-line bg-white px-3 py-2.5 mb-4 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm">
          Synchronizacja z Back Market:{" "}
          {st.enabled ? <b className="text-teal">włączona</b> : <b className="text-amber">wyłączona</b>}
          {st.updated_at && <span className="text-inksoft text-xs"> · zmienił {st.updated_by_email ?? "—"} {fmt(st.updated_at)}</span>}
        </span>
        <button onClick={() => run("toggle")} disabled={!!busy} className={btn}>
          {busy === "toggle" ? "Zapisuję…" : st.enabled ? "Wyłącz synchronizację" : "Włącz synchronizację"}
        </button>
        <button onClick={() => run("quantities")} disabled={!!busy} className={btn} title="Ustaw stany wariantów = ilości ich aktywnych ofert Back Market (oferta nieaktywna albo wyprzedana = 0).">
          {busy === "quantities" ? "Odświeżam…" : "Odśwież ilości"}
        </button>
        <button onClick={() => run("offers")} disabled={!!busy} className={btn} title="Dodaj produkty i warianty z nowych aktywnych ofert Back Market (konsole, aparaty, smartwatche Samsung). Istniejących produktów, nazw i cen nie zmienia.">
          {busy === "offers" ? "Odświeżam…" : "Odśwież oferty"}
        </button>
      </div>
      <div className="text-inksoft mt-1.5 space-y-0.5">
        <div>Ilości: {st.enabled ? "automatycznie co 5 min" : "tylko ręcznie"} · ostatnio {fmt(st.last_qty_at)}{st.last_qty_result ? ` — ${qtyText(st.last_qty_result)}` : ""}</div>
        <div>Oferty: tylko ręcznie · ostatnio {fmt(st.last_offers_at)}{st.last_offers_result ? ` — ${offersText(st.last_offers_result)}` : ""}</div>
      </div>
      {note && <div className={`mt-1.5 ${note.ok ? "text-teal" : "text-rust"}`}>{note.text}</div>}
    </div>
  );
}
