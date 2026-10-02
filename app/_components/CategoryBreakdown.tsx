"use client";

export const FAKTUROWNIA_PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
const FAKTUROWNIA_OTHER_COLOR = "#898781"; // wyciszony szary — wycinek zbiorczy, nie jest częścią palety kategorii
export type CategorySummary = { name: string; count: number; value: number };

function fmtPLN(n: number) {
  return Math.round(n).toLocaleString("pl-PL") + " zł";
}

// Wykres pierścieniowy + tabela kategorii. `none` = sztuki bez kategorii (wykres z SKU: "Bez SKU") — zawsze ostatnie,
// własny jasny szary. `maxRows` ucina tabelę do N największych kategorii i zwija resztę w jeden wiersz "Inne (k kategorii)"
// (przy ~40 kategoriach z SKU pełna tabela byłaby za długa); bez `maxRows` tabela pokazuje wszystkie kategorie.
const FAKTUROWNIA_NONE_COLOR = "#d4d2cc";
export default function CategoryBreakdown({
  title,
  categories,
  totalValue,
  none,
  maxRows,
}: {
  title: string;
  categories: CategorySummary[];
  totalValue: number;
  none?: { count: number; value: number };
  maxRows?: number;
}) {
  const TOP_N = FAKTUROWNIA_PALETTE.length;
  const colorAt = (i: number) => (i < TOP_N ? FAKTUROWNIA_PALETTE[i] : FAKTUROWNIA_OTHER_COLOR);
  const noneRow = none && none.count > 0 ? { name: "Bez SKU", count: none.count, value: none.value, color: FAKTUROWNIA_NONE_COLOR } : null;

  const sorted = categories.map((c, i) => ({ ...c, color: colorAt(i) }));
  const tableRows =
    maxRows !== undefined && sorted.length > maxRows
      ? [
          ...sorted.slice(0, maxRows),
          {
            name: `Inne (${sorted.length - maxRows} kat.)`,
            count: sorted.slice(maxRows).reduce((s, c) => s + c.count, 0),
            value: sorted.slice(maxRows).reduce((s, c) => s + c.value, 0),
            color: FAKTUROWNIA_OTHER_COLOR,
          },
        ]
      : sorted;
  const tableAll = noneRow ? [...tableRows, noneRow] : tableRows;

  // Wycinki pierścienia: top N z palety + "Inne" zbiorczo (szary) + ewentualne "Bez SKU".
  const top = sorted.slice(0, TOP_N);
  const rest = sorted.slice(TOP_N);
  const slices = [
    ...top,
    ...(rest.length > 0 ? [{ name: "Inne", count: rest.reduce((s, c) => s + c.count, 0), value: rest.reduce((s, c) => s + c.value, 0), color: FAKTUROWNIA_OTHER_COLOR }] : []),
    ...(noneRow ? [noneRow] : []),
  ];

  const RADIUS = 70;
  const STROKE = 34;
  const CIRC = 2 * Math.PI * RADIUS;
  const GAP = slices.length > 1 ? 3 : 0;
  let cursor = 0;
  const arcs = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const share = totalValue > 0 ? s.value / totalValue : 0;
      const length = Math.max(share * CIRC - GAP, 0);
      const offset = -cursor;
      cursor += share * CIRC;
      return { ...s, share, length, offset };
    });

  return (
    <div className="border border-line bg-white p-5">
      <h3 className="text-xs font-semibold text-inksoft mb-4">{title}</h3>
      <div className="flex flex-col 2xl:flex-row gap-6 items-center">
        <svg viewBox="0 0 200 200" className="w-44 h-44 shrink-0">
          {arcs.map((a) => (
            <circle
              key={a.name}
              cx="100"
              cy="100"
              r={RADIUS}
              fill="none"
              stroke={a.color}
              strokeWidth={STROKE}
              strokeDasharray={`${a.length} ${Math.max(CIRC - a.length, 0)}`}
              strokeDashoffset={a.offset}
              transform="rotate(-90 100 100)"
            />
          ))}
          <text x="100" y="96" textAnchor="middle" className="fill-ink" style={{ fontSize: 18, fontWeight: 700 }}>
            {fmtPLN(totalValue)}
          </text>
          <text x="100" y="116" textAnchor="middle" className="fill-inksoft" style={{ fontSize: 11 }}>
            łącznie
          </text>
        </svg>

        <div className="flex-1 w-full overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-inksoft border-b border-line">
                <th className="py-2 pr-3">Kategoria</th>
                <th className="py-2 pr-3">Ilość</th>
                <th className="py-2 pr-3">Wartość</th>
                <th className="py-2">Udział</th>
              </tr>
            </thead>
            <tbody>
              {tableAll.map((c, i) => (
                <tr key={c.name + i} className="border-b border-line last:border-b-0">
                  <td className="py-2 pr-3">
                    <span className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-sm inline-block shrink-0" style={{ background: c.color }} />
                      <span className="font-semibold">{c.name}</span>
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono">{c.count}</td>
                  <td className="py-2 pr-3 font-mono whitespace-nowrap">{fmtPLN(c.value)}</td>
                  <td className="py-2 font-mono text-inksoft">{totalValue > 0 ? Math.round((c.value / totalValue) * 100) : 0}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

