import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Wartości to zmienne CSS (globals.css) — trzy motywy (Obecny/Nowy/Tryb nocny) przełączane atrybutem
        // data-theme na <html> (lib/theme.ts), bez zmiany żadnej klasy w komponentach. "white" jest tu specjalnie
        // NADPISANE (poza swoim zwykłym #fff) — w tym kodzie bg-white oznacza zawsze "powierzchnia karty/tabeli",
        // nigdy dosłowną biel, więc musi też ciemnieć w Trybie nocnym.
        paper: "var(--color-paper)",
        panel: "var(--color-panel)",
        ink: "var(--color-ink)",
        inksoft: "var(--color-inksoft)",
        line: "var(--color-line)",
        amber: "var(--color-amber)",
        ambersoft: "var(--color-ambersoft)",
        teal: "var(--color-teal)",
        tealsoft: "var(--color-tealsoft)",
        rust: "var(--color-rust)",
        rustsoft: "var(--color-rustsoft)",
        white: "var(--color-card)",
      },
    },
  },
  plugins: [],
};
export default config;
