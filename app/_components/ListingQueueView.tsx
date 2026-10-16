"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { displayNameForEmail, type MemberLite } from "@/lib/displayName";
import { escapeLike } from "@/lib/search";
import { skuCategoryOf } from "@/lib/skuParts";
import { summarizeShippingCosts, type ShipmentCostRow } from "@/lib/shippingCosts";
import { warsawYmd } from "@/lib/warsawDate";
import { DEFAULT_ASSUMPTIONS, normListingSku, bmRules, refurbedRules, suggestPrice, type Assumptions, type PriceInputs, type Suggestion, type VatMode } from "@/lib/listingPrice";
import { autoBand, decidePrice } from "@/lib/pricingStrategy";
import { isCountedOrder } from "@/lib/salesOrders";
import StockSyncBar from "./StockSyncBar";
import { marginAtPrice } from "@/lib/listingPrice";
import type { MarketInfo } from "@/lib/marketPricing";
import ProductCardDrawer from "./ProductCardDrawer";

// Magazyn -> "Do wystawienia" (16.10.2026, na prośbę właściciela): urządzenia gotowe do wystawienia na sprzedaż wprowadzane skanerem (numer seryjny + SKU). Cena zakupu i koszty
// dodatkowe (serwis, prowizja + PCC) idą z Towaru, a sugerowana cena sprzedaży na Back Market i refurbed jest liczona tak, żeby zysk netto po wszystkich kosztach wynosił ~20% ceny
// (wzór i założenia: lib/listingPrice.ts, ta sama definicja marży co zakładka Marża); widełki zysku 20–25% są edytowalne. Przy każdej sugestii widać, czy oferta z tym SKU jest już
// utworzona w Listingach i jaka jest w niej ilość. Ceny widzą tylko osoby z dostępem do Towaru (RLS) — pozostali widzą samą listę.

type Entry = { id: number; serial_number: string; sku: string; notes: string | null; created_by_email: string | null; created_at: string; listed_at: string | null; listed_by_email: string | null };
type Goods = { serial: string | null; name: string | null; kind: string | null; vat: string | null; price_pln: number | string | null; total_pln: number | string | null; costs: number | string | null; commission_pcc: number | string | null; purchased_on: string | null };
type Filter = "todo" | "done" | "all";
type ListingRow = { marketplace: string; external_id: string; sku: string | null; quantity: number | null; price: number | null; min_price?: number | null; currency: string | null; state: string | null };
type Offer = { externalId: string; sku: string; quantity: number; price: number | null; minPrice: number | null; currency: string | null };
type ListingInfo = { count: number; quantity: number; prices: number[]; currency: string | null; skus: string[]; offers: Offer[] };
type Pair = { lo: Suggestion | null; hi: Suggestion | null };

