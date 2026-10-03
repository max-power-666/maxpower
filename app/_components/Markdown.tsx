"use client";

import type { ReactNode } from "react";

// Minimalny renderer markdownu dla odpowiedzi asystenta AI (bez zależności i bez dangerouslySetInnerHTML — tekst od modelu
// nigdy nie trafia do DOM jako HTML). Obsługuje: nagłówki #..####, akapity, listy punktowane i numerowane, tabele
// (GFM: | a | b | + linia ---), bloki kodu ```, linię poziomą ---, oraz w tekście **pogrubienie**, *kursywę* i `kod`.

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={key} className="font-mono text-[0.9em] bg-paper px-1 rounded">{tok.slice(1, -1)}</code>);
    else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export default function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++} className="bg-paper border border-line rounded p-3 text-xs font-mono overflow-x-auto my-3 whitespace-pre">{code.join("\n")}</pre>);
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const cls = level === 1 ? "text-lg font-bold mt-4 mb-2" : level === 2 ? "text-base font-bold mt-4 mb-2" : "text-sm font-bold mt-3 mb-1";
      blocks.push(<div key={k++} className={cls}>{inline(h[2], `h${k}`)}</div>);
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push(<hr key={k++} className="border-line my-3" />); i++; continue; }

    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "left"));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const at = (c: number) => (align[c] === "right" ? "text-right" : align[c] === "center" ? "text-center" : "text-left");
      blocks.push(
        <div key={k++} className="overflow-x-auto my-3 border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-inksoft border-b border-line bg-paper">
                {head.map((c, ci) => <th key={ci} className={`p-2 font-semibold ${at(ci)}`}>{inline(c, `th${k}-${ci}`)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-line last:border-b-0">
                  {r.map((c, ci) => <td key={ci} className={`p-2 ${at(ci)} ${align[ci] === "right" ? "font-mono" : ""}`}>{inline(c, `td${k}-${ri}-${ci}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      blocks.push(<ul key={k++} className="list-disc pl-5 my-2 space-y-1 text-sm">{items.map((t, ii) => <li key={ii}>{inline(t, `li${k}-${ii}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push(<ol key={k++} className="list-decimal pl-5 my-2 space-y-1 text-sm">{items.map((t, ii) => <li key={ii}>{inline(t, `ol${k}-${ii}`)}</li>)}</ol>);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```)/.test(lines[i].trim()) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))) para.push(lines[i++]);
    blocks.push(<p key={k++} className="text-sm my-2 leading-relaxed">{inline(para.join(" "), `p${k}`)}</p>);
  }
  return <div>{blocks}</div>;
}
