// Data wg czasu polskiego składana z części (`formatToParts`), a NIE z gotowego napisu locale: kształt wyniku `format()` dla "en-CA"/"sv-SE" zależy od przeglądarki
// (np. w Safari "en-CA" potrafi dać "10/2026" zamiast "2026-10"), co psuło RCP u części pracowników ("Invalid Date", 07.10.2026).
const FMT = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" });

export function warsawParts(ms: number): { y: string; m: string; d: string } {
  const p = FMT.formatToParts(new Date(ms));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { y: get("year"), m: get("month").padStart(2, "0"), d: get("day").padStart(2, "0") };
}
export const warsawYmd = (ms: number): string => {
  const { y, m, d } = warsawParts(ms);
  return `${y}-${m}-${d}`;
};
export const warsawYm = (ms: number): string => {
  const { y, m } = warsawParts(ms);
  return `${y}-${m}`;
};
