"use client";

import { Fragment, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isEconomySelect, type DhlMoney, type DhlProduct } from "@/lib/dhlExpress";

// Zakładka Wysyłka. Na razie: sprawdzenie połączenia z DHL Express (MyDHL API) — pokazuje, jakie produkty (w tym Economy Select)
// są dostępne na naszym koncie dla wybranej trasy oraz ICH WYCENĘ wg cennika konta. Niczego nie nadaje i nic nie kosztuje. Tworzenie przesyłek i etykiet dojdzie
// po potwierdzeniu, że produkt i trasa działają. Klucze i numer konta są tylko na serwerze (route /api/shipping/dhl-express/check).

// Kraje docelowe do wyboru (UE + kilka popularnych poza nią). Poza UE przesyłka wymaga odprawy celnej.
const EU = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];
const NON_EU = ["GB", "CH", "NO", "US", "UA", "TR"];
const COUNTRY_NAME: Record<string, string> = {
  AT: "Austria", BE: "Belgia", BG: "Bułgaria", HR: "Chorwacja", CY: "Cypr", CZ: "Czechy", DK: "Dania", EE: "Estonia", FI: "Finlandia",
  FR: "Francja", DE: "Niemcy", GR: "Grecja", HU: "Węgry", IE: "Irlandia", IT: "Włochy", LV: "Łotwa", LT: "Litwa", LU: "Luksemburg",
  MT: "Malta", NL: "Holandia", PL: "Polska", PT: "Portugalia", RO: "Rumunia", SK: "Słowacja", SI: "Słowenia", ES: "Hiszpania", SE: "Szwecja",
  GB: "Wielka Brytania", CH: "Szwajcaria", NO: "Norwegia", US: "USA", UA: "Ukraina", TR: "Turcja",
};

const fmtMoney = (m: DhlMoney | null) =>
  m ? `${m.price.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${m.currency}` : "—";

const inputCls = "w-full border border-line bg-white px-2 py-2 rounded text-sm";
const STORAGE_KEY = "dhl-check-origin";

