// Nadawanie przesyłek przez WŁASNY system logistyczny Erli (nie InPost bezpośrednio — Erli zleca przesyłkę na
// swoim koncie/rozliczeniu przewoźnika). Dziś tylko Paczkomaty InPost 24/7 (typeId "erliPaczkomat" — pełna lista
// metod w słowniku GET /dictionaries/shippingMethods, nieużywana tu, bo używamy tylko tej jednej).
// Ta sama para ERLI_API_KEY/ERLI_UA co przy synchronizacji zamówień (lib/erli.ts) — ten sam host i schemat
// autoryzacji ("Marketplace API"), żadnych nowych zmiennych środowiskowych.
//
// Adres odbiorcy NIE jest potrzebny przy tworzeniu — pominięty, Erli bierze go z zamówienia (klient wybrał
// konkretny paczkomat przy składaniu zamówienia w Erli, patrz order.delivery.pickupPlace). Wymiary w milimetrach,
// waga w gramach (limity API: 1-2000 mm, 10-700000 g) — inne jednostki niż reszta Wysyłki (cm/kg), bo to bezpośrednio
// odzwierciedla ich schemat.
//
// Etykieta NIE wraca od razu w odpowiedzi tworzenia przesyłki — trzeba dopytać osobno (erliSearchParcel), tak samo
// jak przy DHL Parcel (getLabels po nieudanym pobraniu przy tworzeniu). Numer śledzenia też bywa dogrywany później.
//
// Dokumentacja: https://erli.pl/svc/shop-api/doc/swagger.json (sekcja "shipping").

import type { ErliClient } from "./erli";
import { ERLI_BASE_URL } from "./erli";

export function erliShipConfigFromEnv(): ErliClient | null {
  const apiKey = process.env.ERLI_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, userAgent: process.env.ERLI_UA?.trim() || "backmarket@recoo.io" };
}

export class ErliShipError extends Error {
  constructor(message: string, public errors?: { errorCode: number; errorMessage: string }[]) {
    super(message);
  }
}

export type ErliParcel = {
  id: number | null;
  status: string;
  trackingNumber: string | null;
  waybills: string[]; // linki do etykiety (PDF); puste, dopóki Erli jej nie wygeneruje
  pickupProtocol: string | null;
};

const parseParcel = (p: any): ErliParcel => ({
  id: typeof p?.id === "number" ? p.id : null,
  status: String(p?.status ?? "unknown"),
  trackingNumber: typeof p?.trackingNumber === "string" ? p.trackingNumber : null,
  waybills: Array.isArray(p?.shipping?.waybills) ? p.shipping.waybills.filter((w: unknown) => typeof w === "string") : [],
  pickupProtocol: typeof p?.shipping?.pickupProtocol === "string" ? p.shipping.pickupProtocol : null,
});

async function erliShipFetch(c: ErliClient, method: "POST" | "DELETE", path: string, body?: unknown): Promise<any> {
  const doFetch = c.fetchImpl ?? fetch;
  const res = await doFetch(`${c.baseUrl ?? ERLI_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.apiKey.trim().replace(/^Bearer\s+/i, "")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": c.userAgent,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(c.timeoutMs ?? 30_000),
  });
  const text = await res.text().catch(() => "");
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* odpowiedź nie jest JSON-em — zostaje surowy tekst niżej */
    }
  }
  if (!res.ok) {
    if (Array.isArray(data) && data[0]?.errorMessage) {
      throw new ErliShipError(`Erli zwróciło błąd: ${data.map((e: any) => `${e.errorCode} ${e.errorMessage}`).join("; ")}`, data);
    }
    throw new ErliShipError(`Erli zwróciło błąd (${res.status}): ${text.slice(0, 300)}`);
  }
  return data;
}

// POST /shipping/parcels/ — tworzy przesyłkę (tablica, bo API pozwala na wiele naraz — my zawsze wysyłamy jedną).
export async function erliCreateParcel(
  c: ErliClient,
  opts: { orderId: string; widthMm: number; heightMm: number; lengthMm: number; weightG: number; typeId?: string; additionalInformation?: string }
): Promise<ErliParcel> {
  const body = [
    {
      orderId: opts.orderId,
      dimensions: { width: opts.widthMm, height: opts.heightMm, length: opts.lengthMm, weight: opts.weightG },
      shipping: { typeId: opts.typeId ?? "erliPaczkomat", ...(opts.additionalInformation ? { additionalInformation: opts.additionalInformation } : {}) },
    },
  ];
  const data = await erliShipFetch(c, "POST", "/shipping/parcels/", body);
  const parcel = Array.isArray(data) ? data[0] : null;
  if (!parcel) throw new ErliShipError("Erli nie zwróciło danych przesyłki.");
  if (Array.isArray(parcel.errors) && parcel.errors.length > 0) {
    throw new ErliShipError(`Erli odrzuciło przesyłkę: ${parcel.errors.map((e: any) => `${e.errorCode} ${e.errorMessage}`).join("; ")}`, parcel.errors);
  }
  return parseParcel(parcel);
}

// POST /shipping/parcels/_search — dogania numer śledzenia i link do etykiety, gdy nie były gotowe od razu.
export async function erliSearchParcel(c: ErliClient, opts: { orderId: string }): Promise<ErliParcel | null> {
  const data = await erliShipFetch(c, "POST", "/shipping/parcels/_search", { filter: { field: "orderId", operator: "=", value: opts.orderId } });
  const list = Array.isArray(data) ? data : [];
  return list[0] ? parseParcel(list[0]) : null;
}

// DELETE /shipping/parcels/{id} — anulowanie, dopóki przesyłka nie została faktycznie nadana kurierowi/do sieci.
export async function erliCancelParcel(c: ErliClient, opts: { id: number }): Promise<void> {
  await erliShipFetch(c, "DELETE", `/shipping/parcels/${opts.id}`);
}
