"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import TradeInView from "./_components/TradeInView";
import TradeInHub from "./_components/TradeInHub";
import SalesOrdersHub from "./_components/SalesOrdersHub";
import BacklogView from "./_components/BacklogView";
import ShippingView from "./_components/ShippingView";
import RcpView from "./_components/RcpView";
import ReturnsView from "./_components/ReturnsView";
import type { ShipPrefill } from "@/lib/shipping";
import ServiceView from "./_components/ServiceView";
import TestsView from "./_components/TestsView";
import InventoryRawView from "./_components/InventoryRawView";
import ThemeSwitcher from "./_components/ThemeSwitcher";
import { displayNameForEmail } from "@/lib/displayName";

const ROLES = ["Admin", "Manager", "Magazyn", "Zamówienia", "Serwis", "Testy", "Bidder", "Trade-in"];

type ViewKey = "overview" | "inventory" | "sales" | "team" | "service" | "tests" | "tradein" | "orders" | "backlog" | "shipping" | "rcp" | "returns";

const TABS: { key: ViewKey; label: string }[] = [
  { key: "overview", label: "Przegląd" },
  { key: "inventory", label: "Magazyn" },
  { key: "sales", label: "Zamówienia" },
  { key: "team", label: "Zespół" },
  { key: "service", label: "Serwis" },
  { key: "tests", label: "Testy" },
  { key: "tradein", label: "Bidder" },
  { key: "orders", label: "Trade-in" },
  { key: "backlog", label: "Backlog" },
  { key: "shipping", label: "Wysyłka" },
  { key: "rcp", label: "RCP" },
  { key: "returns", label: "Zwroty" },
];

// Kto widzi jaką zakładkę — DOMYŚLNY zestaw wg roli, Admin ma dostęp do wszystkiego,
// Przegląd jest wspólną stroną startową dla każdej roli. Admin może to nadpisać per
// osoba w Zespole (checkboxy przy każdej zakładce, `members.view_access` — patrz
// `effectiveAccess`); ta mapa jest tylko domyślnym punktem startowym dla nowej roli
// i dla osób, których nikt jeszcze nie dotknął ręcznie (view_access = NULL). Na razie
// to tylko filtruje nawigację w tej przeglądarce — to nie jest twarde zabezpieczenie
// (RLS pozwala każdemu authenticated na wszystko, patrz supabase/schema.sql).
// "orders" (zakładka Trade-in — podgląd zamówień BuyBack) na razie tylko dla Admina,
// dopóki nie ustalimy docelowej roli dla osoby przetwarzającej zamówienia.
const ROLE_ACCESS: Record<string, ViewKey[]> = {
  Admin: ["overview", "inventory", "sales", "team", "service", "tests", "tradein", "orders", "backlog", "shipping", "rcp", "returns"],
  Manager: ["overview", "inventory", "sales", "team", "service", "tests", "tradein", "orders", "backlog", "shipping", "rcp", "returns"], // wszystko; Zespół tylko do odczytu, usuwa tylko Admin
  Magazyn: ["overview", "inventory", "backlog", "rcp", "returns"],
  Zamówienia: ["overview", "sales", "shipping", "backlog", "rcp", "returns"],
  Serwis: ["overview", "service", "backlog", "rcp", "returns"],
  Testy: ["overview", "tests", "backlog", "rcp", "returns"],
  Bidder: ["overview", "tradein", "backlog", "rcp", "returns"],
  "Trade-in": ["overview", "orders", "backlog", "rcp", "returns"],
};

type Member = { user_id: string; role: string; email: string; name: string; view_access: string[] | null };

// Dostęp do zakładek dla danego członka zespołu: view_access (jeśli ustawiony przez Admina w Zespole) nadpisuje
// domyślny zestaw z ROLE_ACCESS dla jego roli. NULL = jeszcze nikt tego nie dotykał, używamy domyślnego wg roli.
function effectiveAccess(role: string, viewAccess: string[] | null | undefined, fallback: ViewKey[] = ["overview", "inventory"]): ViewKey[] {
  return (viewAccess as ViewKey[] | null | undefined) ?? ROLE_ACCESS[role] ?? fallback;
}

