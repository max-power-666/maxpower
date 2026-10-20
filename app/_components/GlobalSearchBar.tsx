"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { searchEverywhere, type SearchHit } from "@/lib/globalSearch";
import { setPrefill } from "@/lib/searchPrefill";
import { MARKETPLACES } from "@/lib/salesOrders";
import type { MemberLite } from "@/lib/displayName";
import SalesOrderCard from "./SalesOrderCard";
import ProductCardDrawer from "./ProductCardDrawer";

// Wyszukiwarka globalna (20.10.2026, na prośbę właściciela): wąski pasek na górze strony, nad komunikatami. Po wpisaniu numeru zamówienia albo numeru seryjnego pokazuje odnośniki do miejsc,
// w których ten numer występuje w systemie (lib/globalSearch.ts). Zamówienie i karta produktu otwierają się od razu na panelu bocznym, pozostałe wyniki przenoszą do zakładki z wpisaną frazą.
const label = (k: string) => MARKETPLACES.find((m) => m.key === k)?.label ?? k;

export default function GlobalSearchBar({
  session,
  members,
  allowedViews,
  readOnlyOrders,
  onNavigate,
}: {
  session: Session;
  members: MemberLite[];
  allowedViews: string[];
  readOnlyOrders: boolean;
  onNavigate: (view: string) => void;
}) {
  const [input, setInput] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [openOrder, setOpenOrder] = useState<{ marketplace: string; externalId: string } | null>(null);
  const [openSerial, setOpenSerial] = useState<string | null>(null);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = input.trim();
    if (q.length < 3) {
      setHits(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    const my = ++seq.current;
    const t = setTimeout(async () => {
      const res = await searchEverywhere(supabase, q, label);
      if (my !== seq.current) return; // starsza odpowiedź
      setHits(res);
      setBusy(false);
      setOpen(true);
    }, 350);
    return () => clearTimeout(t);
  }, [input]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const visible = (hits || []).filter((h) => h.kind !== "nav" || allowedViews.includes(h.view));

  function go(h: SearchHit) {
    setOpen(false);
    if (h.kind === "order") return setOpenOrder({ marketplace: h.marketplace, externalId: h.externalId });
    if (h.kind === "product") return setOpenSerial(h.serial);
    try {
      if (h.sub) sessionStorage.setItem(h.sub.storage, h.sub.value);
    } catch {
      /* brak sessionStorage */
    }
    if (h.prefillKey) setPrefill(h.prefillKey, h.q);
    onNavigate(h.view);
    window.dispatchEvent(new Event("nav-sub-changed")); // widok już otwarty — niech odczyta podstronę
    if (h.prefillKey) setPrefill(h.prefillKey, h.q); // drugi raz po przełączeniu zakładki: widok zamontowany dopiero teraz też dostanie frazę
  }

  return (
    <div className="px-8 pt-3" ref={box}>
      <div className="relative max-w-xl">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => hits && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter" && visible.length === 1) go(visible[0]);
          }}
          placeholder="Szukaj numeru zamówienia lub numeru seryjnego — gdzie występuje w systemie…"
          className="w-full border border-line bg-white px-3 py-1.5 rounded text-sm"
          aria-label="Wyszukiwarka numeru zamówienia i numeru seryjnego"
        />
        {busy && <span className="absolute right-3 top-2 text-[11px] text-inksoft">szukam…</span>}
        {open && hits && (
          <div className="absolute z-30 mt-1 w-full border border-line bg-white rounded shadow-lg max-h-96 overflow-auto">
            {visible.length === 0 ? (
              <div className="p-3 text-xs text-inksoft">Nic nie znaleziono dla „{input.trim()}”. Wyszukiwanie jest dokładne (cały numer, bez rozróżniania wielkości liter).</div>
            ) : (
              visible.map((h) => (
                <button key={h.key} onClick={() => go(h)} className="w-full text-left px-3 py-2 border-b border-line last:border-b-0 hover:bg-paper flex items-start gap-3">
                  <span className="text-xs mt-0.5">{h.kind === "order" ? "🧾" : h.kind === "product" ? "📦" : "➜"}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">
                      {h.label}
                      {h.kind === "nav" && <span className="ml-2 text-xs font-normal text-inksoft">{h.count} {h.count === 1 ? "wpis" : "wpisów"}</span>}
                    </span>
                    {(h.kind !== "nav" ? h.note : h.note) && <span className="block text-[11px] text-inksoft">{h.kind !== "nav" ? h.note : h.note}</span>}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {openSerial && <ProductCardDrawer serial={openSerial} members={members} onClose={() => setOpenSerial(null)} />}
      {openOrder && <SalesOrderCard marketplace={openOrder.marketplace} externalId={openOrder.externalId} session={session} members={members} readOnly={readOnlyOrders} onClose={() => setOpenOrder(null)} />}
    </div>
  );
}
