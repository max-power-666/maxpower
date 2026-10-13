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

// Data i godzina wg czasu polskiego jako "13.10.2026, 15:38" (z sekundami: "15:38:02"). Składana z części (formatToParts), nie z gotowego napisu locale — patrz uwaga na górze pliku.
const DT_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
export function fmtWarsawDateTime(ms: number, withSeconds = false): string {
  if (!Number.isFinite(ms)) return "";
  const p = DT_FMT.formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const hh = g("hour") === "24" ? "00" : g("hour");
  return `${g("day")}.${g("month")}.${g("year")}, ${hh}:${g("minute")}${withSeconds ? ":" + g("second") : ""}`;
}

// Zamienia w tekście znaczniki czasu ISO (np. "2026-10-13T13:38:02.848Z", w logach korekt) na czas polski; reszta tekstu bez zmian.
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;
export function humanizeIsoTimes(text: string, withSeconds = false): string {
  return text.replace(ISO_RE, (m) => {
    const t = Date.parse(m);
    return Number.isFinite(t) ? fmtWarsawDateTime(t, withSeconds) : m;
  });
}
