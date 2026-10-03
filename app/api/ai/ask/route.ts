import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/serverAuth";
import { runAiAgent, type AiChatMessage } from "@/lib/aiAgent";
import { buildAiSystemPrompt } from "@/lib/aiSchema";
import { aiCostUsd } from "@/lib/aiPricing";

// Asystent AI (zakładka "AI", 03.10.2026) — TYLKO Admin (na tym etapie, decyzja właściciela). Pytanie po polsku -> Claude
// układa zapytania SQL tylko do odczytu (supabase/ai.sql: widoki ai.*, rola ai_reader, funkcja ai_query) -> odpowiedź.
// Cała rozmowa idzie w body (serwer nie trzyma stanu); każde pytanie jest zapisywane w ai_log (kto, o co, jakie zapytania,
// tokeny) — audyt i kontrola kosztów. Klucz Anthropic tylko w env (ANTHROPIC_API_KEY), nigdy w przeglądarce.

export const maxDuration = 300;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const MAX_MESSAGES = 30;
const MAX_CHARS = 6000;

export async function POST(request: Request) {
  const db = admin();
  const uid = await requireRole(request, db, ["Admin"]);
  if (!uid) return NextResponse.json({ error: "Asystent AI jest dostępny tylko dla Admina." }, { status: 403 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Brak klucza ANTHROPIC_API_KEY w zmiennych środowiskowych (Vercel) — dodaj go i wykonaj nowy deploy." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const raw = Array.isArray(body?.messages) ? body.messages : [];
  const messages: AiChatMessage[] = raw
    .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, MAX_CHARS) }));
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "Brak pytania." }, { status: 400 });
  }
  const question = messages[messages.length - 1].content;
  const model = process.env.AI_MODEL || "claude-sonnet-5-5";
  const email = (await db.auth.admin.getUserById(uid)).data.user?.email ?? null;

  try {
    const result = await runAiAgent({
      apiKey,
      model,
      system: buildAiSystemPrompt(),
      messages,
      runSql: async (sql) => {
        const { data, error } = await db.rpc("ai_query", { q: sql });
        if (error) throw new Error(error.message);
        return data;
      },
    });
    const costUsd = aiCostUsd(model, result.usage);
    await db.from("ai_log").insert({
      user_email: email,
      question,
      answer: result.text,
      queries: result.queries,
      model,
      input_tokens: result.usage.input,
      output_tokens: result.usage.output,
      cache_write_tokens: result.usage.cacheWrite,
      cache_read_tokens: result.usage.cacheRead,
      cost_usd: costUsd,
    });
    return NextResponse.json({ ok: true, answer: result.text, queries: result.queries, usage: result.usage, costUsd, model });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await db.from("ai_log").insert({ user_email: email, question, model, error: msg });
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