function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function ShippingView({ session }: { session: Session }) {
  const auth = { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
  const [status, setStatus] = useState<{ configured: boolean; env: string | null } | null>(null);
  const [origin, setOrigin] = useState({ city: "", postal: "" });
  const [form, setForm] = useState({ country: "DE", city: "", postal: "", weight: "5", length: "40", width: "30", height: "20" });
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ env: string; products: DhlProduct[]; warnings: string[]; country: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/shipping/dhl-express/check", { headers: auth })
      .then((r) => r.json())
      .then((d) => setStatus({ configured: !!d.configured, env: d.env ?? null }))
      .catch(() => setStatus(null));
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved?.city) setOrigin(saved);
    } catch {
      /* brak zapamiętanych danych — zostają puste pola */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function check() {
    setError("");
    setResult(null);
    setExpanded(null);
    setChecking(true);
    try {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(origin));
      } catch {
        /* zapamiętywanie jest tylko wygodą */
      }
      const res = await fetch("/api/shipping/dhl-express/check", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          originCityName: origin.city,
          originPostalCode: origin.postal,
          destinationCountryCode: form.country,
          destinationCityName: form.city,
          destinationPostalCode: form.postal,
          weight: Number(form.weight.replace(",", ".")),
          length: Number(form.length.replace(",", ".")),
          width: Number(form.width.replace(",", ".")),
          height: Number(form.height.replace(",", ".")),
          isCustomsDeclarable: !EU.includes(form.country),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Nie udało się sprawdzić połączenia.");
      setResult({ env: data.env, products: data.products, warnings: data.warnings || [], country: form.country });
    } catch (e: any) {
      setError(e.message || "Nie udało się sprawdzić połączenia.");
    } finally {
      setChecking(false);
    }
  }

  const economy = result?.products.filter(isEconomySelect) ?? [];

  return (
    <div>
      <div className="border border-line bg-white p-4 mb-6">
        <h2 className="text-xs font-semibold text-inksoft mb-2">DHL EXPRESS — SPRAWDZENIE POŁĄCZENIA</h2>
        {status === null && <p className="text-xs text-inksoft">Sprawdzanie konfiguracji…</p>}
        {status && !status.configured && (
          <p className="text-xs text-rust">
            DHL Express nie jest skonfigurowany. Ustaw w zmiennych środowiskowych (Vercel): DHL_EXPRESS_API_KEY, DHL_EXPRESS_API_SECRET,
            DHL_EXPRESS_ACCOUNT (numer konta nadawcy) i DHL_EXPRESS_ENV (test albo production), potem zrób Redeploy.
          </p>
        )}
        {status?.configured && (
          <p className="text-xs text-inksoft">
            Połączenie skonfigurowane, środowisko: <span className={`font-semibold ${status.env === "production" ? "text-rust" : "text-teal"}`}>{status.env === "production" ? "PRODUKCYJNE" : "testowe"}</span>.
            To sprawdzenie tylko odczytuje dostępne produkty — nic nie nadaje i nic nie kosztuje.
          </p>
        )}
      </div>

      {status?.configured && (
        <div className="border border-line bg-white p-4 mb-6">
          <h2 className="text-xs font-semibold text-inksoft mb-3">TRASA I PACZKA</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <div>
              <label className="text-xs font-semibold text-inksoft block mb-1">Miasto nadania (Polska) *</label>
              <input value={origin.city} onChange={(e) => setOrigin({ ...origin, city: e.target.value })} placeholder="np. Warszawa" className={inputCls} />
            </div>
            <div>
              <label className="text-xs font-semibold text-inksoft block mb-1">Kod pocztowy nadania</label>
              <input value={origin.postal} onChange={(e) => setOrigin({ ...origin, postal: e.target.value })} placeholder="00-001" className={inputCls} />
            </div>
            <div>
              <label className="text-xs font-semibold text-inksoft block mb-1">Kraj docelowy *</label>
              <select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} className={inputCls}>
                <optgroup label="Unia Europejska">
                  {EU.filter((c) => c !== "PL").map((c) => <option key={c} value={c}>{COUNTRY_NAME[c]} ({c})</option>)}
                </optgroup>
                <optgroup label="Poza UE (odprawa celna)">
                  {NON_EU.map((c) => <option key={c} value={c}>{COUNTRY_NAME[c]} ({c})</option>)}
                </optgroup>
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-inksoft block mb-1">Miasto docelowe *</label>
              <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="np. Berlin" className={inputCls} />
            </div>
            <div>
              <label className="text-xs font-semibold text-inksoft block mb-1">Kod pocztowy docelowy</label>
              <input value={form.postal} onChange={(e) => setForm({ ...form, postal: e.target.value })} placeholder="10115" className={inputCls} />
            </div>
            <div>
              <label className="text-xs font-semibold text-inksoft block mb-1">Waga (kg) *</label>
              <input value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} inputMode="decimal" className={inputCls} />
            </div>
            <div>
              <label className="text-xs font-semibold text-inksoft block mb-1">Wymiary cm (dł. × szer. × wys.) *</label>
              <div className="flex gap-1">
                <input value={form.length} onChange={(e) => setForm({ ...form, length: e.target.value })} inputMode="decimal" className={inputCls} />
                <input value={form.width} onChange={(e) => setForm({ ...form, width: e.target.value })} inputMode="decimal" className={inputCls} />
                <input value={form.height} onChange={(e) => setForm({ ...form, height: e.target.value })} inputMode="decimal" className={inputCls} />
              </div>
            </div>
          </div>
          <button onClick={check} disabled={checking} className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold disabled:opacity-50">
            {checking ? "Pytanie DHL…" : "Sprawdź dostępne produkty"}
          </button>
          {error && <p className="text-rust text-xs mt-3">{error}</p>}
        </div>
      )}

      {result && (
        <div>
          <div className={`border p-3 mb-3 text-sm ${economy.length > 0 ? "border-teal bg-tealsoft text-teal" : "border-rust bg-rustsoft text-rust"} font-semibold`}>
            {economy.length > 0
              ? `Economy Select jest dostępny na trasie PL → ${result.country} (kod ${economy.map((p) => p.code).join(", ")}): ${economy
                  .map((p) => [fmtMoney(p.billing), p.local && p.billing?.currency !== p.local.currency ? `≈ ${fmtMoney(p.local)}` : null, p.transitDays !== null ? `${p.transitDays} dni` : null].filter(Boolean).join(" · "))
                  .join("; ")}.`
              : `Economy Select NIE jest dostępny na trasie PL → ${result.country} na tym koncie (albo dla tych parametrów paczki).`}
          </div>
          <div className="border border-line bg-white overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-inksoft border-b border-line">
                  <th className="p-3">Kod</th>
                  <th className="p-3">Produkt</th>
                  <th className="p-3">Typ sieci</th>
                  <th className="p-3">Tylko w umowie</th>
                  <th className="p-3 text-right">Cena</th>
                  <th className="p-3 text-right">Cena (PLN)</th>
                  <th className="p-3 text-right">Waga taryfowa</th>
                  <th className="p-3 text-right">Dni w drodze</th>
                  <th className="p-3">Szacowana dostawa</th>
                  <th className="p-3">Odbiór do godz.</th>
                </tr>
              </thead>
              <tbody>
                {result.products.length === 0 && (
                  <tr><td colSpan={10} className="p-6 text-center text-inksoft text-sm">DHL nie zwrócił żadnych produktów dla tej trasy.</td></tr>
                )}
                {result.products.map((p) => (
                  <Fragment key={p.code + p.name}>
                    <tr className={`border-b border-line last:border-b-0 ${isEconomySelect(p) ? "bg-tealsoft font-semibold" : ""}`}>
                      <td className="p-3 font-mono">{p.code}</td>
                      <td className="p-3">
                        {p.name}
                        {p.breakdown.length > 0 && (
                          <button onClick={() => setExpanded(expanded === p.code ? null : p.code)} className="ml-2 text-xs font-semibold text-teal hover:underline">
                            {expanded === p.code ? "ukryj składniki" : "składniki ceny"}
                          </button>
                        )}
                      </td>
                      <td className="p-3">{p.networkType || "—"}</td>
                      <td className="p-3">{p.customerAgreement ? "tak" : "nie"}</td>
                      <td className="p-3 text-right font-mono whitespace-nowrap">{fmtMoney(p.billing)}</td>
                      <td className="p-3 text-right font-mono whitespace-nowrap">{fmtMoney(p.local)}</td>
                      <td className="p-3 text-right font-mono whitespace-nowrap" title={p.volumetricWeight !== null ? `waga objętościowa: ${p.volumetricWeight} kg` : undefined}>
                        {p.chargeableWeight !== null ? `${p.chargeableWeight} kg` : "—"}
                      </td>
                      <td className="p-3 text-right font-mono">{p.transitDays ?? "—"}</td>
                      <td className="p-3 text-xs whitespace-nowrap">{fmtDateTime(p.estimatedDelivery)}</td>
                      <td className="p-3 text-xs whitespace-nowrap">{fmtDateTime(p.pickupCutoff)}</td>
                    </tr>
                    {expanded === p.code && (
                      <tr className="border-b border-line bg-paper">
                        <td colSpan={10} className="p-3 text-xs">
                          <div className="font-semibold text-inksoft mb-1">Składniki ceny ({p.billing?.currency ?? "waluta rozliczeniowa"})</div>
                          <ul className="space-y-0.5">
                            {p.breakdown.map((b, i) => (
                              <li key={i} className="flex justify-between max-w-md">
                                <span>{b.name}</span>
                                <span className="font-mono">{b.price.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {result.warnings.length > 0 && <p className="text-xs text-inksoft mt-2">Ostrzeżenia DHL: {result.warnings.join("; ")}</p>}
          <p className="text-xs text-inksoft mt-2">
            Środowisko: {result.env === "production" ? "produkcyjne" : "testowe"}. Wynik dotyczy jednej paczki o podanych parametrach. Cena to wycena wg cennika konta —
            nie jest to zobowiązanie, a ostateczną kwotę (opłaty dodatkowe, podatek VAT) potwierdza faktura DHL.
            {result.env !== "production" && " Środowisko testowe może zwracać inne stawki niż produkcyjne — porównaj po przełączeniu na produkcję (wycena niczego nie tworzy i nie kosztuje)."}
          </p>
        </div>
      )}
    </div>
  );
}
