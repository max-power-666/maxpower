"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import TradeInView from "./_components/TradeInView";
import TradeInHub from "./_components/TradeInHub";
import SalesOrdersHub from "./_components/SalesOrdersHub";
import BacklogView from "./_components/BacklogView";
import ShippingView from "./_components/ShippingView";
import InvoicesView from "./_components/InvoicesView";
import AiView from "./_components/AiView";
import MarginView from "./_components/MarginView";
import PointsView from "./_components/PointsView";
import NbpView from "./_components/NbpView";
import CostInvoicesView from "./_components/CostInvoicesView";
import { stockTradeInCosts, type BuybackOrderLite, type CostLine } from "@/lib/stockCosts";
import type { NbpRate } from "@/lib/nbp";
import CategoryBreakdown, { FAKTUROWNIA_PALETTE } from "./_components/CategoryBreakdown";
import { skuCategoryOf } from "@/lib/skuParts";
import OverviewSalesDashboard from "./_components/OverviewSalesDashboard";
import OverviewMarginChart from "./_components/OverviewMarginChart";
import RcpView from "./_components/RcpView";
import RcpWidget from "./_components/RcpWidget";
import RemindersView from "./_components/RemindersView";
import GoodsView from "./_components/GoodsView";
import ListingsView from "./_components/ListingsView";
import ListingQueueView from "./_components/ListingQueueView";
import ReminderBanners from "./_components/ReminderBanners";
import { tracksWorkTime } from "@/lib/rcp";
import ReturnsView from "./_components/ReturnsView";
import ShopProductsView from "./_components/ShopProductsView";
import ShopStockView from "./_components/ShopStockView";
import type { ShipPrefill } from "@/lib/shipping";
import ServiceHub from "./_components/ServiceHub";
import TestsView from "./_components/TestsView";
import InventoryRawView from "./_components/InventoryRawView";
import ConsoleCatalogView from "./_components/ConsoleCatalogView";
import ThemeSwitcher from "./_components/ThemeSwitcher";
import { displayNameForEmail } from "@/lib/displayName";

const ROLES = ["Admin", "Manager", "Księgowa", "Magazyn", "Zamówienia", "Serwis", "Kierownik serwisu", "Testy", "Bidder", "Trade-in", "Kierownik trade-in", "Sklep"];

type ViewKey =
  | "overview" | "inventory" | "sales" | "team" | "service" | "tests" | "tradein" | "orders" | "backlog" | "shipping" | "invoices" | "margin" | "points" | "nbp" | "costs" | "ai" | "rcp" | "returns" | "reminders" | "goods" | "listings" | "toList"
  // Recoo Sklep (backoffice sklepu, przełącznik w pasku bocznym):
  | "shop_products" | "shop_stock";

// Dwie przestrzenie w jednej aplikacji: ERP i backoffice sklepu. Przełącznik to nazwa w lewym górnym rogu;
// pasek boczny pokazuje tylko zakładki bieżącej przestrzeni. Dostęp do zakładek sklepu — jak do każdej innej
// (ROLE_ACCESS / view_access w Zespole).
type Space = "erp" | "shop";
const SPACE_NAMES: Record<Space, string> = { erp: "Recoo ERP", shop: "Recoo Sklep" };

const TABS: { key: ViewKey; label: string; space?: Space }[] = [
  { key: "overview", label: "Przegląd" },
  { key: "inventory", label: "Magazyn" },
  { key: "goods", label: "Towar" }, // rejestr zakupionego towaru z arkusza (VM/V23 i Trade-in), Admin i Manager (10.10.2026)
  { key: "toList", label: "Do wystawienia" }, // urządzenia gotowe do wystawienia (skaner) + sugerowana cena na Back Market i refurbed (16.10.2026)
  { key: "listings", label: "Listingi" }, // oferty wystawione na Back Market i refurbed (13.10.2026), Admin i Manager
  { key: "sales", label: "Zamówienia" },
  { key: "team", label: "Zespół" },
  { key: "service", label: "Serwis" },
  { key: "tests", label: "Testy" },
  { key: "tradein", label: "Bidder" },
  { key: "orders", label: "Trade-in" },
  { key: "backlog", label: "Backlog" },
  { key: "reminders", label: "Przypomnienia" }, // ważne komunikaty i zadania cykliczne + baner na górze strony; na razie tylko Admin (09.10.2026)
  { key: "shipping", label: "Wysyłka" },
  { key: "invoices", label: "Faktury" },
  { key: "margin", label: "Marża" },
  { key: "points", label: "Punktacja" }, // podsumowanie punktacji pracowników wg regulaminu, Admin i Manager (06.10.2026)
  { key: "costs", label: "Faktury kosztowe" }, // faktury kosztowe z Fakturowni (w tym z KSeF), Admin, Manager i Księgowa (14.10.2026)
  { key: "nbp", label: "NBP" },
  { key: "ai", label: "AI" },
  { key: "rcp", label: "RCP" },
  { key: "returns", label: "Zwroty" },
  { key: "shop_products", label: "Produkty", space: "shop" },
  { key: "shop_stock", label: "Magazyn", space: "shop" },
];

// Grupy zakładek w pasku bocznym przestrzeni ERP (10.10.2026): kolejność grup i zakładek w grupie = kolejność w menu. Grupa bez nagłówka (title = null) to Przegląd na samej górze.
// Zakładka spoza listy (nowa, jeszcze niedopisana) trafia na koniec w grupie "Inne", więc nigdy nie zniknie z menu.
const NAV_GROUPS: { title: string | null; keys: ViewKey[] }[] = [
  { title: null, keys: ["overview"] },
  { title: "Sprzedaż", keys: ["sales", "shipping", "returns"] },
  { title: "Magazyn", keys: ["inventory", "goods", "toList", "listings"] },
  { title: "Serwis", keys: ["service", "tests"] },
  { title: "Skup", keys: ["orders", "tradein"] },
  { title: "Finanse", keys: ["invoices", "costs", "margin", "nbp"] },
  { title: "Zespół", keys: ["rcp", "points", "team"] },
  { title: "Narzędzia", keys: ["backlog", "reminders", "ai"] },
];
function navSections(space: Space, visible: ViewKey[]): { title: string | null; tabs: { key: ViewKey; label: string }[] }[] {
  const tabs = TABS.filter((t) => spaceOf(t.key) === space && visible.includes(t.key));
  if (space !== "erp") return [{ title: null, tabs }];
  const placed = new Set<ViewKey>();
  const sections = NAV_GROUPS.map((g) => ({
    title: g.title,
    tabs: g.keys.flatMap((k) => {
      const t = tabs.find((x) => x.key === k);
      if (!t) return [];
      placed.add(k);
      return [t];
    }),
  })).filter((g) => g.tabs.length > 0);
  const rest = tabs.filter((t) => !placed.has(t.key));
  if (rest.length > 0) sections.push({ title: "Inne", tabs: rest });
  // Nagłówki tylko, gdy osoba widzi zakładki z co najmniej dwóch grup z nagłówkiem — inaczej to szum.
  if (sections.filter((g) => g.title !== null).length < 2) return [{ title: null, tabs: sections.flatMap((g) => g.tabs) }];
  return sections;
}

