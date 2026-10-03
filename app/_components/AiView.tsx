"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { fmtUsd } from "@/lib/aiPricing";
import Markdown from "./Markdown";

// Asystent AI (03.10.2026, tylko Admin): okno, w którym wpisujesz polecenie po polsku (np. "wygeneruj raport sprzedaży za
// poprzedni miesiąc"); serwer (app/api/ai/ask) daje modelowi dostęp tylko do odczytu wybranych widoków (supabase/ai.sql).
// Rozmowy zapisuje serwer (ai_conversations — historia po lewej, każdy Admin widzi tylko własne); dodatkowo każde pytanie
// trafia do ai_log (audyt kosztów).

type Trace = { sql: string; rows?: number; error?: string };
type ConversationRow = { id: string; title: string; updated_at: string; cost_usd: number | string };
type Usage = { input: number; output: number; cacheWrite?: number; cacheRead?: number };
type Msg = { role: "user" | "assistant"; content: string; queries?: Trace[]; usage?: Usage; costUsd?: number | null; model?: string };

const EXAMPLES = [
  "Na podstawie dostępnych danych wygeneruj raport sprzedaży za poprzedni miesiąc.",
  "Sprzedaż w ostatnich 30 dniach wg kanału i kraju — wartość w PLN i liczba zamówień.",
  "Które 10 SKU sprzedało się najlepiej w tym miesiącu?",
  "Wartość magazynu wg kategorii z SKU oraz ile sztuk nie ma SKU.",
  "Ile zamówień czeka na wysyłkę i które mają najbliższy termin?",
];

