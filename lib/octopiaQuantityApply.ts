import type { SupabaseClient } from "@supabase/supabase-js";
import { octopiaSetQuantities, type OctopiaConfig } from "./octopia";

// Zmiana ilości ofert Cdiscount z walidacją po stronie serwera (23.10.2026, Listingi -> Cdiscount): ilość całkowita 0–9999, oferta musi być w naszej bazie, każda próba (też nieudana) trafia do listing_stock_log.
export type OctopiaQuantityRequest = { externalId: string; quantity: number };
export type OctopiaQuantityOutcome = { externalId: string; ok: boolean; message: string; applied?: number | null };
export type OctopiaQuantityApplyResult = { ok: boolean; okCount: number; failCount: number; packageId: string | null; packageState: string | null; results: OctopiaQuantityOutcome[] };

export async function applyOctopiaQuantities(db: SupabaseClient<any, any, any>, cfg: OctopiaConfig, who: string, raw: OctopiaQuantityRequest[]): Promise<OctopiaQuantityApplyResult> {
  const ids = Array.from(new Set(raw.map((c) => String(c?.externalId || "").trim()).filter(Boolean)));
  const { data: listings, error: le } = await db.from("marketplace_listings").select("external_id, sku, quantity").eq("marketplace", "octopia").in("external_id", ids);
  if (le) throw new Error(`Błąd odczytu ofert: ${le.message}`);
  const byId = new Map((listings || []).map((l: any) => [l.external_id as string, l]));

  const out = new Map<string, OctopiaQuantityOutcome>();
  const toSend: { offerId: string; quantity: number; old: number | null; sku: string | null }[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const externalId = String(c?.externalId || "").trim();
    if (!externalId) continue;
    const fail = (message: string) => out.set(externalId, { externalId, ok: false, message });
    if (seen.has(externalId)) { fail("Ta oferta jest w żądaniu dwa razy."); continue; }
    seen.add(externalId);
    const l: any = byId.get(externalId);
    const q = Number(c?.quantity);
    if (!l) { fail("Tej oferty nie ma w naszej bazie (Listingi) — odśwież listingi."); continue; }
    if (!Number.isInteger(q) || q < 0 || q > 9999) { fail("Ilość musi być liczbą całkowitą od 0 do 9999."); continue; }
    const old = l.quantity === null || l.quantity === undefined ? null : Number(l.quantity);
    if (old === q) { fail("Ilość w ofercie już wynosi tyle."); continue; }
    toSend.push({ offerId: externalId, quantity: q, old, sku: l.sku ?? null });
  }

  let packageId: string | null = null;
  let packageState: string | null = null;
  if (toSend.length > 0) {
    try {
      const batch = await octopiaSetQuantities(cfg, toSend.map((t) => ({ offerId: t.offerId, quantity: t.quantity })));
      packageId = batch.packageId;
      packageState = batch.packageState;
      for (const r of batch.results) out.set(r.offerId, { externalId: r.offerId, ok: r.ok, message: r.message, applied: r.verifiedQuantity ?? null });
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 400);
      for (const t of toSend) out.set(t.offerId, { externalId: t.offerId, ok: false, message: msg });
    }
    for (const t of toSend) {
      const r = out.get(t.offerId)!;
      await db.from("listing_stock_log").insert({ source: "manual", by_email: who, marketplace: "octopia", external_id: t.offerId, sku: t.sku, old_quantity: t.old, new_quantity: t.quantity, reason: [packageId ? `paczka ${packageId}` : "", "ręczna zmiana ilości (Listingi → Cdiscount)"].filter(Boolean).join(" · "), ok: r.ok, error: r.ok ? null : r.message });
      if (r.ok && packageState === "Integrated") await db.from("marketplace_listings").update({ quantity: r.applied !== null && r.applied !== undefined ? r.applied : t.quantity }).eq("marketplace", "octopia").eq("external_id", t.offerId);
    }
  }
  const results = raw.map((c) => out.get(String(c?.externalId || "").trim())).filter(Boolean) as OctopiaQuantityOutcome[];
  const okCount = results.filter((r) => r.ok).length;
  return { ok: okCount > 0, okCount, failCount: results.length - okCount, packageId, packageState, results };
}
