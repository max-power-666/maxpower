import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Magazyn ERP",
  description: "Wewnętrzny system magazynowy",
};

// Ustawia data-theme na <html> PRZED hydracją (synchronny inline script) — bez tego strona mignęłaby domyślnym
// motywem na ułamek sekundy przy każdym twardym odświeżeniu, zanim React zdążyłby odczytać localStorage.
const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem("erp-theme");document.documentElement.setAttribute("data-theme",(t==="new"||t==="dark")?t:"default")}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
