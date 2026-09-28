// Skutki uboczne udanego nadania przesyłki DHL dla zamówienia z Zamówień: (1) notifyMarketplace zgłasza numer
// przesyłki z powrotem do marketplace'u, z którego pochodzi zamówienie — dziś Back Market i refurbed, jedyne dwa
// kanały, z których karta zamówienia daje przycisk "Nadaj przesyłkę DHL" (patrz buildShipPrefill w lib/shipping.ts;
// inne marketplace'y — Erli, Allegro, Octopia, Apilo, Amazon — na razie nie mają tego przycisku, więc nic tu dla
// nich nie robimy); (2) markOurStatusShipped przestawia nasz wewnętrzny "Nasz status" na "Wysłane", niezależnie
// od marketplace'u i niezależnie od wyniku (1) — to dwa całkiem osobne skutki tego samego zdarzenia.
//
// Razem z numerem przesyłki zgłaszamy też IMEI/numer seryjny pozycji, gdy zespół go już wpisał w Zamówieniach
// (sales_order_items.serial_number) — oba marketplace'y wymagają tego dla smartfonów (od 1.01.2022 u Back Marketu,
// podobnie u refurbed), pod karą finansową za brak. Pole w naszej bazie jest jedno ("Numer seryjny" — może być
// zarówno numerem seryjnym, jak i IMEI, zależnie od produktu), więc rozpoznajemy typ automatycznie: IMEI ma zawsze
// dokładnie 15 cyfr, każda inna wartość idzie jako zwykły numer seryjny.
//
// WAŻNE: to wywołanie nigdy nie cofa ani nie failuje utworzenia przesyłki — w tym momencie przesyłka w DHL już
// istnieje i jest płatna. Błąd zgłoszenia do marketplace'u zapisujemy w shipments.marketplace_sync_error (UI
// pokazuje ostrzeżenie z możliwością ponowienia, route /api/shipping/sync-marketplace), zamiast go przepuszczać
// dalej i tracić informację o już nadanej przesyłce.

import type { SupabaseClient } from "@supabase/supabase-js";
import { bmShipConfigFromEnv, bmMarkOrderShipped, bmSetOrderlineIdentifier, BM_SHIPPER_BY_CARRIER } from "./backmarket";
import { refurbedListCarriers, refurbedMarkItemsShipped } from "./refurbed";
import { OUR_STATUSES } from "./salesOrders";

export type ShipmentCarrier = "dhl_express" | "dhl_parcel";

// Przestawia "Nasz status" (sales_orders.our_status) na "Wysłane", gdy przesyłka DHL powstała bez błędu — niezależnie
// od marketplace'u (to nasze własne, wewnętrzne pole, nie wymaga żadnego API kanału) i niezależnie od tego, czy
// zgłoszenie numeru do marketplace'u (notifyMarketplace) się udało — to dwa oddzielne, niezależne skutki nadania.
// Nie failuje twardo: przesyłka i tak już powstała, a "Nasz status" da się poprawić ręcznie z listy Zamówień.
export async function markOurStatusShipped(
  db: SupabaseClient<any, any, any>,
  opts: { marketplace: string | null; externalId: string | null; byEmail: string | null }
): Promise<{ ok: boolean; error: string | null }> {
  if (!opts.marketplace || !opts.externalId) return { ok: true, error: null }; // przesyłka nie powiązana z zamówieniem — nic do zrobienia
  try {
    const { data: cur, error: curErr } = await db
      .from("sales_orders")
      .select("our_status")
      .eq("marketplace", opts.marketplace)
      .eq("external_id", opts.externalId)
      .maybeSingle();
    if (curErr) return { ok: false, error: `Nie udało się odczytać zamówienia: ${curErr.message}` };
    if (!cur) return { ok: true, error: null }; // zamówienie spoza Zamówień — nic do zrobienia
    if (cur.our_status === "wyslane") return { ok: true, error: null }; // już ustawione (np. ponowne nadanie po błędzie)

    const fromLabel = OUR_STATUSES.find((s) => s.key === cur.our_status)?.label ?? cur.our_status;
    const entry = {
      action: "edited",
      by_email: opts.byEmail,
      at: new Date().toISOString(),
      changes: [{ field: "Nasz status", from: fromLabel, to: "Wysłane" }],
    };
    const { error: rpcErr } = await db.rpc("sales_order_set_status", {
      p_marketplace: opts.marketplace,
      p_external_id: opts.externalId,
      p_status: "wyslane",
      p_entry: entry,
    });
    if (rpcErr) return { ok: false, error: `Nie udało się ustawić "Nasz status" na Wysłane: ${rpcErr.message}` };
    return { ok: true, error: null };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Nie udało się ustawić statusu zamówienia." };
  }
}

// IMEI ma zawsze dokładnie 15 cyfr (norma GSMA) — inaczej traktujemy wartość jako zwykły numer seryjny. Puste/białe
// znaki -> brak identyfikatora (nic do zgłoszenia, nie błąd).
export function classifyIdentifier(raw: string | null | undefined): { imei: string | null; serialNumber: string | null } {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return { imei: null, serialNumber: null };
  return /^\d{15}$/.test(v) ? { imei: v, serialNumber: null } : { imei: null, serialNumber: v };
}

