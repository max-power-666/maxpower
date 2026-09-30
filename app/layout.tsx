import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Magazyn ERP",
  description: "Wewnętrzny system magazynowy",
};

// Ustawia data-theme na <html> PRZED hydracją (synchronny inline script) — bez tego strona mignęłaby złym
// motywem na ułamek sekundy przy każdym twardym odświeżeniu, zanim React zdążyłby odczytać localStorage/zegar.
// Bez jawnego wyboru w localStorage motyw idzie automatycznie wg pory dnia (21:00–5:00 = ciemny) — logika
// godzin 1:1 z autoTheme() w lib/theme.ts, celowo zduplikowana (ten skrypt musi być samodzielny, bez importów).
const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem("erp-theme");if(t!=="new"&&t!=="dark"){var h=new Date().getHours();t=(h>=21||h<5)?"dark":"new"}document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

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
