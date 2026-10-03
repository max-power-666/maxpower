"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import Markdown from "./Markdown";

// Asystent AI (03.10.2026, tylko Admin): okno, w którym wpisujesz polecenie po polsku (np. "wygeneruj raport sprzedaży za
// poprzedni miesiąc"); serwer (app/api/ai/ask) daje modelowi dostęp tylko do odczytu wybranych widoków (supabase/ai.sql).
// Rozmowa żyje w stanie przeglądarki (odświeżenie ją czyści); każde pytanie zapisuje się w ai_log po stronie serwera.

type Trace = { sql: string; rows?: number; error?: string };
type Msg = { role: "user" | "assistant"; content: string; queries?: Trace[]; usage?: { input: number; output: number } };

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
  const bottomRef = useRef<HTMLDivElement>(null);

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
        body: JSON.stringify({ messages: next.map((m) => ({ role: m.role, content: m.content })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Błąd serwera (${res.status}).`);
      setMessages([...next, { role: "assistant", content: data.answer, queries: data.queries, usage: data.usage }]);
    } catch (e: any) {
      setError(e.message || "Nie udało się uzyskać odpowiedzi.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-inksoft">
          Asystent widzi tylko zamówienia, pozycje, magazyn i kursy NBP (bez danych klientów) i niczego nie zmienia — tylko odczyt.
        </p>
        {messages.length > 0 && (
          <button onClick={() => { setMessages([]); setError(""); }} className="text-xs font-semibold text-teal hover:underline shrink-0 ml-3">
            Nowa rozmowa
          </button>
        )}
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
                {m.usage && <span>tokeny: {m.usage.input.toLocaleString("pl-PL")} wej. / {m.usage.output.toLocaleString("pl-PL")} wyj.</span>}
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
  );
}