export async function notifyMarketplace(
  db: SupabaseClient<any, any, any>,
  opts: { marketplace: string | null; externalId: string | null; carrier: ShipmentCarrier; trackingNumber: string; trackingUrl: string }
): Promise<{ synced: boolean; error: string | null }> {
  if (!opts.marketplace || !opts.externalId) return { synced: false, error: null }; // przesyłka nie powiązana z zamówieniem — nic do zgłoszenia

  try {
    if (opts.marketplace === "backmarket") {
      const cfg = bmShipConfigFromEnv();
      if (!cfg) return { synced: false, error: "Brak konfiguracji Back Market (BACKMARKET_AUTH) — zgłoś numer przesyłki ręcznie w panelu Back Market." };

      // Numer seryjny/IMEI dołączamy tylko dla pozycji, których PRAWDZIWA pozycja u Back Marketu miała ilość = 1
      // (Back Market nie obsługuje IMEI dla pozycji z ilością > 1 — to twarde ograniczenie ich API, nie nasze).
      // U nas taka pozycja rozbija się na kilka wierszy z kluczami "id", "id-2", "id-3"... — więcej niż jeden wiersz
      // o tym samym bazowym id = oryginalna ilość była > 1, więc żaden z nich się nie kwalifikuje.
      let items: { item_key: string; serial_number: string | null }[] = [];
      try {
        const { data, error } = await db.from("sales_order_items").select("item_key, serial_number").eq("marketplace", "backmarket").eq("external_id", opts.externalId);
        if (error) throw error;
        items = data ?? [];
      } catch {
        // best-effort — brak odczytu pozycji nie blokuje zgłoszenia numeru przesyłki, tylko IMEI/numeru seryjnego
      }
      const baseKeyCount = new Map<string, number>();
      for (const it of items) {
        const base = it.item_key.replace(/-\d+$/, "");
        baseKeyCount.set(base, (baseKeyCount.get(base) ?? 0) + 1);
      }
      const eligible = items
        .filter((it) => (baseKeyCount.get(it.item_key.replace(/-\d+$/, "")) ?? 0) === 1)
        .map((it) => ({ orderlineId: it.item_key, ...classifyIdentifier(it.serial_number) }))
        .filter((it) => it.imei || it.serialNumber);

      // Jedna pozycja w zamówieniu -> dokładamy identyfikator do tego samego zapytania, które zgłasza przesyłkę
      // (bez sku trafiłby do tej jedynej pozycji jednoznacznie). Więcej pozycji -> osobne zapytanie na pozycję.
      const bundled = items.length === 1 ? eligible[0] : undefined;
      await bmMarkOrderShipped(cfg, {
        orderId: opts.externalId,
        trackingNumber: opts.trackingNumber,
        trackingUrl: opts.trackingUrl,
        shipper: BM_SHIPPER_BY_CARRIER[opts.carrier],
        imei: bundled?.imei,
        serialNumber: bundled?.serialNumber,
      });

      const idFailed: string[] = [];
      if (items.length > 1) {
        for (const it of eligible) {
          try {
            await bmSetOrderlineIdentifier(cfg, it);
          } catch (e: any) {
            idFailed.push(`${it.orderlineId}: ${e?.message || "błąd"}`);
          }
        }
      }
      if (idFailed.length > 0) return { synced: true, error: `Numer przesyłki zgłoszony, ale nie numer seryjny/IMEI części pozycji (${idFailed.join("; ")}).` };
      return { synced: true, error: null };
    }

    if (opts.marketplace === "refurbed") {
      const token = process.env.REFURBED_API_TOKEN;
      if (!token) return { synced: false, error: "Brak konfiguracji refurbed (REFURBED_API_TOKEN) — zgłoś numer przesyłki ręcznie w panelu refurbed." };
      const client = { token, userAgent: process.env.REFURBED_UA || "backmarket@recoo.io" };

      // refurbed oznacza jako wysłane POZYCJE zamówienia, nie samo zamówienie — potrzebujemy ich id i numeru
      // seryjnego z naszej bazy. Każda pozycja refurbed to zawsze jedna fizyczna sztuka (mapRefurbedItems nie
      // rozbija ilości > 1), więc — inaczej niż w Back Markecie — kwalifikują się wszystkie.
      const { data: rows, error: itemsErr } = await db
        .from("sales_order_items")
        .select("item_key, serial_number")
        .eq("marketplace", "refurbed")
        .eq("external_id", opts.externalId);
      if (itemsErr) return { synced: false, error: `Nie udało się odczytać pozycji zamówienia: ${itemsErr.message}` };
      const items = (rows ?? []).map((i: any) => ({ id: String(i.item_key), ...classifyIdentifier(i.serial_number) }));
      if (items.length === 0) return { synced: false, error: "Brak pozycji tego zamówienia w bazie — zgłoś numer przesyłki ręcznie w panelu refurbed." };

      // Nazwa przewoźnika jest tylko kosmetyczna (ładniejszy widok dla klienta) — brak dopasowania nie blokuje zgłoszenia.
      let carrierSlug: string | null = null;
      try {
        const carriers = await refurbedListCarriers(client);
        carrierSlug =
          (opts.carrier === "dhl_express" ? carriers.find((c) => /dhl/i.test(c.name) && /express/i.test(c.name))?.slug : undefined) ??
          carriers.find((c) => /dhl/i.test(c.name))?.slug ??
          null;
      } catch {
        // best-effort — parcel_tracking_url (wymagany) i tak zostanie ustawiony
      }

      const result = await refurbedMarkItemsShipped(client, { items, trackingUrl: opts.trackingUrl, carrierSlug, trackingNumber: opts.trackingNumber });
      if (!result.ok) return { synced: false, error: `Część pozycji nie została zgłoszona (${result.failed.map((f) => `${f.id}: ${f.message}`).join("; ")}).` };
      return { synced: true, error: null };
    }

    return { synced: false, error: null }; // inny marketplace — przycisk "Nadaj przesyłkę DHL" go dziś nie obsługuje
  } catch (e: any) {
    return { synced: false, error: e?.message || "Nie udało się zgłosić numeru przesyłki do marketplace'u." };
  }
}
