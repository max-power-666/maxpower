// Cennik API Claude (USD za milion tokenów) do licznika kosztów w zakładce AI — wg strony cennika Anthropic
// (platform.claude.com/docs/en/about-claude/pricing) z 03.10.2026. Ceny się zmieniają — przy zmianie modelu
// (`AI_MODEL`) albo cennika zaktualizuj tabelę niżej; dla modelu spoza tabeli licznik pokazuje tokeny bez kwoty (nie zgaduje).
// To SZACUNEK po stronie aplikacji: faktyczne rozliczenie jest w konsoli Anthropic (console.anthropic.com).

export type AiUsage = { input: number; output: number; cacheWrite: number; cacheRead: number };

type Price = { input: number; output: number; cacheWrite: number; cacheRead: number };

const P = (input: number, output: number, cacheWrite: number, cacheRead: number): Price => ({ input, output, cacheWrite, cacheRead });

// cacheWrite = zapis do cache 5-minutowego (używamy cache_control: ephemeral, domyślnie 5 min).
export const AI_PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": P(2, 10, 2.5, 0.2),
  "claude-sonnet-5": P(2, 10, 2.5, 0.2),
  "claude-opus-5-5": P(4, 20, 5, 0.2),
  "claude-opus-5": P(5, 25, 6.25, 0.5),
  "claude-fable-5-1": P(10, 50, 12.5, 0.25),
  "claude-fable-5": P(10, 50, 12.5, 1),
  "claude-haiku-4-5": P(1, 5, 1.25, 0.1),
  "claude-haiku-4-5-20251001": P(1, 5, 1.25, 0.1),
};

// Koszt w USD albo null, gdy nie znamy cennika modelu.
export function aiCostUsd(model: string, u: AiUsage): number | null {
  const p = AI_PRICES[model];
  if (!p) return null;
  return (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1_000_000;
}

export function fmtUsd(n: number): string {
  // przy groszowych kwotach potrzeba więcej miejsc po przecinku, inaczej wszystko wyglądałoby jak $0,00
  return "$" + n.toLocaleString("pl-PL", { minimumFractionDigits: n < 1 ? 4 : 2, maximumFractionDigits: n < 1 ? 4 : 2 });
}