type FakturowniaCategorySummary = { name: string; count: number; value: number };
type FakturowniaSummary = { totalCount: number; totalValue: number; categories: FakturowniaCategorySummary[] };

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

function fmtEUR(n: number) {
  return "€" + (n || 0).toLocaleString("pl-PL", { maximumFractionDigits: 0 });
}

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
  const [shipPrefill, setShipPrefill] = useState<ShipPrefill | null>(null); // dane z karty zamówienia do formularza przesyłki
  const [invSub, setInvSub] = useState<"summary" | "raw">("summary");
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

  // jeśli rola nie ma już dostępu do aktualnie otwartej zakładki (np. zmieniła się rola), wróć do Przeglądu
  useEffect(() => {
    if (!role) return;
    const allowed = effectiveAccess(role, viewAccess);
    if (!allowed.includes(view)) setView("overview");
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
  async function loadUnits() {
    const { data } = await supabase.from("units").select("*").order("created_at", { ascending: false });
    setUnits((data as Unit[]) || []);
  }
  async function loadMembers() {
    const { data } = await supabase.from("members").select("user_id, role, email, name, view_access").order("email");
    setMembers((data as Member[]) || []);
  }
  // Supabase (PostgREST) domyślnie zwraca max 1000 wierszy na zapytanie — przy > 1000
  // sztukach trzeba dociągać kolejne strony przez .range(), inaczej wynik się urywa.
  async function fetchAllStockCacheRows() {
    const PAGE = 1000;
    let from = 0;
    const all: { category_name: string; purchase_price_gross: number }[] = [];
    while (true) {
      const { data, error } = await supabase
        .from("fakturownia_stock_cache")
        .select("category_name, purchase_price_gross")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      all.push(...((data as any[]) || []));
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  // Czyta z bazy (fakturownia_stock_cache), a nie z Fakturowni bezpośrednio — dlatego
  // podsumowanie jest dostępne od razu po odświeżeniu strony, bez czekania na API.
  async function loadFakturowniaSummaryFromDb() {
    let rows: { category_name: string; purchase_price_gross: number }[];
    let metaRow: { last_synced_at: string } | null;
    try {
      const [r, meta] = await Promise.all([
        fetchAllStockCacheRows(),
        supabase.from("fakturownia_sync_meta").select("last_synced_at").eq("id", 1).maybeSingle().throwOnError(),
      ]);
      rows = r;
      metaRow = meta.data;
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

    setFakturowniaError("");
    setFakturowniaSummary({
      totalCount,
      totalValue,
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

  const activeUnits = useMemo(() => units.filter((u) => !["Sprzedane", "Złom"].includes(u.status)), [units]);
  const value = activeUnits.reduce((s, u) => s + Number(u.price_cost || 0), 0);
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
        <div className="font-bold text-lg mb-6">Recoo ERP</div>
        <nav className="flex flex-col gap-1">
          {TABS.filter((t) => effectiveAccess(role ?? "", viewAccess).includes(t.key)).map((t) => (
            <button key={t.key} onClick={() => setView(t.key)} className={`text-left px-2 py-2 rounded text-sm font-medium ${view === t.key ? "bg-white border border-line" : "text-inksoft"}`}>
              {t.label}
            </button>
          ))}
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
        <div className="flex items-center justify-between px-8 py-5 border-b border-line">
          <h1 className="text-lg font-semibold">{TABS.find((t) => t.key === view)?.label}</h1>
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

        <div className="p-8">
          {view === "overview" && (
            <div className="grid grid-cols-4 gap-px bg-line border border-line">
              <div className="bg-white p-5"><div className="text-xs text-inksoft mb-2">URZĄDZENIA</div><div className="text-3xl font-bold font-mono">{activeUnits.length}</div></div>
              <div className="bg-white p-5"><div className="text-xs text-inksoft mb-2">WARTOŚĆ MAGAZYNU</div><div className="text-3xl font-bold font-mono">{fmtEUR(value)}</div></div>
              <div className="bg-white p-5"><div className="text-xs text-inksoft mb-2">GOTOWE DO SPRZEDAŻY</div><div className="text-3xl font-bold font-mono">{ready}</div></div>
              <div className="bg-white p-5"><div className="text-xs text-inksoft mb-2">W NAPRAWIE</div><div className="text-3xl font-bold font-mono">{units.filter((u) => u.status === "W naprawie").length}</div></div>
            </div>
          )}

          {view === "inventory" && (
            <div>
              <div className="flex gap-2 mb-4">
                {(
                  [
                    ["summary", "Podsumowanie"],
                    ["raw", "Raw data"],
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
            </div>
          )}

          {view === "sales" && <SalesOrdersHub
              session={session}
              members={members}
              isAdmin={role === "Admin"}
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
            />
          )}

          {view === "service" && <ServiceView session={session} members={members} isAdmin={role === "Admin"} />}

          {view === "tests" && <TestsView session={session} members={members} isAdmin={role === "Admin"} />}

          {view === "tradein" && <TradeInView session={session} />}

          {view === "shipping" && (
            <ShippingView session={session} isAdmin={role === "Admin"} members={members} prefill={shipPrefill} onPrefillUsed={() => setShipPrefill(null)} />
          )}

          {view === "rcp" && <RcpView />}

          {view === "returns" && <ReturnsView />}

          {view === "backlog" && <BacklogView session={session} members={members} isAdmin={role === "Admin"} />}

          {view === "orders" && <TradeInHub session={session} members={members} isAdmin={role === "Admin"} />}
        </div>
      </main>

    </div>
  );
}

/* ---------------- podsumowanie Fakturowni (magazyn) ---------------- */

// Stała, walidowana kolejność barw kategorycznych (skill dataviz) — max 5 realnych
// kategorii + "Inne", zgodnie z zasadą "part-to-whole na pierwszy rzut oka, <= 6 wycinków".
const FAKTUROWNIA_PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
const FAKTUROWNIA_OTHER_COLOR = "#898781"; // wyciszony szary — wycinek zbiorczy, nie jest częścią palety kategorii

function fmtPLN(n: number) {
  return Math.round(n).toLocaleString("pl-PL") + " zł";
}

function FakturowniaSummaryView({ summary }: { summary: FakturowniaSummary }) {
  const TOP_N = FAKTUROWNIA_PALETTE.length;
  const top = summary.categories.slice(0, TOP_N);
  const rest = summary.categories.slice(TOP_N);
  const otherValue = rest.reduce((s, c) => s + c.value, 0);
  const otherCount = rest.reduce((s, c) => s + c.count, 0);

  const slices = [
    ...top.map((c, i) => ({ ...c, color: FAKTUROWNIA_PALETTE[i] })),
    ...(rest.length > 0 ? [{ name: "Inne", count: otherCount, value: otherValue, color: FAKTUROWNIA_OTHER_COLOR }] : []),
  ];

  const RADIUS = 70;
  const STROKE = 34;
  const CIRC = 2 * Math.PI * RADIUS;
  const GAP = slices.length > 1 ? 3 : 0;
  let cursor = 0;
  const arcs = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const share = summary.totalValue > 0 ? s.value / summary.totalValue : 0;
      const length = Math.max(share * CIRC - GAP, 0);
      const offset = -cursor;
      cursor += share * CIRC;
      return { ...s, share, length, offset };
    });

  return (
    <div>
      <div className="grid grid-cols-2 gap-px bg-line border border-line mb-6">
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">DOSTĘPNE PRODUKTY (stan = 1)</div>
          <div className="text-3xl font-bold font-mono">{summary.totalCount.toLocaleString("pl-PL")}</div>
        </div>
        <div className="bg-white p-5">
          <div className="text-xs text-inksoft mb-2">ŁĄCZNA WARTOŚĆ (ceny zakupu brutto)</div>
          <div className="text-3xl font-bold font-mono">{fmtPLN(summary.totalValue)}</div>
        </div>
      </div>

      {summary.categories.length === 0 ? (
        <div className="border border-line bg-white p-10 text-center text-inksoft text-sm">
          Brak produktów ze stanem magazynowym = 1.
        </div>
      ) : (
        <div className="border border-line bg-white p-6 flex flex-col md:flex-row gap-8 items-center">
          <svg viewBox="0 0 200 200" className="w-56 h-56 shrink-0">
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
              {fmtPLN(summary.totalValue)}
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
                {summary.categories.map((c, i) => (
                  <tr key={c.name + i} className="border-b border-line last:border-b-0">
                    <td className="py-2 pr-3">
                      <span className="flex items-center gap-2">
                        <span
                          className="w-3 h-3 rounded-sm inline-block shrink-0"
                          style={{ background: i < TOP_N ? FAKTUROWNIA_PALETTE[i] : FAKTUROWNIA_OTHER_COLOR }}
                        />
                        <span className="font-semibold">{c.name}</span>
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-mono">{c.count}</td>
                    <td className="py-2 pr-3 font-mono">{fmtPLN(c.value)}</td>
                    <td className="py-2 font-mono text-inksoft">
                      {summary.totalValue > 0 ? Math.round((c.value / summary.totalValue) * 100) : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
}: {
  members: Member[];
  currentUserId: string;
  canEdit: boolean; // role i imiona zmienia tylko Admin (polityka w bazie); reszta widzi listę tylko do odczytu
  onChangeRole: (userId: string, role: string) => void;
  onChangeName: (userId: string, name: string) => void;
  onChangeAccess: (userId: string, access: ViewKey[] | null) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Imię i nazwisko to zwykły tekst; dopiero "Zmień" (tylko Admin) otwiera pole, żeby nie dało się go przypadkiem edytować.
  const [editingId, setEditingId] = useState<string | null>(null);

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

  // "Przegląd" jest wspólną stroną startową dla każdej roli — zawsze wymuszony, nie da się go odznaczyć
  // (inaczej dałoby się kogoś całkiem zablokować z aplikacji).
  function toggleAccess(m: Member, key: ViewKey) {
    if (key === "overview") return;
    const current = effectiveAccess(m.role, m.view_access);
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    onChangeAccess(m.user_id, (next.includes("overview") ? next : ["overview", ...next]) as ViewKey[]);
  }

  return (
    <div className="border border-line bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-inksoft border-b border-line">
            <th className="p-3">Użytkownik</th>
            <th className="p-3">Email</th>
            <th className="p-3">Rola</th>
            <th className="p-3">Dostęp do zakładek</th>
          </tr>
        </thead>
        <tbody>
          {members.length === 0 && (
            <tr><td colSpan={4} className="p-6 text-center text-inksoft text-sm">Brak członków zespołu.</td></tr>
          )}
          {members.map((m) => {
            const draft = drafts[m.user_id];
            return (
              <tr key={m.user_id} className="border-b border-line last:border-b-0">
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
                  <div className="flex flex-wrap gap-x-3 gap-y-1 max-w-md">
                    {TABS.map((t) => {
                      const checked = effectiveAccess(m.role, m.view_access).includes(t.key);
                      return (
                        <label key={t.key} className={`flex items-center gap-1 text-xs ${canEdit && t.key !== "overview" ? "cursor-pointer" : ""} ${checked ? "text-ink" : "text-inksoft"}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!canEdit || t.key === "overview"}
                            onChange={() => toggleAccess(m, t.key)}
                          />
                          {t.label}
                        </label>
                      );
                    })}
                  </div>
                  {canEdit && m.view_access !== null && (
                    <button onClick={() => onChangeAccess(m.user_id, null)} className="text-xs font-semibold text-teal hover:underline mt-1">
                      Resetuj do domyślnych (rola)
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