// Kto widzi jaką zakładkę — DOMYŚLNY zestaw wg roli, Admin ma dostęp do wszystkiego.
// Przegląd jest domyślnie TYLKO dla Admina i Managera (02.10.2026, na prośbę właściciela)
// — dla innych ról zakładką startową jest ich własna, główna zakładka (pierwszy element
// listy niżej — np. Testy -> Testy, Trade-in -> Trade-in, Serwis -> Serwis). Admin może to
// nadpisać per osoba w Zespole (checkboxy przy każdej zakładce, `members.view_access` —
// patrz `effectiveAccess`); ta mapa jest tylko domyślnym punktem startowym dla nowej roli
// i dla osób, których nikt jeszcze nie dotknął ręcznie (view_access = NULL). Na razie
// to tylko filtruje nawigację w tej przeglądarce — to nie jest twarde zabezpieczenie
// (RLS pozwala każdemu authenticated na wszystko, patrz supabase/schema.sql).
// "orders" (zakładka Trade-in — podgląd zamówień BuyBack) na razie tylko dla Admina,
// dopóki nie ustalimy docelowej roli dla osoby przetwarzającej zamówienia.
// "overview" (Przegląd) od 02.10.2026 jest domyślnie TYLKO dla Admina i Managera (na wyraźną prośbę
// właściciela) — inne role go nie mają w domyślnym zestawie, więc ich zakładką startową (pierwszy
// element listy, patrz "wróć do pierwszej dostępnej zakładki" niżej) jest ich własna, główna zakładka.
// Admin wciąż może przywrócić komuś dostęp do Przeglądu ręcznie, w Zespole (view_access) — to nie jest
// twardo zablokowane, tylko inny domyślny zestaw wg roli, jak każda inna zakładka.
const ROLE_ACCESS: Record<string, ViewKey[]> = {
  // "ai" (asystent AI, 03.10.2026) — na tym etapie TYLKO Admin (także serwer: app/api/ai/ask); Manager go nie ma.
  Admin: ["overview", "inventory", "goods", "toList", "listings", "sales", "team", "service", "tests", "tradein", "orders", "backlog", "shipping", "invoices", "costs", "margin", "points", "nbp", "ai", "rcp", "returns", "reminders", "shop_products", "shop_stock"],
  Manager: ["overview", "inventory", "goods", "toList", "listings", "sales", "team", "service", "tests", "tradein", "orders", "backlog", "shipping", "invoices", "costs", "margin", "points", "nbp", "rcp", "returns", "shop_products", "shop_stock"], // wszystko (poza AI); Zespół tylko do odczytu, usuwa tylko Admin
  Księgowa: ["overview", "inventory", "goods", "toList", "listings", "sales", "team", "service", "tests", "tradein", "orders", "backlog", "shipping", "invoices", "costs", "margin", "points", "nbp", "rcp", "returns", "shop_products", "shop_stock"], // 14.10.2026: na razie dokładnie jak Manager (na prośbę właściciela)
  Magazyn: ["inventory", "toList", "backlog", "rcp", "returns"],
  Zamówienia: ["sales", "shipping", "invoices", "backlog", "rcp", "returns"],
  // Serwis i Kierownik serwisu (08.10.2026): dodatkowo "sales" — wgląd w Zamówienia BEZ edycji (readOnly) i Zapotrzebowanie, które serwis przyjmuje.
  Serwis: ["service", "sales", "backlog", "rcp", "returns"],
  // Kierownik serwisu (05.10.2026): te same zakładki co Serwis; w samym Serwisie widzi naprawy wszystkich i może edytować wiersz w KAŻDYM statusie (patrz ServiceView).
  "Kierownik serwisu": ["service", "sales", "backlog", "rcp", "returns"],
  Testy: ["tests", "backlog", "rcp", "returns"],
  Bidder: ["tradein", "backlog", "rcp", "returns"],
  "Trade-in": ["orders", "backlog", "rcp", "returns"],
  // Kierownik trade-in (07.10.2026): zakładki jak Trade-in + prace administracyjne w RCP (wspólne dla kierowników).
  "Kierownik trade-in": ["orders", "backlog", "rcp", "returns"],
  // Obsługa sklepu: katalog i stany. Edycję w bazie pilnuje can_edit_shop() (supabase/shop.sql) — Admin/Manager/Sklep.
  Sklep: ["shop_products", "shop_stock", "backlog", "rcp"],
};

const spaceOf = (k: ViewKey): Space => TABS.find((t) => t.key === k)?.space ?? "erp";

type Member = { user_id: string; role: string; email: string; name: string; view_access: string[] | null; employment_type: string | null; zebra_printer_name?: string | null; a4_printer_name?: string | null };

// Forma zatrudnienia — zwykły tekst w bazie (jak rola), ta lista to tylko opcje w rozwijanej liście
// w UI; dodanie kolejnej formy nie wymaga SQL.
const EMPLOYMENT_TYPES = ["Umowa o pracę", "Umowa zlecenie"];

// Dostęp do zakładek dla danego członka zespołu: view_access (jeśli ustawiony przez Admina w Zespole) nadpisuje
// domyślny zestaw z ROLE_ACCESS dla jego roli. NULL = jeszcze nikt tego nie dotykał, używamy domyślnego wg roli.
function effectiveAccess(role: string, viewAccess: string[] | null | undefined, fallback: ViewKey[] = ["inventory"]): ViewKey[] {
  return (viewAccess as ViewKey[] | null | undefined) ?? ROLE_ACCESS[role] ?? fallback;
}

type FakturowniaCategorySummary = { name: string; count: number; value: number; children?: FakturowniaCategorySummary[] };
// sku: rozbicie dostępnych sztuk wg "kategorii z SKU" (widok fakturownia_stock_with_sku); null = nie udało się policzyć
// (np. nie uruchomiono inventory.sql). `categories` bez sztuk bez SKU — te są osobno w `none`.
// Rodziny SKU na wykresie "Wg kategorii z SKU" (14.10.2026, na prośbę właściciela — "od ogółu do szczegółu"): kategorie z SKU o wspólnym początku zbiera jedna rodzina
// (PS4 = PS4 + PS4S + PS4P…), a po kliknięciu wiersza widać warianty. Rodziny z `SKU_CHART_PINNED` są zawsze widoczne jako osobne wiersze. Tylko wykres — filtry i Raw data
// w Magazynie dalej używają pełnej kategorii z SKU. Kolejność reguł ma znaczenie (pierwsza pasująca); nieopisane kategorie są własną rodziną.
const SKU_CHART_FAMILIES: { prefix: RegExp; name: string }[] = [
  { prefix: /^PS5/, name: "PS5" },
  { prefix: /^PS4/, name: "PS4" },
  { prefix: /^(NSDL|NDS|NNDS|N3DS)/, name: "NDS" }, // Nintendo DS — przed Switchem
  { prefix: /^NS/, name: "NS" }, // Nintendo Switch: NS, NSO, NSL, NS2…
  { prefix: /^XOS/, name: "XOS" },
  { prefix: /^XOX/, name: "XOX" },
  { prefix: /^XO/, name: "XO" },
  { prefix: /^XSX/, name: "XSX" },
  { prefix: /^XSS/, name: "XSS" },
  { prefix: /^AW/, name: "AW" }, // Apple Watch: AW6C, AW9C, AWSE, AWS9C…
  { prefix: /^APM/, name: "APM" },
  { prefix: /^AHP/, name: "AHP" },
  { prefix: /^ID/, name: "ID" }, // wszystkie iPady: ID9, ID8, IDP111, IDM5C…
  { prefix: /^IP/, name: "IP" }, // iPhone
  { prefix: /^(SGS|SG21|S20FE)/, name: "SGS" }, // Samsung Galaxy S
  { prefix: /^SGA/, name: "SGA" },
  { prefix: /^SGN/, name: "SGN" },
  { prefix: /^SGW/, name: "SGW" },
  { prefix: /^MB/, name: "MB" }, // Macbooki
];
const SKU_CHART_PINNED = ["PS5", "AW", "APM", "XOS", "XOX", "XSS", "ID"];
// wielkość liter nie rozdziela kategorii (np. ipse2 / IPSE2); kategorie z Towaru ("<Kategoria> (Towar)") zostają bez zmian
const chartVariantOf = (category: string) => (category.includes("(Towar)") ? category : category.trim().toUpperCase());
function chartFamilyOf(variant: string): string {
  if (variant.includes("(Towar)")) return variant;
  return SKU_CHART_FAMILIES.find((f) => f.prefix.test(variant))?.name ?? variant;
}

// Ogólny podział produktów na wykresie "Wg grup produktów" (14.10.2026, na prośbę właściciela): Konsole, Apple Watch, Aparat, Samsung Watch, iPad, iPhone, Samsung,
// Macbook, Audio (+ "Inne"). Najpierw rozstrzyga kategoria z SKU (prefiks), a gdy jej brak — kategoria z Fakturowni / Towaru oraz nazwa produktu.
const PRODUCT_GROUPS = ["Konsole", "Apple Watch", "Aparat", "Samsung Watch", "iPad", "iPhone", "Samsung", "Macbook", "Audio"] as const;
function productGroupOf(skuCategory: string | null, categories: (string | null | undefined)[], name: string | null): string {
  const s = (skuCategory || "").trim().toUpperCase();
  const text = (name || "").toLowerCase();
  if (s) {
    if (s === "APARAT") return "Aparat";
    if (/^(AW|APPS)/.test(s)) return "Apple Watch";
    if (/^SGW/.test(s)) return "Samsung Watch";
    if (/^(PS|XO|XS|NS|NDS|NNDS|N3DS|ONEX|VSD|VVSD|MOQ|ASA)/.test(s)) return "Konsole";
    if (/^(IPAD|ID)/.test(s)) return "iPad";
    if (/^IP/.test(s)) return "iPhone";
    if (/^MB/.test(s)) return "Macbook";
    if (/^(APM|AHP|B7|APP|MARSH|QC|BSS|OF)/.test(s)) return "Audio";
    if (/^(SG|S2\d|GP|A\d)/.test(s)) return "Samsung";
  }
  for (const raw of categories) {
    const c = (raw || "").toLowerCase().replace(/\d+$/, "").trim();
    if (!c) continue;
    if (c === "konsola") return "Konsole";
    if (c === "aparat") return "Aparat";
    if (c === "ipad") return "iPad";
    if (c === "iphone") return "iPhone";
    if (c === "macbook") return "Macbook";
    if (c === "audio") return "Audio";
    if (c === "samsung") return /watch/.test(text) ? "Samsung Watch" : "Samsung";
    if (c === "watch") {
      if (/samsung|galaxy|sgw/.test(text)) return "Samsung Watch";
      if (/apple|apps\d|\baw|series|\bse\b|tbg|cpo/.test(text) || !/garmin|fenix|epix|amazfit|fitbit/.test(text)) return "Apple Watch"; // kategoria Watch to głównie Apple Watch
    }
  }
  return "Inne";
}

