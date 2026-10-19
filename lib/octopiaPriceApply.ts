import type { SupabaseClient } from "@supabase/supabase-js";
import { octopiaSetPrices, type OctopiaConfig } from "./octopia";

// Zmiana cen ofert Cdiscount z walidacją po stronie serwera (19.10.2026): wspólna dla ręcznej akcji (app/api/listings/octopia-price) i automatu (app/api/listings/octopia-auto).
// Cena musi mieścić się w naszych granicach min/max (listing_price_rules), tylko EUR, zmiana o ponad 50% wymaga force; każda próba (też nieudana) trafia do listing_price_log.
export type OctopiaPriceRequest = { externalId: string; price: number; reason?: string };
export type OctopiaPriceOutcome = { externalId: string; ok: boolean; message: string; applied?: number | null };
export type OctopiaApplyResult = { ok: boolean; okCount: number; failCount: number; packageId: string | null; packageState: string | null; results: OctopiaPriceOutcome[] };

export async function applyOctopiaPrices(db: SupabaseClient<any, any, any>, cfg: OctopiaConfig, who: string, raw: OctopiaPriceRequest[], opts: { force?: boolean } = {}): Promise<OctopiaApplyResult> {
  const ids = Array.from(new Set(raw.map((c) => String(c?.externalId || "").trim()).filter(Boolean)));
  const { data: listings, error: le } = await db.from("marketplace_listings").select("external_id, sku, price, currency").eq("marketplace", "octopia").in("external_id", ids);
  if (le) throw new Error(`Błąd odczytu ofert: ${le.message}`);
  const { data: rules } = await db.from("listing_price_rules").select("external_id, min_price, max_price").eq("marketplace", "octopia").in("external_id", ids);
  const byId = new Map((listings || []).map((l: any) => [l.external_id as string, l]));
  const ruleById = new Map((rules || []).map((r: any) => [r.external_id as string, r]));

  type Out = OctopiaPriceOutcome;
  const out = new Map<string, Out>();
  const toSend: { offerId: string; price: number; reason: string; old: number | null; sku: string | null }[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const externalId = String(c?.externalId || "").trim();
    const price = Math.round(Number(c?.price) * 100) / 100;
    const l: any = byId.get(externalId);
    const fail = (message: string) => out.set(externalId, { externalId, ok: false, message });
    if (!externalId) continue;
    if (seen.has(externalId)) { fail("Ta oferta jest w żądaniu dwa razy."); continue; }
    seen.add(externalId);
    if (!l) { fail("Tej oferty nie ma w naszej bazie (Listingi) — odśwież listingi."); continue; }
    if (String(l.currency || "EUR").toUpperCase() !== "EUR") { fail(`Waluta oferty (${l.currency}) nie jest obsługiwana — tylko EUR.`); continue; }
    if (!Number.isFinite(price) || price <= 0 || price > 100_000) { fail("Niepoprawna cena."); continue; }
    const rule: any = ruleById.get(externalId);
    const min = rule?.min_price === null || rule?.min_price === undefined ? null : Number(rule.min_price);
    const max = rule?.max_price === null || rule?.max_price === undefined ? null : Number(rule.max_price);
    if (min === null) { fail("Oferta nie ma ustawionej ceny minimalnej — ustaw ją najpierw."); continue; }
    if (price < min - 0.004) { fail(`Cena ${price} jest poniżej ceny minimalnej ${min}.`); continue; }
    if (max !== null && price > max + 0.004) { fail(`Cena ${price} jest powyżej ceny maksymalnej ${max}.`); continue; }
    const old = l.price === null || l.price === undefined ? null : Number(l.price);
    if (old !== null && old > 0 && Math.abs(price / old - 1) > 0.5 && opts.force !== true) { fail(`Zmiana ceny z ${old} na ${price} to ponad 50% — wygląda na pomyłkę (potwierdź ponownie, jeśli zamierzona).`); continue; }
    toSend.push({ offerId: externalId, price, reason: typeof c?.reason === "string" ? c.reason.slice(0, 500) : "", old, sku: l.sku ?? null });
  }

  let packageId: string | null = null;
  let packageState: string | null = null;
  if (toSend.length > 0) {
    try {
      const batch = await octopiaSetPrices(cfg, toSend.map((t) => ({ offerId: t.offerId, price: t.price })));
      packageId = batch.packageId;
      packageState = batch.packageState;
      for (const r of batch.results) out.set(r.offerId, { externalId: r.offerId, ok: r.ok, message: r.message, applied: r.verifiedPrice ?? null });
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 400);
      for (const t of toSend) out.set(t.offerId, { externalId: t.offerId, ok: false, message: msg });
    }
    for (const t of toSend) {
      const r = out.get(t.offerId)!;
      const entry = { by_email: who, marketplace: "octopia", external_id: t.offerId, sku: t.sku, old_price: t.old, new_price: t.price, currency: "EUR", reason: [t.reason, packageId ? `paczka ${packageId}` : ""].filter(Boolean).join(" · ").slice(0, 500) || null, ok: r.ok, error: r.ok ? null : r.message.slice(0, 500) };
      await db.from("listing_price_log").insert(entry);
      if (r.ok && packageState === "Integrated") await db.from("marketplace_listings").update({ price: r.applied && Math.abs(r.applied - t.price) < 0.01 ? r.applied : t.price }).eq("marketplace", "octopia").eq("external_id", t.offerId); // migawka i tak odświeża się co 30 min
    }
  }
  const results = raw.map((c) => out.get(String(c?.externalId || "").trim())).filter(Boolean) as Out[];
  const okCount = results.filter((r) => r.ok).length;
  return { ok: okCount > 0, okCount, failCount: results.length - okCount, packageId, packageState, results };
}
