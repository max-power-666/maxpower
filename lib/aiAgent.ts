// Pętla agenta dla zakładki AI (03.10.2026): pytanie po polsku -> model Claude układa zapytania SQL (narzędzie `run_sql`,
// TYLKO odczyt — patrz supabase/ai.sql) -> odpowiedź jako tekst/markdown. Czysta logika bez Next.js, z wstrzykiwanym
// `fetch` i `runSql`, żeby dało się ją testować na atrapie (bez klucza Anthropic i bez bazy).

export type AiChatMessage = { role: "user" | "assistant"; content: string };
export type AiQueryTrace = { sql: string; rows?: number; error?: string };
export type AiAgentResult = { text: string; queries: AiQueryTrace[]; usage: { input: number; output: number } };

type Block = { type: string; [k: string]: any };

export const RUN_SQL_TOOL = {
  name: "run_sql",
  description:
    "Wykonuje jedno zapytanie SQL (PostgreSQL) TYLKO DO ODCZYTU na widokach ai.orders, ai.order_items, ai.stock i ai.nbp_rates. " +
    "Dozwolone tylko SELECT lub WITH, jedna instrukcja, bez średników w środku; maksymalnie 500 wierszy i 15 s. " +
    "Zwraca tablicę JSON wierszy. Agreguj w SQL (sum/count/group by) zamiast pobierać surowe wiersze.",
  input_schema: {
    type: "object",
    properties: { sql: { type: "string", description: "Zapytanie SELECT/WITH." } },
    required: ["sql"],
  },
};

const MAX_RESULT_CHARS = 30000;

// Wynik narzędzia do modelu: JSON, ucięty, gdy za duży (model dostaje informację, że ucięto, i ma agregować).
export function formatToolResult(rows: unknown): string {
  const json = JSON.stringify(rows);
  if (json.length <= MAX_RESULT_CHARS) return json;
  const arr = Array.isArray(rows) ? rows : [];
  let kept = arr.length;
  let out = json;
  while (kept > 1 && out.length > MAX_RESULT_CHARS) {
    kept = Math.floor(kept / 2);
    out = JSON.stringify(arr.slice(0, kept));
  }
  return `${out}\n[UCIĘTO: pokazano ${kept} z ${arr.length} wierszy — zagreguj wynik w SQL albo zawęź zapytanie]`;
}

export async function runAiAgent(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: AiChatMessage[];
  runSql: (sql: string) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  maxSteps?: number;
  maxTokens?: number;
}): Promise<AiAgentResult> {
  const f = opts.fetchImpl ?? fetch;
  const maxSteps = opts.maxSteps ?? 12;
  const queries: AiQueryTrace[] = [];
  const usage = { input: 0, output: 0 };
  const convo: { role: "user" | "assistant"; content: string | Block[] }[] = opts.messages.map((m) => ({ role: m.role, content: m.content }));

  for (let step = 0; step < maxSteps; step++) {
    const res = await f("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        // Prompt systemowy (słownik danych) jest długi i taki sam przy każdym pytaniu — cache obniża koszt i czas.
        system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
        tools: [RUN_SQL_TOOL],
        messages: convo,
      }),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || `Błąd API Anthropic (${res.status}).`);
    usage.input += Number(data?.usage?.input_tokens) || 0;
    usage.output += Number(data?.usage?.output_tokens) || 0;

    const content: Block[] = Array.isArray(data?.content) ? data.content : [];
    const toolUses = content.filter((b) => b.type === "tool_use");
    if (data?.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").trim();
      return { text: text || "(Model nie zwrócił odpowiedzi.)", queries, usage };
    }

    convo.push({ role: "assistant", content });
    const results: Block[] = [];
    for (const tu of toolUses) {
      const sql = typeof tu.input?.sql === "string" ? tu.input.sql : "";
      try {
        if (tu.name !== "run_sql") throw new Error(`Nieznane narzędzie: ${tu.name}`);
        const rows = await opts.runSql(sql);
        queries.push({ sql, rows: Array.isArray(rows) ? rows.length : undefined });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: formatToolResult(rows) });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        queries.push({ sql, error: msg });
        // Błąd SQL wraca do modelu jako wynik narzędzia — zwykle poprawia zapytanie i próbuje ponownie.
        results.push({ type: "tool_result", tool_use_id: tu.id, content: `BŁĄD: ${msg}`, is_error: true });
      }
    }
    convo.push({ role: "user", content: results });
  }
  return { text: "Przerwano: przekroczono limit kroków analizy. Zawęź pytanie albo zadaj je w mniejszych częściach.", queries, usage };
}