type FakturowniaSku = { count: number; categories: FakturowniaCategorySummary[]; none: { count: number; value: number }; groups: FakturowniaCategorySummary[]; total: number; totalValue: number; fromTowar: boolean };
// costs: koszty dodatkowe sztuk w magazynie (dziś tylko Trade-in; kolejne składniki jako kolejne linie) — patrz lib/stockCosts.ts; null = nie udało się policzyć.
// goods: wartości dostępnych pozycji z rejestru Towar (14.10.2026) — cena PLN i "cena + koszty (PLN)"; null = brak dostępu do Towaru / brak widoku dostępności.
// servicePln = kolumna Serwis, commissionPln = Prowizja (10% + logistyka; dla wierszy z arkusza prowizja + PCC − PCC), pccPln = PCC.
type GoodsValues = { count: number; pricePln: number; totalPln: number; noPrice: number; noTotal: number; servicePln: number; commissionPln: number; pccPln: number };
type FakturowniaSummary = { totalCount: number; totalValue: number; sku: FakturowniaSku | null; costs: CostLine[] | null; categories: FakturowniaCategorySummary[]; goods: GoodsValues | null };

type Unit = {
  id: string;
  category: string;
  name: string;
  location: string;
  price_cost: number;
  price_sell: number;
  notes: string;
  fields: Record<string, string>;
  status: string;
  history: { status: string; user_id: string; at: string }[];
  created_by: string;
  created_at: string;
};

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ---------------- ekran logowania (magic link) ---------------- */

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function sendLink() {
    setError("");
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper px-4">
      <div className="max-w-sm w-full text-center">
        <h1 className="text-xl font-semibold mb-1">Magazyn ERP</h1>
        <p className="text-inksoft text-sm mb-6">Zaloguj się linkiem wysłanym na Twój firmowy e-mail.</p>
        {sent ? (
          <p className="text-sm">Sprawdź skrzynkę <b>{email}</b> i kliknij link, żeby się zalogować.</p>
        ) : (
          <>
            <input
              type="email"
              placeholder="ty@twojafirma.pl"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-line bg-white px-3 py-2 rounded mb-3"
            />
            <button onClick={sendLink} className="w-full bg-ink text-paper py-2 rounded font-semibold">
              Wyślij link logowania
            </button>
            {error && <p className="text-rust text-xs mt-2">{error}</p>}
          </>
        )}
        <div className="mt-10">
          <ThemeSwitcher />
        </div>
      </div>
    </div>
  );
}

/* ---------------- brak przypisanej roli ---------------- */

