"use client";

import type { BidderProposal } from "@/lib/octopiaBidder";

export type PriceRule = { min: number | null; max: number | null };

const f2 = (n: number) => n.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Komórka "Bidder" w Listingach Cdiscount (19.10.2026): cena minimalna i maksymalna (wpisywane ręcznie, zapis przy wyjściu z pola) oraz PROPOZYCJA ceny (nic nie zmienia samo — "Ustaw" otwiera potwierdzenie).
export default function OctopiaBidderCell({
  rule,
  canEdit,
  proposal,
  busy,
  onSaveRule,
  onApply,
}: {
  rule: PriceRule | undefined;
  canEdit: boolean;
  proposal: BidderProposal | null;
  busy: boolean;
  onSaveRule: (min: string, max: string) => void;
  onApply: (p: BidderProposal) => void;
}) {
  const minV = rule?.min ?? null;
  const maxV = rule?.max ?? null;
  const inputCls = "w-[72px] border border-line bg-white px-1.5 py-0.5 rounded font-mono text-[11px] text-right";
  const commit = (field: "min" | "max", el: HTMLInputElement) => {
    const val = el.value.trim();
    const cur = field === "min" ? minV : maxV;
    const same = (val === "" && cur === null) || (val !== "" && cur !== null && Number(val.replace(",", ".")) === cur);
    if (same) return;
    const asText = (n: number | null) => (n === null ? "" : String(n));
    onSaveRule(field === "min" ? val : asText(minV), field === "max" ? val : asText(maxV));
  };
  return (
    <td className="p-3 text-xs align-top min-w-[230px]">
      {canEdit ? (
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-inksoft" title="Cena minimalna — poniżej niej bidder nigdy nie proponuje zejścia">min</label>
          <input key={`min-${minV}`} defaultValue={minV ?? ""} disabled={busy} inputMode="decimal" placeholder="—" className={inputCls} onBlur={(e) => commit("min", e.currentTarget)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
          <label className="text-[10px] text-inksoft" title="Cena maksymalna — do niej bidder może proponować podwyżkę (puste = bez podwyżek ponad obecną cenę)">max</label>
          <input key={`max-${maxV}`} defaultValue={maxV ?? ""} disabled={busy} inputMode="decimal" placeholder="—" className={inputCls} onBlur={(e) => commit("max", e.currentTarget)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        </div>
      ) : (
        <div className="font-mono text-[11px] text-inksoft">{minV !== null || maxV !== null ? `min ${minV !== null ? f2(minV) : "—"} / max ${maxV !== null ? f2(maxV) : "—"}` : "—"}</div>
      )}
      {proposal && (
        <div className="mt-1.5">
          {proposal.action === "set" && proposal.price !== null && (
            <div>
              {canEdit && (
                <button onClick={() => onApply(proposal)} disabled={busy} className="bg-ink text-paper px-2 py-0.5 rounded text-[11px] font-semibold disabled:opacity-50">
                  Ustaw {f2(proposal.price)} €
                </button>
              )}
              {!canEdit && <span className="font-semibold text-teal">Propozycja: {f2(proposal.price)} €</span>}
              <div className="text-[11px] text-inksoft mt-0.5 whitespace-normal max-w-[260px]">{proposal.reason}</div>
            </div>
          )}
          {proposal.action === "warn" && <div className="text-[11px] text-amber whitespace-normal max-w-[260px]">⚠ {proposal.reason}</div>}
          {proposal.action === "none" && <div className="text-[11px] text-inksoft whitespace-normal max-w-[260px]">{proposal.reason}</div>}
        </div>
      )}
    </td>
  );

}