export default function AiView({ session }: { session: Session }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  // Historia rozmów: lista po lewej + otwarta rozmowa (null = nowa, jeszcze niezapisana).
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Licznik kosztów (szacunek wg cennika z lib/aiPricing.ts; faktyczne rozliczenie jest w konsoli Anthropic): suma tej
  // rozmowy + suma z dziennika ai_log od początku bieżącego miesiąca (odczyt ai_log ma tylko Admin — RLS).
  const [monthly, setMonthly] = useState<{ usd: number; questions: number } | null>(null);
  const conversationUsd = messages.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);

  async function loadMonthly() {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    let usd = 0;
    let questions = 0;
    for (let from = 0; ; from += 1000) {
      const { data, error: err } = await supabase.from("ai_log").select("cost_usd").gte("at", start.toISOString()).is("error", null).range(from, from + 999);
      if (err) return; // brak kolumny (nie uruchomiono ai.sql) itp. — po prostu bez sumy miesięcznej
      for (const r of (data as { cost_usd: number | string | null }[]) || []) {
        usd += Number(r.cost_usd) || 0;
        questions += 1;
      }
      if (!data || data.length < 1000) break;
    }
    setMonthly({ usd, questions });
  }

  useEffect(() => {
    loadMonthly();
    loadConversations();
  }, []);

  async function loadConversations() {
    const { data, error: err } = await supabase.from("ai_conversations").select("id, title, updated_at, cost_usd").order("updated_at", { ascending: false }).limit(200);
    if (!err) setConversations((data as ConversationRow[]) || []); // brak tabeli (nie uruchomiono ai.sql) — po prostu bez historii
  }

  async function openConversation(id: string) {
    if (loading || id === activeId) return;
    setError("");
    const { data, error: err } = await supabase.from("ai_conversations").select("messages").eq("id", id).maybeSingle();
    if (err || !data) return setError(`Nie udało się otworzyć rozmowy: ${err?.message ?? "nie znaleziono"}`);
    setMessages(((data.messages as any[]) || []).map((m) => ({ role: m.role, content: m.content, queries: m.queries, usage: m.usage, costUsd: m.costUsd, model: m.model })));
    setActiveId(id);
  }

  function newConversation() {
    if (loading) return;
    setMessages([]);
    setActiveId(null);
    setError("");
  }

  async function deleteConversation(c: ConversationRow) {
    if (loading) return;
    if (!confirm(`Usunąć rozmowę „${c.title}”? Tej operacji nie można cofnąć.`)) return;
    const { error: err } = await supabase.from("ai_conversations").delete().eq("id", c.id);
    if (err) return setError(`Nie udało się usunąć rozmowy: ${err.message}`);
    if (c.id === activeId) newConversation();
    loadConversations();
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [loading]);

  async function ask(text: string) {
    const question = text.trim();
    if (!question || loading) return;
    setError("");
    const next: Msg[] = [...messages, { role: "user", content: question }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ messages: next.map((m) => ({ role: m.role, content: m.content })), conversationId: activeId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Błąd serwera (${res.status}).`);
      setMessages([...next, { role: "assistant", content: data.answer, queries: data.queries, usage: data.usage, costUsd: data.costUsd, model: data.model }]);
      if (data.conversationId) setActiveId(data.conversationId);
      loadMonthly();
      loadConversations();
    } catch (e: any) {
      setError(e.message || "Nie udało się uzyskać odpowiedzi.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col lg:flex-row gap-6 items-start">
      <aside className="w-full lg:w-72 shrink-0 border border-line bg-white">
        <div className="flex items-center justify-between px-3 py-2 border-b border-line">
          <span className="text-xs font-semibold text-inksoft">HISTORIA ROZMÓW</span>
          <button onClick={newConversation} disabled={loading} className="text-xs font-semibold text-teal hover:underline disabled:opacity-50">+ Nowa</button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {conversations.length === 0 && <p className="p-3 text-xs text-inksoft">Brak zapisanych rozmów — pierwsza zapisze się po pierwszej odpowiedzi.</p>}
          {conversations.map((c) => (
            <div key={c.id} className={`group flex items-start gap-2 px-3 py-2 border-b border-line last:border-b-0 ${c.id === activeId ? "bg-paper" : "hover:bg-paper"}`}>
              <button onClick={() => openConversation(c.id)} disabled={loading} className="flex-1 text-left min-w-0 disabled:opacity-60">
                <div className={`text-sm truncate ${c.id === activeId ? "font-semibold" : ""}`} title={c.title}>{c.title}</div>
                <div className="text-[11px] text-inksoft">
                  {new Date(c.updated_at).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  {Number(c.cost_usd) > 0 && ` · ${fmtUsd(Number(c.cost_usd))}`}
                </div>
              </button>
              <button onClick={() => deleteConversation(c)} disabled={loading} title="Usuń rozmowę" className="text-rust text-xs font-bold opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0">✕</button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex-1 min-w-0 max-w-4xl">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-inksoft">
          Asystent widzi tylko zamówienia, pozycje, magazyn i kursy NBP (bez danych klientów) i niczego nie zmienia — tylko odczyt.
        </p>
        {messages.length > 0 && (
          <button onClick={newConversation} disabled={loading} className="text-xs font-semibold text-teal hover:underline shrink-0 ml-3 disabled:opacity-50">
            Nowa rozmowa
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-inksoft mb-4 border border-line bg-white px-3 py-2" title="Szacunek wg cennika API (USD). Faktyczne rozliczenie: console.anthropic.com">
        <span>Koszt tej rozmowy: <span className="font-mono font-semibold text-ink">{fmtUsd(conversationUsd)}</span></span>
        {monthly && (
          <span>
            W tym miesiącu: <span className="font-mono font-semibold text-ink">{fmtUsd(monthly.usd)}</span> ({monthly.questions} {monthly.questions === 1 ? "pytanie" : "pytań"})
          </span>
        )}
        <span>szacunek wg cennika API w USD</span>
      </div>

      {messages.length === 0 && !loading && (
        <div className="border border-line bg-white p-5 mb-4">
          <div className="text-sm font-semibold mb-2">Przykładowe polecenia</div>
          <div className="flex flex-col gap-2 items-start">
            {EXAMPLES.map((ex) => (
              <button key={ex} onClick={() => ask(ex)} className="text-left text-sm border border-line rounded px-3 py-2 hover:bg-paper">
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4 mb-4">
        {messages.map((m, idx) =>
          m.role === "user" ? (
            <div key={idx} className="flex justify-end">
              <div className="bg-ink text-paper rounded px-4 py-2 text-sm max-w-[85%] whitespace-pre-wrap">{m.content}</div>
            </div>
          ) : (
            <div key={idx} className="border border-line bg-white p-5">
              <Markdown text={m.content} />
              <div className="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-4 text-xs text-inksoft">
                <button onClick={() => navigator.clipboard?.writeText(m.content)} className="font-semibold text-teal hover:underline">Kopiuj</button>
                {m.usage && (
                  <span>
                    tokeny: {m.usage.input.toLocaleString("pl-PL")} wej. / {m.usage.output.toLocaleString("pl-PL")} wyj.
                    {(m.usage.cacheRead || m.usage.cacheWrite) ? ` / cache ${(m.usage.cacheRead ?? 0).toLocaleString("pl-PL")} odcz. · ${(m.usage.cacheWrite ?? 0).toLocaleString("pl-PL")} zap.` : ""}
                  </span>
                )}
                {m.costUsd !== undefined && (
                  <span>
                    koszt ≈ <span className="font-mono font-semibold text-ink">{m.costUsd === null ? "—" : fmtUsd(m.costUsd)}</span>
                    {m.costUsd === null && ` (brak cennika modelu ${m.model ?? ""})`}
                  </span>
                )}
              </div>
              {m.queries && m.queries.length > 0 && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-inksoft font-semibold">Użyte zapytania do bazy ({m.queries.length}) — do weryfikacji liczb</summary>
                  <div className="mt-2 space-y-2">
                    {m.queries.map((q, qi) => (
                      <div key={qi}>
                        <pre className="bg-paper border border-line rounded p-2 font-mono whitespace-pre-wrap break-words">{q.sql}</pre>
                        <div className={q.error ? "text-rust" : "text-inksoft"}>{q.error ? `Błąd: ${q.error}` : `zwrócono wierszy: ${q.rows ?? "—"}`}</div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )
        )}
        {loading && (
          <div className="border border-line bg-white p-4 text-sm text-inksoft">
            Analizuję dane… {elapsed} s <span className="text-xs">(złożone raporty mogą trwać do kilku minut)</span>
          </div>
        )}
      </div>

      {error && <p className="text-rust text-xs mb-3">{error}</p>}

      <div className="sticky bottom-0 bg-paper pt-2 pb-4">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={2}
            placeholder="Wpisz polecenie, np. „Wygeneruj raport sprzedaży za poprzedni miesiąc”. Enter wysyła, Shift+Enter — nowa linia."
            className="flex-1 border border-line bg-white px-3 py-2 rounded text-sm resize-y"
          />
          <button onClick={() => ask(input)} disabled={loading || !input.trim()} className="bg-ink text-paper px-5 py-2 rounded text-sm font-semibold disabled:opacity-50">
            Wyślij
          </button>
        </div>
      </div>
      <div ref={bottomRef} />
      </div>
    </div>
  );
}