const LS_KEY = "listing-queue-assumptions";
const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const inp = "border border-line bg-white px-3 py-2 rounded text-sm";
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const pln = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct1 = (n: number) => `${(n * 100).toLocaleString("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const normSerial = (s: string | null | undefined) => (s || "").trim().toLowerCase().replace(/^0+/, "");
const fmtDT = (iso: string) => new Date(iso).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const looksLikeSku = (v: string | null | undefined) => /^[A-Za-z0-9][A-Za-z0-9./]*(-[A-Za-z0-9./]+)+$/.test((v || "").trim());

// Warianty zapisu numeru seryjnego (zera wiodące, wielkość liter) do zapytań .in(...)
function serialVariants(s: string): string[] {
  const t = s.trim();
  const stripped = t.replace(/^0+/, "");
  const out = new Set<string>([t, t.toUpperCase(), t.toLowerCase(), stripped, stripped.toUpperCase(), "0" + stripped, "00" + stripped, "0" + stripped.toUpperCase(), "00" + stripped.toUpperCase()]);
  return Array.from(out).filter(Boolean);
}
const inList = (vals: string[]) => `(${vals.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(",")})`;

async function fetchGoods(serials: string[]): Promise<Map<string, Goods>> {
  const out = new Map<string, Goods>();
  for (let i = 0; i < serials.length; i += 40) {
    const vars = serials.slice(i, i + 40).flatMap(serialVariants);
    const { data } = await supabase.from("goods_register_available").select("serial, name, kind, vat, price_pln, total_pln, costs, commission_pcc, purchased_on").filter("serial", "in", inList(vars));
    for (const g of (data as Goods[]) || []) {
      const k = normSerial(g.serial);
      const cur = out.get(k);
      if (!cur || (g.purchased_on || "") > (cur.purchased_on || "")) out.set(k, g); // ten sam numer kilka razy (odkup) — najnowszy zakup
    }
  }
  return out;
}

// Oferty z Magazyn -> Listingi (marketplace_listings): po SKU z listy, porównanie bez "+dodatku" i końcówki -nM; dla każdego marketplace'u liczba ofert, łączna ilość i ceny.
async function fetchListings(skus: string[]): Promise<Map<string, { backmarket: ListingInfo | null; refurbed: ListingInfo | null }>> {
  const want = Array.from(new Set(skus.map(normListingSku).filter(Boolean)));
  const out = new Map<string, { backmarket: ListingInfo | null; refurbed: ListingInfo | null }>();
  for (const k of want) out.set(k, { backmarket: null, refurbed: null });
  for (let i = 0; i < want.length; i += 15) {
    const chunk = want.slice(i, i + 15);
    const or = chunk.map((k) => `sku.ilike."${escapeLike(k).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}%"`).join(",");
    const { data } = await supabase.from("marketplace_listings").select("marketplace, external_id, sku, quantity, price, min_price, currency, state").or(or).limit(2000);
    for (const l of (data as ListingRow[]) || []) {
      const k = normListingSku(l.sku);
      const slot = out.get(k);
      if (!slot || (l.marketplace !== "backmarket" && l.marketplace !== "refurbed")) continue;
      const cur = (slot[l.marketplace] ??= { count: 0, quantity: 0, prices: [], currency: l.currency, skus: [], offers: [] });
      cur.count += 1;
      cur.quantity += Number(l.quantity) || 0;
      if (l.price !== null && l.price !== undefined) cur.prices.push(Number(l.price));
      cur.skus.push(`${l.sku} ×${Number(l.quantity) || 0}`);
      cur.offers.push({ externalId: l.external_id, sku: l.sku || "", quantity: Number(l.quantity) || 0, price: l.price === null || l.price === undefined ? null : Number(l.price), minPrice: l.min_price === null || l.min_price === undefined ? null : Number(l.min_price), currency: l.currency });
    }
  }
  return out;
}

type Group = { key: string; sku: string; rows: Entry[] };
// Oferta "własna" grupy: SKU oferty = SKU z listy (z ewentualną końcówką -nM). Oferty z dodatkiem ("PS4-500-BK-B+GTA5") to inne produkty (zestawy z grą) — ich ceny nie ruszamy.
const isOwnOffer = (o: Offer, groupSku: string) => o.sku.trim().toUpperCase().replace(/-\d+M$/, "") === groupSku;

export default function ListingQueueView({ session, members, canPrice = false, isAdmin = false }: { session: Session; members: MemberLite[]; canPrice?: boolean; isAdmin?: boolean }) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [goods, setGoods] = useState<Map<string, Goods>>(new Map());
  const [listings, setListings] = useState<Map<string, { backmarket: ListingInfo | null; refurbed: ListingInfo | null }>>(new Map());
  const [filter, setFilter] = useState<Filter>("todo");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [serial, setSerial] = useState("");
  const [sku, setSku] = useState("");
  const [skuHint, setSkuHint] = useState("");
  const [adding, setAdding] = useState(false);
  const [openSerial, setOpenSerial] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [reload, setReload] = useState(0);
  // Ceny BuyBox z marketplace'ów (na żądanie) i zmiana cen ofert (16.10.2026)
  const [mkt, setMkt] = useState<Map<string, { markets: MarketInfo[]; error?: string }>>(new Map());
  const [bmLang, setBmLang] = useState<string | null>(null);
  const [fetchingMkt, setFetchingMkt] = useState(false);
  const [pricing, setPricing] = useState<string | null>(null);
  const [priceNote, setPriceNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [qtyBusy, setQtyBusy] = useState(false);
  const [eurRate, setEurRate] = useState<{ mid: number; date: string } | null>(null);
  const [shipAvg, setShipAvg] = useState<number | null>(null);
  const [showParams, setShowParams] = useState(false);
  const [a, setA] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);
  const serialRef = useRef<HTMLInputElement>(null);
  const skuRef = useRef<HTMLInputElement>(null);
  const today = warsawYmd(Date.now());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) setA({ ...DEFAULT_ASSUMPTIONS, ...JSON.parse(raw) });
    } catch {
      /* brak localStorage */
    }
    (async () => {
      const { data } = await supabase.from("nbp_rates").select("mid, rate_date").eq("currency", "EUR").order("rate_date", { ascending: false }).limit(1);
      if (data?.[0]) setEurRate({ mid: Number(data[0].mid), date: String(data[0].rate_date) });
      // średni koszt przesyłki z ostatnich 90 dni (tylko jako podpowiedź do założenia o wysyłce; tabela przesyłek jest dostępna dla Admina/Managera/Księgowej)
      const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
      const sh = await supabase.from("shipments").select("created_at, carrier, cancelled_at, environment, charges").gte("created_at", since).limit(2000);
      if (!sh.error && sh.data) {
        const avg = summarizeShippingCosts(sh.data as ShipmentCostRow[]).all.average;
        if (avg) setShipAvg(Math.round(avg * 100) / 100);
      }
    })();
  }, []);
  const setParam = (patch: Partial<Assumptions>) =>
    setA((p) => {
      const n = { ...p, ...patch };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(n));
      } catch {
        /* ignoruj */
      }
      return n;
    });

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let q = supabase.from("listing_queue").select("id, serial_number, sku, notes, created_by_email, created_at");
      if (search) q = q.or(`serial_number.ilike.%${escapeLike(search)}%,sku.ilike.%${escapeLike(search)}%`);
      const { data, error: err } = await q.order("created_at", { ascending: false }).limit(300);
      if (cancelled) return;
      if (err) {
        setError(err.code === "42P01" || /listing_queue/.test(err.message) ? "Brak tabeli — uruchom supabase/listing-queue.sql w Supabase." : `Nie udało się wczytać listy: ${err.message}`);
        setRows([]);
      } else {
        setError("");
        const list = (data as Entry[]) || [];
        setRows(list);
        setGoods(await fetchGoods(Array.from(new Set(list.map((r) => r.serial_number)))));
        setListings(await fetchListings(list.map((r) => r.sku)));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [search, reload]);

  // Po zeskanowaniu numeru seryjnego podpowiadamy SKU znane z systemu (Towar -> Skup, SKU z magazynu: Testy / Trade-in / import); można je nadpisać skanem SKU.
  async function lookupSku(s: string) {
    setSkuHint("");
    const g = (await fetchGoods([s])).get(normSerial(s));
    let found = g && g.kind === "trade_in" && looksLikeSku(g.name) ? (g.name as string).trim() : "";
    if (!found) {
      const { data } = await supabase.from("fakturownia_stock_with_sku").select("sku").filter("name", "in", inList(serialVariants(s))).not("sku", "is", null).limit(1);
      found = (data?.[0] as { sku?: string } | undefined)?.sku || "";
    }
    if (found) {
      setSku(found);
      setSkuHint("SKU podpowiedziane z systemu — zatwierdź Enterem albo zeskanuj inne.");
    }
    if (!g) setSkuHint((h) => h || "Tego numeru nie ma w Towarze — cena zakupu będzie niedostępna.");
  }

  async function add() {
    const s = serial.trim().toUpperCase();
    const k = sku.trim().toUpperCase();
    if (!s) return serialRef.current?.focus();
    if (!k) return skuRef.current?.focus();
    setAdding(true);
    setError("");
    const { error: err } = await supabase.from("listing_queue").insert({ serial_number: s, sku: k, notes: note.trim() || null });
    setAdding(false);
    if (err) {
      setError(err.code === "23505" ? `Numer ${s} jest już na liście „Do wystawienia”.` : `Nie dodano: ${err.message}`);
      return;
    }
    setSerial("");
    setSku("");
    setSkuHint("");
    setNote("");
    setReload((n) => n + 1);
    serialRef.current?.focus();
  }

  async function remove(r: Entry) {
    if (!confirm(`Usunąć ${r.serial_number} z listy?`)) return;
    const { data, error: err } = await supabase.from("listing_queue").delete().eq("id", r.id).select("id");
    if (err) setError(`Nie usunięto: ${err.message}`);
    else if (!data?.length) setError("Nie usunięto — usuwać może Admin albo osoba, która dodała wpis.");
    else setReload((n) => n + 1);
  }

  // ---- Ceny BuyBox z marketplace'ów i zmiana cen ofert (16.10.2026) ----
  const offerKey = (mp: string, id: string) => `${mp}:${id}`;
  const marketFor = (mp: "backmarket" | "refurbed", markets: MarketInfo[]): MarketInfo | null => {
    if (markets.length === 0) return null;
    const want = mp === "backmarket" ? (bmLang?.split("-")[1] || a.bmCountry).toUpperCase() : a.rfMarket.toUpperCase();
    return markets.find((m) => m.market.toUpperCase() === want) ?? markets[0];
  };

  async function fetchBuybox() {
    const items: { marketplace: string; externalId: string }[] = [];
    for (const g of groups) {
      const l = listings.get(g.key);
      for (const mp of ["backmarket", "refurbed"] as const) for (const o of l?.[mp]?.offers ?? []) if (isOwnOffer(o, g.key)) items.push({ marketplace: mp, externalId: o.externalId });
    }
    if (items.length === 0) return setPriceNote({ ok: false, text: "Brak ofert z tymi SKU — nie ma czego sprawdzać." });
    setFetchingMkt(true);
    setPriceNote(null);
    try {
      const next = new Map(mkt);
      let fails = 0;
      for (let i = 0; i < items.length; i += 24) {
        const res = await fetch("/api/listings/market-info", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ items: items.slice(i, i + 24) }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Błąd pobierania cen BuyBox.");
        if (data.bmLang) setBmLang(data.bmLang);
        for (const r of data.results as { marketplace: string; externalId: string; ok: boolean; markets: MarketInfo[]; error?: string }[]) {
          if (!r.ok) fails++;
          next.set(offerKey(r.marketplace, r.externalId), { markets: r.markets, error: r.error });
        }
      }
      setMkt(next);
      setPriceNote({ ok: fails === 0, text: fails === 0 ? `Pobrano dane BuyBox dla ${items.length} ofert.` : `Pobrano dane BuyBox; ${fails} z ${items.length} ofert zwróciło błąd (szczegóły przy ofercie).` });
    } catch (e: any) {
      setPriceNote({ ok: false, text: e.message || String(e) });
    } finally {
      setFetchingMkt(false);
    }
  }

  async function applyPrice(g: Group, mp: "backmarket" | "refurbed", o: Offer, target: number, reason: string, marginsTxt: string, minTarget: number | null = null) {
    const label = mp === "backmarket" ? "Back Market" : "refurbed";
    if (!confirm(`Zmienić cenę oferty na ${label}?\n\nSKU: ${o.sku}\nCena teraz: ${o.price ?? "—"} ${o.currency || "EUR"}\nNowa cena: ${target} ${o.currency || "EUR"}\n${minTarget !== null ? `Cena minimalna (automat marketplace'u): ${o.minPrice ?? "—"} → ${minTarget} ${o.currency || "EUR"}\n` : ""}Powód: ${reason}\n${marginsTxt ? `Zysk przy nowej cenie: ${marginsTxt}\n` : ""}\nTo zmienia PRAWDZIWĄ cenę na marketplace'ie (kupujący zobaczą ją od razu).`)) return;
    const key = offerKey(mp, o.externalId);
    setPricing(key);
    setPriceNote(null);
    const call = async (force: boolean) => {
      const res = await fetch("/api/listings/update-price", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ marketplace: mp, externalId: o.externalId, price: target, ...(minTarget !== null ? { minPrice: minTarget } : {}), confirm: true, force, reason }) });
      return { res, data: await res.json() };
    };
    try {
      let { res, data } = await call(false);
      if (res.status === 409 && data?.needsForce) {
        if (!confirm(`${data.error}\n\nCzy na pewno ustawić ${target} ${o.currency || "EUR"}?`)) return;
        ({ res, data } = await call(true));
      }
      if (!res.ok) throw new Error(data?.error || "Nie udało się zmienić ceny.");
      setPriceNote({ ok: !data.mismatch && !data.logWarning, text: `${label}: cena oferty ${o.sku} ustawiona na ${data.applied} ${o.currency || "EUR"}${minTarget !== null ? `, cena minimalna ${data.appliedMin ?? minTarget}${data.minMismatch ? ` (marketplace zwrócił inną niż wysłana: ${minTarget})` : ""}` : ""}${data.mismatch ? ` (marketplace zwrócił inną cenę niż wysłana: ${data.applied} zamiast ${data.requested})` : ""}.${data.logWarning ? ` ${data.logWarning}` : ""}` });
      setMkt((p) => {
        const n = new Map(p);
        n.delete(key); // dane BuyBox sprzed zmiany są nieaktualne
        return n;
      });
      setReload((n) => n + 1);
    } catch (e: any) {
      setPriceNote({ ok: false, text: `${label}: ${e.message || e}` });
    } finally {
      setPricing(null);
    }
  }

  // "Zaktualizuj ilości" (16.10.2026): ilość każdej oferty z danym SKU na Back Market i refurbed = liczba sztuk z listy "Do wystawienia" z tym SKU, które nie zostały jeszcze sprzedane
  // (numer seryjny pozycji zamówienia liczonego jako sprzedaż, z datą zamówienia po dodaniu wpisu do listy). Zmienia PRAWDZIWE stany na marketplace'ach — najpierw okno ze zmianami.
  async function updateQuantities() {
    setQtyBusy(true);
    setPriceNote(null);
    try {
      const { data: all, error: qe } = await supabase.from("listing_queue").select("serial_number, sku, created_at").limit(5000);
      if (qe) throw new Error(qe.message);
      const entries = ((all as { serial_number: string; sku: string; created_at: string }[]) || []).filter((e) => e.sku);
      if (entries.length === 0) throw new Error("Lista „Do wystawienia” jest pusta.");
      const soldSerials = new Map<string, { at: number }[]>();
      const serials = Array.from(new Set(entries.map((e) => e.serial_number)));
      for (let i = 0; i < serials.length; i += 40) {
        const chunk = serials.slice(i, i + 40);
        const { data: items } = await supabase.from("sales_order_items").select("serial_number, marketplace, sales_orders(order_date, status)").filter("serial_number", "in", inList(chunk.flatMap(serialVariants)));
        for (const it of (items as any[]) || []) {
          const o = Array.isArray(it.sales_orders) ? it.sales_orders[0] : it.sales_orders;
          if (!o || !isCountedOrder(it.marketplace, o.status)) continue;
          const k = normSerial(it.serial_number);
          soldSerials.set(k, [...(soldSerials.get(k) ?? []), { at: Date.parse(o.order_date) }]);
        }
      }
      const available = new Map<string, number>();
      for (const e of entries) {
        const sold = (soldSerials.get(normSerial(e.serial_number)) ?? []).some((s) => s.at >= Date.parse(e.created_at) - 60_000);
        const k = e.sku.trim().toUpperCase().replace(/-\d+M$/, "");
        available.set(k, (available.get(k) ?? 0) + (sold ? 0 : 1));
      }
      const lst = await fetchListings(Array.from(available.keys()));
      const changes: { marketplace: "backmarket" | "refurbed"; externalId: string; sku: string; from: number; to: number }[] = [];
      const notes: string[] = [];
      for (const [k, qty] of available) {
        for (const mp of ["backmarket", "refurbed"] as const) {
          const own = (lst.get(normListingSku(k))?.[mp]?.offers ?? []).filter((o) => isOwnOffer(o, k));
          if (own.length === 0) continue;
          if (own.length > 1) {
            notes.push(`${k} (${mp === "backmarket" ? "Back Market" : "refurbed"}): ${own.length} ofert — pominięto`);
            continue;
          }
          if (own[0].quantity !== qty) changes.push({ marketplace: mp, externalId: own[0].externalId, sku: k, from: own[0].quantity, to: qty });
        }
      }
      if (changes.length === 0) {
        setPriceNote({ ok: true, text: `Ilości ofert zgadzają się z listą — nic do zmiany.${notes.length ? ` Pominięte: ${notes.join("; ")}.` : ""}` });
        return;
      }
      const lines = changes.slice(0, 25).map((c) => `${c.sku} — ${c.marketplace === "backmarket" ? "Back Market" : "refurbed"}: ${c.from} → ${c.to}`).join("\n");
      if (!confirm(`Zmienić ilości ofert (${changes.length})?\n\n${lines}${changes.length > 25 ? `\n… i ${changes.length - 25} więcej` : ""}\n\nIlość = sztuki z listy „Do wystawienia” z tym SKU, które nie zostały jeszcze sprzedane (sprzedaż rozpoznajemy po numerze seryjnym w zamówieniu). To zmienia PRAWDZIWE stany na marketplace'ach.`)) return;
      let ok = 0;
      const errs: string[] = [];
      for (let i = 0; i < changes.length; i += 24) {
        const batch = changes.slice(i, i + 24);
        const res = await fetch("/api/listings/set-quantity", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ confirm: true, items: batch.map((c) => ({ marketplace: c.marketplace, externalId: c.externalId, quantity: c.to, reason: `Zaktualizuj ilości: ${c.sku}` })) }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Nie udało się zmienić ilości.");
        for (const r of data.results as { ok: boolean; error?: string; externalId: string }[]) {
          if (r.ok) ok++;
          else errs.push(r.error || r.externalId);
        }
      }
      setPriceNote({ ok: errs.length === 0, text: `Zmieniono ilości w ${ok} ofertach${errs.length ? `; błędy (${errs.length}): ${errs.slice(0, 3).join(" | ")}` : ""}.${notes.length ? ` Pominięte: ${notes.join("; ")}.` : ""}` });
      setReload((n) => n + 1);
    } catch (e: any) {
      setPriceNote({ ok: false, text: e.message || String(e) });
    } finally {
      setQtyBusy(false);
    }
  }

  // Wyliczenia na wiersz
  const calc = useMemo(() => {
    const out = new Map<number, { g: Goods | null; input: PriceInputs | null; bm: Pair | null; rf: Pair | null; bmNote: string; rfNote: string; cat: string; vatMissing: boolean }>();
    for (const r of rows) {
      const g = goods.get(normSerial(r.serial_number)) ?? null;
      const purchase = num(g?.price_pln);
      const totalCosts = num(g?.total_pln);
      const extra = purchase !== null ? (totalCosts !== null ? Math.max(0, totalCosts - purchase) : (num(g?.costs) ?? 0) + (num(g?.commission_pcc) ?? 0)) : 0;
      const vat: VatMode = (g?.vat || "").toUpperCase() === "V23" ? "V23" : "VM";
      const input: PriceInputs | null = purchase !== null && purchase > 0 && eurRate ? { purchasePln: purchase, extraPln: extra, vat, shippingPln: a.shippingPln, targetPct: a.targetMinPct, eurRate: eurRate.mid } : null;
      const bmr = bmRules(r.sku, a, today);
      const rfr = refurbedRules(a);
      out.set(r.id, {
        g,
        input,
        bm: input ? { lo: suggestPrice(input, bmr.rules), hi: suggestPrice({ ...input, targetPct: a.targetMaxPct }, bmr.rules) } : null,
        rf: input ? { lo: suggestPrice(input, rfr.rules), hi: suggestPrice({ ...input, targetPct: a.targetMaxPct }, rfr.rules) } : null,
        bmNote: bmr.note,
        rfNote: rfr.note,
        cat: skuCategoryOf(r.sku),
        vatMissing: !!g && !["VM", "V23"].includes((g.vat || "").toUpperCase()),
      });
    }
    return out;
  }, [rows, goods, a, eurRate, today]);

  const SugCell = ({ p, info }: { p: Pair | null; info: ListingInfo | null | undefined }) => {
    const lo = p?.lo ?? null;
    const hi = p?.hi ?? null;
    const same = lo && hi && lo.eur === hi.eur;
    return (
      <div className="whitespace-nowrap">
        {lo && hi ? (
          <>
            <div className="font-mono font-bold text-base">{same ? `${lo.eur.toLocaleString("pl-PL")} €` : `${lo.eur.toLocaleString("pl-PL")} – ${hi.eur.toLocaleString("pl-PL")} €`}</div>
            <div className="text-[11px] text-inksoft font-mono">{same ? `${pln(lo.pricePln)} zł` : `${pln(lo.pricePln)} – ${pln(hi.pricePln)} zł`}</div>
            <div className="text-[11px] text-teal font-mono" title="Zysk netto po wszystkich kosztach przy cenie minimalnej i maksymalnej">zysk {pln(lo.margin.marginPln)}{same ? "" : ` – ${pln(hi.margin.marginPln)}`} zł · {pct1(lo.margin.marginPct)}{same ? "" : ` – ${pct1(hi.margin.marginPct)}`}</div>
          </>
        ) : (
          <span className="text-inksoft">—</span>
        )}
        <ListingBadge info={info} />
      </div>
    );
  };

  // Czy oferta z tym SKU jest już utworzona (Magazyn -> Listingi) i jaka jest w niej ilość
  const ListingBadge = ({ info }: { info: ListingInfo | null | undefined }) =>
    info === undefined ? null : info === null ? (
      <div className="text-[11px] text-inksoft mt-1" title="W Listingach nie ma oferty z tym SKU">brak listingu</div>
    ) : (
      <div className={`text-[11px] mt-1 ${info.quantity > 0 ? "text-teal" : "text-amber"}`} title={`Oferty z tym SKU: ${info.skus.join(", ")}`}>
        listing jest · ilość {info.quantity}{info.count > 1 ? ` (${info.count} oferty)` : ""}
        {info.prices.length > 0 && <span className="text-inksoft"> · cena {info.prices.length === 1 || Math.min(...info.prices) === Math.max(...info.prices) ? info.prices[0] : `${Math.min(...info.prices)}–${Math.max(...info.prices)}`} {info.currency || ""}</span>}
      </div>
    );

  const Breakdown = ({ p, title, note, input }: { p: Pair | null; title: string; note: string; input: PriceInputs | null }) => {
    const lo = p?.lo;
    const hi = p?.hi;
    if (!lo || !hi || !input) return null;
    const rowsDef: [string, (s: Suggestion) => number][] = [
      ["Cena sprzedaży brutto", (s) => s.margin.salePln],
      [`− cena zakupu ${input.vat === "V23" ? "(netto, V23)" : ""}`, () => input.purchasePln],
      [`− ${input.vat === "V23" ? "VAT należny 23% od całej ceny" : "VAT od marży 23/123"}`, (s) => s.margin.vatPln],
      ["− wysyłka do klienta", () => input.shippingPln],
      ["− koszty dodatkowe (serwis, prowizja + PCC z Towaru)", () => input.extraPln],
      ["− prowizja i opłaty marketplace'u", (s) => s.margin.commissionPln],
    ];
    return (
      <div className="text-xs">
        <div className="font-semibold mb-1">{title}</div>
        <div className="text-inksoft mb-1">{note}</div>
        <table className="font-mono">
          <thead>
            <tr className="text-inksoft"><th></th><th className="text-right pl-4 font-normal">cena min. ({lo.eur} €)</th><th className="text-right pl-4 font-normal">cena maks. ({hi.eur} €)</th></tr>
          </thead>
          <tbody>
            {rowsDef.map(([label, f]) => (
              <tr key={label}><td className="pr-4">{label}</td><td className="text-right pl-4">{pln(f(lo))}</td><td className="text-right pl-4">{pln(f(hi))}</td></tr>
            ))}
            <tr className="font-bold border-t border-line"><td className="pr-4">= zysk netto</td><td className="text-right pl-4">{pln(lo.margin.marginPln)} ({pct1(lo.margin.marginPct)})</td><td className="text-right pl-4">{pln(hi.margin.marginPln)} ({pct1(hi.margin.marginPct)})</td></tr>
          </tbody>
        </table>
      </div>
    );
  };

  // "Wystawione" wynika z Listingów (bez ręcznego przycisku): oferta z tym SKU z ilością > 0 na Back Market albo refurbed.
  const isListed = (r: Entry) => {
    const l = listings.get(normListingSku(r.sku));
    return !!l && ((l.backmarket?.quantity ?? 0) > 0 || (l.refurbed?.quantity ?? 0) > 0);
  };
  const todoCount = rows.filter((r) => !isListed(r)).length;
  const listedCount = rows.length - todoCount;
  const visible = rows.filter((r) => (filter === "all" ? true : filter === "todo" ? !isListed(r) : isListed(r)));
  const anyGoods = goods.size > 0;
  // Grupy sztuk z tym samym SKU: na marketplace'ie jest jedna oferta (jedna cena) dla wszystkich sztuk, więc cenę liczymy dla grupy.
  const groups = useMemo(() => {
    const m = new Map<string, Group>();
    for (const r of visible) {
      const key = normListingSku(r.sku) || r.sku;
      const g = m.get(key) ?? { key, sku: key, rows: [] };
      g.rows.push(r);
      m.set(key, g);
    }
    return Array.from(m.values());
  }, [visible]);

  // Widełki grupy: dolna = najwyższa z cen minimalnych (zysk 20%) wśród sztuk, górna = najwyższa z cen maksymalnych (zysk 25%) — żadna sztuka nie schodzi poniżej celu.
  const bandsOf = (g: Group, mp: "bm" | "rf") => {
    let floor = 0;
    let ceil = 0;
    let n = 0;
    for (const r of g.rows) {
      const p = calc.get(r.id)?.[mp];
      if (!p?.lo || !p.hi) continue;
      floor = Math.max(floor, p.lo.eur);
      ceil = Math.max(ceil, p.hi.eur);
      n++;
    }
    return n > 0 ? { floor, ceil, n } : null;
  };

  const renderOffers = (g: Group, mp: "backmarket" | "refurbed") => {
    const band = bandsOf(g, mp === "backmarket" ? "bm" : "rf");
    const info = listings.get(g.key)?.[mp] ?? null;
    const rules = mp === "backmarket" ? bmRules(g.sku, a, today).rules : refurbedRules(a).rules;
    const title = mp === "backmarket" ? "Back Market" : "refurbed";
    return (
      <div className="text-xs">
        <div className="font-semibold mb-1">{title}{band ? <span className="font-normal text-inksoft"> — widełki grupy: {band.floor === band.ceil ? `${band.floor} €` : `${band.floor} – ${band.ceil} €`}</span> : <span className="font-normal text-inksoft"> — brak cen zakupu w Towarze</span>}</div>
        {!info || info.offers.filter((o) => isOwnOffer(o, g.sku)).length === 0 ? (
          <div className="text-inksoft">Brak oferty z tym SKU — utwórz ją w panelu marketplace'u (aplikacja ofert nie tworzy).</div>
        ) : (
          info.offers.filter((o) => isOwnOffer(o, g.sku)).slice(0, 6).map((o) => {
            const m = mkt.get(offerKey(mp, o.externalId));
            const mi = m ? marketFor(mp, m.markets) : null;
            const eurOk = (o.currency || "EUR").toUpperCase() === "EUR";
            const dec = band && eurOk ? decidePrice({ floorEur: band.floor, ceilingEur: band.ceil, currentEur: o.price, won: mi?.won ?? null, priceToWinEur: mi && (mi.currency || "EUR") === "EUR" ? mi.priceToWin : null, undercutEur: a.undercutEur }) : null;
            const unitMargins = dec && eurRate ? g.rows.map((r) => { const c = calc.get(r.id); return c?.input ? marginAtPrice(dec.targetEur * eurRate.mid, c.input, rules).marginPct : null; }) : [];
            const marginsTxt = unitMargins.filter((x): x is number => x !== null).map(pct1).join(" · ");
            return (
              <div key={o.externalId} className="border border-line bg-white p-2 mb-1.5">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-mono">{o.sku}</span>
                  <span className={o.quantity > 0 ? "text-teal" : "text-amber"}>ilość {o.quantity}</span>
                  <span>cena teraz: <b className="font-mono">{o.price ?? "—"} {o.currency || ""}</b></span>
                </div>
                {m?.error ? (
                  <div className="text-rust mt-1">BuyBox: {m.error}</div>
                ) : m ? (
                  mi ? (
                    <div className="mt-1" title={m.markets.map((x) => `${x.market}: ${x.won === null ? "?" : x.won ? "mamy" : "nie mamy"}${x.priceToWin !== null ? `, do wygrania ${x.priceToWin}` : ""}`).join(" | ")}>
                      BuyBox ({mi.market}): {mi.won === null ? <span className="text-inksoft">brak danych</span> : mi.won ? <span className="text-teal font-semibold">mamy</span> : <span className="text-rust font-semibold">nie mamy</span>}
                      {mi.priceToWin !== null && <> · cena do wygrania: <b className="font-mono">{mi.priceToWin} {mi.currency || ""}</b></>}
                      {mi.winnerPrice !== null && <span className="text-inksoft"> · {mp === "refurbed" ? "cena zwycięzcy (z wysyłką)" : "cena zwycięzcy"}: {mi.winnerPrice}</span>}
                    </div>
                  ) : (
                    <div className="mt-1 text-inksoft">BuyBox: marketplace nie zwrócił danych dla tej oferty.</div>
                  )
                ) : (
                  canPrice && <div className="mt-1 text-inksoft">BuyBox: kliknij „Sprawdź BuyBox”.</div>
                )}
                {band && eurOk && (() => {
                  const ab = autoBand(mp, band.floor, band.ceil);
                  const same = o.price !== null && o.minPrice !== null && Math.abs(o.price - ab.priceEur) < 0.005 && Math.abs(o.minPrice - ab.minEur) < 0.005;
                  const mAt = (eur: number) => (eurRate ? g.rows.map((r) => { const c = calc.get(r.id); return c?.input ? marginAtPrice(eur * eurRate.mid, c.input, rules).marginPct : null; }).filter((x): x is number => x !== null).map(pct1).join(" · ") : "");
                  return (
                    <div className="mt-1 border-t border-line pt-1">
                      Automat marketplace&apos;u ({mp === "backmarket" ? "BackPricer" : "cena min. + referencyjna"}): teraz min <b className="font-mono">{o.minPrice ?? "—"}</b> · cena <b className="font-mono">{o.price ?? "—"}</b>; docelowo min <b className="font-mono">{ab.minEur} €</b> (zysk {mAt(ab.minEur) || "—"}) · cena <b className="font-mono">{ab.priceEur} €</b> (zysk {mAt(ab.priceEur) || "—"})
                      {ab.capped && <div className="text-inksoft">Back Market dopuszcza cenę najwyżej 8% powyżej minimalnej, więc cena docelowa jest niższa niż górna granica widełek ({band.ceil} €).</div>}
                      {canPrice && (same ? <div className="text-teal">✓ ustawione zgodnie z widełkami</div> : (
                        <button onClick={() => applyPrice(g, mp, o, ab.priceEur, `automat marketplace'u: min ${ab.minEur} €, cena ${ab.priceEur} €`, mAt(ab.priceEur), ab.minEur)} disabled={pricing === offerKey(mp, o.externalId)} className="mt-1 block border border-ink px-3 py-1 rounded text-xs font-semibold disabled:opacity-50">
                          {pricing === offerKey(mp, o.externalId) ? "Ustawiam…" : `Ustaw automat: min ${ab.minEur} € · cena ${ab.priceEur} €`}
                        </button>
                      ))}
                    </div>
                  );
                })()}
                {dec ? (
                  <div className="mt-1">
                    Strategia: <b className="font-mono">{dec.targetEur} €</b>{" "}
                    <span className={dec.action === "hold" ? "text-inksoft" : dec.action === "lower" ? "text-rust" : "text-teal"}>({dec.action === "hold" ? "bez zmiany" : dec.action === "lower" ? "obniż" : "podnieś"})</span>
                    <span className="text-inksoft"> — {dec.reason}</span>
                    {dec.warning && <div className="text-amber">⚠ {dec.warning}</div>}
                    {marginsTxt && <div className="text-inksoft">zysk przy tej cenie (sztuki z grupy): {marginsTxt}</div>}
                    {canPrice && dec.action !== "hold" && (
                      <button onClick={() => applyPrice(g, mp, o, dec.targetEur, dec.reason, marginsTxt)} disabled={pricing === offerKey(mp, o.externalId)} className="mt-1 bg-ink text-paper px-3 py-1 rounded text-xs font-semibold disabled:opacity-50">
                        {pricing === offerKey(mp, o.externalId) ? "Zmieniam…" : `Ustaw ${dec.targetEur} € na ${title}`}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="mt-1 text-inksoft">{!eurOk ? `Oferta w walucie ${o.currency} — strategia liczy tylko EUR.` : "Brak cen zakupu w Towarze — nie wyliczę strategii."}</div>
                )}
              </div>
            );
          })
        )}
        {info && info.offers.some((o) => !isOwnOffer(o, g.sku)) && (
          <div className="text-inksoft mt-1" title="Oferty z dodatkiem (np. zestaw z grą) to inne produkty — cen nie zmieniamy z aplikacji">
            Powiązane oferty z dodatkiem (bez zmiany ceny): {info.offers.filter((o) => !isOwnOffer(o, g.sku)).slice(0, 4).map((o) => `${o.sku} ×${o.quantity} ${o.price ?? "—"} ${o.currency || ""}`).join("; ")}
          </div>
        )}
      </div>
    );
  };

  const renderGroupPanel = (g: Group) => {
    const costs = g.rows.map((r) => { const c = calc.get(r.id); return c?.input ? c.input.purchasePln + c.input.extraPln : null; }).filter((x): x is number => x !== null);
    return (
      <tr key={`${g.key}-panel`} className="border-b border-line bg-paper">
        <td colSpan={8} className="p-3">
          <div className="text-xs mb-2">
            <b className="font-mono">{g.sku}</b> · {g.rows.length} {g.rows.length === 1 ? "sztuka" : "szt."}
            {costs.length > 0 && <span className="text-inksoft"> · koszt (zakup + koszty): {costs.length > 1 && Math.min(...costs) !== Math.max(...costs) ? `${pln(Math.min(...costs))} – ${pln(Math.max(...costs))}` : pln(costs[0])} zł</span>}
            {g.rows.length > 1 && <span className="text-inksoft"> · jedna oferta = jedna cena dla wszystkich sztuk, więc widełki liczone są po najdroższej sztuce</span>}
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            {renderOffers(g, "backmarket")}
            {renderOffers(g, "refurbed")}
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div>
      <div className="border border-line bg-white p-4 mb-4">
        <h2 className="text-xs font-semibold text-inksoft mb-3">DODAJ URZĄDZENIE (skaner: numer seryjny → Enter → SKU → Enter)</h2>
        <div className="flex flex-wrap gap-3 items-start">
          <div>
            <label className="text-xs font-semibold text-inksoft block mb-1">Numer seryjny *</label>
            <input
              ref={serialRef}
              autoFocus
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (!serial.trim()) return;
                  lookupSku(serial.trim()).finally(() => skuRef.current?.focus());
                }
              }}
              placeholder="zeskanuj numer seryjny"
              className={`${inp} w-64 font-mono`}
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-inksoft block mb-1">SKU *</label>
            <input
              ref={skuRef}
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="zeskanuj SKU"
              className={`${inp} w-64 font-mono`}
            />
          </div>
          <div className="flex-1 min-w-[12rem]">
            <label className="text-xs font-semibold text-inksoft block mb-1">Uwagi (opcjonalnie)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} className={`${inp} w-full`} />
          </div>
          <button onClick={add} disabled={adding || !serial.trim() || !sku.trim()} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50 self-end">{adding ? "Dodawanie…" : "Dodaj"}</button>
        </div>
        {skuHint && <p className="text-xs text-inksoft mt-2">{skuHint}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {([["todo", "Do wystawienia", todoCount], ["done", "Wystawione", listedCount], ["all", "Wszystkie", rows.length]] as const).map(([k, label, n]) => (
          <button key={k} onClick={() => setFilter(k)} className={pill(filter === k)} title={k === "done" ? "Mają ofertę z tym SKU i ilością > 0 na Back Market albo refurbed (Magazyn → Listingi)" : undefined}>{label}<span className="ml-1.5 text-xs font-normal opacity-70">{n}</span></button>
        ))}
        <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Szukaj: numer seryjny albo SKU" className={`${inp} w-64 ml-2`} />
        {canPrice && <button onClick={fetchBuybox} disabled={fetchingMkt || groups.length === 0} className="ml-auto border border-line bg-white px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-50" title="Pobierz z marketplace'ów ceny BuyBox/Backbox dla ofert z tymi SKU (tylko odczyt)">{fetchingMkt ? "Sprawdzam…" : "Sprawdź BuyBox"}</button>}
        {canPrice && <button onClick={updateQuantities} disabled={qtyBusy} className="border border-line bg-white px-3 py-1.5 rounded text-sm font-semibold disabled:opacity-50" title="Ustaw ilość ofert z tymi SKU na Back Market i refurbed = liczba niesprzedanych sztuk z listy „Do wystawienia” (najpierw okno ze zmianami)">{qtyBusy ? "Liczę…" : "Zaktualizuj ilości"}</button>}
        <button onClick={() => setShowParams((v) => !v)} className={`${canPrice ? "" : "ml-auto "}border border-line bg-white px-3 py-1.5 rounded text-sm font-semibold`}>{showParams ? "Ukryj założenia" : "Założenia cen"}</button>
      </div>

      {showParams && (
        <div className="border border-line bg-white p-4 mb-3 text-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="text-xs font-semibold text-inksoft">Widełki zysku netto (% ceny)
              <div className="flex items-center gap-1 mt-1">
                <input type="number" step="0.5" value={a.targetMinPct} onChange={(e) => setParam({ targetMinPct: Number(e.target.value) || 0 })} className={`${inp} w-full font-mono`} title="Od (cena minimalna)" />
                <span>–</span>
                <input type="number" step="0.5" value={a.targetMaxPct} onChange={(e) => setParam({ targetMaxPct: Number(e.target.value) || 0 })} className={`${inp} w-full font-mono`} title="Do (cena maksymalna)" />
              </div>
            </div>
            <label className="text-xs font-semibold text-inksoft">Wysyłka do klienta (zł netto)
              <input type="number" step="1" value={a.shippingPln} onChange={(e) => setParam({ shippingPln: Number(e.target.value) || 0 })} className={`${inp} w-full mt-1 font-mono`} />
              {shipAvg !== null && <button type="button" onClick={() => setParam({ shippingPln: shipAvg })} className="text-teal font-normal underline block mt-0.5">użyj średniej z ostatnich przesyłek: {pln(shipAvg)}</button>}
            </label>
            <label className="text-xs font-semibold text-inksoft">Back Market: kraj sprzedaży
              <select value={a.bmCountry} onChange={(e) => setParam({ bmCountry: e.target.value })} className={`${inp} w-full mt-1`}>
                {["FR", "DE", "ES", "IT", "PL", "NL", "BE", "AT"].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-inksoft">Back Market: opłata płatnicza (%)
              <input type="number" step="0.1" value={a.bmPaymentPct} onChange={(e) => setParam({ bmPaymentPct: Number(e.target.value) || 0 })} className={`${inp} w-full mt-1 font-mono`} />
            </label>
            <label className="text-xs font-semibold text-inksoft">refurbed: prowizja (%)
              <input type="number" step="0.1" value={a.rfCommissionPct} onChange={(e) => setParam({ rfCommissionPct: Number(e.target.value) || 0 })} className={`${inp} w-full mt-1 font-mono`} />
            </label>
            <label className="text-xs font-semibold text-inksoft">refurbed: rynek dla BuyBox
              <select value={a.rfMarket} onChange={(e) => setParam({ rfMarket: e.target.value })} className={`${inp} w-full mt-1`}>
                {["DE", "FR", "AT", "ES", "IT", "NL", "BE", "PL"].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-inksoft" title="O ile € schodzimy poniżej ceny do wygrania BuyBox (0 = dokładnie cena do wygrania — największa marża)">Poniżej ceny do wygrania BuyBox (€)
              <input type="number" step="1" min="0" value={a.undercutEur} onChange={(e) => setParam({ undercutEur: Math.max(0, Number(e.target.value) || 0) })} className={`${inp} w-full mt-1 font-mono`} />
            </label>
            <label className="text-xs font-semibold text-inksoft">refurbed: opłata płatnicza (%)
              <input type="number" step="0.1" value={a.rfPaymentPct} onChange={(e) => setParam({ rfPaymentPct: Number(e.target.value) || 0 })} className={`${inp} w-full mt-1 font-mono`} />
            </label>
          </div>
          <p className="text-[11px] text-inksoft mt-3 max-w-4xl">
            Założenia zapamiętuje ta przeglądarka. Kurs EUR: {eurRate ? `${eurRate.mid.toLocaleString("pl-PL", { minimumFractionDigits: 4 })} (NBP z ${eurRate.date})` : "brak kursu NBP — odśwież kursy w zakładce NBP"}.
            Marża liczona jak w zakładce Marża: cena brutto − zakup − VAT (od marży 23/123 albo 23% dla V23) − wysyłka − koszty dodatkowe z Towaru (serwis, prowizja Buyback, PCC) − prowizja i opłaty marketplace'u; % = zysk ÷ cena sprzedaży.
            Back Market: prowizja wg reguł z Marży (konsole do FR/DE/ES/IT 6% tylko do 31.12.2026, potem 11%; akcesoria 20%), płatność 1%, CCBM 6,99 € (akcesoria 1,99 €). refurbed: 12% + 1,5% wg danych naszych zamówień.
            Cena jest zaokrąglana w górę do pełnego euro. To sugestia — nie uwzględnia konkurencji na marketplace'ie.
          </p>
        </div>
      )}

      {error && <p className="text-rust text-xs mb-3">{error}</p>}
      {canPrice && <StockSyncBar session={session} isAdmin={isAdmin} canRun={canPrice} />}
      {priceNote && <p className={`text-xs mb-3 ${priceNote.ok ? "text-teal" : "text-rust"}`}>{priceNote.text}</p>}
      {!loading && rows.length > 0 && !anyGoods && <p className="text-amber text-xs mb-3">Nie znaleziono tych numerów w Towarze (albo nie masz dostępu do zakładki Towar) — ceny zakupu i sugestie są niedostępne.</p>}

      <div className="bg-white border border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-inksoft border-b border-line">
              <th className="p-3">Dodano</th>
              <th className="p-3">Numer seryjny</th>
              <th className="p-3">SKU</th>
              <th className="p-3 text-right">Cena zakupu</th>
              <th className="p-3 text-right" title="Serwis + prowizja Buyback + PCC z Towaru">Koszty dod.</th>
              <th className="p-3" title="Widełki ceny: zysk netto od dolnej do górnej granicy (Założenia cen)">Back Market — sugerowana cena</th>
              <th className="p-3">refurbed — sugerowana cena</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {!loading && visible.length === 0 && !error && <tr><td colSpan={8} className="p-6 text-center text-inksoft text-sm">{search ? "Brak wyników." : filter === "done" ? "Żadne urządzenie z listy nie ma jeszcze oferty z ilością > 0." : filter === "todo" && rows.length > 0 ? "Wszystkie urządzenia z listy mają już aktywne oferty." : "Lista jest pusta — zeskanuj pierwsze urządzenie powyżej."}</td></tr>}
            {groups.map((g) => (
              <Fragment key={g.key}>
              {renderGroupPanel(g)}
              {g.rows.map((r) => {
              const c = calc.get(r.id)!;
              const open = expanded.has(r.id);
              return (
                <Fragment key={r.id}>
                  <tr className="border-b border-line align-top">
                    <td className="p-3 text-xs whitespace-nowrap">
                      <div>{fmtDT(r.created_at)}</div>
                      <div className="text-inksoft">{displayNameForEmail(r.created_by_email, members)}</div>
                    </td>
                    <td className="p-3 font-mono text-xs">
                      {r.serial_number} <button onClick={() => setOpenSerial(r.serial_number)} title="Otwórz kartę produktu" className="text-teal">↗</button>
                      {r.notes && <div className="font-sans text-inksoft mt-0.5">{r.notes}</div>}
                    </td>
                    <td className="p-3 font-mono text-xs">
                      {r.sku}
                      <div className="text-inksoft font-sans">{c.cat}</div>
                    </td>
                    <td className="p-3 text-right font-mono whitespace-nowrap">
                      {c.g ? (
                        <>
                          {pln(num(c.g.price_pln))}
                          <div className="text-[11px] text-inksoft font-sans">{(c.g.vat || "").toUpperCase() === "V23" ? "V23 (netto)" : c.g.vat ? c.g.vat : "VAT?"}</div>
                        </>
                      ) : <span className="text-inksoft font-sans text-xs">brak w Towarze</span>}
                    </td>
                    <td className="p-3 text-right font-mono whitespace-nowrap">{c.input ? pln(c.input.extraPln) : "—"}</td>
                    <td className="p-3"><SugCell p={c.bm} info={listings.size ? (listings.get(normListingSku(r.sku))?.backmarket ?? null) : undefined} /></td>
                    <td className="p-3"><SugCell p={c.rf} info={listings.size ? (listings.get(normListingSku(r.sku))?.refurbed ?? null) : undefined} /></td>
                    <td className="p-3 whitespace-nowrap text-xs">
                      {c.input && <button onClick={() => setExpanded((p) => { const n = new Set(p); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} className="text-inksoft font-semibold mr-3" title="Pokaż wyliczenie">{open ? "▾ Wyliczenie" : "▸ Wyliczenie"}</button>}
                      <button onClick={() => remove(r)} className="text-rust font-semibold">Usuń</button>
                      {c.vatMissing && <div className="text-amber mt-1" title="W Towarze brak VAT (VM/V23) — liczone jak VM">brak VAT w Towarze</div>}
                    </td>
                  </tr>
                  {open && c.input && (
                    <tr className="border-b border-line bg-paper">
                      <td colSpan={8} className="p-4">
                        <div className="grid md:grid-cols-2 gap-6">
                          <Breakdown p={c.bm} title="Back Market" note={c.bmNote} input={c.input} />
                          <Breakdown p={c.rf} title="refurbed" note={c.rfNote} input={c.input} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {openSerial && <ProductCardDrawer serial={openSerial} members={members} onClose={() => setOpenSerial(null)} />}
    </div>
  );
}
