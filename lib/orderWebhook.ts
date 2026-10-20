// Powiadomienie o nowym zamówieniu na webhook (Make, 20.10.2026, na prośbę właściciela): "marketplace, sku, ilość i cena" — bez jakichkolwiek danych klienta.
// Tu tylko czysta logika (payload, wysyłka); wybór zamówień i dziennik wysłanych są w orderWebhookServer.ts. Adres webhooka jest sekretem: zmienna MAKE_ORDER_WEBHOOK_URL (nigdy w repozytorium).
export type WebhookItem = { sku: string | null; price: number | null; currency: string | null };
export type WebhookPayload = { marketplace: string; items: { sku: string | null; quantity: number; price: number | null; currency: string | null }[] };

const round2 = (n: number) => Math.round(n * 100) / 100;

// Pozycje zamówienia to "jedna sztuka = jeden wiersz" — grupujemy je po (sku, cena, waluta) do ilości; kolejność pierwszego wystąpienia zostaje.
export function buildWebhookPayload(marketplace: string, items: WebhookItem[]): WebhookPayload {
  const grouped = new Map<string, WebhookPayload["items"][number]>();
  for (const it of items) {
    const price = it.price === null || it.price === undefined || !Number.isFinite(Number(it.price)) ? null : round2(Number(it.price));
    const k = `${it.sku ?? ""}|${price ?? ""}|${it.currency ?? ""}`;
    const g = grouped.get(k);
    if (g) g.quantity += 1;
    else grouped.set(k, { sku: it.sku ?? null, quantity: 1, price, currency: it.currency ?? null });
  }
  return { marketplace, items: [...grouped.values()] };
}

// Wysyła JSON na webhook; sukces = odpowiedź 2xx. Błąd sieci/limit czasu/odpowiedź inna niż 2xx = { ok: false, error } (nie rzuca).
export async function sendWebhook(url: string, payload: WebhookPayload, fetchImpl: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000), cache: "no-store" });
    if (res.ok) return { ok: true };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