// Rolę nadaje administrator z zakładki Zespół — nowy użytkownik nie wybiera jej sam.
// Przycisk wylogowania (13.10.2026, zgłoszenie z Backlogu ZAD-4): po zalogowaniu na zły adres e-mail nie było jak się stąd wylogować i wejść na właściwy.
function NoRoleScreen({ email, onRetry }: { email: string; onRetry: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-paper px-4">
      <div className="max-w-sm w-full text-center">
        <h2 className="text-lg font-semibold mb-1">Witaj w Magazynie</h2>
        <p className="text-inksoft text-sm">
          Twoje konto (<b>{email}</b>) nie ma jeszcze przypisanej roli. Poproś administratora, żeby nadał Ci ją w zakładce Zespół.
        </p>
        <p className="text-inksoft text-xs mt-3">Gdy rola zostanie nadana, ta strona odświeży się sama.</p>
        <button onClick={onRetry} className="mt-3 text-sm font-semibold text-teal hover:underline">
          Sprawdź ponownie
        </button>
        <div className="mt-6 pt-4 border-t border-line">
          <p className="text-inksoft text-xs mb-2">To nie ten adres e-mail?</p>
          <button onClick={() => supabase.auth.signOut()} className="text-sm font-semibold border border-line bg-white px-4 py-2 rounded hover:bg-paper">
            Wyloguj i zaloguj się na inne konto
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- główna aplikacja ---------------- */

export default function Home() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [role, setRole] = useState<string | undefined>(undefined);
  const [viewAccess, setViewAccess] = useState<string[] | null>(null);
  const [roleError, setRoleError] = useState("");
  const [units, setUnits] = useState<Unit[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [view, setView] = useState<ViewKey>("overview");
  // Zwinięte grupy menu (10.10.2026): zapamiętane w przeglądarce; zwinięta grupa chowa zakładki poza aktywną.
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("nav-collapsed") || "[]");
      if (Array.isArray(raw)) setCollapsedGroups(raw.filter((x) => typeof x === "string"));
    } catch {
      /* localStorage niedostępne — grupy zostają rozwinięte */
    }
  }, []);
  const toggleGroup = (title: string) =>
    setCollapsedGroups((prev) => {
      const next = prev.includes(title) ? prev.filter((x) => x !== title) : [...prev, title];
      try {
        localStorage.setItem("nav-collapsed", JSON.stringify(next));
      } catch {
        /* ignorujemy */
      }
      return next;
    });
  const [shipPrefill, setShipPrefill] = useState<ShipPrefill | null>(null); // dane z karty zamówienia do formularza przesyłki
  const [invSub, setInvSub] = useState<"summary" | "raw" | "catalog">("summary");
  const [rawReloadKey, setRawReloadKey] = useState(0);
  const [fakturowniaSummary, setFakturowniaSummary] = useState<FakturowniaSummary | null>(null);
  const [fakturowniaLastSynced, setFakturowniaLastSynced] = useState<string | null>(null);
  const [fakturowniaLoading, setFakturowniaLoading] = useState(false);
  const [fakturowniaError, setFakturowniaError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Zapamiętaj aktywną zakładkę, żeby odświeżenie strony (F5) nie wracało do Przeglądu.
  useEffect(() => {
    const saved = localStorage.getItem("magazyn-view");
    if (saved && TABS.some((t) => t.key === saved)) setView(saved as ViewKey);
  }, []);
  useEffect(() => {
    localStorage.setItem("magazyn-view", view);
    localStorage.setItem(`magazyn-view-${spaceOf(view)}`, view);
  }, [view]);

  useEffect(() => {
    if (!session) return;
    loadRole();
    loadUnits();
    loadMembers();
    loadFakturowniaSummaryFromDb();
    const channel = supabase
      .channel("units-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "units" }, () => loadUnits())
      // Zmiana w members odświeża też własną rolę — inaczej osoba, której Admin właśnie nadał
      // lub zmienił rolę, widzi starą (np. ekran "brak roli") aż do przeładowania strony.
      .on("postgres_changes", { event: "*", schema: "public", table: "members" }, () => {
        loadMembers();
        loadRole();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "fakturownia_stock_cache" }, () => loadFakturowniaSummaryFromDb())
      .on("postgres_changes", { event: "*", schema: "public", table: "fakturownia_sync_meta" }, () => loadFakturowniaSummaryFromDb())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Rola odświeża się też przy powrocie do karty, a na ekranie "brak roli" co 15 s — działa nawet
  // bez realtime na members (np. przed uruchomieniem migracji w schema.sql).
  useEffect(() => {
    if (!session) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") loadRole();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = role === "" ? setInterval(loadRole, 15000) : undefined;
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, role]);

  // Jeśli rola nie ma już dostępu do aktualnie otwartej zakładki (np. zmieniła się rola), wróć do PIERWSZEJ
  // dostępnej zakładki — nie zawsze do Przeglądu, bo od 02.10.2026 to domyślnie tylko Admin/Manager (dla innych
  // rół pierwszy element ich listy w ROLE_ACCESS to ich własna, główna zakładka — np. Testy -> Testy).
  useEffect(() => {
    if (!role) return;
    const allowed = effectiveAccess(role, viewAccess);
    if (!allowed.includes(view)) setView((allowed[0] as ViewKey) ?? "overview");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, viewAccess]);

  async function loadRole() {
    const attempt = () => supabase.from("members").select("role, view_access").eq("user_id", session!.user.id).maybeSingle();
    let { data, error } = await attempt();
    if (error && /jwt/i.test(error.message)) {
      // Token dostępu wygasł — typowo karta była długo w tle (uśpiony komputer, zminimalizowane okno) i
      // supabase-js nie zdążył go odświeżyć proaktywnie, zanim to zapytanie poleciało. Wymuszamy odświeżenie
      // i próbujemy raz jeszcze, zanim pokażemy błąd — samo powtórzenie tego samego zapytania (przycisk
      // "Spróbuj ponownie") niczego by nie naprawiło, bo używałoby tego samego, już nieważnego tokenu.
      const { error: refreshErr } = await supabase.auth.refreshSession();
      if (refreshErr) {
        // Sesja naprawdę wygasła (refresh token też) — nie da się jej odzyskać, trzeba zalogować się ponownie.
        await supabase.auth.signOut();
        return;
      }
      ({ data, error } = await attempt());
    }
    if (error) {
      // Błąd odczytu (sieć, sesja) to nie to samo co brak roli — zostawiamy dotychczasowy stan.
      console.error("loadRole:", error.message);
      setRoleError(error.message);
      return;
    }
    setRoleError("");
    if (data) {
      setRole(data.role ?? "");
      setViewAccess((data.view_access as string[] | null) ?? null);
    } else {
      // Pierwsze logowanie: zakładamy wiersz z pustą rolą, żeby admin zobaczył
      // to konto w Zespole i mógł mu przypisać rolę. Sam użytkownik już jej nie wybiera.
      await supabase.from("members").insert({ user_id: session!.user.id, role: "", email: session!.user.email });
      setRole("");
      setViewAccess(null);
    }
  }
  // Zmiana roli / imienia / dostępu do zakładek innego użytkownika — wywoływane z Zespołu (tylko Admin widzi tę zakładkę).
  async function changeMemberRole(userId: string, r: string) {
    await supabase.from("members").update({ role: r }).eq("user_id", userId);
  }
  async function changeMemberName(userId: string, name: string) {
    await supabase.from("members").update({ name }).eq("user_id", userId);
  }
  async function changeMemberAccess(userId: string, access: ViewKey[] | null) {
    await supabase.from("members").update({ view_access: access }).eq("user_id", userId);
  }
  async function changeMemberEmploymentType(userId: string, employmentType: string | null) {
    await supabase.from("members").update({ employment_type: employmentType }).eq("user_id", userId);
  }
  async function loadUnits() {
    const { data } = await supabase.from("units").select("*").order("created_at", { ascending: false });
    setUnits((data as Unit[]) || []);
  }
  async function changeMemberPrinter(userId: string, field: "zebra_printer_name" | "a4_printer_name", value: string | null) {
    await supabase.from("members").update({ [field]: value }).eq("user_id", userId);
    await loadMembers();
  }
  async function loadMembers() {
    // Kolumny drukarek (schema.sql, 05.10.2026) mogą jeszcze nie istnieć — wtedy zwykły odczyt bez nich, żeby lista zespołu nie zniknęła.
    const full = await supabase.from("members").select("user_id, role, email, name, view_access, employment_type, zebra_printer_name, a4_printer_name").order("email");
    if (full.error && full.error.code === "42703") {
      const basic = await supabase.from("members").select("user_id, role, email, name, view_access, employment_type").order("email");
      setMembers((basic.data as Member[]) || []);
      return;
    }
    setMembers((full.data as Member[]) || []);
  }
  // Supabase (PostgREST) domyślnie zwraca max 1000 wierszy na zapytanie — przy > 1000
  // sztukach trzeba dociągać kolejne strony przez .range(), inaczej wynik się urywa.
  async function fetchAllStockCacheRows() {
    const PAGE = 1000;
    let from = 0;
    const all: { category_name: string; purchase_price_gross: number; description: string | null }[] = [];
    while (true) {
      const { data, error } = await supabase
        .from("fakturownia_stock_cache")
        .select("category_name, purchase_price_gross, description")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      all.push(...((data as any[]) || []));
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  // Rozbicie wg kategorii z SKU — z widoku (SKU liczone z Testów/Trade-in/importu). Dodatek do podsumowania: błąd
  // (np. brak widoku) zwraca null i nie blokuje reszty.
  async function fetchSkuBreakdown(): Promise<FakturowniaSku | null> {
    const PAGE = 1000;
    let from = 0;
    const rows: { name: string | null; sku_category: string | null; category_name: string | null; purchase_price_gross: number }[] = [];
    while (true) {
      const { data, error } = await supabase
        .from("fakturownia_stock_with_sku")
        .select("name, sku_category, category_name, purchase_price_gross")
        .range(from, from + PAGE - 1);
      if (error) return null;
      rows.push(...((data as any[]) || []));
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    // Dane z zakładki Towar (14.10.2026, na prośbę właściciela): sztuki bez SKU w widoku szukamy w rejestrze Towar po numerze seryjnym —
    // (1) nazwa wyglądająca jak SKU (bez spacji, z myślnikiem) daje kategorię z SKU jak zwykle; (2) w przeciwnym razie kategoria z arkusza Towaru
    // (Aparat, Watch, Konsola…) jako osobny wiersz "<kategoria> (Towar)" zamiast zbiorczego "Bez SKU". Bez dostępu do Towaru (RLS) lista jest pusta
    // i wykres działa jak dotąd.
    const goodsBySerial = new Map<string, { name: string | null; category: string | null }[]>();
    try {
      for (let gFrom = 0; ; gFrom += PAGE) {
        const { data: g, error: gErr } = await supabase.from("goods_register").select("serial, name, category").order("id").range(gFrom, gFrom + PAGE - 1);
        if (gErr) break;
        for (const x of (g as { serial: string | null; name: string | null; category: string | null }[]) || []) {
          const k = (x.serial || "").trim().toUpperCase();
          if (!k) continue;
          const list = goodsBySerial.get(k) ?? [];
          list.push({ name: x.name, category: x.category });
          goodsBySerial.set(k, list);
        }
        if (!g || g.length < PAGE) break;
      }
    } catch {
      /* Towar niedostępny — wykres bez dodatkowych danych */
    }
    // Populacja wykresów (14.10.2026): gdy jest dostęp do Towaru, wykresy liczą POZYCJE DOSTĘPNE Z TOWARU (cena PLN z rejestru) — te same liczby co kafelki wartości;
    // klasyfikację (SKU, kategoria z Fakturowni) bierzemy z dopasowanej sztuki magazynowej. Bez Towaru zostaje stary rachunek z cen Fakturowni.
    type Item = { textName: string | null; skuCategory: string | null; categoryName: string | null; value: number; goods: { name: string | null; category: string | null }[] };
    const normKey = (t: string) => t.trim().toLowerCase().replace(/^0+/, "");
    const stockKeys = (nm: string | null): string[] => {
      const t = (nm || "").trim();
      const out = new Set<string>([normKey(t)]);
      out.add(normKey(t.replace(/\s+/g, " ").split(" ")[0] || ""));
      const par = /\(([A-Za-z0-9]+)\)\s*$/.exec(t);
      if (par) out.add(normKey(par[1]));
      const last = /([A-Za-z0-9]+)$/.exec(t);
      if (last) out.add(normKey(last[1]));
      return Array.from(out).filter(Boolean);
    };
    let towarItems: Item[] | null = null;
    try {
      const avail: { serial: string | null; name: string | null; category: string | null; price_pln: number | string | null }[] = [];
      let okAll = true;
      for (let aFrom = 0; ; aFrom += PAGE) {
        const { data: a, error: aErr } = await supabase.from("goods_register_available").select("serial, name, category, price_pln").eq("available", true).order("id").range(aFrom, aFrom + PAGE - 1);
        if (aErr) {
          okAll = false;
          break;
        }
        avail.push(...((a as typeof avail) || []));
        if (!a || a.length < PAGE) break;
      }
      if (okAll && avail.length > 0) {
        const stockIdx = new Map<string, (typeof rows)[number]>();
        for (const r of rows) for (const k of stockKeys(r.name)) if (!stockIdx.has(k)) stockIdx.set(k, r);
        towarItems = avail.map((g) => {
          const st = stockIdx.get(normKey(g.serial || ""));
          return {
            textName: g.name || st?.name || null,
            skuCategory: st?.sku_category ?? null,
            categoryName: st?.category_name ?? null,
            value: Number(g.price_pln) || 0,
            goods: [{ name: g.name, category: g.category }],
          };
        });
      }
    } catch {
      towarItems = null;
    }
    const items: Item[] = towarItems ?? rows.map((r) => ({ textName: r.name, skuCategory: r.sku_category, categoryName: r.category_name, value: Number(r.purchase_price_gross) || 0, goods: goodsBySerial.get((r.name || "").trim().toUpperCase()) ?? [] }));
    const looksLikeSku = (n: string | null) => !!n && !/\s/.test(n.trim()) && n.includes("-");
    const goodsCategoryLabel = (c: string | null) => {
      const t = (c || "").trim().replace(/\d+$/, "").trim();
      if (!t) return null;
      const low = t.toLowerCase();
      const nice = low === "ipad" ? "iPad" : low === "iphone" ? "iPhone" : `${low.charAt(0).toUpperCase()}${low.slice(1)}`;
      return `${nice} (Towar)`;
    };
    const totals = new Map<string, FakturowniaCategorySummary>();
    const none = { count: 0, value: 0 };
    let count = 0;
    const groupTotals = new Map<string, FakturowniaCategorySummary>();
    for (const r of items) {
      const value = r.value;
      let category = r.skuCategory;
      let hasSku = !!category;
      const g = r.goods;
      if (!category) {
        const skuRow = g.find((x) => looksLikeSku(x.name));
        if (skuRow) {
          category = skuCategoryOf(skuRow.name) || null;
          hasSku = !!category;
        }
        if (!category) {
          const label = g.map((x) => goodsCategoryLabel(x.category)).find(Boolean);
          if (label) category = label;
        }
      }
      // grupa produktów (wykres ogólny): SKU (z widoku albo z Towaru) > kategoria z Fakturowni > kategoria z Towaru
      const grp = productGroupOf(category && !category.includes("(Towar)") ? category : null, [r.categoryName, ...g.map((x) => x.category)], r.textName);
      const ge = groupTotals.get(grp) || { name: grp, count: 0, value: 0 };
      ge.count += 1;
      ge.value += value;
      groupTotals.set(grp, ge);
      if (!category) {
        none.count += 1;
        none.value += value;
        continue;
      }
      category = chartVariantOf(category);
      const entry = totals.get(category) || { name: category, count: 0, value: 0 };
      entry.count += 1;
      entry.value += value;
      totals.set(category, entry);
      if (hasSku) count += 1;
    }
    // warianty -> rodziny (z wariantami jako `children`, gdy rodzina ma więcej niż samą siebie)
    const families = new Map<string, { name: string; count: number; value: number; variants: FakturowniaCategorySummary[] }>();
    for (const v of totals.values()) {
      const f = chartFamilyOf(v.name);
      const fam = families.get(f) || { name: f, count: 0, value: 0, variants: [] };
      fam.count += v.count;
      fam.value += v.value;
      fam.variants.push(v);
      families.set(f, fam);
    }
    const categories: FakturowniaCategorySummary[] = Array.from(families.values())
      .map((f) => ({
        name: f.name,
        count: f.count,
        value: f.value,
        children: f.variants.length > 1 || f.variants[0].name !== f.name ? [...f.variants].sort((a, b) => b.value - a.value) : undefined,
      }))
      .sort((a, b) => b.value - a.value);
    const order = [...PRODUCT_GROUPS, "Inne"] as string[];
    const groups = Array.from(groupTotals.values()).sort((a, b) => b.value - a.value || order.indexOf(a.name) - order.indexOf(b.name));
    return { count, categories, none, groups, total: items.length, totalValue: items.reduce((a, i) => a + i.value, 0), fromTowar: towarItems !== null };
  }

  // Wartości z zakładki Towar (14.10.2026, na prośbę właściciela): suma "Cena PLN" i "Cena + koszty (PLN)" pozycji DOSTĘPNYCH w Fakturowni (widok
  // goods_register_available). Dodatek do podsumowania — brak dostępu do Towaru (RLS), brak widoku albo błąd zwraca null i nie blokuje reszty.
  async function fetchGoodsValues(): Promise<GoodsValues | null> {
    try {
      const out: GoodsValues = { count: 0, pricePln: 0, totalPln: 0, noPrice: 0, noTotal: 0, servicePln: 0, commissionPln: 0, pccPln: 0 };
      type R = { price_pln: number | string | null; total_pln: number | string | null; costs: number | string | null; pcc: number | string | null; commission?: number | string | null; commission_pcc: number | string | null };
      let withCommission = true; // kolumna commission pojawia się po uruchomieniu goods-buyback.sql (+ ponownym goods-available.sql)
      for (let from = 0; ; from += 1000) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const run = (cols: string): PromiseLike<{ data: any; error: { message: string } | null }> =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase.from("goods_register_available") as any).select(cols).eq("available", true).order("id").range(from, from + 999);
        let res = await run(withCommission ? "price_pln, total_pln, costs, pcc, commission, commission_pcc" : "price_pln, total_pln, costs, pcc, commission_pcc");
        if (res.error && withCommission) {
          withCommission = false;
          res = await run("price_pln, total_pln, costs, pcc, commission_pcc");
        }
        if (res.error) return null;
        for (const r of ((res.data as unknown) as R[]) || []) {
          out.count += 1;
          if (r.price_pln === null) out.noPrice += 1;
          else out.pricePln += Number(r.price_pln);
          if (r.total_pln === null) out.noTotal += 1;
          else out.totalPln += Number(r.total_pln);
          out.servicePln += Number(r.costs ?? 0);
          const pcc = Number(r.pcc ?? 0);
          out.pccPln += pcc;
          const comm = r.commission ?? (r.commission_pcc !== null && r.commission_pcc !== undefined ? Number(r.commission_pcc) - pcc : 0);
          out.commissionPln += Number(comm ?? 0);
        }
        if (!res.data || res.data.length < 1000) break;
      }
      return out.count > 0 ? out : null;
    } catch {
      return null;
    }
  }

  // Koszty dodatkowe sztuk w magazynie (dziś: Trade-in). Zamówienia BM dopasowujemy po `description` sztuki (numer zamówienia), w paczkach po 60
  // identyfikatorów (limit długości URL); raz pobrane zamówienia zostają w pamięci podręcznej do końca sesji, żeby odświeżenia z realtime
  // nie odpytywały bazy od nowa. Dodatek do podsumowania — błąd zwraca null i nie blokuje reszty.
  const buybackOrderCache = useRef(new Map<string, BuybackOrderLite | null>());
  async function fetchStockCosts(descriptions: (string | null)[]): Promise<CostLine[] | null> {
    try {
      const ids = Array.from(new Set(descriptions.map((d) => (d || "").trim()).filter((d) => /^[A-Z]{2}-\d{5}-[A-Z0-9]{5}$/.test(d))));
      const missing = ids.filter((id) => !buybackOrderCache.current.has(id));
      const chunks: string[][] = [];
      for (let i = 0; i < missing.length; i += 60) chunks.push(missing.slice(i, i + 60));
      for (let i = 0; i < chunks.length; i += 6) {
        await Promise.all(
          chunks.slice(i, i + 6).map(async (chunk) => {
            const { data, error } = await supabase
              .from("buyback_orders")
              .select("order_public_id, status, product_title, sku, original_price, original_price_currency, counter_offer_price, counter_offer_price_currency, payment_date, creation_date")
              .in("order_public_id", chunk);
            if (error) throw error;
            for (const id of chunk) buybackOrderCache.current.set(id, null);
            for (const o of (data as BuybackOrderLite[]) || []) buybackOrderCache.current.set(o.order_public_id, o);
          })
        );
      }
      const orders = new Map<string, BuybackOrderLite>();
      for (const id of ids) {
        const o = buybackOrderCache.current.get(id);
        if (o) orders.set(id, o);
      }
      const { data: rateRows, error: rateErr } = await supabase.from("nbp_rates").select("currency, rate_date, mid").eq("currency", "EUR").limit(1000);
      if (rateErr) throw rateErr;
      const rates: NbpRate[] = (rateRows || []).map((r: any) => ({ currency: r.currency, rateDate: r.rate_date, mid: Number(r.mid) }));
      return [stockTradeInCosts(descriptions, orders, rates)];
    } catch {
      return null;
    }
  }

  // Czyta z bazy (fakturownia_stock_cache), a nie z Fakturowni bezpośrednio — dlatego
  // podsumowanie jest dostępne od razu po odświeżeniu strony, bez czekania na API.
  async function loadFakturowniaSummaryFromDb() {
    let rows: { category_name: string; purchase_price_gross: number; description: string | null }[];
    let metaRow: { last_synced_at: string } | null;
    let sku: FakturowniaSku | null = null;
    try {
      const [r, meta, skuData] = await Promise.all([
        fetchAllStockCacheRows(),
        supabase.from("fakturownia_sync_meta").select("last_synced_at").eq("id", 1).maybeSingle().throwOnError(),
        fetchSkuBreakdown(),
      ]);
      rows = r;
      metaRow = meta.data;
      sku = skuData;
    } catch (e: any) {
      setFakturowniaError(`Nie udało się wczytać podsumowania z bazy: ${e.message || e}`);
      return;
    }

    const totals = new Map<string, FakturowniaCategorySummary>();
    let totalCount = 0;
    let totalValue = 0;
    for (const r of rows) {
      const entry = totals.get(r.category_name) || { name: r.category_name, count: 0, value: 0 };
      entry.count += 1;
      entry.value += Number(r.purchase_price_gross) || 0;
      totals.set(r.category_name, entry);
      totalCount += 1;
      totalValue += Number(r.purchase_price_gross) || 0;
    }

    const [costs, goods] = await Promise.all([fetchStockCosts(rows.map((r) => r.description)), fetchGoodsValues()]);
    setFakturowniaError("");
    setFakturowniaSummary({
      totalCount,
      totalValue,
      sku,
      costs,
      goods,
      categories: Array.from(totals.values()).sort((a, b) => b.value - a.value),
    });
    setFakturowniaLastSynced((metaRow?.last_synced_at as string) ?? null);
  }

  // Woła serwer, który dociąga zmiany z Fakturowni i zapisuje je do bazy —
  // efekt widzimy przez subskrypcję realtime powyżej (lub od razu po zakończeniu, tutaj).
  async function refreshFakturownia() {
    setFakturowniaLoading(true);
    setFakturowniaError("");
    try {
      const res = await fetch("/api/fakturownia/sync", {
        headers: { Authorization: `Bearer ${session!.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Nie udało się zsynchronizować danych z Fakturowni.");
      await loadFakturowniaSummaryFromDb();
      setRawReloadKey((n) => n + 1);
    } catch (e: any) {
      setFakturowniaError(e.message || "Nie udało się zsynchronizować danych z Fakturowni.");
    } finally {
      setFakturowniaLoading(false);
    }
  }

  const ready = units.filter((u) => u.status === "Gotowe do sprzedaży").length;

  if (session === undefined) return <div className="min-h-screen flex items-center justify-center text-inksoft text-sm">Ładowanie…</div>;
  if (!session) return <LoginScreen />;
  if (role === undefined)
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-inksoft text-sm">
        {roleError ? (
          <>
            <span>Nie udało się wczytać Twojej roli ({roleError}).</span>
            <button onClick={() => loadRole()} className="font-semibold text-teal hover:underline">Spróbuj ponownie</button>
            <button onClick={() => supabase.auth.signOut()} className="text-xs text-inksoft hover:underline">Wyloguj i zaloguj się na inne konto</button>
          </>
        ) : (
          "Ładowanie…"
        )}
      </div>
    );
  if (role === "") return <NoRoleScreen email={session.user.email ?? ""} onRetry={() => loadRole()} />;

  return (
    <div className="min-h-screen flex">
      <aside className="w-36 shrink-0 bg-panel border-r border-line p-3 flex flex-col">
        <SpaceSwitcher
          current={spaceOf(view)}
          allowed={effectiveAccess(role ?? "", viewAccess)}
          onSwitch={(space) => {
            const allowed = effectiveAccess(role ?? "", viewAccess);
            const saved = localStorage.getItem(`magazyn-view-${space}`) as ViewKey | null;
            const target =
              saved && spaceOf(saved) === space && allowed.includes(saved)
                ? saved
                : TABS.find((t) => spaceOf(t.key) === space && allowed.includes(t.key))?.key;
            if (target) setView(target);
          }}
        />
        {tracksWorkTime(role) && <RcpWidget session={session} role={role ?? ""} onOpenRcp={() => effectiveAccess(role ?? "", viewAccess).includes("rcp") && setView("rcp")} />}
        <nav className="flex flex-col gap-1">
          {navSections(spaceOf(view), effectiveAccess(role ?? "", viewAccess)).map((g, gi) => {
            const collapsed = !!g.title && collapsedGroups.includes(g.title);
            const shown = collapsed ? g.tabs.filter((t) => t.key === view) : g.tabs; // w zwiniętej grupie zostaje widoczna aktywna zakładka
            return (
              <div key={g.title ?? `g${gi}`} className={gi > 0 && g.title ? "mt-3" : ""}>
                {g.title && (
                  <button onClick={() => toggleGroup(g.title!)} aria-expanded={!collapsed} className="w-full flex items-center justify-between gap-2 px-2 pb-1 text-left text-[10px] font-semibold uppercase tracking-wide text-inksoft/70 hover:text-ink">
                    <span className="whitespace-nowrap text-left">{g.title}</span>
                    <span className="text-[9px]">{collapsed ? "▸" : "▾"}</span>
                  </button>
                )}
                <div className="flex flex-col gap-1">
                  {shown.map((t) => (
                    <button key={t.key} onClick={() => setView(t.key)} className={`text-left px-2 py-2 rounded text-sm font-medium ${view === t.key ? "bg-white border border-line" : "text-inksoft"}`}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="mt-auto text-xs text-inksoft">
          <div className="font-semibold text-ink truncate" title={session.user.email ?? undefined}>{displayNameForEmail(session.user.email, members)}</div>
          <div>{role}</div>
          <button onClick={() => supabase.auth.signOut()} className="mt-2 underline">Wyloguj</button>
          <div className="mt-4">
            <ThemeSwitcher />
          </div>
        </div>
      </aside>

      <main className="flex-1">
        {(role === "Admin" || role === "Manager" || role === "Księgowa" || role === "Serwis" || role === "Kierownik serwisu") && <ReminderBanners session={session} role={role} onOpen={(v) => setView(v as ViewKey)} />}
        {/* Tytuł zakładki usunięty (10.10.2026) — zajmował miejsce; pasek zostaje tylko w Magazynie, bo trzyma przycisk "Odśwież". */}
        {view === "inventory" && (
        <div className="flex items-center justify-end px-8 py-3 border-b border-line">
          {view === "inventory" && (
            <div className="flex items-center gap-3">
              <button
                onClick={refreshFakturownia}
                disabled={fakturowniaLoading}
                className="bg-white border border-line px-4 py-2 rounded text-sm font-semibold disabled:opacity-50"
              >
                {fakturowniaLoading ? "Odświeżanie…" : "Odśwież"}
              </button>
              <span className="text-xs text-inksoft lowercase">
                {fakturowniaLastSynced ? `ostatnia aktualizacja: ${fmtDateTime(fakturowniaLastSynced)}` : "brak jeszcze synchronizacji"}
              </span>
            </div>
          )}
        </div>
        )}

        <div className="p-8">
          {view === "overview" && (
            <div>
              <OverviewSalesDashboard session={session} />
              <OverviewMarginChart session={session} />
              <div className="grid grid-cols-4 gap-px bg-line border border-line">
                <div className="bg-white p-5"><div className="text-xs text-inksoft mb-2">URZĄDZENIA</div><div className="text-3xl font-bold font-mono">{(fakturowniaSummary?.goods?.count ?? fakturowniaSummary?.totalCount ?? 0).toLocaleString("pl-PL")}</div></div>
                <div className="bg-white p-5"><div className="text-xs text-inksoft mb-2">WARTOŚĆ MAGAZYNU</div><div className="text-3xl font-bold font-mono">{fmtPLN(fakturowniaSummary?.goods?.pricePln ?? fakturowniaSummary?.totalValue ?? 0)}</div></div>
                <div className="bg-white p-5"><div className="text-xs text-inksoft mb-2">GOTOWE DO SPRZEDAŻY</div><div className="text-3xl font-bold font-mono">{ready}</div></div>
                <div className="bg-white p-5"><div className="text-xs text-inksoft mb-2">W NAPRAWIE</div><div className="text-3xl font-bold font-mono">{units.filter((u) => u.status === "W naprawie").length}</div></div>
              </div>
            </div>
          )}

          {view === "inventory" && (
            <div>
              <div className="flex gap-2 mb-4">
                {(
                  [
                    ["summary", "Podsumowanie"],
                    ["raw", "Raw data"],
                    ["catalog", "Katalog konsol"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setInvSub(k)}
                    className={`px-3 py-1.5 rounded-full text-sm font-semibold border ${invSub === k ? "bg-ink text-paper border-ink" : "bg-white border-line"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {fakturowniaError && <p className="text-rust text-xs mb-3">{fakturowniaError}</p>}

              {invSub === "summary" && fakturowniaSummary && (
                <div>
                  <h2 className="text-xs font-semibold text-inksoft mb-2">PODSUMOWANIE Z FAKTUROWNI (stan magazynowy = 1)</h2>
                  <FakturowniaSummaryView summary={fakturowniaSummary} />
                </div>
              )}

              {invSub === "raw" && <InventoryRawView reloadKey={rawReloadKey} members={members} />}

              {invSub === "catalog" && <ConsoleCatalogView isAdmin={role === "Admin"} canSeePrices={role === "Admin" || role === "Manager" || role === "Księgowa"} />}
            </div>
          )}

          {view === "sales" && <SalesOrdersHub
              session={session}
              members={members}
              isAdmin={role === "Admin"}
              readOnly={!["Admin", "Manager", "Księgowa", "Zamówienia"].includes(role ?? "")}
              role={role ?? ""}
              canShip={effectiveAccess(role ?? "", viewAccess, []).includes("shipping")}
              onShip={(p) => {
                setShipPrefill(p);
                setView("shipping");
              }}
            />}

          {view === "team" && (
            <TeamView
              members={members}
              currentUserId={session.user.id}
              canEdit={role === "Admin"}
              onChangeRole={changeMemberRole}
              onChangeName={changeMemberName}
              onChangeAccess={changeMemberAccess}
              onChangeEmploymentType={changeMemberEmploymentType}
              onChangePrinter={changeMemberPrinter}
            />
          )}

          {view === "service" && <ServiceHub session={session} members={members} role={role} isAdmin={role === "Admin"} isAdminOrManager={role === "Admin" || role === "Manager" || role === "Księgowa"} isServiceLead={role === "Kierownik serwisu"} />}

          {view === "tests" && <TestsView session={session} members={members} isAdmin={role === "Admin"} isAdminOrManager={role === "Admin" || role === "Manager" || role === "Księgowa"} />}

          {view === "tradein" && <TradeInView session={session} members={members} />}

          {view === "shipping" && (
            <ShippingView session={session} isAdmin={role === "Admin"} canEditRules={role === "Admin" || role === "Manager" || role === "Księgowa"} members={members} prefill={shipPrefill} onPrefillUsed={() => setShipPrefill(null)} />
          )}

          {view === "invoices" && <InvoicesView session={session} members={members} />}

          {view === "margin" && <MarginView session={session} members={members} />}
          {view === "goods" && <GoodsView session={session} members={members} isAdmin={role === "Admin"} canSend={role === "Admin" || role === "Manager" || role === "Księgowa"} />}
          {view === "toList" && <ListingQueueView session={session} members={members} />}
          {view === "listings" && <ListingsView session={session} />}
          {view === "points" && <PointsView session={session} members={members} />}

          {view === "nbp" && <NbpView session={session} />}
          {view === "costs" && <CostInvoicesView session={session} />}

          {view === "ai" && <AiView session={session} />}

          {view === "reminders" && role === "Admin" && <RemindersView session={session} />}
          {view === "rcp" && <RcpView session={session} role={role} members={members} />}

          {view === "returns" && <ReturnsView />}

          {view === "shop_products" && <ShopProductsView session={session} members={members} isAdmin={role === "Admin"} />}

          {view === "shop_stock" && <ShopStockView members={members} />}

          {view === "backlog" && <BacklogView session={session} members={members} isAdmin={role === "Admin"} />}

          {view === "orders" && <TradeInHub session={session} members={members} isAdmin={role === "Admin"} isAdminOrManager={role === "Admin" || role === "Manager" || role === "Księgowa"} />}
        </div>
      </main>

    </div>
  );
}

/* ---------------- podsumowanie Fakturowni (magazyn) ---------------- */

// Stała, walidowana kolejność barw kategorycznych (skill dataviz) — max 5 realnych
// kategorii + "Inne", zgodnie z zasadą "part-to-whole na pierwszy rzut oka, <= 6 wycinków".

function fmtPLN(n: number) {
  return Math.round(n).toLocaleString("pl-PL") + " zł";
}

function FakturowniaSummaryView({ summary }: { summary: FakturowniaSummary }) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-px bg-line border border-line mb-6">
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">DOSTĘPNE PRODUKTY {summary.goods ? "(z Towaru)" : "(stan = 1)"}</div>
          <div className="text-3xl font-bold font-mono">{(summary.goods?.count ?? summary.totalCount).toLocaleString("pl-PL")}</div>
          {summary.sku !== null && (
            <div className="text-xs text-inksoft mt-2">
              z SKU: <span className="font-semibold text-ink">{summary.sku.count.toLocaleString("pl-PL")}</span>
              {(summary.sku.total || summary.totalCount) > 0 && ` (${Math.round((summary.sku.count / (summary.sku.total || summary.totalCount)) * 100)}%)`}
              {" · "}bez SKU: <span className="font-semibold text-ink">{((summary.sku.total || summary.totalCount) - summary.sku.count).toLocaleString("pl-PL")}</span>
            </div>
          )}
        </div>
        {/* Wartości z rejestru Towar (14.10.2026, na prośbę właściciela): to "rzeczywiste" liczby magazynu (cena PLN + serwis + prowizja/logistyka + PCC) dla pozycji
            dostępnych w Fakturowni. Bez dostępu do Towaru (albo bez widoku) kafelki wracają do liczb z samej Fakturowni. */}
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">ŁĄCZNA WARTOŚĆ (ceny zakupu)</div>
          <div className="text-3xl font-bold font-mono">{fmtPLN(summary.goods ? summary.goods.pricePln : summary.totalValue)}</div>
          <div className="text-xs text-inksoft mt-2">
            {summary.goods ? (
              <>
                z Towaru, {summary.goods.count.toLocaleString("pl-PL")} dostępnych pozycji
                {summary.goods.noPrice > 0 && <span> · {summary.goods.noPrice} bez ceny</span>}
              </>
            ) : (
              "z Fakturowni (stan = 1)"
            )}
          </div>
        </div>
        {summary.goods ? (
          <>
            <div className="bg-white p-5">
              <div className="text-xs text-inksoft mb-2">KOSZTY DODATKOWE</div>
              <div className="text-sm space-y-2">
                <div className="flex justify-between gap-4">
                  <span>Serwis (części przypisane do numeru seryjnego)</span>
                  <span className="font-mono font-semibold">{fmtPLN(summary.goods.servicePln)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span>Prowizja Back Market 10% + logistyka</span>
                  <span className="font-mono font-semibold">{fmtPLN(summary.goods.commissionPln)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span>PCC (2% od wartości powyżej 1000 zł)</span>
                  <span className="font-mono font-semibold">{fmtPLN(summary.goods.pccPln)}</span>
                </div>
              </div>
              <div className="text-[11px] text-inksoft mt-3">
                Z rejestru Towar (pozycje dostępne). Prowizja i logistyka wg regulaminu Back Market, EUR → PLN kursem NBP z dnia poprzedniego względem płatności — szacunek, nie faktura.
              </div>
            </div>
            <div className="bg-white p-5">
              <div className="text-xs text-inksoft mb-2">ŁĄCZNA WARTOŚĆ + KOSZTY</div>
              <div className="text-3xl font-bold font-mono">{fmtPLN(summary.goods.totalPln)}</div>
              <div className="text-xs text-inksoft mt-2">
                ceny zakupu {fmtPLN(summary.goods.pricePln)} + koszty {fmtPLN(summary.goods.totalPln - summary.goods.pricePln)}
                {summary.goods.noTotal > 0 && <span> · {summary.goods.noTotal} pozycji bez sumy</span>}
              </div>
            </div>
          </>
        ) : (
          summary.costs && (
            <>
              <div className="bg-white p-5">
                <div className="text-xs text-inksoft mb-2">KOSZTY DODATKOWE (dziś tylko Trade-in)</div>
                <div className="text-sm space-y-2">
                  {summary.costs.map((c) => (
                    <div key={c.key}>
                      <div className="flex justify-between gap-4">
                        <span>{c.label}</span>
                        <span className="font-mono font-semibold">{fmtPLN(c.amountPln)}</span>
                      </div>
                      <div className="text-[11px] text-inksoft">{c.detail}</div>
                    </div>
                  ))}
                </div>
                <div className="text-[11px] text-inksoft mt-3">
                  Wg regulaminu Back Market (netto, EUR → PLN kursem NBP z dnia poprzedniego). Bez kosztów serwisu.
                </div>
              </div>
              <div className="bg-white p-5">
                <div className="text-xs text-inksoft mb-2">ŁĄCZNA WARTOŚĆ + KOSZTY</div>
                <div className="text-3xl font-bold font-mono">{fmtPLN(summary.totalValue + summary.costs.reduce((acc, c) => acc + c.amountPln, 0))}</div>
                <div className="text-xs text-inksoft mt-2">
                  ceny zakupu {fmtPLN(summary.totalValue)} + koszty {fmtPLN(summary.costs.reduce((acc, c) => acc + c.amountPln, 0))}
                </div>
              </div>
            </>
          )
        )}
      </div>

      {summary.categories.length === 0 ? (
        <div className="border border-line bg-white p-10 text-center text-inksoft text-sm">
          Brak produktów ze stanem magazynowym = 1.
        </div>
      ) : (
        // Dwa wykresy obok siebie, każdy na pół szerokości (02.10.2026): kategorie z Fakturowni i kategorie z SKU.
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <CategoryBreakdown
            title={summary.sku ? "WG GRUP PRODUKTÓW" : "WG KATEGORII Z FAKTUROWNI"}
            categories={summary.sku ? summary.sku.groups : summary.categories}
            totalValue={summary.sku ? summary.sku.totalValue : summary.totalValue}
            note={summary.sku ? "Konsole (NS, PS4, PS5, XOS, XSX…), Apple Watch, Aparat, Samsung Watch, iPad, iPhone, Samsung, Macbook, Audio. Grupa wynika z SKU, a gdy go brak — z kategorii w Fakturowni / Towarze." : undefined}
          />
          {summary.sku ? (
            <CategoryBreakdown
              title="WG KATEGORII Z SKU"
              categories={summary.sku.categories}
              totalValue={summary.sku.totalValue}
              none={summary.sku.none}
              maxRows={FAKTUROWNIA_PALETTE.length * 2}
              pinned={SKU_CHART_PINNED}
              note="Kliknij wiersz z ▸, żeby zobaczyć warianty (np. PS4 → PS4, PS4S, PS4P). Rodzina zbiera SKU zaczynające się tak samo, np. ID = wszystkie iPady, AW = Apple Watch."
            />
          ) : (
            <div className="border border-line bg-white p-6 text-sm text-inksoft">
              Wykres wg kategorii z SKU pojawi się po uruchomieniu <span className="font-mono">supabase/inventory.sql</span>.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- zespół ---------------- */

function TeamView({
  members,
  currentUserId,
  canEdit,
  onChangeRole,
  onChangeName,
  onChangeAccess,
  onChangeEmploymentType,
  onChangePrinter,
}: {
  members: Member[];
  currentUserId: string;
  canEdit: boolean; // role i imiona zmienia tylko Admin (polityka w bazie); reszta widzi listę tylko do odczytu
  onChangeRole: (userId: string, role: string) => void;
  onChangeName: (userId: string, name: string) => void;
  onChangeAccess: (userId: string, access: ViewKey[] | null) => void;
  onChangeEmploymentType: (userId: string, employmentType: string | null) => void;
  onChangePrinter: (userId: string, field: "zebra_printer_name" | "a4_printer_name", value: string | null) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Imię i nazwisko to zwykły tekst; dopiero "Zmień" (tylko Admin) otwiera pole, żeby nie dało się go przypadkiem edytować.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Dostęp do zakładek i dane pracownika (forma zatrudnienia) edytuje się w osobnym oknie (30.09.2026) —
  // wcześniej cała siatka checkboxów siedziała wprost w wierszu tabeli, co robiło się nieczytelne.
  const [editingAccessId, setEditingAccessId] = useState<string | null>(null);

  function cancelEdit(userId: string) {
    setDrafts(({ [userId]: _omit, ...rest }) => rest);
    setEditingId(null);
  }

  const cancelled = useRef(false);

  function saveName(userId: string, value: string) {
    const skip = cancelled.current;
    cancelled.current = false;
    if (skip) return cancelEdit(userId); // Escape: porzuć zmianę
    const current = members.find((m) => m.user_id === userId)?.name ?? "";
    if (value.trim() !== current.trim()) onChangeName(userId, value.trim());
    cancelEdit(userId);
  }

  const editingMember = members.find((m) => m.user_id === editingAccessId) ?? null;

  return (
    <div className="border border-line bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-inksoft border-b border-line">
            <th className="p-3 w-10">Lp.</th>
            <th className="p-3">Użytkownik</th>
            <th className="p-3">Email</th>
            <th className="p-3">Rola</th>
            <th className="p-3">Dostęp do zakładek</th>
          </tr>
        </thead>
        <tbody>
          {members.length === 0 && (
            <tr><td colSpan={5} className="p-6 text-center text-inksoft text-sm">Brak członków zespołu.</td></tr>
          )}
          {members.map((m, idx) => {
            const draft = drafts[m.user_id];
            return (
              <tr key={m.user_id} className="border-b border-line last:border-b-0">
                <td className="p-3 text-xs text-inksoft">{idx + 1}</td>
                <td className="p-3">
                  {editingId === m.user_id ? (
                    <input
                      autoFocus
                      value={draft ?? m.name ?? ""}
                      onChange={(e) => setDrafts({ ...drafts, [m.user_id]: e.target.value })}
                      onBlur={(e) => saveName(m.user_id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                        if (e.key === "Escape") {
                          cancelled.current = true;
                          (e.currentTarget as HTMLInputElement).blur();
                        }
                      }}
                      placeholder="Imię i nazwisko"
                      className="w-full border border-line bg-white px-2 py-1.5 rounded text-sm font-semibold"
                    />
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="font-semibold">{m.name || "—"}</span>
                      {canEdit && (
                        <button onClick={() => setEditingId(m.user_id)} className="text-xs font-semibold text-teal hover:underline">
                          Zmień
                        </button>
                      )}
                    </div>
                  )}
                </td>
                <td className="p-3 text-inksoft">{m.email || "—"}</td>
                <td className="p-3">
                  <select
                    value={m.role}
                    onChange={(e) => onChangeRole(m.user_id, e.target.value)}
                    disabled={!canEdit || m.user_id === currentUserId}
                    title={
                      !canEdit
                        ? "Role zmienia tylko Admin."
                        : m.user_id === currentUserId
                          ? "Nie możesz zmienić własnej roli — poproś innego Admina."
                          : undefined
                    }
                    className="text-xs font-semibold px-2 py-1 rounded-full bg-tealsoft text-teal border-none disabled:opacity-60"
                  >
                    {!m.role && <option value="">— brak roli —</option>}
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setEditingAccessId(m.user_id)} className="text-xs font-semibold text-teal hover:underline">
                      {canEdit ? "Edytuj" : "Pokaż"}
                    </button>
                    {m.view_access !== null && <span className="text-xs text-inksoft">dostosowany</span>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {editingMember && (
        <MemberEditDrawer
          member={editingMember}
          canEdit={canEdit}
          onChangeAccess={onChangeAccess}
          onChangeEmploymentType={onChangeEmploymentType}
          onChangePrinter={onChangePrinter}
          onClose={() => setEditingAccessId(null)}
        />
      )}
    </div>
  );
}

// Okno edycji jednego pracownika (30.09.2026): dostęp do zakładek (dawniej siatka checkboxów wprost w wierszu
// tabeli Zespołu) i dane pracownicze (na razie forma zatrudnienia). Tylko Admin edytuje (polityka w bazie i tak
// by to zablokowała) — reszta widzi okno w trybie tylko do odczytu, żeby dało się sprawdzić czyjś dostęp.
function MemberEditDrawer({
  member,
  canEdit,
  onChangeAccess,
  onChangeEmploymentType,
  onChangePrinter,
  onClose,
}: {
  member: Member;
  canEdit: boolean;
  onChangeAccess: (userId: string, access: ViewKey[] | null) => void;
  onChangeEmploymentType: (userId: string, employmentType: string | null) => void;
  onChangePrinter: (userId: string, field: "zebra_printer_name" | "a4_printer_name", value: string | null) => void;
  onClose: () => void;
}) {
  // Przegląd nie jest już twardo wymuszony (od 02.10.2026 to zwykła zakładka jak każda inna — domyślnie
  // tylko Admin/Manager, ale Admin może ją komuś przywrócić tu, tak jak każdą inną). Jedyna pozostała
  // ochrona: nie da się odznaczyć OSTATNIEJ zaznaczonej zakładki — inaczej dana osoba zostałaby bez
  // żadnej zakładki do kliknięcia po zalogowaniu.
  function toggleAccess(key: ViewKey) {
    const current = effectiveAccess(member.role, member.view_access);
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    if (next.length === 0) return;
    onChangeAccess(member.user_id, next as ViewKey[]);
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-50" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg bg-paper h-full overflow-y-auto p-6 border-l border-line">
        <div className="flex justify-between items-start mb-6">
          <div>
            <div className="text-xs text-inksoft">PRACOWNIK</div>
            <h2 className="text-lg font-semibold">{member.name || member.email || "—"}</h2>
            <div className="text-xs text-inksoft">{member.email}</div>
          </div>
          <button onClick={onClose} className="text-inksoft text-lg">✕</button>
        </div>

        <h3 className="text-xs font-semibold text-inksoft mb-2">DANE PRACOWNICZE</h3>
        <div className="border border-line bg-white p-4 mb-6">
          <label className="text-xs font-semibold text-inksoft block mb-1">Forma zatrudnienia</label>
          <select
            value={member.employment_type ?? ""}
            onChange={(e) => onChangeEmploymentType(member.user_id, e.target.value || null)}
            disabled={!canEdit}
            className="w-full border border-line bg-white px-2 py-2 rounded text-sm disabled:opacity-60"
          >
            <option value="">— nie ustawiono —</option>
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        <h3 className="text-xs font-semibold text-inksoft mb-2">DRUKARKI (drukowanie bezpośrednie z Wysyłki)</h3>
        <div className="border border-line bg-white p-4 mb-6">
          <p className="text-xs text-inksoft mb-3">Nazwy dokładnie jak w Windowsie na komputerze tej osoby (QZ Tray musi tam działać). Puste = drukarki domyślne z Wysyłki → „Zmień dane nadawcy”.</p>
          {([["zebra_printer_name", "Drukarka etykiet (Zebra)"], ["a4_printer_name", "Drukarka A4 (packing slip)"]] as const).map(([field, labelText]) => (
            <div key={field} className="mb-3 last:mb-0">
              <label className="text-xs font-semibold text-inksoft block mb-1">{labelText}</label>
              <input
                key={`${member.user_id}-${field}`}
                defaultValue={member[field] ?? ""}
                disabled={!canEdit}
                placeholder="— domyślna —"
                onBlur={(e) => {
                  const v = e.target.value.trim() || null;
                  if (v !== (member[field] ?? null)) onChangePrinter(member.user_id, field, v);
                }}
                className="w-full border border-line bg-white px-2 py-2 rounded text-sm disabled:opacity-60"
              />
            </div>
          ))}
        </div>

        <h3 className="text-xs font-semibold text-inksoft mb-2">DOSTĘP DO ZAKŁADEK</h3>
        <div className="border border-line bg-white p-4">
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {TABS.map((t) => {
              const checked = effectiveAccess(member.role, member.view_access).includes(t.key);
              return (
                <label key={t.key} className={`flex items-center gap-2 text-sm ${canEdit ? "cursor-pointer" : ""} ${checked ? "text-ink" : "text-inksoft"}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!canEdit}
                    onChange={() => toggleAccess(t.key)}
                  />
                  {t.space === "shop" ? `Sklep: ${t.label}` : t.label}
                </label>
              );
            })}
          </div>
          {canEdit && member.view_access !== null && (
            <button onClick={() => onChangeAccess(member.user_id, null)} className="text-xs font-semibold text-teal hover:underline mt-3">
              Resetuj do domyślnych (rola)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- przełącznik Recoo ERP / Recoo Sklep ---------------- */

// Nazwa w lewym górnym rogu. Gdy osoba ma dostęp tylko do jednej przestrzeni, to zwykły napis (bez przełącznika).
// Nagłówek paska bocznego (06.10.2026): napis "Recoo", a pod nim wybór przestrzeni — ERP albo SKLEP (dwa przyciski obok siebie, bez rozwijanej listy).
// Osoba z dostępem tylko do jednej przestrzeni widzi sam napis "Recoo" z nazwą tej przestrzeni.
const SPACE_SHORT: Record<Space, string> = { erp: "ERP", shop: "SKLEP" };
function SpaceSwitcher({ current, allowed, onSwitch }: { current: Space; allowed: ViewKey[]; onSwitch: (s: Space) => void }) {
  const spaces = (Object.keys(SPACE_NAMES) as Space[]).filter((s) => TABS.some((t) => spaceOf(t.key) === s && allowed.includes(t.key)));
  return (
    <div className="mb-6">
      <div className="font-bold text-lg">Recoo</div>
      {spaces.length < 2 ? (
        <div className="text-xs font-semibold text-inksoft mt-1">{SPACE_SHORT[current]}</div>
      ) : (
        <div role="radiogroup" aria-label="Przestrzeń: ERP lub Sklep" className="flex gap-1 mt-2 p-0.5 rounded border border-line bg-white">
          {spaces.map((s) => (
            <button
              key={s}
              role="radio"
              aria-checked={s === current}
              onClick={() => s !== current && onSwitch(s)}
              className={`flex-1 px-2 py-1 rounded text-xs font-bold ${s === current ? "bg-ink text-paper" : "text-inksoft hover:text-ink"}`}
            >
              {SPACE_SHORT[s]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
