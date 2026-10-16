"use client";

import { INTERVALS } from "@/lib/workLog";
import { defaultCustomPeriod, isYmd, todayYmd, type Period } from "@/lib/period";

// Kapsułki okresu (Dziś / Ostatnie 7 dni / Ostatnie 30 dni) + "Zakres": dowolne daty od–do (16.10.2026). Wspólne dla Serwisu, Testów i Trade-in.
const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;
const dateInput = "border border-line bg-white px-2 py-1 rounded text-sm";

export default function PeriodPicker({ value, onChange, className = "", title }: { value: Period; onChange: (p: Period) => void; className?: string; title?: string }) {
  const custom = value.kind === "custom" ? value : null;
  const today = todayYmd();
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} title={title}>
      {INTERVALS.map((i) => (
        <button key={i.key} onClick={() => onChange({ kind: i.key })} className={pill(value.kind === i.key)}>{i.label}</button>
      ))}
      <button onClick={() => onChange(custom ?? defaultCustomPeriod())} className={pill(!!custom)} title="Wybierz dowolny zakres dat">Zakres</button>
      {custom && (
        <span className="flex items-center gap-1.5 text-sm">
          <span className="text-xs text-inksoft">od</span>
          <input
            type="date"
            value={custom.from}
            max={today}
            onChange={(e) => isYmd(e.target.value) && onChange({ kind: "custom", from: e.target.value, to: e.target.value > custom.to ? e.target.value : custom.to })}
            className={dateInput}
          />
          <span className="text-xs text-inksoft">do</span>
          <input
            type="date"
            value={custom.to}
            max={today}
            onChange={(e) => isYmd(e.target.value) && onChange({ kind: "custom", from: e.target.value < custom.from ? e.target.value : custom.from, to: e.target.value })}
            className={dateInput}
          />
        </span>
      )}
    </div>
  );
}
