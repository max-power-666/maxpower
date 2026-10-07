# Magazyn ERP — kontekst projektu

## Cel biznesowy

Wewnętrzny system firmy (marka Recoo) do obsługi sprzedaży/naprawy/skupu elektroniki
(konsole, smartfony, tablety, laptopy). Budowany na potrzeby **własnej działalności** —
żadnych zewnętrznych klientów, tylko właściciel i mały zespół (kilka-kilkanaście osób).

Docelowa inspiracja funkcjonalna: Margixa (ERP dla sprzedawców elektroniki: magazyn po
numerach seryjnych, wielokanałowa synchronizacja stanów, naprawy, auto-wycena).

## Stack i hosting

- **Next.js 14** (App Router), TypeScript, Tailwind CSS
- **Supabase** (Postgres, realtime, magic link email login) — plan darmowy (limit 500 MB;
  nie było decyzji o upgrade)
- **Vercel Pro** — wymagany, bo cron co minutę (bidder) na Hobby wysadza deploy (Hobby: cron
  tylko raz dziennie). Deploy automatyczny po `git push` na `main`.
- Repo: `github.com/max-power-666/maxpower`
- Cron w `vercel.json` (Vercel liczy w UTC): sync Fakturowni `0 23 * * *`, bidder `* * * * *`,
  sync zamówień BuyBack `*/15 * * * *`, sync zamówień sprzedaży Back Market, refurbed, Erli, Allegro, Octopia i Amazon `*/15 * * * *` (osobne route'y). Autoryzacja crona: nagłówek `Bearer CRON_SECRET`.

## Struktura kodu

- `app/page.tsx` — jeden duży client component: logowanie, nawigacja, role, zakładki
  Przegląd / Magazyn / Zespół. Większe moduły są osobno w `app/_components/`:
  `ServiceView.tsx` (Serwis), `TestsView.tsx` (Testy), `ProductCardDrawer.tsx` (karta produktu), `TradeInHub.tsx` + `TradeInOrdersView.tsx` (Trade-in),
  `TradeInView.tsx` (Bidder), `SalesOrdersHub.tsx` (Zamówienia, karta zamówienia w `SalesOrderCard.tsx`), `ErliParcelPanel.tsx` (nadawanie Paczkomatów InPost 24/7 przez Erli, osadzony na karcie zamówienia Erli), `ShippingView.tsx` (Wysyłka DHL), `InvoicesView.tsx` (Faktury), `NbpView.tsx` (kursy NBP), `OverviewSalesDashboard.tsx` (dashboard sprzedaży na Przeglądzie), `OverviewMarginChart.tsx` (wykres marży na Przeglądzie), `AiView.tsx` + `Markdown.tsx` (zakładka AI), `MarginView.tsx` (zakładka Marża), `ServiceHub.tsx` + `PartsView.tsx` (Serwis: podstrony Naprawy / Części), `RcpView.tsx` + `RcpWidget.tsx` (RCP — rejestracja czasu pracy), `CategoryBreakdown.tsx` (wykresy kategorii w Magazynie).
- `app/api/*/route.ts` — endpointy serwerowe (sekrety tylko tu, nigdy w przeglądarce):
  `fakturownia/sync`, `tradein/bidder`, `tradein/competitors`, `tradein/orders-sync`, `tradein/validate`, `orders/bm-sync`, `orders/refurbed-sync`, `orders/erli-sync`, `orders/allegro-sync`, `orders/allegro-auth`, `orders/allegro-callback`, `orders/octopia-sync`, `orders/amazon-sync`, `orders/validate`, `orders/bm-refresh`, `orders/erli-refresh`, `shipping/dhl-express/{check,create}`, `shipping/dhl-parcel/{check,create,label,cancel}`, `shipping/erli/{create,label,cancel}`, `shipping/ups/{check,create,cancel}`, `shipping/sync-marketplace`, `shipping/render-zpl`, `shipping/fetch-remote-pdf`, `shipping/qz-sign`, `invoices/{create,prefill}`, `nbp/sync`, `overview/sales-stats`, `ai/ask`, `margin/{list,summary,bm-invoice}`.
- `lib/` — `supabaseClient.ts`, `buyback.ts` (logika biddera + `isAuthorized`),
  `displayName.ts` (skrócone imię: "Maksymilian J."), `workLog.ts` (interwały Dziś/7/30 dni,
  liczenie czasu i **etykiety typów czynności/statusów** — jedno źródło dla list i karty produktu),
  `search.ts` (`escapeLike` do wyszukiwania po numerze seryjnym), `scanOrders.ts` (stronicowany skan
  zamówień Back Market z budżetem czasu i kursorem), `invoices.ts` (wystawianie faktur w Fakturowni, stawka VAT, prefill nabywcy),
  `nbp.ts` (kursy NBP: pobieranie, kurs z dnia poprzedniego, przeliczanie na PLN), `overview.ts` (bucketing dzienny/kanałowy na Przeglądzie), `aiAgent.ts` (pętla agenta Claude z narzędziem run_sql), `aiSchema.ts` (prompt systemowy = słownik danych asystenta AI), `margin.ts` (marża na sztuce + średnie stawki BM z faktur), `buybackCosts.ts`/`stockCosts.ts` (koszty Trade-in), `csv.ts` (parser CSV), `ups.ts` + `upsServer.ts` (przewoźnik UPS).
- `supabase/*.sql` — schemat, każdy plik idempotentny: `schema.sql` (units, members,
  cache Fakturowni), `tradein.sql` (bidder), `buyback-orders.sql` (zamówienia + obsługa
  paczek), `backlog.sql` (zakładka Backlog), `shipping.sql` (Wysyłka: nadawca, szablony, przesyłki), `sales-orders.sql` (zamówienia sprzedaży Back Market, refurbed, Erli, Allegro, Octopia i Amazon, plus archiwum Apilo; tokeny OAuth), `service.sql` (rejestr napraw), `service-parts.sql` (Serwis -> Części: tabela `service_parts`; po schema.sql), `tests.sql` (rejestr testów), `invoices.sql` (zakładka Faktury: tabela faktur + widok `invoices_ready_orders`),
  `overview.sql` (widok `sales_order_values` dla dashboardu Przeglądu), `nbp.sql` (zakładka NBP: kursy walut), `inventory.sql` (widok `fakturownia_stock_with_sku` dla Magazynu -> Raw data; po schema/buyback-orders/tests), `margin.sql` (zakładka Marża: `fakturownia_purchases`, `bm_invoice_lines`, widok `margin_items`; po shipping/buyback-orders/nbp), `rcp.sql` (RCP: `rcp_segments`, `rcp_settings`, funkcje `rcp_act`/`rcp_close_stale`; po schema.sql), `ai.sql` (zakładka AI: widoki `ai.*`, rola `ai_reader`, funkcja `ai_query`, dziennik `ai_log`; po wszystkich powyższych).
- `scripts/import-buyback.mjs` — jednorazowy import ze starego programu Buyback Bidder.

## Zakładki i role

Role: **Admin, Manager, Magazyn, Zamówienia, Serwis, Kierownik serwisu (05.10.2026), Testy, Bidder, Trade-in, Kierownik trade-in (07.10.2026)** (+ Sklep). Rolę nadaje Admin w zakładce Zespół (tam też
imię i nazwisko — `members.name`). Nowa osoba po pierwszym logowaniu dostaje pusty wiersz
w `members` i ekran "poproś administratora o rolę" (`NoRoleScreen`); sama roli nie wybiera.
Rola odświeża się sama po nadaniu/zmianie przez Admina (realtime na `members` — wymaga bloku publikacji z `schema.sql`;
do tego odczyt przy powrocie do karty i co 15 s na ekranie "brak roli"). Błąd odczytu roli to NIE brak roli — pokazujemy "Spróbuj ponownie".
Przegląd jest domyślną stroną startową TYLKO dla Admina i Managera (02.10.2026, na prośbę właściciela — wcześniej
wspólna dla wszystkich ról). Dla pozostałych ról zakładką startową jest ich własna, główna zakładka (pierwszy
element listy w `ROLE_ACCESS` — Testy startują w Testach, Trade-in w Trade-in, Serwis w Serwisie, itd.). Mapa
dostępu: `ROLE_ACCESS` w `app/page.tsx`.
Manager widzi wszystkie zakładki (Zespół tylko do odczytu), ale niczego nie usuwa i nie zmienia ról ani imion (to tylko Admin, także w bazie).
Rola jest zwykłym tekstem w `members.role` — dodanie roli nie wymaga SQL.

| Zakładka | Klucz widoku | Kto widzi |
|---|---|---|
| Przegląd | `overview` | Admin, Manager (od 02.10.2026 — wcześniej wszyscy, patrz niżej) |
| Magazyn | `inventory` | Admin, Manager, Magazyn |
| Zamówienia | `sales` | Admin, Manager, Zamówienia |
| Backlog | `backlog` | wszyscy (każda rola) |
| Wysyłka | `shipping` | Admin, Manager, Zamówienia |
| Faktury | `invoices` | Admin, Manager, Zamówienia |
| Marża | `margin` | Admin, Manager (03.10.2026) |
| Punktacja | `points` | Admin i Manager (06.10.2026; serwer też wpuszcza tylko ich) |
| NBP | `nbp` | Admin, Manager |
| AI | `ai` | tylko Admin (03.10.2026; serwer też wpuszcza tylko Admina) |
| RCP | `rcp` | wszyscy (każda rola) |
| Zwroty | `returns` | wszyscy (każda rola) |
| Zespół | `team` | Admin (edycja), Manager (tylko odczyt) |
| Serwis | `service` | Admin, Manager, Serwis |
| Testy | `tests` | Admin, Manager, Testy |
| Bidder | `tradein` | Admin, Manager, Bidder |
| Trade-in | `orders` | Admin, Manager, Trade-in |

Uwaga: nazwa zakładki "Bidder" to klucz `tradein`, a zakładka "Trade-in" to klucz `orders` —
historyczne, nie mylić. Aktywna zakładka jest zapamiętywana w `localStorage`.

**Dostęp do zakładek per osoba (od 30.09.2026).** Tabela wyżej to tylko DOMYŚLNY zestaw wg roli (`ROLE_ACCESS`
w `app/page.tsx`) — Admin może go nadpisać dla KAŻDEJ osoby z osobna, zapisywane w `members.view_access`
(`text[]`, `null` = jeszcze nikt nie dotykał, więc liczy się domyślny zestaw dla roli). `effectiveAccess(role,
viewAccess)` w `app/page.tsx` liczy efektywny dostęp (nadpisanie, jeśli jest, inaczej `ROLE_ACCESS[role]`) i jest
jedynym miejscem, które o tym decyduje — użyte zarówno przy filtrowaniu nawigacji/gate'owaniu widoku dla
zalogowanej osoby, jak i przy renderowaniu checkboxów. **"Przegląd" NIE jest już twardo wymuszony (02.10.2026)** —
wcześniej checkbox był zablokowany na stałe zaznaczony (żeby nie dało się kogoś całkiem zablokować z aplikacji);
teraz to zwykła zakładka jak każda inna, domyślnie tylko dla Admina/Managera, ale Admin MOŻE ją komuś przywrócić
ręcznie w tym samym oknie, tak jak każdą inną zakładkę. Jedyna pozostała ochrona (`toggleAccess`): nie da się
odznaczyć OSTATNIEJ zaznaczonej zakładki danej osoby — próba nic nie robi, zamiast zostawić kogoś bez żadnej
dostępnej zakładki po zalogowaniu. Przycisk "Resetuj do domyślnych (rola)" czyści
nadpisanie (`view_access = null`) — zmiana samej roli NIE resetuje automatycznie nadpisania (świadomie, żeby
poprawka literówki w roli nie kasowała starannie dobranego dostępu; do zresetowania służy ten przycisk). Nadal
tylko UI (RLS pozwala każdemu `authenticated` na wszystko) — twarde uprawnienia per rola są w planie rozwoju,
punkt 10.

**Okno edycji pracownika (30.09.2026, `MemberEditDrawer` w `app/page.tsx`).** Checkboxy dostępu do zakładek
przeniesione z wiersza tabeli Zespołu (robiło się nieczytelne, dużo zakładek naraz) do osobnego okna bocznego —
kolumna "Dostęp do zakładek" w tabeli ma teraz tylko przycisk "Edytuj" (dla Admina) albo "Pokaż" (reszta, okno w
trybie tylko do odczytu) + etykietę "dostosowany", gdy `view_access` nie jest `null`, żeby dało się ocenić z
samej listy, kto ma nadpisany dostęp bez otwierania okna każdej osoby. W tym samym oknie: **"Forma zatrudnienia"**
(`members.employment_type`, nowa kolumna — zwykły tekst jak `role`, bez CHECK constraint; `EMPLOYMENT_TYPES` w
`app/page.tsx` to tylko lista opcji w rozwijanej liście UI — "Umowa o pracę" / "Umowa zlecenie", dodanie kolejnej
formy nie wymaga SQL, tak samo jak dodanie roli). Zmienia tylko Admin — chroni to już istniejąca polityka RLS
`admin update members` (`USING (is_admin())` bez wyjątków kolumnowych, patrz sekcja Uprawnienia), nowa kolumna
jest więc chroniona automatycznie, bez dodatkowej polityki; sprawdzone wprost testem, nie tylko założone. Imię i
rola zostają edytowalne bezpośrednio w wierszu tabeli jak dotąd (okno dotyczy tylko dostępu i danych pracowniczych). Tabela Zespołu ma kolumnę **Lp.** (02.10.2026) przed "Użytkownik" — zwykły numer porządkowy wiersza w aktualnej kolejności listy, nie zapisany nigdzie identyfikator.

## Model danych i moduły

**Przegląd** (`OverviewSalesDashboard.tsx`, widoczny dla wszystkich ról). Dashboard sprzedaży wzorowany na
zrzucie ekranu dashboardu Apilo od właściciela (01.10.2026): 4 kafelki (ilość/wartość zamówień dzisiaj, ilość/
wartość z ostatnich 30 dni), wykres dzienny (słupki = wartość, linia = ilość) i udział kanałów z ostatnich 30
dni — **jako poziome słupki z procentem, nie koło/donut jak w pierwowzorze** (świadoma decyzja właściciela,
wyraźnie poproszona zamiana). Pod spodem zostają cztery starsze kafelki (patrz niżej, osobny, starszy temat) —
"Urządzenia"/"Wartość magazynu" przełączone 01.10.2026 na prawdziwe dane z Fakturowni (`fakturowniaSummary`, te
same liczby co w Magazyn → Podsumowanie), "Gotowe do sprzedaży"/"W naprawie" wciąż z wycofanej tabeli `units`
(zawsze zero, bo nic już do niej nie zapisuje).
- **"Ostatnie 30 dni" to 30 PEŁNYCH dni PRZED dzisiaj, BEZ dzisiaj** — potwierdzone wprost na zrzucie ekranu
  (wykres kończy się dzień przed "dzisiaj", nie na nim); "dzisiaj" ma własne, osobne kafelki. Bucketing po
  LOKALNYM dniu kalendarzowym przeglądarki (`lib/overview.ts`, ten sam duch co `summarizeDays` w
  `lib/salesOrders.ts` dla kafelków Zamówień dzisiaj/wczoraj, tylko tu dowolna liczba dni) — serwer
  (`app/api/overview/sales-stats`) oddaje surowe, już przeliczone na PLN wiersze z ~35-dniowym zapasem, a
  bucketing liczy klient, żeby "dzisiaj" zawsze zgadzało się z zegarem patrzącej osoby, nie z serwerem Vercela.
- **Zamówienia filtrowane tym samym `isCountedOrder`/`NOT_COUNTED`** co kafelki Zamówienia dzisiaj/wczoraj w
  `SalesOrdersHub.tsx` (`lib/salesOrders.ts`) — nie osobna, druga definicja "co się liczy".
- **Różne waluty (EUR/DKK/PLN — sprawdzone na żywych danych 01.10.2026: Back Market/refurbed/Octopia/Amazon
  głównie EUR, część refurbed w DKK, Allegro/Erli w PLN) wymagają przeliczenia na jedną wspólną PLN** — właściciel
  świadomie wybrał automatyczne przeliczanie wg kursu NBP (patrz **NBP** niżej), a NIE: pokazywanie osobnych sum
  per waluta ani ręcznie wpisany stały kurs. **Zasada księgowa: kurs z OSTATNIEGO DNIA ROBOCZEGO PRZED dniem
  zamówienia** (zgłoszone wprost przez właściciela), nigdy z dnia samego zamówienia — `rateBeforeDate` w
  `lib/nbp.ts` szuka najpóźniejszej daty ŚCIŚLE mniejszej niż data zamówienia. Zamówienie bez dostępnego kursu
  (np. sprzed zakresu zsynchronizowanych kursów) jest pomijane z sum (`missingRate` w odpowiedzi route'a), NIE
  liczone jako 0 ani zgadywane.
- Agregacja wartości zamówienia: widok `sales_order_values` (`overview.sql`) sumuje `sales_order_items.price`
  per zamówienie (join z `sales_orders`) — `null`, gdy żadna pozycja nie ma jeszcze ceny (np. bardzo świeże
  zamówienie Amazon przed fazą 2 synchronizacji), wtedy zamówienie pomijane z sum, nie liczone jako 0.
- Wykresy to **surowe SVG rysowane ręcznie** (ten sam wzorzec co wykres kołowy Magazynu i wykres Biddera w
  `TradeInView.tsx`) — w projekcie świadomie nie ma biblioteki wykresów (recharts/chart.js itp.), żeby nie
  dokładać zależności dla dwóch prostych wykresów.

**NBP** (`NbpView.tsx`, `lib/nbp.ts`, `nbp.sql`, `app/api/nbp/sync`) — kursy średnie NBP (tabela A, `api.nbp.pl`,
publiczne, bez klucza/autoryzacji — stąd brak nowej zmiennej środowiskowej). Dziś używane do przeliczania
wartości zamówień na PLN na Przeglądzie, ale **świadomie osobna, reużywalna zakładka** (nie funkcja wewnętrzna
Przeglądu) — na wyraźną prośbę właściciela, bo kursy przydadzą się gdzie indziej w przyszłości. Dostęp Admin/
Manager (zakładka techniczna/konfiguracyjna, nie codzienna operacyjna — inaczej niż Faktury/Wysyłka).
- **Tylko EUR i DKK** na razie (`NBP_CURRENCIES` w `lib/nbp.ts`) — jedyne obce waluty faktycznie występujące w
  zamówieniach (sprawdzone na żywych danych), łatwe do rozszerzenia listą, bez zmian schematu.
- Synchronizacja (`app/api/nbp/sync`, GET): cron raz dziennie (`vercel.json`, `13:00 UTC` — z zapasem po
  publikacji NBP ok. południa czasu polskiego, niezależnie od zmiany czasu) + przycisk "Odśwież" w zakładce.
  Pierwszy przebieg dla danej waluty (brak wierszy) robi backfill **60 dni wstecz** — zapas na 30-dniowe okno
  Przeglądu plus "kurs z dnia poprzedniego" na samym początku tego okna; kolejne przebiegi dociągają tylko od
  ostatniego zsynchronizowanego dnia. NBP pomija dni bez notowania (weekendy/święta) — zakres bez ŻADNEGO dnia
  roboczego zwraca 404, co traktujemy jako "brak danych", nie błąd.
- `nbp_rates` (`currency`, `rate_date`, `mid`) — odczyt dla każdego `authenticated` (kursy walut nie są
  wrażliwe), zapis WYŁĄCZNIE przez serwer (service_role, zero polityk insert/update — jak `oauth_tokens`).

**Magazyn.** Zakładka ma dwa podwidoki: *Podsumowanie* (liczba sztuk ze `stock_level = 1`, wartość
wg **ceny zakupu** (w UI bez dopisku "brutto" od 03.10.2026 — to nadal `purchase_price_gross` z Fakturowni, czyli cena brutto) — `price_gross` jest w Fakturowni puste dla prawie wszystkich sztuk —
i wykres kołowy per kategoria, top 5 + "Inne") oraz *Raw data* (`InventoryRawView.tsx`): lista
sztuk ze stronicowaniem po stronie serwera (25/50/100) i wyszukiwaniem po numerze seryjnym.
W Fakturowni numer seryjny to nazwa produktu (= kod), a `description` to numer zamówienia
Back Market, z którego sztuka pochodzi. Dane: `fakturownia_stock_cache` (tylko sztuki ze stanem 1;
kolumny `name`, `description`, `product_created_at`, kategoria, cena zakupu) +
`fakturownia_sync_meta`. Sync `app/api/fakturownia/sync` (`maxDuration = 300`): pełny skan
(~19 tys. produktów, ok. minuty) tylko gdy `last_synced_at` jest puste, potem przyrostowo przez
`date_from`. Po dodaniu nowych kolumn `schema.sql` sam kasuje `last_synced_at`, więc następne
"Odśwież" robi jednorazowy pełny skan i uzupełnia braki. Zapis tylko serwer (service_role);
zespół ma tylko odczyt.

**Wartość z kosztami** (03.10.2026, na prośbę właściciela; Magazyn -> Podsumowanie, drugi rząd kafelków POD kafelkami "Dostępne produkty"/"Łączna wartość"): kafelek
"Koszty dodatkowe" (lista linii kosztów z opisem, ile zamówień/sztuk objęto) i kafelek **"Łączna wartość + koszty"** (ceny zakupu + suma kosztów). **DZIŚ jedyny
koszt to Trade-in** (prowizja BM 10% + logistyka wg regulaminu, patrz sekcja Trade-in -> koszty dodatkowe, `lib/buybackCosts.ts`); z czasem dojdą koszty części, podatek PCC
(zakup powyżej 1000 zł) itd. — **każdy składnik to osobna linia `CostLine`** (`lib/stockCosts.ts`), sumowana do "wartości z kosztami", więc dodanie składnika to nowa funkcja
zwracająca `CostLine` dopisana w `fetchStockCosts` (`page.tsx`), bez przebudowy reszty. Koszty Trade-in w tym kafelku obejmują prowizję BM, logistykę **i PCC**. Mechanizm Trade-in: sztuka w magazynie wskazuje zamówienie w `description` (numer BM,
np. FR-26392-JMMYS; pozostałe opisy — faktury "VAT marża" itp. — nie pasują do wzorca i nie mają kosztu Trade-in), dopasowanie do `buyback_orders` (paczkami po 60 id, pamięć
podręczna na sesję), liczone tylko zamówienia WYPŁACONE (VALIDATED/PAID/MONEY_TRANSFERED — BM pobiera opłaty przy wypłacie), **jedno zamówienie RAZ** nawet gdy wskazuje je kilka
sztuk. EUR -> PLN **kursem NBP z dnia poprzedniego względem wypłaty** (a bez daty wypłaty — względem utworzenia zamówienia), tą samą zasadą co reszta aplikacji; zamówienia bez
kursu są pominięte z sumy i policzone osobno w opisie ("brak kursu NBP"), bez zgadywania. **Kursy NBP sięgają teraz do 15.12.2025:** `nbp/sync` jednorazowo dociąga historię wstecz
(`HISTORY_START`), bo wcześniej backfill miał tylko 60 dni, a zamówienia Trade-in sięgają stycznia 2026 — po wdrożeniu trzeba raz kliknąć "Odśwież" w zakładce NBP (albo poczekać na
cron). Na dzień wdrożenia: 937 zamówień Trade-in w magazynie, koszty ≈ 99 tys. zł przy wartości zakupu ≈ 666 tys. zł (≈ 15%; liczone testowo z kursami NBP pobranymi wprost).
Kafelek "Wartość magazynu" na Przeglądzie dalej pokazuje samą wartość zakupu (bez kosztów).
**Status produktu (05.10.2026, na prośbę właściciela; Magazyn -> Raw data, karta produktu):** ostatni status ustawiony dla produktu (po numerze seryjnym, bez rozróżniania wielkości liter i spacji) w jednym z trzech modułów — **Serwis: kolumna "Status"** (`service_log.status`, po `device_ref`), **Testy: kolumna "Wynik"** (`test_log.result`: Sprawny/Serwis/RMA/Do poprawy/Outlet — NIE status testu w trakcie/przetestowane/przerwany; test bez wyniku nie daje statusu)
i **Trade-in: kolumna "Status"** (`buyback_order_intake.status`). Wygrywa najświeższa zmiana: wpisy mają `status_changed_at` (Serwis, Trade-in) albo `result_changed_at` (Testy) ustawiane triggerem przy zmianie TEJ kolumny (edycja uwag itp. daty nie przesuwa); wiersze sprzed zmiany dostały przybliżenie z `finished_at`/`started_at`/`entered_at`.
Funkcja `product_status_for(serial)` (`inventory.sql`, z indeksami po `lower(btrim(numer seryjny))` w trzech tabelach; **`security definer`** — jako `security invoker` przechodziła dla zalogowanych przez RLS trzech tabel przy każdym z ~18 tys. produktów i lista Raw data kończyła się "statement timeout", zgłoszone 05.10.2026; kolumny statusu w widokach to podzapytania skalarne, nie lateral join, żeby liczyły się tylko dla wierszy strony) zwraca źródło (`serwis`/`testy`/`trade_in`), klucz i chwilę; oba widoki magazynowe (`fakturownia_stock_with_sku`, `fakturownia_products_with_sku`) mają na końcu kolumny `product_status_source`/`product_status`/`product_status_at`. W UI: kolumna "Status produktu" (np. "Serwis: Naprawiony", w podpowiedzi czas zmiany),
**filtr "Status produktu"** (lista: Wszystkie / Bez statusu / każde "Źródło: status") działający łącznie z pozostałymi filtrami i podsumowaniem, oraz wiersz w karcie produktu. Etykiety w `lib/workLog.ts` (`PRODUCT_STATUS_SOURCES`, `productStatusLabel`). Przed uruchomieniem SQL kolumna i filtr same znikają (awaryjny odczyt bez nowych kolumn).
Wymaga uruchomienia: `service.sql`, `tests.sql`, `buyback-orders.sql`, potem `inventory.sql` i `margin.sql`. Nie jest dodany do widoków `ai.*` asystenta AI.
**Katalog konsol (06.10.2026, na prośbę właściciela; Magazyn -> pigułka "Katalog konsol", `ConsoleCatalogView.tsx`, `supabase/console-catalog.sql`):** katalog modeli konsol z arkusza `katalog konsol.numbers` (75 wierszy: Sony PlayStation 45, Microsoft 30; model x kolor x pamięć x liczba padów) w tabeli `console_catalog` — producent, nazwa, akcesoria ("bez padów"/"1 pad"/"2 pady"), kolor, pamięć i **SKU wg stanu: zadowalający (klasa C), dobry (B), bardzo dobry (A)**. SKU w arkuszu ma końcówkę z liczbą kontrolerów (`-0M`/`-1M`/`-2M`), więc obok są **trzy dodatkowe kolumny "SKU bez info o kontrolerach"** (np. `PS5S-1TB-WE-C`) — wyliczane w aplikacji przez obcięcie końcówki `-nM` (`skuWithoutControllers`, ta sama reguła co `sku_base` w `ai.order_items` i SKU sztuk w Magazynie), nie przechowywane. Widok: wyszukiwarka (nazwa, kolor, pamięć, SKU) i pigułki producentów. **Admin edytuje katalog w aplikacji (06.10.2026):** komórki wprost (`InlineEditCell`: Enter/wyjście zapisuje, Esc anuluje — producent, nazwa, akcesoria, kolor, pamięć i trzy SKU; kolumny "bez info o kontrolerach" przeliczają się same), **"+ Dodaj wiersz"** (nowy wiersz na końcu z nazwą tymczasową "Nowa pozycja" do poprawienia), **"Duplikuj"** (kopia wiersza z nazwą "… (kopia)", wygodne dla innego koloru/liczby padów) i **"Usuń"** (z potwierdzeniem; wpis trafia do `deleted_records` przez `audit_delete`). Nazwa jest unikalna (duplikat = czytelny komunikat), nie może być pusta. Pozostali czytają — **RLS: odczyt dla zalogowanych, zapis tylko `is_admin()`**. **Dane startowe z arkusza są w pliku SQL, ale wgrywają się wyłącznie do PUSTEJ tabeli** — ponowne uruchomienie pliku NIE nadpisuje zmian Admina (wcześniejsza wersja pliku miała `on conflict do update`; po tej zmianie zmiany w katalogu robi się już w aplikacji, nie plikiem). 9 modeli (PS5 Pro 2TB, Xbox Series S 1TB) nie ma w arkuszu SKU — pokazane jako "—". Przy imporcie zauważono, że **PS4 Pro 1TB Biały ma w arkuszu SKU z kolorem `BK` (czarny)** — identyczne jak wiersze Czarny (prawdopodobnie błąd w arkuszu, zaimportowane bez zmian).
**Pozycje ręczne w magazynie (06.10.2026):** produkt spoza Fakturowni dopisany wprost do `fakturownia_stock_cache` i `fakturownia_purchases` z **ujemnym `id`** (id z Fakturowni są dodatnie, więc nie kolidują; synchronizacja kasuje tylko wiersze o id pobranych z Fakturowni, więc ręcznych nie rusza). Pierwsza: **`joystick1`** (id -1, kategoria "Akcesoria", cena zakupu 1 zł, **VAT `V23`**, stan 1, data utworzenia 01.01.2026, żeby była "przed" wszystkimi zamówieniami) — to wspólny numer seryjny wpisywany w Zamówieniach przy akcesoriach bez własnych numerów (na dzień dodania ~46 pozycji: pady PS4/PS5, Joy-Cony, kontrolery z BM/Amazon/Allegro/Erli/refurbed); Marża pobiera dla nich cenę zakupu 1 zł netto. Dodane jednorazowo przez REST (bez UI do dodawania pozycji ręcznych). **Cena zakupu w polu `purchase_price_gross` to BRUTTO (jak wszędzie) — dla `joystick1` zapisano 1,23 zł, co daje 1,00 zł netto przy V23** (właściciel podał cenę netto 1 zł).
**VAT `V23` i marża (06.10.2026, na prośbę właściciela — "zgodnie z zasadami księgowymi"):** towar kupiony ze standardowym VAT 23% (odliczalnym) NIE podlega procedurze VAT-marża. W `lib/margin.ts` (`computeMargin`, `vatMode: "V23"`) kosztem jest cena zakupu **netto** (brutto z Fakturowni / 1,23), a od sprzedaży odprowadzamy VAT należny 23% od PEŁNEJ ceny sprzedaży (`sprzedaż × 23/123`; pole "VAT" w wierszu i rozwinięciu — etykieta "VAT należny (V23)", w tabeli znacznik "V23"), więc **marża = sprzedaż/1,23 − zakup netto − wysyłka − koszty dodatkowe − prowizja − serwis**; "Marża netto" = sprzedaż/1,23 − zakup netto. Pozostałe sztuki (VM i bez VAT) liczą się jak dotąd (VAT od marży = (sprzedaż − zakup) × 23/123, nigdy ujemny). Wysyłka DHL/UPS, prowizje BM/refurbed/Octopia i części serwisowe są już kwotami netto — bez zmian. **Skąd widok bierze VAT zakupu:** nowa kolumna `fakturownia_purchases.vat` (ręczna, sync jej nie rusza) albo — gdy pusta — `fakturownia_stock_cache.vat` sztuki wciąż w magazynie (`margin_items.purchase_vat`, `margin.sql`; widok "Wszystkie" w Raw data pokazuje VAT też z zakupów); dla SPRZEDANYCH sztuk (cache je kasuje) V23 trzeba wpisać w `fakturownia_purchases.vat`. Wymaga ponownego uruchomienia `margin.sql`; do tego czasu Marża liczy wszystko VAT-marżą.
**Raw data — kolumny SKU i VAT** (02.10.2026, na prośbę właściciela). Raw data czyta teraz widok
`fakturownia_stock_with_sku` (`supabase/inventory.sql`, uruchamiać PO schema/buyback-orders/tests) zamiast samej tabeli
cache. **SKU** nie istnieje w Fakturowni (tam serial = nazwa = kod), więc jest wyliczane z naszej bazy po numerze
seryjnym: z Testów (`test_log.sku`, kolumna dodana tego samego dnia) albo z Trade-in (`buyback_order_intake.sku`), a gdy są
oba — **wygrywa wpis wcześniejszy** (`test_log.started_at` vs `buyback_order_intake.entered_at`; decyzja właściciela).
**Trzecie, rezerwowe źródło: tabela `serial_skus`** (numer seryjny -> SKU, `inventory.sql`) — import z arkusza właściciela
(plik importu poza repo, bo to dane, nie schemat): pokazuje się TYLKO gdy ani Testy, ani Trade-in nie mają SKU dla sztuki
(świeży wpis zespołu ma pierwszeństwo przed importem). **Import wykonano dwa razy tego samego dnia (02.10.2026):** wersja 1
(cały stary arkusz, ~4,5 tys. numerów, stary schemat SKU typu `PS4-500-B-2M`) została ZASTĄPIONA wersją 3 z nowego arkusza
(nowy schemat SKU z kolorem, np. `PS4-500-BK-C`; ~15 tys. wierszy w pliku) **ograniczoną do numerów, które są w magazynie**
(`fakturownia_stock_cache` w chwili generowania pliku) — 1071 przypisań. Plik importu najpierw kasuje wszystkie wiersze
`source = 'import'`, więc kolejny import też zastępuje poprzedni, a wiersze dodane inaczej (`source <> 'import'`) zostają.
Pominięto: placeholdery zamiast numeru ('-', 'TUTAJ', 'BRAK SN'), SKU dosłownie 'SKU'/'None' (puste wartości z eksportu),
zwinięto zdublowane numery z tym samym SKU i **wykluczono 2 numery ze sprzecznymi SKU** (03274523235631167: PS4-500-WE-C/-D,
128809753548: XO-1TB-BK-E/-F — do ręcznego rozstrzygnięcia). 422 sztuki z magazynu nie mają numeru w arkuszu (SKU dostaną z
Testów/Trade-in albo wcale). **Ręczne przypisanie SKU — `source = 'manual'` (05.10.2026, na prośbę właściciela):** wpis w `serial_skus` z `source = 'manual'` ma **NAJWYŻSZY priorytet** (przed Testami, Trade-in i zwykłym importem) w obu widokach magazynowych (`fakturownia_stock_with_sku`, `fakturownia_products_with_sku`) — poprawia pomyłki w SKU wpisanych przez zespół, nic w ich wpisach nie zmieniając. Wprowadzone tego dnia 57 par numer seryjny -> SKU (lista wklejona przez właściciela; 14 sztuk nie miało SKU, 8 miało inne z Trade-in/Testów z 1–2.10.2026 — np. `XSS-512-WE-BC` poprawione na `XSS-512-WE-A`; reszta bez zmian).
Pominięty wiersz `006055223717` (wartość "Xbox Series S" nie jest SKU). Uwaga na pułapkę: PostgREST obcina odpowiedzi do 1000 wierszy niezależnie od `limit` — przy aktualizacjach `serial_skus` po wcześniej pobranej liście (ponad 1000 wierszy w tabeli) szukaj po numerze seryjnym, nie po mapie z jednej strony.
**Drugi import uzupełniający (03.10.2026, plik `imeisku.numbers`, ~22 tys. wierszy IMEI;SKU):** dla sztuk, które nadal nie miały żadnego SKU (421 w chwili importu).
Numer może powtarzać się w pliku — **wygrywa NAJNOWSZY zapis, czyli najwyższy wiersz** (wiersz 1 = najstarszy; dla 20 z 140 dopasowanych numerów SKU w historii się zmieniało).
Dopasowano 140 numerów, 281 sztuk nadal bez SKU (ich numerów nie ma w pliku; lista w pliku CSV przekazanym właścicielowi). Wiersze z tego importu mają `source = 'import_imeisku'`,
są dopisywane z `on conflict do nothing` (NIGDY nie nadpisują istniejącego przypisania) i **nie giną przy ponownym uruchomieniu importu głównego** (ten kasuje tylko
`source = 'import'`). Przy okazji sprawdzone: wśród sztuk, które już miały SKU, 75 z 163 występujących w pliku ma w nim INNE SKU niż nasze (np. nasze `PS4-500-BK-C`, w pliku `PS4-500-BK-A`) —
plik NIE nadpisuje naszych SKU, bo miał uzupełniać braki (rozstrzygnięcie, które SKU jest właściwe, zostaje po stronie właściciela).
Zapis do `serial_skus` tylko Admin (RLS) albo SQL Editor.
**"Kategoria z SKU"** (`sku_category` w widoku, 02.10.2026; kolumna w Raw data i wiersz w karcie produktu) = pierwszy człon
SKU przed pierwszym myślnikiem (XSX-1TB-BK-A -> XSX, PS4S-1TB-BK-AB -> PS4S, NS-32-V1-D -> NS); SKU bez myślnika -> cała
wartość; brak SKU -> puste. Wyliczana w widoku (`split_part`), nie przechowywana — zmiana SKU od razu zmienia kategorię;
to INNE pole niż "Kategoria" z Fakturowni obok (`category_name`), nic ich ze sobą nie łączy.
Wpisy z pustym SKU są pomijane (wcześniejszy, ale nieuzupełniony wpis nie zasłania późniejszego z SKU); numery
porównywane bez rozróżniania wielkości liter i bez spacji na brzegach; dla sztuki bez żadnego wpisu SKU jest puste
("—"). **Dwa kształty SKU (doprecyzowanie właściciela, 03.10.2026):** SKU w MAGAZYNIE (Trade-in, Testy, import) ma postać `XSX-1TB-BK-B`
(KATEGORIA-POJEMNOŚĆ-KOLOR-KLASA), a SKU Z ZAMÓWIENIA (marketplace, Bidder) ma dodatkowo na końcu liczbę kontrolerów: `XSX-1TB-BK-B-1M`
(0M bez kontrolera, 1M jeden, 2M dwa) — to to samo urządzenie, tylko z informacją o zestawie. Dlatego reguła klasy poniżej ("ostatni człon z samych
liter") jest poprawna dla SKU magazynowych i nie wymaga zmiany; SKU z zamówienia nie dostaje klasy z `sku_class` magazynu. Dla asystenta AI
`ai.order_items` ma `sku_base` (SKU bez końcówki `-nM`, pasuje do SKU z `ai.stock`), `sku_controllers` i `sku_class` (z `sku_base`), a prompt
każe łączyć sprzedaż z magazynem po `sku_base`, nie po surowym SKU.
**"Klasa"** (`sku_class` w widoku, 03.10.2026; wiersz "Klasa" w karcie produktu, sekcja Magazyn) = OSTATNI człon SKU po ostatnim
myślniku, ale tylko gdy składa się wyłącznie z liter (NS-32-V1-D -> D, NS-32-V2-BC -> BC, NS-32-V1-C -> C, NS-32-V2-B -> B, APM-A -> A);
inaczej puste — SKU bez myślnika albo ze starego schematu, gdzie ostatni człon to liczba pad-ów ("PS4-500-B-2M"; "2M" nie jest klasą), nie
dostają fałszywej klasy. Wyliczana w widoku jak kategoria z SKU, widoczna też w `ai.stock` dla asystenta AI.
**Przełącznik zakresu "Dostępne" / "Wszystkie"** (03.10.2026, dwa przyciski z licznikami nad listą Raw data): "Dostępne" (domyślnie) to dotychczasowa lista sztuk ze stanem 1
(`fakturownia_stock_with_sku`), "Wszystkie" to także produkty niedostępne/sprzedane — widok `fakturownia_products_with_sku` (`margin.sql`) nad historią zakupów (`fakturownia_purchases`: produkty utworzone
od 01.01.2025 PLUS wszystkie sztuki ze stanem 1, więc "Wszystkie" zawsze zawiera "Dostępne"). Widok liczy SKU/kategorię z SKU/klasę tak samo jak widok "Dostępne" (test porównuje oba) i dodaje `stock_level`/`available`;
w trybie "Wszystkie" jest kolumna **"Stan"** (dostępne/niedostępne). Zmiana zakresu czyści filtry kategorii i klasy, a wyszukiwanie, filtry i pasek podsumowania liczą się na wybranym zakresie. VAT tylko dla sztuk w cache (dla sprzedanych puste).
Podsumowanie magazynu (kafelki, wykres, koszty) dalej dotyczy WYŁĄCZNIE dostępnych. Przełącznik pojawia się dopiero po `margin.sql` (bez widoku zostaje samo "Dostępne"), a "Wszystkie" jest puste do pierwszej pełnej synchronizacji z Fakturownią.
`fakturownia_purchases` jest czytelna dla każdego zalogowanego (te same dane są już widoczne w cache), zapis tylko serwer.
**Filtry "Kategoria z SKU" i "Klasa"** (03.10.2026, dwie listy rozwijane nad Raw data, obok wyszukiwarki po numerze seryjnym; **działają JEDNOCZEŚNIE**, razem z
wyszukiwaniem — AND): opcje "Wszystkie" / "Bez SKU" (kategoria) albo "Bez klasy" / każda wartość z licznikiem (np. "NS (249)", "B (310)"). **Liczniki są
wzajemnie zależne:** po wybraniu kategorii lista klas pokazuje tylko klasy sztuk z tej kategorii (i odwrotnie), a wybrana wartość zostaje na liście nawet przy
zerowym wyniku. Listy budowane z par (kategoria z SKU, klasa) wszystkich sztuk wczytywanych z widoku i odświeżanych razem z listą; zmiana filtra wraca na stronę 1.
W tabeli Raw data jest też kolumna **"Klasa"** (zaraz po "Kategoria z SKU").
**Podsumowanie pod tabelą Raw data** (03.10.2026): pasek z liczbą sztuk, sumą cen zakupu i **średnią ceną zakupu** dla CAŁEGO wyniku bieżących filtrów
(wyszukiwanie + kategoria z SKU + klasa), a nie tylko dla widocznej strony. Liczone w przeglądarce z cen wszystkich pasujących sztuk (osobne zapytanie
paginowane po 1000, bez agregatów PostgREST), przeliczane tylko przy zmianie filtrów/odświeżeniu — nie przy zmianie strony. Pusty wynik pokazuje "—".
**VAT "VM" automatycznie dla zakupów z Trade-in (05.10.2026, na prośbę właściciela):** sztuka, której opis w Fakturowni to numer zamówienia skupu BuyBack (`buyback_orders.order_public_id`, po `btrim`), dostaje w widokach `fakturownia_stock_with_sku` i `fakturownia_products_with_sku` (a więc w Magazynie -> Raw data, karcie produktu i filtrze "Wszystkie") VAT **"VM"** = VAT-marża (zakup od osoby prywatnej). Wartość jest WYLICZANA w widoku, nie zapisywana w cache; ręcznie wpisany VAT (`fakturownia_stock_cache.vat`) ma pierwszeństwo, pusty ręczny VAT też daje "VM".
Sztuki spoza Trade-in (np. faktury "VAT marża" w opisie) nie dostają automatu — ich VAT zostaje do ręcznego uzupełnienia. Wymaga ponownego uruchomienia `inventory.sql` i `margin.sql`.
**VAT** (`fakturownia_stock_cache.vat`, nullable tekst) ma być wpisywany RĘCZNIE przy dodawaniu produktu do
magazynu — na razie nic go nie wypełnia (kolumna pokazuje "—"), synchronizacja z Fakturowni go nie rusza. Podsumowanie
magazynu (kafelki, wykres kołowy) dalej czyta tabelę, nie widok — z wyjątkami: **drugi wykres obok pierwszego** (02.10.2026): oba pierścienie z tabelą mają teraz po pół szerokości
(`CategoryBreakdown.tsx`, układ `xl:grid-cols-2`, na węższym ekranie jeden pod drugim) — pierwszy wg kategorii z Fakturowni,
drugi **wg "kategorii z SKU"** (`fetchSkuBreakdown` w `page.tsx`, z widoku; sztuki bez SKU w osobnym, jasnoszarym wierszu
"Bez SKU" zawsze na końcu; tabela ucięta do 10 największych kategorii + wiersz "Inne (k kat.)", bo kategorii z SKU jest ~40).
Udziały obu wykresów liczone względem tej samej łącznej wartości. Gdy widoku brak (nie uruchomiono `inventory.sql`), zamiast
drugiego wykresu jest krótka informacja. Oraz: pod kafelkiem "Dostępne produkty" jest linijka **"z SKU: N (X%) · bez SKU: M"** (02.10.2026; licznik z widoku `fakturownia_stock_with_sku`, `FakturowniaSummary.skuCount`; gdy widoku brak albo zapytanie padnie, linijka znika, reszta podsumowania działa).

Ręczna ewidencja sztuk w tabeli `units` została **wycofana z Magazynu** na prośbę właściciela
i jej kod usunięto z `page.tsx` (lista, dodawanie, panel szczegółów, `CATEGORIES` z polami per
kategoria). Sama tabela `units` zostaje w `schema.sql` — dwa z czterech starych kafelków Przeglądu
("Gotowe do sprzedaży", "W naprawie") wciąż z niej liczą (dziś same zera, bo nic do niej nie
zapisuje). **"Urządzenia" i "Wartość magazynu" przełączone na prawdziwe dane 01.10.2026** (na
prośbę właściciela, wprost na te same liczby co kafelki "Dostępne produkty"/"Łączna wartość" w
Magazyn → Podsumowanie) — `fakturowniaSummary.totalCount`/`totalValue` (ten sam stan już liczony
z `fakturownia_stock_cache`, patrz sekcja Magazyn niżej), nie osobne zapytanie. Planowana karta
towaru z magazynu ma zastąpić `units` całkowicie — wtedy pozostałe dwa kafelki też trzeba
przełączyć na nowe źródło.

**Bidder** (zakładka Bidder, `TradeInView.tsx`). Automat cen skupu Back Market (DE/ES/FR/IT):
dla każdego SKU ustawia chwilowo 10 €, czyta `price_to_win` i ustawia `min(price_to_win, cena max)`.
Tabele `buyback_skus`, `buyback_runs`, `buyback_log`, `buyback_price_history`,
`buyback_settings` (`tradein.sql`). Logika `lib/buyback.ts`, route `tradein/bidder`
(GET = cron, POST = "Uruchom teraz"). Przebieg (~135 SKU × ~3 s) dzielony na "ticki" po
max ~2 min; kursor to `last_attempt_at < run.started_at`. `in_progress_since` pilnuje
przywrócenia cen po ubitej funkcji. Historia cen tylko przy zmianie ceny. Stary program na
Macu jest wyłączony; bidder działa na produkcji, włącznik: `buyback_settings.enabled`.

**Uruchomienie biddera tylko dla zaznaczonych SKU (05.10.2026, na prośbę właściciela; Bidder -> Ceny SKU, w pasku zaznaczenia "Uruchom bidder dla zaznaczonych"):** `POST /api/tradein/bidder` z body `{ skus: [...] }` -> `bidderRunSkus` (`lib/buyback.ts`) robi przebieg TYLKO dla wskazanych SKU, od razu, w jednym wywołaniu (bez czekania na cron i bez ruszania reszty katalogu): te same kroki co zwykły przebieg
(10 € -> cena do wygrania -> `min(do wygrania, max)`) i te same reguły (tylko SKU nieignorowane i z ceną max > 0; pozostałe są pomijane i policzone jako `skipped`). Bierze TEN SAM zamek co tick crona — gdy cron akurat pracuje, zwraca `locked` ("spróbuj za chwilę"); przed startem przywraca ceny po ubitych przebiegach (`recoverInterrupted`).
Limit 60 SKU i 240 s na jedno kliknięcie (ok. 5 s na SKU), reszta wraca jako `remaining`/"niewykonane — uruchom ponownie". Zapisuje własny, OD RAZU zakończony wpis w `buyback_runs` (`source = "selected"`, widać w "Przebiegi i log") zamiast "trwającego" przebiegu — po ubitej funkcji cron nie dociągnie przez to całego katalogu. Przed uruchomieniem `confirm` z liczbą SKU (zmienia ceny na żywym Back Markecie); działa też przy wyłączonym automatycznym bidderze.
Nie testowane na żywym API Back Market (zmienia prawdziwe ceny skupu) — logika to ten sam `processSku`, co w zwykłym przebiegu.
**Pary "nasza cena / cena do wygrania" i status wygrywania (05.10.2026, na prośbę właściciela; Bidder -> Ceny SKU):** kolumny rynków (DE/ES/FR/IT) pokazują `nasza / do wygrania` z ostatniego przebiegu, nasza cena zielona, gdy wygrywa (cena >= cena do wygrania), czerwona, gdy cena max jest za niska (bidder ustawia `min(do wygrania, max)`, więc przegrywa tylko przy `max < do wygrania`).
Cena do wygrania zapisuje się w nowej kolumnie `buyback_skus.last_ptw` (jsonb jak `last_set`; `tradein.sql`) — **osobnym, nieblokującym zapisem** w `processSku` (`lib/buyback.ts`), żeby brak kolumny przed uruchomieniem SQL nie zepsuł głównego zapisu cen/`last_set`. **Status:** "wygrywa" (wszystkie rynki z parą), "wygrywa n/m" albo "nie wygrywa" (amber), "błąd" (`last_error`, w podpowiedzi treść) — jak dotąd; wiersze bez pary (przebieg sprzed zmiany) pokazują stare "OK" i same ceny do następnego przebiegu.
Rynek, na którym API nie podało ceny do wygrania (zostaje 10 €), nie liczy się do wygrywania. Nowa pigułka filtra **"Nie wygrywają"** (SKU w wycenie, bez błędu, wygrywające mniej niż na wszystkich rynkach z parą).
**Natychmiastowa aktualizacja ceny po zmianie max (06.10.2026, na prośbę właściciela — "nie czekajmy na zbiorczą zmianę"):** po zapisaniu ceny max (komórka), po zmianie hurtowej (do 60 SKU naraz) i po zdjęciu "Ignoruj" przy SKU z ceną max, aplikacja od razu woła `POST /api/tradein/bidder` z `{ skus }` (ten sam mechanizm co "Uruchom bidder dla zaznaczonych": 10 € -> cena do wygrania -> `min(do wygrania, max)`), nie czekając na swoją kolej w zbiorczym przebiegu — `pushNow` w `TradeInView.tsx`, wynik w komunikacie ("cena zaktualizowana na Back Markecie"). Bez potwierdzenia przy edycji pojedynczej komórki (właściciel świadomie tego chciał); zmiana hurtowa ma `confirm` jak dotąd. SKU **ignorowane** nie są przeliczane (komunikat to mówi). **Gdy bidder akurat pracuje w tle** (trzyma blokadę, przebieg trwa ~12 min z 16): trigger `buyback_skus_request_recheck` (`tradein.sql`) znakuje SKU w `recheck_requested_at` (zmiana max na > 0 albo zdjęcie ignorowania; też przy zmianie spoza aplikacji), a trwający przebieg bierze takie SKU **pierwsze, przed resztą kolejki** (`priorityQueue` w `lib/buyback.ts`, sprawdzane przed każdym SKU, max 10 naraz); gdy żaden przebieg nie jest prowadzony, tick przelicza je od razu (wpis w `buyback_runs` ze `source = 'recheck'`). **Przy okazji poprawione:** `processSku` czyta teraz aktualną cenę max i flagę "ignorowany" tuż przed wyceną — kolejka ticka powstaje na jego starcie (do ~2 min wcześniej), więc zmiana max w trakcie ticka była ignorowana, a SKU zignorowane w międzyczasie wciąż były przeliczane. Przed uruchomieniem `tradein.sql` działa natychmiastowe wołanie z aplikacji, ale bez pierwszeństwa w trwającym przebiegu (komunikat "bidder pracuje, zaktualizuje w jego przebiegu").
**Rynek bez konkurencji — Włochy (06.10.2026, na prośbę właściciela):** we Włoszech bywa, że nikt nie licytuje i cena do wygrania jest absurdalnie niska (np. 48 € za konsolę wartą ok. 400 €; nikt takiej nie sprzeda), a bidder kupowałby po niej. Reguła (`lib/noCompetition.ts`, wspólna dla biddera i UI): gdy na rynku z listy `NO_COMPETITION_MARKETS` (dziś tylko **IT**) cena do wygrania jest **niższa niż 55% (do 06.10.2026 wieczorem było 50%) najwyższej ceny ustawionej na pozostałych rynkach** (DE/ES/FR), cena na tym rynku = **85% (czyli 15% niżej) tej najwyższej ceny**, nigdy powyżej ceny max SKU (referencja jest ograniczona max, więc w praktyce to 85% max, a gdy pozostałe rynki wygrywają poniżej max — 85% ich najwyższej ceny). Stosowana w `processSku` po wyliczeniu `min(ptw, max)` per rynek; w logu przebiegu dopisek "IT: brak konkurencji (cena do wygrania 48) → 85% ceny z pozostałych rynków"; w tabeli Ceny SKU przy cenie z reguły znacznik **"brak konk."** (podpowiedź z wyjaśnieniem). **Próg 55% to moja interpretacja "braku konkurencji"** (po zgłoszeniu "na modelu XSS jest to samo" podniesiony z 50%: XSS-512-C-1M miał IT 76 € przy 151,65 €, czyli 50,1%) (właściciel podał tylko przykład 48 € vs ~400 €) — dobrany tak, żeby nie ruszać normalnych różnic cen między rynkami (np. PS4: IT 38 € przy 57–66 € w DE/ES/FR to proporcja 0,58–0,67, więc reguła NIE działa; XSX z IT 204/138 € przy 450 € i XSS z IT 48/76/65 € przy 111–197 € — działa; **uwaga: powtarzające się w IT ceny 33/38/48 € dla różnych modeli wyglądają na dolną granicę (brak ofert), więc PS4 z 38 € też może być "bez konkurencji" — nie ruszane, bo właściciel o PS4 nie pisał**); zmiana progu/rabatu/rynków to stałe `NO_COMPETITION_THRESHOLD`/`NO_COMPETITION_DISCOUNT`/`NO_COMPETITION_MARKETS`. Gdy dla IT w ogóle nie ma ceny do wygrania, reguła NIE działa (rynek zostaje na 10 € jak dotąd), tak samo gdy inne rynki nie mają cen. Nie testowane na żywym API (zmienia ceny skupu): logika zweryfikowana testem na wierszach ze zrzutu właściciela.
**Link do oferty w Back Market (06.10.2026, na prośbę właściciela):** w karcie SKU (`SkuDrawer`), w tabeli "Konkurencja", przy każdym rynku link "oferta ↗" -> `https://www.backmarket.fr/bo-seller/buyback/create-quotation/{product_id}?countryCode={DE|ES|FR|IT}` (jedna domena .fr; adres po `buyback_skus.product_id`, wspólnym dla SKU tego samego modelu, nie po `listing_id`); bez `product_id` linku nie ma.
**Nieaktualne liczby w wierszu (06.10.2026, pytanie właściciela: "mam max 70, a wygrywam przy 107"):** para "nasza cena / do wygrania" i status pochodzą z OSTATNIEGO przebiegu, a nie z bieżącej ceny max. Gdy max obniżono po przebiegu (w tym przypadku 140 -> 70) i SKU jest **ignorowany** (bidder go w ogóle nie przelicza), wiersz dalej świecił "wygrywa", a oferta na Back Markecie zostaje na starej cenie (107,45 €), dopóki ktoś nie zdejmie ignorowania i nie uruchomi przebiegu. Teraz status pokazuje **"ignorowany"**, a gdy ostatnio ustawiona oferta jest wyższa niż cena max — czerwony znacznik **"max < oferta"** (dla SKU nieignorowanego pomarańczowy: obniży się w następnym przebiegu); `offerAboveMax` w `TradeInView.tsx`.
**Hurtowa zmiana ceny max** (03.10.2026, na prośbę właściciela; zakładka Bidder -> Ceny SKU): kolumna checkboxów po lewej (nagłówek =
zaznacz/odznacz WSZYSTKIE WIDOCZNE wiersze, ze stanem "częściowo"), a po zaznaczeniu pojawia się pasek z polem "Zmień cenę max o" (kwota w €,
ujemna obniża, np. `5` albo `-10`) i przyciskiem "Zastosuj". **Zmiana jest o wartość (nowa = obecna + delta), nie ustawieniem jednej ceny.**
Zaznaczenie obejmuje tylko widoczne wiersze i **czyści się przy zmianie wyszukiwania/filtra**, żeby hurtowa zmiana nie dotknęła SKU, których już
nie widać. Logika planu w `lib/bulkPrice.ts` (testowana): pomija SKU bez ceny max (nie ma do czego dodać), takie, którym wyszłoby <= 0 (0 znaczy
"brak ceny max"), i takie z niezapisaną edycją w wierszu. Przed zapisem `confirm` z liczbą SKU, przykładem (`SKU: €65 → €70`) i listą pominiętych —
to ceny na żywym Back Markecie (Bidder użyje ich w najbliższym przebiegu). Każdy zapis ma warunek na starą cenę (`eq("max_price", stara)`): jeśli ktoś
w międzyczasie zmienił SKU, ta pozycja jest pomijana i raportowana, a nie nadpisywana. Zapisy idą po 8 równolegle jako zwykłe UPDATE-y, więc każdy
trafia do logu zmian ceny max z autorem (trigger w bazie, patrz niżej). Bez zmian w bazie.
**Log zmian ceny maksymalnej** (03.10.2026, na prośbę właściciela; karta SKU w Bidderze — `SkuDrawer` w `TradeInView.tsx`, sekcja "Log zmian
ceny maksymalnej" nad historią cen): kto, kiedy i z jakiej na jaką cenę zmienił max (`€85 → €90`, "brak" = pusta cena). Wypełnia go **trigger
w bazie** (`buyback_log_max_price_change` na `buyback_skus`, `tradein.sql`, tabela `buyback_max_price_log`) przy każdej realnej zmianie `max_price` —
z UI, z SQL Editora i z serwera — więc nie da się go ominąć kodem aplikacji; nie loguje zapisów bez zmiany wartości ani zmian innych kolumn (np.
`ignored`) i loguje też wyczyszczenie ceny oraz nowy SKU z już ustawioną ceną. Autor z JWT (`auth.jwt()->>'email'`, w razie braku z `members` po
`auth.uid()`); zmiany spoza aplikacji (service_role, SQL Editor, import) nie mają autora i w UI widać "poza aplikacją". Tabela logu jest tylko do odczytu
dla zalogowanych (zapisuje wyłącznie trigger jako security definer; brak polityk insert/update/delete). Log działa od momentu uruchomienia aktualizacji
`tradein.sql` — wcześniejszych zmian nie odtworzy (np. dwie zmiany cen PS4P z 02.10.2026, zrobione bezpośrednio w bazie, w nim nie ma). `TradeInView`
dostaje `members` z `page.tsx` (do skróconych imion).

**Trade-in** (zakładka Trade-in, `TradeInHub.tsx`) — dwa podwidoki:
- *Raw data* (`TradeInOrdersView.tsx`): podgląd zsynchronizowanych zamówień BuyBack (`buyback_orders`, sync co 15 min
  z `GET /ws/buyback/v1/orders`: pełny skan od 1 stycznia przez `creationDate` w porcjach z kursorem,
  potem przyrostowo przez `modificationDate` — łapie nowe i zmiany statusu). Zapis tylko serwer. Lista jest
  stronicowana po stronie serwera (`.range()`, 10/20/50, przyciski Poprzednia/Następna — 30.09.2026, wcześniej
  `.limit()` bez offsetu pokazywał zawsze tylko pierwszą stronę z 17 tys.+ zamówień, wzorzec jak w `InventoryRawView.tsx`).
  Pigułki filtra **Wszystkie / Wysłane** nad listą (30.09.2026, `smallPill` jak w `SalesOrdersHub.tsx`) — "Wysłane"
  to `.eq("status", "SENT")` (surowy status BuyBack API, `buyback_orders.status`; wartości potwierdzone na żywych
  danych: `TO_SEND`/`SENT`/`RECEIVED`/`PAID`/`MONEY_TRANSFERED`/`VALIDATED`/`CANCELED`/`SUSPENDED`/
  `COUNTER_PROPOSAL` — na razie bez własnego mappera etykiet, status pokazuje się na liście surowy). Zmiana filtra
  resetuje stronę na 1, jak zmiana rozmiaru strony. Kolumny **Utworzono** i **Data modyfikacji** (`buyback_orders.
  modification_date`, dodana 30.09.2026) są klikalne nagłówki sortujące (strzałka ▲/▼ przy aktywnej kolumnie,
  sortowanie po stronie serwera przez `.order()`, nie w przeglądarce) — klik na nieaktywną kolumnę ustawia ją
  malejąco (najnowsze pierwsze), klik na już aktywną odwraca kierunek; zmiana też resetuje stronę na 1.
  Nad listą kafelki **Zamówienia dzisiaj / wczoraj** (`TradeInDaySummary`, po dacie utworzenia, podział na rynek
  DE/ES/FR/IT zamiast marketplace'u — analogiczny wzorzec do `DaySummary` w `SalesOrdersHub.tsx`, ale bez filtrowania
  statusów, bo to skup, nie sprzedaż).
- *Wprowadzanie*: obsługa paczek przez pracowników. Pracownik podaje numer zamówienia LUB
  przesyłki, aplikacja znajduje zamówienie (`buyback_order_intake`, unikalne na
  `order_public_id` — ta sama paczka nie zaliczy się dwa razy). Status:
  W trakcie / Obsłużona / **Kontroferta** (30.09.2026) / **Ok. Dok.** (01.10.2026) / Problem, czas obsługi,
  podsumowanie punktacji Dziś/7/30 dni. **Punkty 100/6 za paczkę liczą się dla Obsłużona, Kontroferta, Ok. Dok.
  I Problem** (`POINTS_STATUSES` w `TradeInHub.tsx`) — pierwotnie (Regulamin §2 ust. 4: po prawidłowym zakończeniu
  procesu) tylko dla "Obsłużona"; rozszerzenie na Kontrofertę, Ok. Dok. i Problem to **świadoma decyzja
  właściciela**, nie literalny zapis regulaminu — potwierdzone wprost przy dodawaniu tych statusów, nie
  domyślone. "Kontroferta" i "Ok. Dok." są **czysto wewnętrznymi statusami** — w odróżnieniu od "Obsłużona" NIE wołają
  żadnego API Back Marketu (BM ma wprawdzie własną koncepcję `COUNTER_PROPOSAL`/`counter_offer_price`/
  `counter_offer_reasons` na poziomie zamówienia, ale świadomie z nią nie integrujemy — to był jawny wybór
  przy dodawaniu statusu, nie przeoczenie). "Ok. Dok." oznacza paczkę z kompletną, poprawną dokumentacją
  (potwierdzone przy dodawaniu tej funkcji, że ma wymagać tego samego kompletu numer seryjny/SKU/pady co
  "Obsłużona" i "Kontroferta" — nie osobny, luźniejszy warunek). **Punktacja liczona TYLKO RAZ (05.10.2026, na prośbę właściciela — "zmiana statusu nie może naliczać punktów kilka razy, np. Ok. Dok. -> punkty, potem Obsłużona -> punkty"):** paczka to jeden wiersz (unique na `order_public_id`), więc punkty nigdy nie sumowały się podwójnie, ale UI przy KAŻDEJ zmianie statusu nadpisywał `finished_at` bieżącą chwilą, a podsumowanie Dziś/7/30 liczyło po `finished_at` — paczka zaliczona wczoraj pojawiała się znów "dziś", a punkty z ubiegłego miesiąca przeskakiwały do bieżącego.
Teraz kolumna `points_awarded_at` (chwila PIERWSZEGO wejścia w status punktowany: obsłużona/kontroferta/ok. dok./problem) ustawiana wyłącznie triggerem `buyback_order_intake_points_once` (zegar serwera; zalogowani nie zmieniają jej ręcznie, nie czyści jej cofnięcie do "W trakcie" — powrót do punktowanego statusu nie daje nowej daty); `finished_at` też zostaje na pierwszym zakończeniu przy przejściach między statusami zakończenia
(czyści je tylko powrót do "W trakcie", a "Czas obsługi" liczy do pierwszego zakończenia). Podsumowanie punktów (`IntakeView` w `TradeInHub.tsx`) liczy po `points_awarded_at` (przed uruchomieniem `buyback-orders.sql` awaryjnie po `finished_at`). Wiersze sprzed zmiany dostały `points_awarded_at = finished_at` (ich pierwotna data zaliczenia, jeśli były już przestawiane, jest nieodtwarzalna — przyjmujemy ostatnią zmianę statusu). Punkty za paczkę nadal liczą się tylko dopóki status jest punktowany.
Numer przesyłki służy tylko do
  znalezienia zamówienia przy rozpoczynaniu (w liście nie ma kolumny przesyłki; jest na karcie).
  **Lista paczek ma paginację po stronie serwera (07.10.2026, na prośbę właściciela; wcześniej tylko najświeższe 50 wpisów):** `.range()` + licznik z bazy, wybór "Pokaż" 10/20/50/100 (domyślnie 50), "z N paczek · strona X z Y", przyciski Poprzednia/Następna nad tabelą obok wyszukiwarki; zmiana wyszukiwania lub rozmiaru strony wraca na stronę 1, strona poza zakresem (np. po usunięciu wpisów) też. **Pigułki Dziś / 7 dni / 30 dni** (okres podsumowania punktacji) przeniesione pod nagłówek podsumowania, po lewej stronie. Wyszukiwarka nad listą
  (30.09.2026, `escapeLike` jak w `InventoryRawView.tsx`, debounce 300 ms) szuka jednocześnie po numerze zamówienia
  I numerze seryjnym (`order_public_id.ilike.%...%,serial_number.ilike.%...%` — PostgREST `.or()`) i wtedy limit
  rośnie do 200, bo szukany wpis mógł dawno wypaść poza najświeższe 50. **Kolorowanie wierszy wg osoby, która
  dodała wpis** (01.10.2026, `ROW_COLOR_BY_EMAIL`/`rowColorForUser` w `TradeInHub.tsx`): przypisanie
  e-mail -> kolor na sztywno w kodzie, kolory dobrane przez właściciela po imieniu (Zuzanna różowy, Kuba
  Szymoniak niebieski, Kuba Gola fioletowy, Adrian żółty — wszystkie jasne/pastelowe, żeby nie gryzły się z
  plakietkami statusu w komórkach) — nie wyliczane automatycznie z hasha. Osoba spoza tej listy (np. nowa w
  zespole) dostaje brak koloru (zwykłe tło wiersza), dopóki właściciel nie poda dla niej koloru. Czysto
  wizualne ułatwienie do szybkiego rozróżnienia "czyja to paczka" na oko, bez osobnej kolumny ani filtra.
- Kolumny edytowane w wierszu: Numer seryjny, SKU, Pady (liczba padów w zestawie — konsole; int >= 0,
  0 jest poprawną wartością), Numery seryjne padów (`pad_serials text[]`, element i = pad i+1; osobne pole na każdy pad, tyle ile wpisano w Pady, max 20; Enter w polu — skaner — zapisuje i przechodzi do następnego; nie wymagane do "Obsłużona"/"Kontroferta"/"Ok. Dok."), Uwagi. **Warunek:** statusy "Obsłużona", "Kontroferta" I "Ok. Dok."
  (30.09.2026 — kontroferta dotyczy konkretnego, już zidentyfikowanego urządzenia, więc ten sam komplet;
  01.10.2026 — Ok. Dok. tak samo;
  "Problem" zostaje bez wymagań, bo paczka mogła nie dojść do etapu identyfikacji) wymagają numeru
  seryjnego, SKU i padów — pilnuje tego UI (`changeStatus`, `COMPLETE_REQUIRED_STATUSES`, komunikat co
  brakuje z nazwą statusu) i trigger `buyback_order_intake_require_complete` w bazie (sprawdza przy
  przejściu na jeden z tych trzech statusów i przy czyszczeniu pola w już zakończonej paczce, więc stare
  wiersze bez danych można uzupełniać po jednym polu). Kolumna **Dok.** = checkbox `docs` (boolean, domyślnie false; nie jest wymagana do żadnego statusu; zmiany w logu jako "tak"/"nie").
  **Kanały skupu (06.10.2026, na prośbę właściciela; "Rozpocznij obsługę paczki" ma listę "Kanał skupu"):** domyślnie **Buyback** (jak dotąd: numer zamówienia lub przesyłki szukany wśród zamówień BM, walidacja w BM przy "Obsłużona"), do wyboru także **Allegro, Vinted, OLX, Umowa** (`INTAKE_CHANNELS` w `lib/workLog.ts`, kolumna `buyback_order_intake.channel` — zwykły tekst jak `role`, dodanie kanału to wpis na liście, bez SQL). **Dla kanałów innych niż Buyback pracownik wpisuje NUMER PRZESYŁKI** i to on jest kluczem wpisu (`order_public_id`, nadal unikalny — ta sama paczka nie zaliczy się dwa razy; w kolumnie "Numer zamówienia / przesyłki"); nie ma dla nich zamówienia BM, więc **"Obsłużona" nie woła Back Marketu** (zmienia tylko status), kolumny "Imię i nazwisko", "Zadeklarowane SKU" i "Status BM" są puste ("—"), karta paczki pokazuje tylko dane pracownika i log (bez sekcji BM). Reszta działa tak samo jak w Buyback: SKU/numer seryjny/pady wymagane do "Obsłużona/Kontroferta/Ok. Dok.", usterki, punkty (**17 pkt dla każdego kanału** — nikt nie prosił o inną stawkę), podsumowanie punktacji i status produktu w Magazynie; kolumna "Kanał" (plakietka) w liście i wiersz "Kanał" w karcie produktu.
  **Zmiana w bazie:** klucz obcy `order_public_id -> buyback_orders` został USUNIĘTY (inaczej numer przesyłki z Allegro/OLX nie miałby jak się zapisać); jego rolę dla kanału Buyback przejmuje trigger `buyback_order_intake_check_order` (wpis Buyback wymaga istniejącego zamówienia BM). Bez klucza PostgREST nie robi już osadzenia `buyback_orders(...)`, więc lista Wprowadzania dociąga dane zamówień BM osobnym zapytaniem (`attachBmOrders`). Przed uruchomieniem `buyback-orders.sql` kolumna Kanał i lista wyboru same znikają (awaryjny odczyt bez kolumny `channel`, kod 42703). **Poza zakresem:** koszty Trade-in/PCC i VAT "VM" w Magazynie/Marży liczą się tylko dla zakupów z zamówień BM — zakup z Allegro/Vinted/OLX/Umowy nie dostaje ich automatycznie.
  **Usterki** (06.10.2026, na prośbę właściciela; kolumna po "Dok.", `buyback_order_intake.defects text[]`, `DefectsCell.tsx`): wpisujesz np. "hdmi" i naciskasz Enter — usterka staje się plakietką z ×, a pole od razu czeka na kolejną (opuszczenie pola z niepustym tekstem też dodaje). Cała tablica zapisuje się po każdym dodaniu/usunięciu (kolejka `enqueueUpdate` jak przy padach), w logu zmian "Usterki" jako lista po przecinku; duplikaty (bez rozróżniania wielkości liter) pomijane, max 20 usterek po 60 znaków. Nie wymagane do żadnego statusu, nie wpływa na punkty. Widoczne i edytowalne też w karcie zamówienia. Przed uruchomieniem `buyback-orders.sql` kolumna sama znika z listy i karty (awaryjny odczyt bez niej, kod 42703). **Karta produktu** (po kliknięciu numeru seryjnego, np. w Serwisie — żeby serwis widział usterki zgłoszone przy przyjęciu) ma sekcję **"TRADE-IN"**: numer zamówienia, status obsługi, **usterki** (plakietki), uwagi i kto obsłużył; bez kolumny `defects` (nieuruchomione SQL) odczyt wraca do wersji bez usterek. Nie dodane do widoków `ai.*`.
- **Zadeklarowane SKU** i **Imię i nazwisko** (30.09.2026, kolumny tylko do odczytu) — dane z samego
  zamówienia BuyBack (`buyback_orders.sku`/`customer_first_name`/`customer_last_name`, dociągnięte przez
  PostgREST embed `buyback_orders(...)` po kluczu obcym `order_public_id`, zwraca pojedynczy obiekt, nie
  tablicę — sprawdzone bezpośrednio zapytaniem, nie zgadywane), INNE od edytowalnej kolumny "SKU" obok
  (to, co wpisuje pracownik po fizycznym sprawdzeniu paczki — może różnić się od tego, co klient
  zadeklarował przy składaniu zamówienia). "Imię i nazwisko" renderuje imię NAD nazwiskiem (dwie linie w
  jednej komórce), żeby kolumna nie poszerzała tabeli.
- **Walidacja w Back Market przy "Obsłużona"** (`app/api/tradein/validate/route.ts`, `PUT /ws/buyback/v1/orders/{id}/validate`,
  bez body): najpierw ostrzeżenie (`confirm`: nieodwracalne, uruchamia wypłatę dla klienta, kwota, status BM), potem serwer
  waliduje w BM i dopiero po sukcesie zapisuje status paczki. Odmowa BM (np. status inny niż RECEIVED) = status się nie
  zmienia, błąd widać nad listą. Serwer nie ufa przeglądarce: wymaga zalogowanego użytkownika (sekret crona nie wystarcza)
  oraz kompletu numer seryjny/SKU/pady w bazie; zamówienie już VALIDATED/PAID/MONEY_TRANSFERED nie jest walidowane drugi raz
  (ponowna próba po błędzie zapisu statusu jest bezpieczna). Wynik ląduje w logu ("Walidacja Back Market: zwalidowano").
  Cofnięcie statusu paczki NIE cofa walidacji w BM. Mapper zamówienia jest wspólny: `lib/buybackOrders.ts`.
- **Status zamówienia w Back Markecie** (`buyback_orders.status`, surowy stan z API BuyBack — np. `SUSPENDED`,
  `TO_SEND` — NIE mylić z naszym statusem obsługi paczki, `buyback_order_intake.status`, patrz wyżej) ma teraz
  (30.09.2026, na prośbę właściciela) polskie etykiety i kolory: `BUYBACK_ORDER_STATES`/`buybackStatusLabel`/
  `buybackStatusStyle` w `lib/buybackOrders.ts`, jedno źródło dla karty zamówienia (gdzie wcześniej widać było
  surowe `SUSPENDED` zamiast "Wstrzymane"), kolumny **"Status BM"** w Wprowadzanie (nowa kolumna, przy nowej
  "Status" pracownika dla porównania) i kolumny "Status" w Raw data (tam wcześniej też surowy string — przy
  okazji poprawione, to samo źródło, nie osobna kolumna w bazie). **Oficjalna dokumentacja Back Marketu
  (`buybackOrderState`, api.backmarket.dev) wymienia tylko 10 wartości** (NEW/PENDING/TO_SEND/SENT/RECEIVED/
  COUNTER_PROPOSAL/VALIDATED/PAID/MONEY_TRANSFERED/SUSPENDED) — **`CANCELED` w ogóle nie jest w tym schemacie**,
  a mimo to realnie występuje na żywych danych (sprawdzone: 7477 z ok. 17,5 tys. zamówień — drugi po
  `MONEY_TRANSFERED` najczęstszy stan) — zaufaliśmy żywym danym, nie dokumentacji, i dodaliśmy mu etykietę
  ("Anulowane") mimo braku w schemacie; nieznana wartość (gdyby BM dodał kolejną) i tak pokaże się surowa
  zamiast wybuchać. Kolory pogrupowane wg znaczenia, nie jeden unikalny kolor na wartość (za dużo stanów, żeby
  to było czytelne): teal = zakończone wypłatą (VALIDATED/PAID/MONEY_TRANSFERED), niebieski (`#e3ecf9`/`#2a6bb5`,
  ten sam co "Kontroferta" w naszym statusie obsługi — inny system, to samo pojęcie biznesowe) = COUNTER_PROPOSAL,
  rust = wstrzymane/anulowane (SUSPENDED/CANCELED), amber = reszta normalnego przebiegu (NEW/PENDING/TO_SEND/
  SENT/RECEIVED).
- **Koszty dodatkowe zakupu Trade-in** (03.10.2026, na prośbę właściciela; karta zamówienia Trade-in, sekcja "Cena i przesyłka"; `lib/buybackCosts.ts`).
  Wg Regulaminu Back Market "EU Sellers T&Cs" (marzec 2026), część IV, art. 15.1 "Trade-in": **(1) prowizja 10% (netto)** od całkowitej kwoty zapłaconej przez
  Refurbishera (z podatkami i przesyłką) — u nas od ceny dla klienta, a gdy była kontroferta, **od ceny PO kontrofercie** (decyzja właściciela; bez kontroferty
  od ceny początkowej: `counter_offer_price ?? original_price`); **(2) opłata logistyczna Trade-in** — stała, w EUR, zależna od KRAJU MAGAZYNU sprzedawcy i
  kategorii: magazyn w Polsce = "inne kraje" → **smartfony i audio 12,90 €, MacBooki i konsole 15,90 €, tablety 13,90 €** (FR/ES/DE mają 11,90/14,90/13,90 —
  `TRADEIN_LOGISTICS_REGION` przestawia region jedną stałą). **Koszt całkowity = cena + prowizja + logistyka**; karta pokazuje: cenę do wyliczeń, prowizję,
  logistykę (z kategorią), koszty dodatkowe razem i koszt całkowity. **Kwoty netto — regulamin podaje je "excl. tax", VAT nie jest doliczany** (czy i jak BM
  fakturuje VAT od tych opłat, to sprawa księgowości, nie kodu). Back Market pobiera opłaty przy WYPŁACIE dla klienta (po odebraniu i zwalidowaniu paczki, art. 16.2) i
  wystawia fakturę zbiorczą raz w miesiącu, więc w karcie jest podpis: "naliczone" (VALIDATED/PAID/MONEY_TRANSFERED), "szacunek" (reszta) albo "anulowane — nie
  zostaną naliczone" (CANCELED); **to szacunek z regulaminu, nie faktura**. Kategoria wg regulaminu z NAZWY produktu BM (`product_title`: PlayStation/Xbox/Nintendo/Steam Deck/ROG Ally/Onexplayer/
  Anbernic/Meta Quest/MacBook -> konsole i MacBooki; iPad/Galaxy Tab -> tablety; iPhone/Galaxy S/Pixel/Oppo/AirPods/Bose/Marshall... -> smartfony i audio), a gdy
  nazwa nic nie mówi — z prefiksu SKU (SKU bywa puste albo "None"); sprawdzone na 17 568 zamówieniach z bazy: 100% sklasyfikowane. **Założenie:** konsole przenośne i gogle VR
  (Meta Quest) liczone jak konsole (regulamin ich nie wymienia; stawka "MacBooki i konsole" jest też stawką laptopów). Nieznana kategoria albo waluta inna niż EUR -> prowizja jest, a
  logistyka/suma pokazują "—" (nie zgadujemy). **PCC (03.10.2026, na prośbę właściciela)** — podatek od czynności cywilnoprawnych przy zakupie używanej rzeczy od OSOBY PRYWATNEJ, **wchodzi do kosztów dodatkowych**: wartość do 1000 zł włącznie — zwolniona;
powyżej 1000 zł — **2% CAŁEJ wartości** (nie tylko nadwyżki; np. 1001 zł -> 20,02 zł, 1500 zł -> 30 zł, 3000 zł -> 60 zł; `pccFromValuePln` w `lib/buybackCosts.ts`). **Wartość = cena zapłacona klientowi (po kontrofercie) przeliczona
na PLN kursem NBP z dnia poprzedniego względem wypłaty** (ten sam kurs co reszta kosztów; praktycznie równa cenie zakupu w zł z Fakturowni). PCC liczymy TYLKO dla zakupów z Trade-in (od osób prywatnych), nigdy dla sztuk od
firm (np. faktury "VAT marża") i tylko dla wypłaconych zamówień; bez kursu NBP PCC jest "—" (nie zgadujemy). `computeTradeInCosts` przyjmuje `eurRate` (PLN za EUR) i zwraca `valuePln`/`pccPln`/`pccEur`; PCC w EUR jest dokładane do
"Koszty dodatkowe razem" i "Koszt całkowity" na karcie zamówienia Trade-in (wiersz "PCC — 2% od wartości > 1 000 zł": kwota w zł, w nawiasie EUR i wartość w zł); `tradeInOrderCostPln` (koszty w PLN) dolicza PCC wprost
w PLN, więc **trafia ono też do kafelka kosztów Magazynu i do kolumny "Koszty dodatkowe" w zakładce Marża**. **W karcie produktu** (sekcja "Magazyn (Fakturownia)", pod "Cena zakupu") jest wiersz **"PCC"** z kwotą w zł i wartością
zakupu w zł albo wyjaśnieniem ("— (zakup nie z Trade-in)", "— (zamówienie jeszcze niewypłacone)", "— (brak kursu NBP)"). Na dzień wdrożenia: 52 z 937 zamówień w magazynie przekracza próg, PCC łącznie ≈ 1 718 zł.
**Kurs i PCC liczone od daty PŁATNOŚCI zamówienia BM** (`buyback_orders.payment_date`, pole "Płatność" na karcie; potwierdzone przez właściciela 03.10.2026): kurs = ostatni kurs NBP ŚCIŚLE wcześniejszy niż dzień wypłaty,
a dzień wypłaty brany jako data w czasie POLSKIM (`warsawDate` w `lib/nbp.ts`) — wypłata o 00:30 w Polsce to w UTC jeszcze poprzedni dzień i po dacie UTC dałaby kurs sprzed dwóch dni. Gdy BM nie podał daty płatności (na dzień sprawdzenia 3 z 6823
wypłaconych zamówień), awaryjnie bierzemy datę utworzenia zamówienia. Dotyczy to tylko kosztów Trade-in/PCC; przeliczenia ceny SPRZEDAŻY w Marży i na Przeglądzie dalej liczą datę zamówienia w UTC (jak `overview/sales-stats`).
**Poza zakresem:** opłata 7,50 € za "Trade-in Chargeback" (tylko gdy płatność Refurbishera zostanie odrzucona) i stawki
  prowizji od SPRZEDAŻY (11%/12% itd.) — to osobny temat. Regulamin może się zmienić z 1-miesięcznym wyprzedzeniem (art. 15.1) — przy zmianie zaktualizować stałe w pliku.
- Numer zamówienia jest linkiem do **karty zamówienia** (panel boczny): dane z API + dane
  pracownika (numer seryjny, SKU, pady, uwagi — edytowalne) + numerowany log zmian.
  Na górze karty link "Otwórz w Back Market" → `https://www.backmarket.fr/bo-seller/buyback/orders/{numer}`
  (jedna domena .fr dla wszystkich rynków).

**Zamówienia** (zakładka Zamówienia, `SalesOrdersHub.tsx`) — sprzedaż z marketplace'ów (NIE mylić z zakładką Trade-in,
która obsługuje skup). Dwie podstrony: *Zamówienia* — wspólna lista ze wszystkich kanałów (`sales_orders`, klucz
`marketplace` + `external_id`; kolumny z API: marketplace (etykieta z `MARKETPLACES` w `lib/salesOrders.ts`), nr zamówienia, data, status, **Kraj** (`sales_orders.country_code`, kod ISO 3166-1 alpha-2 odbiorcy/adresu dostawy, tylko odczyt, chroniony jak inne pola API; źródło per kanał: Back Market `shipping_address.country`, refurbed `shipping_address.country_code`, Erli `user.deliveryAddress.country`, Allegro `delivery.address.countryCode`, Octopia pierwsza pozycja z `lines[].shippingAddress.countryCode` — adres jest tylko per-pozycja, Amazon `ShippingAddress.CountryCode`; wartość spoza wzorca dwóch liter albo brak adresu -> `null`, pokazane jako "—"; **zamówienia zsynchronizowane przed dodaniem tej kolumny mają go uzupełnionego jednorazowym `update` w `sales-orders.sql` z już zapisanych surowych danych** — przyrostowa synchronizacja rusza tylko zmienione zamówienia, więc same by go nie dostały), **Metoda wysyłki** (`sales_orders.shipping_method`, tylko odczyt; na razie tylko Back Market — inne kanały `null`, pokazane jako "—") — Back Market API nie ma osobnego pola "standard/express"; jedyny sygnał to `shipper_display` (nazwa przewoźnika/usługi wybrana dla zamówienia, już ustalona ZANIM cokolwiek wyślemy — nie echo naszego zgłoszenia), potwierdzone na żywych danych: "DHL" dla zdecydowanej większości zamówień, "DHL Express" dla nielicznych — `bmShippingMethodLabel` w `lib/salesOrders.ts` rozpoznaje "Express"/"Standard" po słowie "express" w nazwie (nie po sztywnej liście przewoźników, żeby nowy przewoźnik bez "express" w nazwie sam trafił do "Standard"; etykiety skrócone z "Ekspresowa"/"Standardowa" 30.09.2026 na prośbę właściciela; "Express" na liście podświetlone na pomarańczowo — `text-amber font-semibold` — 01.10.2026 na prośbę właściciela, żeby rzucało się w oczy); `delivery_mode` to coś zupełnie innego (HOME_DELIVERY/COLLECTION_POINT — sposób ODBIORU, pokazywany na karcie zamówienia jako "Sposób dostawy", nie mylić). Uzupełnienie dla starych wierszy jest w `sales-orders.sql` (ten sam wzorzec co przy numerze przesyłki — odświeża się przy każdym uruchomieniu pliku, nie tylko raz). **Planowana wysyłka** (`sales_orders.planned_shipping_date`, tylko odczyt, dodana 30.09.2026 na prośbę właściciela) — termin wysyłki wg kanału, **tylko dwa kanały to udostępniają** (sprawdzone na żywych danych z każdej z pięciu surowych tabel przed dodaniem kolumny, nie zgadywane): Back Market `expected_dispatch_date` (populowane przed wysyłką, **znika/`null` po realnym nadaniu** — wtedy realny termin już niesie `date_shipping`/nr przesyłki, nie ta kolumna) i Amazon `LatestShipDate` (deadline ustalony na starcie zamówienia, **zostaje widoczny nawet po `OrderStatus = "Shipped"`** — inaczej niż Back Market, potwierdzone na żywym zamówieniu). refurbed, Erli, Allegro i Octopia nie mają odpowiednika w swoim API (sprawdzone: `raw` zamówienia, `delivery`/`fulfillment` u Erli/Allegro) — kolumna zawsze `null`, pokazane jako "—". Uzupełnienie dla starych wierszy w `sales-orders.sql`, ten sam wzorzec co przy pozostałych kolumnach dosyntezowanych po fakcie. **Nagłówek kolumny jest klikalnym sortowaniem** (02.10.2026, `plannedSort` w `OrdersList`): klik cyklicznie rosnąco ▲ → malejąco ▼ → domyślne (po dacie zamówienia); sortowanie po stronie serwera (`.order()`), więc działa na całej liście, nie tylko na bieżącej stronie; zamówienia bez terminu (większość kanałów) zawsze na końcu, w obrębie tej samej daty najnowsze pierwsze. Kolumna na liście ma mniejszą czcionkę (`text-xs`, jak "Data zamówienia" i "Nr zamówienia" obok niej), a "Nr zamówienia" dostało też ograniczoną szerokość z obcinaniem (`truncate`, pełny numer w `title` na najechanie) — na prośbę właściciela, długie UUID-y Allegro rozciągały kolumnę. SKU, **Ilość** (30.09.2026, zaraz po SKU) — zawsze
pokazuje **1**, bez wyjątków, dla KAŻDEGO wiersza. Nie jest to przeoczenie: `sales_order_items` ma już "jedna sztuka
= jeden wiersz" (pozycja z `quantity` > 1 jest rozbijana na tyle wierszy, ile sztuk — patrz niżej), czyli jeden
wiersz STRUKTURALNIE nigdy nie reprezentuje więcej niż jednej sztuki — kolumna istnieje jako czytelne potwierdzenie
tego dla zespołu (zwłaszcza obok numeru seryjnego, który też zawsze dotyczy dokładnie jednej sztuki), nie jako
licznik czegokolwiek zmiennego. **Przeszła przez dwie błędne wersje tego samego dnia, obie poprawione po
zgłoszeniach właściciela na żywych przykładach:** (1) pierwsza wersja liczyła `sales_order_items.length` na CAŁE
zamówienie i pokazywała sumę jednym zbiorczym `rowSpan` wierszem — dla zamówienia z kilkoma RÓŻNYMI SKU (np. dwa
różne kolory tego samego modelu, po 1 sztuce każdy) pokazywała łączne "2" przy pierwszym z nich, sugerując błędnie,
że to 2 sztuki TEGO jednego SKU; (2) druga wersja poprawiła to na liczność grupy wierszy o TYM SAMYM SKU w obrębie
zamówienia (per pozycja, nie `rowSpan`) — technicznie zgodna z oryginalną ilością z API (dla zamówienia Octopia z
`quantity=2` tego samego SKU, rozbitego na 2 wiersze z osobnymi numerami seryjnymi, obie poprawnie wskazywały "2"),
ale WCIĄŻ myliła: "2" obok KONKRETNEGO numeru seryjnego czyta się jak "ten serial to 2 sztuki", co nie ma sensu —
jeden numer seryjny zawsze jest jedną sztuką. Stąd ostateczna, trzecia wersja: zawsze "1", bez żadnego liczenia.
**Cena** (30.09.2026,
zaraz po Ilości) — `sales_order_items.price`/`currency`, cena JEDNOSTKOWA tej sztuki. **Kluczowa pułapka, sprawdzona
na żywych danych zamiast zgadywana:** część kanałów zwraca w API cenę CAŁEJ pozycji (już przemnożoną przez
`quantity`), część od razu jednostkową — pomylenie tego dawałoby 2x/3x zawyżoną cenę dla rozbitych pozycji.
Back Market `orderline.price` — CAŁA pozycja (zamówienie z `quantity=2`, `price="1250.00"` = suma obu sztuk, nie
cena jednej) → dzielimy przez `quantity` w `mapBmItems`. Amazon `ItemPrice.Amount` — też CAŁA pozycja
(`unit price × QuantityOrdered`, udokumentowane wprost w SP-API, nie mamy w naszych danych żywego zamówienia z
`QuantityOrdered` > 1 do potwierdzenia, ale zachowanie jest oficjalnie opisane) → też dzielimy przez quantity.
Erli `item.unitPrice` (grosze), Allegro `lineItem.price.amount` i Octopia `line.sellingPrice.unitSalesPrice` (a gdy
brak — `offerPrice.unitSalesPrice`) są już JEDNOSTKOWE — potwierdzone na żywych zamówieniach z `quantity` > 1:
Allegro (dwie pozycje tego samego produktu, `quantity` 1 i 2, obie `price.amount="19.99"` — suma 19.99+2×19.99=59.97
zgadza się co do grosza z `summary.totalToPay`) i Octopia (`quantity=2`, `unitSalesPrice=144.99`,
`totalPrice.sellingPrice=289.98=144.99×2` — więc `totalPrice` to suma, a `unitSalesPrice` obok niej to dokładnie to,
czego potrzebujemy, świadomie NIE używamy `totalPrice`) — żadnego dzielenia. refurbed `item.total_charged` też bez
dzielenia, ale z innego powodu: refurbed w ogóle nie rozbija `quantity` (każda pozycja to zawsze jedna sztuka).
**Waluta nie zawsze jest na pozycji** — Erli i Octopia mają ją tylko na poziomie CAŁEGO zamówienia (`o.currency`/
`o.currencyCode`), więc mapper bierze ją stamtąd, nie z pozycji. Kolumna "Cena" na liście pokazuje `"kwota waluta"`
(`fmtPrice` w `SalesOrdersHub.tsx`), "—" gdy nie ma danych. Uzupełnienie dla starych wierszy w `sales-orders.sql`
(po jednym `update` per kanał, ta sama logika co w odpowiednim `mapXItems`) — `price`/`currency` chronione tym
samym triggerem co SKU/pozycja (tylko synchronizacja może je zmieniać). **`sales_order_items.name`** (01.10.2026) —
nazwa produktu z marketplace'u, osobna od SKU (kod, nie czytelna nazwa): Back Market `orderline.product`, refurbed
`item.name`, Erli `item.name`, Allegro `lineItem.offer.name`, Octopia `line.offer.productTitle`, Amazon
`orderItem.Title` — dokładnie te same pola, które `SalesOrderCard.tsx` już pokazywał na karcie zamówienia jako
"Produkt"/"Oferta" w sekcji POZYCJE (patrz `Row label="Produkt"` per kanał), teraz też zapisane w bazie zamiast
tylko odczytywane z `raw` na żywo. Główny powód: **nazwa pozycji na fakturze w Fakturowni** (zakładka Faktury,
zgłoszone przez właściciela 01.10.2026 — wcześniej faktura miała tam tylko `"Produkt {SKU}"`, czytelne wyłącznie
dla kogoś, kto zna katalog na pamięć) — `app/api/invoices/create` używa `name`, z fallbackiem do SKU dla starych
wierszy sprzed tej zmiany albo kanałów, gdzie go zabraknie. Uzupełnienie dla starych wierszy w `sales-orders.sql`,
ten sam wzorzec co przy cenie/walucie (jeden `update` per kanał, dopisany do istniejącego). `name` dołączony też
do `sales_order_items_protect_api_fields` (ten sam trigger co SKU/cena/waluta) — zespół nie edytuje go ręcznie,
tylko synchronizacja. **Nr przesyłki i "Etap" (kubełek statusu, patrz niżej) ukryte z listy 30.09.2026** — na prośbę właściciela, żeby lista była mniej zatłoczona; dane
i tak zostają: `sales_orders.tracking_number` dalej widoczne na karcie zamówienia (`Row label="Numer przesyłki"` per kanał), a Etap dalej rządzi pigułkami filtra (Wszystkie/Nowe/Wysłane/Anulowane), tylko nie ma już własnej kolumny w tabeli. Przy okazji: numer zamówienia na liście dostał mniejszą czcionkę (`text-xs`, wcześniej dziedziczył `text-sm` z tabeli). Etap = kubełek statusu liczony WPROST ze statusu kanału (`statusBucket` w `lib/salesOrders.ts`: Nowe /
Wysłane / Anulowane), **nie osobna kolumna** — zastąpił dawne ręcznie zmieniane `sales_orders.our_status`, wycofane
30.09.2026 na prośbę właściciela ("korzystajmy ze statusów dostępnych w marketplace'ach", zamiast ręcznie śledzić
postęp). "Wysłane" i "Anulowane" to zamknięte, jednoznaczne statusy per kanał — surowe z API albo, gdzie API samo nie
ma takiej wartości, nasz znacznik wyliczony przy synchronizacji (`bmDerivedStatus`/`erliDerivedStatus`/
`allegroDerivedStatus`, patrz opisy kanałów niżej): Back Market `9`/`cancelled`/`refunded`, refurbed
`SHIPPED`/`FULFILLED`/`CANCELLED`/`REJECTED`/`RETURNED`, Erli `sent`(★)/`cancelled`/`returned`, Allegro
`SENT`(★)/`CANCELLED`/`RETURNED`(★), Octopia `Shipped`/`Delivered`/`Cancelled`/`Rejected`/`Refused`, Amazon `Shipped`/`Canceled`
— (★) = nasz znacznik, nie wartość z API. Wszystko inne (do
zaakceptowania, do wysyłki, oczekuje na płatność, opłacone, za pobraniem, w przygotowaniu...) to po prostu "Nowe".
Filtr na liście (pigułki Wszystkie/Nowe/Wysłane/Anulowane) buduje z TYCH SAMYCH list (`shippedOrFilter`/
`cancelledOrFilter`) kompozytowy filtr PostgREST — "Nowe" to `NOT (wysłane OR anulowane)`, czyli `not.or=(...)`;
supabase-js nie ma na to wprost metody, więc nadużywamy parametru `foreignTable` w `.or()` (`key = foreignTable +
".or"` w źródle biblioteki) — sprawdzone bezpośrednio na żywej bazie: 962 nowe + 7958 wysłane + 1325 anulowane =
10245 wszystkich, dokładna suma. Kolumna `sales_orders.our_status` i funkcja bazy `sales_order_set_status` zostają w
schemacie jako martwy, nieużywany relikt (bez migracji usuwającej — to samo podejście co przy `units`/`apilo_orders`).
**Akceptacja zamówienia u marketplace'u to od 29.09.2026 jawny przycisk "Zaakceptuj zamówienie →"** na karcie
zamówienia (`SalesOrderCard.tsx`, `acceptOrder`), obok plakietki statusu — widoczny tylko dla Back Marketu w stanie
"Do zaakceptowania" (`bm.state === 1`); woła `app/api/orders/validate/route.ts` (`POST /ws/orders/{id}`,
`new_state: 2`, `lib/backmarket.ts` `bmAcceptOrder`) — to osobna, jawna akcja, niezależna od Etapu (wcześniej była
efektem ubocznym zmiany "Nasz status" na "w realizacji", co myliło dwie różne rzeczy). **`new_state: 2` WYMAGA "sku"
w body** — bez niego Back Market zwraca błąd 400 "sku not found" (zgłoszone przez właściciela 29.09.2026, poprawione
tego samego dnia); to inaczej niż `new_state: 3` (wysyłka), gdzie SKU jest zbędne, bo dotyczy całego zamówienia naraz
— `new_state: 2` działa PER POZYCJA, więc `route.ts` czyta unikalne SKU z już zsynchronizowanych
`bm_orders.orderlines` i woła `bmAcceptOrder` osobno na każdy z nich (zamówienie z jednym SKU = jedno wywołanie). Po
sukcesie dopisuje wpis do `history` (`sales_order_add_log`, funkcja bazy dopisująca do logu bez ruszania innych pól)
i od razu dogrywa świeże dane zamówienia (`bm-refresh`, patrz niżej), żeby plakietka statusu zaktualizowała się na
miejscu, bez czekania na cron. Inne kanały: route nic nie robi (nie błąd), brak przycisku. Nigdy nie failuje twardo
— błąd trafia do UI jako komunikat. **Wcześniejsza "obserwacja" o niekompletnych danych przed akceptacją była
błędna — prawdziwa przyczyna to bug, nie stan zamówienia w Back Market (poprawiony 28.09.2026):**
`shipping_address` z Back Market API to pola snake_case (`first_name`, `last_name`, `postal_code`, `phone`), a
`formatAddress`/`fullName` w `SalesOrderCard.tsx` i `buildShipPrefill` w `lib/shipping.ts` czytały je jako camelCase
(`firstName`, `lastName`, `postalCode`, `phoneNumber`) — literówka w nazwach pól, nie ograniczenie API. Imię, kod
pocztowy i telefon wychodziły puste dla **każdego** zamówienia Back Market, niezależnie od stanu. Test w
`shipping.test.js` miał ten sam błąd w danych testowych (fixture też był camelCase), więc się nie wyłapał —
poprawiony razem z kodem. Formularz Wysyłki nadal pokazuje ostrzeżenie, gdy wypełnienie z zamówienia wypadło
niekompletne (`prefillNote` w `ShippingView.tsx`), na wypadek gdyby jednak czegoś realnie zabrakło — to zostaje,
tylko już nie z błędnym powodem. Udane nadanie przesyłki (dhl-express/create, dhl-parcel/create) **NIE przestawia
już żadnego wewnętrznego statusu** — `markOurStatusShipped` usunięty razem z `our_status` (30.09.2026); jedyny
skutek uboczny nadania to `notifyMarketplace` (patrz niżej); do tego dane pracownicze edytowane w wierszu: numer seryjny, pady i numery seryjne padów — jak w Trade-in, wspólny komponent `PadSerialsCell.tsx`; log zmian w `sales_orders.history`). **Dane pracownicze są per pozycja:** zamówienie ma jedną lub więcej pozycji (`sales_order_items`, jedna sztuka = jeden wiersz, ilość > 1 rozbijana; klucz `item_key` = id pozycji z API, `id-2`… dla kolejnych sztuk; `mapBmItems` w `lib/salesOrders.ts` i jednorazowe uzupełnienie w SQL muszą trzymać tę samą zasadę). Na liście każda pozycja ma własny wiersz (numer, data i status zamówienia to `rowSpan`). Zapis pozycji + wpis do logu to funkcja bazy `sales_item_update` (jedna transakcja, dopisanie do historii po stronie bazy); zespół zmienia tylko numer seryjny i pady — pola z API (SKU, kolejność, status zamówienia) tylko synchronizacja, pilnują tego triggery `*_protect_api_fields`, a upsert synchronizacji nie rusza kolumn pracowniczych; nad listą wyszukiwarka po numerze zamówienia **albo SKU** (04.10.2026; fragment, bez rozróżniania wielkości liter; SKU z `sales_orders.sku`, które trzyma SKU wszystkich pozycji zamówienia po przecinku — filtr `.or()` z wartością w cudzysłowie), pigułki filtra po marketplace (Wszystkie + każdy aktywny kanał z `MARKETPLACES` poza Apilo — integracja wycofana, filtrowanie po niej nie ma sensu, ale etykieta w `MARKETPLACES` zostaje dla podpisu na liście, własny wiersz nad Pagerem)
i filtr po "Etapie" (pigułki Wszystkie/Nowe/Wysłane/Anulowane w pasku stron, między "Pokaż"/liczbą zamówień a "strona X z Y" —
`middle` w `Pager`, współdzielony komponent stron; oba filtry resetują stronę na 1, tak jak zmiana wyszukiwania, i działają niezależnie od siebie — można łączyć). Podstrona
*BM raw data* (surowy podgląd `bm_orders`) usunięta z UI (nieużywana) — tabela `bm_orders` i sam sync zostają, bo z
nich korzystają mappery (`mapBmToSales`, `mapBmItems`) i karta zamówienia. Sync: `app/api/orders/bm-sync` (`GET /ws/orders`, cron co 15 min + "Odśwież"): pełny skan od 1 stycznia
w porcjach z kursorem (`sales_orders_sync_meta`, wiersz per kanał), potem przyrostowo po `date_modification`; ten sam
`lib/scanOrders.ts` co przy skupie. Dodatkowo każdy przebieg odświeża pojedynczo (`GET /ws/orders/{id}`) do 25 zamówień w stanach
nieskończonych (0/10/1/3), nieodświeżanych od godziny — siatka bezpieczeństwa, gdyby `date_modification` pominęło zmianę statusu. Surowy status Back Market to kod stanu ("1", "3", "9"), etykiety w `lib/salesOrders.ts`
(`BM_ORDER_STATES`); API nie zwraca stanów 0 i 8. SKU = `orderlines[].listing`, kilka pozycji po przecinku.
Na górze zakładki są kafelki **Zamówienia dzisiaj / wczoraj** (`DaySummary`, `summarizeDays` w `lib/salesOrders.ts`): doby lokalne
(północ do północy w strefie przeglądarki), po `order_date`, z podziałem na marketplace'y. **Nie liczą się** anulowane, zwrócone/odrzucone
i nieopłacone (`NOT_COUNTED` — nowy kanał trzeba tam dopisać); zamówienie za pobraniem się liczy.
Numer zamówienia na liście jest linkiem do **karty zamówienia** (`SalesOrderCard.tsx`, panel boczny): dane z API
(pozycje, daty, dostawa, adres dostawy — z surowej tabeli kanału), dane pracownicze (edytowalne) i numerowany log zmian;
edycje z listy i z karty trafiają do tego samego logu (wzór: karta zamówienia Trade-in). Na górze karty link "Otwórz w Back Market" (`https://www.backmarket.fr/bo-seller/orders/all?page=1&pageSize=10&endDate={dziś}&orderId={numer}`). Dla Amazon analogicznie "Otwórz w Amazon" (`https://sellercentral.amazon.pl/orders-v3/order/{numer}`) — domena `.pl` (nasze konto) działa dla zamówień z DOWOLNEGO rynku UE (potwierdzone przez właściciela na żywym zamówieniu z rynku FR), bo konto sprzedawcy UE jest wspólne dla wszystkich rynków — ten sam wzorzec co jedna domena `.fr` dla wszystkich rynków Back Marketu. Dla refurbed "Otwórz w refurbed"
(`https://merchant.refurbed.com/orders/details/{numer}`) — przykład od właściciela miał doklejone `tableOptions`/
`freeSearchOptions` (stan widoku listy, z której kliknął w zamówienie, nie coś specyficznego dla samego zamówienia),
pominięte. **Octopia bez bezpośredniego linku do zamówienia** — panel
sprzedawcy (`seller.octopia.com/Order/Detail/{uuid}`) adresuje zamówienia wewnętrznym UUID, którego API w ogóle nie zwraca (sprawdzone
w dokumentacji Octopii: `orderId`/`reference` z API to inny identyfikator niż ten UUID, zero związku) — nie da się go zbudować z
danych, które mamy. Zamiast tego link "Otwórz listę zamówień w Octopia" (`https://seller.octopia.com/order/all`, statyczny, bez
numeru w URL) — numer zamówienia trzeba wkleić ręcznie w wyszukiwarkę panelu.
**refurbed** (`marketplace = 'refurbed'`, `lib/refurbed.ts`, `app/api/orders/refurbed-sync`, surowe dane w `refurbed_orders`): API tylko POST,
`https://api.refurbed.com/refb.merchant.v1.OrderService/ListOrders`, nagłówek `Authorization: Plain <token>`, limit 10 zapytań/s
(429 -> ponowienie), paginacja kursorem (`starting_after` = id, `has_more`), sortujemy po ID rosnąco. Numer zamówienia = `Order.id`,
data = `released_at`, status = `state` (NEW/ACCEPTED/SHIPPED/...; etykiety w `REFURBED_ORDER_STATES`), SKU = `items[].sku`; **każda
pozycja API to jedna sztuka** (klucz = `item.id`). "Nr przesyłki" to link `parcel_tracking_url` pozycji (refurbed nie ma numeru) — lista
pokazuje go jako "śledzenie". **refurbed nie ma filtra po dacie modyfikacji**, więc przyrostowo pobieramy (A) nowe po `released_at`
(z zapasem 10 min) i (B) ponownie zamówienia w stanach NEW/ACCEPTED/SHIPPED z ostatnich 60 dni; pełny skan od 1 stycznia idzie
z kursorem `sales_orders_sync_meta.scan_cursor`. **`state` zamówienia potrafi utknąć na "ACCEPTED" mimo realnie wysłanej i dostarczonej
paczki** — nasze własne zgłoszenie wysyłki (`notifyMarketplace` -> `BatchUpdateOrderItemsState`) ustawia numer przesyłki na pozycji, ale
NIE zmienia `state`; realny postęp pokazuje osobne pole na pozycji `items[].shipment_status` (UNSPECIFIED/INFO_RECEIVED/IN_TRANSIT/
OUT_FOR_DELIVERY/AVAILABLE_FOR_PICKUP/DELIVERED/FAILED_ATTEMPT/EXCEPTION — wypełniane dopiero, gdy przewoźnik zacznie raportować
zdarzenia). Zgłoszone przez właściciela 30.09.2026 (kilka zamówień z numerem przesyłki widoczne w "Nowe", część sprzed prawie roku —
`state` nie ma tu związku z wiekiem zamówienia, po prostu nigdy się nie zmienia tą drogą). `refurbedDerivedStatus` (`lib/salesOrders.ts`,
wywoływane w `mapRefurbedToSales`) podnosi status do `SHIPPED` (istniejąca wartość, już w `SHIPPED_STATUS`), gdy KTÓRAKOLWIEK pozycja ma
`shipment_status` różny od `UNSPECIFIED`/pusty — `state` `CANCELLED`/`REJECTED`/`RETURNED` zostaje NADRZĘDNY. Nie testowane na żywym API
(brak tokena w środowisku asystenta) — zweryfikowane na atrapie `fetch` wg swaggera (gitlab.com/refurbed-community/public-apis).
**Erli** (`marketplace = 'erli'`, `lib/erli.ts`, `app/api/orders/erli-sync`, surowe dane w `erli_orders`): `POST https://erli.pl/svc/shop-api/orders/_search`,
`Authorization: Bearer <klucz>`, odpowiedź to zwykła tablica zamówień (bez has_more — koniec listy = strona krótsza niż limit 200).
**Sortujemy po `updated` rosnąco i idziemy kursorem** (`pagination.after` = pole `cursor` ostatniego zamówienia), a kursor trzymamy w
`sales_orders_sync_meta.scan_cursor` — ten mechanizm łapie nowe zamówienia i większość zmian statusu w starych. **Ale (odkryte
28.09.2026): pole `updated` NIE zawsze się rusza przy zmianie statusu płatności** — zaobserwowane na żywo: zamówienie oznaczone w
panelu Erli jako "Opłacone"/"Gotowe do realizacji" (`sellerStatus: readyToProcess`), a `updated` u nas wciąż sprzed tej zmiany, mimo
że kursor dawno je minął przy kolejnych przebiegach. Dlatego **drugi, niezależny skan** filtruje `POST /orders/_search` po
`filter: {field: "paymentStatus", operator: "=", value: "completed"}` (osobny parametr `OrderSearch`, dokumentacja Erli) — to inna,
mniejsza pula zamówień (tylko opłacone), więc mimo tego samego sortowania po `updated` i tak dochodzi do zamówień, których główny
skan już dawno minął. Własny kursor pod syntetycznym kluczem `erli_paid` w tej samej tabeli `sales_orders_sync_meta` (nie prawdziwy
marketplace, tylko wewnętrzna księgowość drugiego skanu); dzieli budżet czasu funkcji z głównym skanem (`erliSweep` w `lib/erli.ts`
przyjmuje teraz opcjonalny `filter`), pojedyncza porażka tego skanu nie psuje głównego wyniku (`paidSweepError` w odpowiedzi).
**Trzeci skan (od 30.09.2026): zamówienia COD są ślepą plamką dla drugiego skanu** — płatność gotówką kurierowi nigdy nie
osiąga u Erli `paymentStatus="completed"`, więc `paidSweep` ich nie widzi, a `updated`, jak wyżej, nie rusza się przy zmianie
statusu dostawy — COD-y raz zsynchronizowane ze statusem "purchased"/"purchased_cod" mogły więc **zostać tak trwale, bez
końca**, nawet gdy realnie dawno dostarczone/zwrócone. Zgłoszone przez właściciela 30.09.2026 (kilkanaście zamówień COD
sprzed tygodni, wszystkie z realnym postępem u przewoźnika, wciąż widoczne w "Nowe"); dwa wcześniejsze jednorazowe
backfille SQL (`one-off-erli-seller-status-backfill.sql`, `one-off-erli-deliverytracking-backfill.sql`, poza plikami
schematu) naprawiały stan na dany moment, ale nowe COD-y wpadały w ten sam dołek dalej. Naprawione W KODZIE, nie kolejnym
jednorazowym SQL-em: `orders/erli-sync/route.ts` po głównym i drugim skanie czyta z NASZEJ bazy (nie z kursora/filtra
Erli) do 100 zamówień `sales_orders` (marketplace erli, status purchased/purchased_cod), dociąga je od Erli jednym
zapytaniem po `{field: "id", operator: "in", value: [...]}` (`OrderFilter` wspiera operator "in", potwierdzone w
swaggerze — przykład w dokumentacji to dokładnie filtr po liście ID) i zapisuje przez ten sam `saveOrders`/mappery co
reszta — więc jeśli Erli w międzyczasie ruszyło `sellerStatus`/`deliveryTracking`, `erliDerivedStatus` poprawnie
przeliczy status przy tym zapisie. Ten skan pyta o stan z NASZEJ bazy, więc zbiór naturalnie maleje w miarę jak
zamówienia się rozwiązują (stają się `sent`/`cancelled`/`returned` i wypadają z zapytania) — bez arbitralnego okna
dni jak przy refurbed. Wynik w odpowiedzi jako `stuckSweep: {checked, updated}`/`stuckSweepError`, pojedyncza porażka
nie psuje reszty. Nie testowane na żywym API (brak klucza w środowisku asystenta) — zweryfikowane na atrapie `fetch`
(`erli.test.js`, asercja że `{field:"id",operator:"in",value:[...]}` trafia do body żądania dokładnie tak, jak wg
swaggera). Numer
zamówienia = `Order.id`, data = `created`, status = `status` (pending/purchased/cancelled/returned z API, plus nasze
znaczniki `purchased_cod`/`sent`, etykiety w `ERLI_ORDER_STATES`), SKU = `items[].sku`, a gdy brak — `items[].externalId`;
pozycja z ilością > 1 rozbijana na sztuki jak w Back Market.
Numer przesyłki = `deliveryTracking.trackingNumber` (dla przesyłek Erli uzupełnia go system po wygenerowaniu etykiety), a gdy brak — link.
**Uwaga: zamówienie za pobraniem (COD) ma w API ten sam status `purchased` co opłacone** — dlatego w `sales_orders` zapisujemy je jako
własny status `purchased_cod` ("Za pobraniem", czerwona plakietka), a SQL poprawia stare wiersze. Kwoty w API są w groszach (dzielimy przez 100 przy wyświetlaniu).
**Status zamówienia (pending/purchased/cancelled/returned) NIE ma w ogóle wartości "wysłane" — realny postęp siedzi w
osobnym polu `sellerStatus`** ("Status zamówienia w systemie sprzedawcy": created/readyToProcess/inProgress/sent/
readyToPickup/received/returned/returningToSender/canceled/unknown, już zbierane jako `erli_orders.seller_status`).
`erliDerivedStatus` (`lib/salesOrders.ts`, wywoływane w `mapErliToSales`, ten sam wzorzec co `bmDerivedStatus` dla
Back Marketu) podnosi `purchased`/`purchased_cod` do naszego znacznika `sent` ("Wysłane"), gdy `sellerStatus` to
`sent`/`readyToPickup`/`received` (celowo jeden wspólny znacznik — nie rozróżniamy "w drodze" od "dostarczone"), albo
do `cancelled`/`returned`, gdy `sellerStatus` to `canceled`/`returned`/`returningToSender` — `status` zamówienia
(`cancelled`/`returned`) jest przy tym NADRZĘDNY, sellerStatus już nic tam nie zmienia. **Zgłoszone przez właściciela
30.09.2026** ("stare zamówienia z Erli które już wysłałem mają status Opłacone") — na żywych danych aż 472 zamówienia
z `seller_status="received"` (DOSTARCZONE) miały `sales_orders.status` wciąż "purchased"; jednorazowa poprawka
istniejących wierszy uruchomiona ręcznie w Supabase SQL Editor (poza plikami schematu). **Trzeci, jeszcze bardziej
wiarygodny sygnał: `deliveryTracking.status`** — realny status śledzenia przesyłki OD PRZEWOŹNIKA (`vendor`:
inpost/dhl/...; wartości: preparing/readyToSend/waitingForCourier/sent/readyToPickup/pickupTimeExpired/delivered/
returned/canceled/deliveryUnsuccessful/redirected), niezależny od `sellerStatus` (które jest tylko polem "co
sprzedawca ustawił w panelu Erli" i potrafi utknąć, mimo że przesyłka faktycznie dojechała) — dodane do
`erliDerivedStatus` 30.09.2026, sprawdzone na żywych danych **przy tym samym zgłoszeniu**: 34 zamówienia miały
`deliveryTracking.status` = `sent`/`delivered`, a `sellerStatus` wciąż `inProgress` (np. zamówienia sprzed
prawie roku z numerem przesyłki, ale bez zmiany statusu — dokładnie ten przypadek zgłoszony przez właściciela).
Oba sygnały (`sellerStatus` i `deliveryTracking.status`) sprawdzane równolegle, który pierwszy wskaże postęp,
ten wygrywa; `returned` ma pierwszeństwo przed `sent`/`cancelled`. **`readyToSend`/`waitingForCourier` też liczą
się jako "wysłane"** (nie tylko `sent`/`readyToPickup`/`delivered`) — formalnie wg enumu Erli to jeszcze etap
PRZED nadaniem, ale na żywych danych (30.09.2026, potwierdzone przez właściciela na 3 konkretnych zamówieniach —
w tym jednym wysłanym poza naszą integracją Paczkomatów, z numerem przesyłki UPS) paczka była już fizycznie
wysłana, mimo że Erli samo nie zdążyło jeszcze przesunąć statusu dalej niż `readyToSend`; jedyny etap, który
świadomie zostaje bez zmian, to `preparing` (label jeszcze nie gotowy). **Niezapłacone zamówienia Erli
(`status = 'pending'`, "Oczekuje na płatność") są ukryte z listy "Zamówienia" w ogóle** (`OrdersList` w
`SalesOrdersHub.tsx`, filtr PostgREST `marketplace.neq.erli,status.in.(purchased,purchased_cod,sent)`) — klient
może się jeszcze rozmyślić i nigdy nie zapłacić, więc zaśmiecały widok "Nowe"; wciąż są zapisywane w bazie (sync ich nie pomija), tylko
niewidoczne w UI, dopóki status nie zmieni się na `purchased`/`purchased_cod`/`sent` (albo `cancelled`/`returned` — te też zostają ukryte,
bo i tak nigdy nie doszły do realizacji). Dotyczy tylko listy — kafelki "Zamówienia dzisiaj/wczoraj" już wcześniej pomijały `pending`
przez `NOT_COUNTED` (a teraz, dzięki `erliDerivedStatus`, poprawnie pomijają też zamówienia anulowane/zwrócone u sprzedawcy, które
wcześniej — mimo `status` wciąż "purchased" — były błędnie liczone jako sprzedaż). Nie testowane na żywym API (brak klucza w środowisku asystenta) —
zweryfikowane na atrapie `fetch` wg swaggera (erli.pl/svc/shop-api/doc/swagger.json).
**Allegro** (`marketplace = 'allegro'`, `lib/allegro.ts`, `lib/allegroServer.ts`, route'y `orders/allegro-*`, surowe dane w `allegro_orders`):
zamówienia to *checkout forms* (`GET https://api.allegro.pl/order/checkout-forms`, `Accept: application/vnd.allegro.public.v1+json`, sortowanie
po `updatedAt`). **Autoryzacja to OAuth2 Authorization Code, nie stały klucz:** aplikacja ma Client_ID/Secret, a Admin raz klika w Zamówieniach
"Połącz z Allegro" (`allegro-auth` POST -> strona zgody Allegro -> `allegro-callback` wymienia kod na tokeny; scope tylko `allegro:api:orders:read`;
`state` jednorazowy, ważny 10 min). Access token żyje 12 h, **refresh token jest jednorazowy i ważny 3 miesiące** (każde odświeżenie zwraca nową
parę) — dlatego leży w tabeli `oauth_tokens` (RLS bez żadnej polityki: czyta i zapisuje tylko serwer/service_role), a `getAccessToken` zapisuje
nową parę z porównaniem starego refresh tokena (bezpieczne przy równoległych przebiegach). Gdy zgoda wygaśnie (3 miesiące bez użycia, zmiana
hasła, odpięcie aplikacji), sync zwraca prośbę o ponowne "Połącz z Allegro". Adres przekierowania to `https://<domena>/api/orders/allegro-callback`
i musi być identyczny w ustawieniach aplikacji Allegro (panel pokazuje go Adminowi). Synchronizacja: kursor `updatedAt.gte` (offset tylko gdy
cała strona ma ten sam updatedAt), kursor w `sales_orders_sync_meta.scan_cursor`, start od 1 stycznia. Numer zamówienia = id checkout form (UUID),
data = najwcześniejsze `lineItems.boughtAt`, SKU = `offer.external.id` (a gdy brak — id oferty), pozycje z ilością > 1 rozbijane na sztuki.
Numer przesyłki (waybill) nie jest na liście — dociągamy `GET /order/checkout-forms/{id}/shipments` dla zamówień, w których cokolwiek wysłano
(zapisane w `raw._shipments`). **Jak przy Erli: COD (`payment.type = CASH_ON_DELIVERY`) ma ten sam status `READY_FOR_PROCESSING` co opłacone**, więc zapisujemy
je jako `READY_FOR_PROCESSING_COD` ("Za pobraniem"). **Status zamówienia (BOUGHT/FILLED_IN/READY_FOR_PROCESSING/CANCELLED) sam NIE ma wartości
"wysłane" — dokładnie ten sam wzorzec problemu co przy Erli (patrz wyżej). Realny postęp realizacji siedzi w osobnym polu `fulfillment.status`**
("Status realizacji (Allegro)" na karcie zamówienia, zapisywane w `allegro_orders.fulfillment_status`): `NEW`/`PROCESSING`/`READY_FOR_SHIPMENT`/
`READY_FOR_PICKUP`/`SENT`/`PICKED_UP`/`CANCELLED`/`SUSPENDED`/`RETURNED` (dokumentacja Allegro: `SENT` ustawia się samo, gdy do zamówienia dojdzie
numer przesyłki i sprzedawca ma włączoną automatyczną zmianę statusu; `RETURNED` też tylko automatycznie, gdy całość zwrócona i zrefundowana —
nie da się go ustawić ręcznie). `allegroDerivedStatus` (`lib/salesOrders.ts`, wywoływane w `mapAllegroToSales`, ten sam wzorzec co
`erliDerivedStatus`) podnosi bazowy status do naszego znacznika `SENT` ("Wysłane"), gdy `fulfillment.status` to `SENT` lub `PICKED_UP` (odebrane
przez kuriera z paczkomatu — jeden wspólny znacznik jak przy Erli, bez rozróżniania), do `CANCELLED` (nasz znacznik, ta sama etykieta co
anulowanie zamówienia), gdy `fulfillment.status` to `CANCELLED` — sprawdzone na żywych danych: 4 zamówienia miały status `READY_FOR_PROCESSING`
(opłacone), a `fulfillment.status` już `CANCELLED` (sprzedawca anulował realizację), albo do `RETURNED` ("Zwrócone"), gdy `fulfillment.status`
to `RETURNED` — status zamówienia `CANCELLED` jest przy tym NADRZĘDNY, fulfillment już nic tam nie zmienia. **Zgłoszone przez właściciela
30.09.2026** (zamówienie z `fulfillment.status = SENT` pokazywało w kolumnie Status wciąż "Opłacone"; na żywych danych 298 z 322 zsynchronizowanych
zamówień miało `fulfillment.status = SENT`/`PICKED_UP` mimo statusu zamówienia wciąż "Opłacone") — poprawka obejmuje tylko przyszłe
synchronizacje; `RETURNED` dodane też do listy statusów pomijanych w kafelkach "Zamówienia dzisiaj/wczoraj" (`NOT_COUNTED.allegro`), bo to w
pełni zwrócone i zrefundowane zamówienie, tak samo jak anulowane. Nie testowane na żywym API (brak konta/aplikacji w środowisku asystenta) — zweryfikowane na atrapie
`fetch` wg swaggera (developer.allegro.pl/swagger.yaml).
**Back Market — stan zamówienia vs stany pozycji:** gdy wszystkie pozycje dojdą do stanu końcowego, całe zamówienie ma stan 9 ("przetworzone") także
przy zamówieniu anulowanym przez klienta (pozycja stan 4, brak `date_shipping`) — pokazywało się to jako "Wysłane" (w dniu poprawki: 463 anulowane
i 399 zwrócone z 5748 zamówień). Dlatego `bmDerivedStatus` (`lib/salesOrders.ts`) zapisuje `cancelled` ("Anulowane"), gdy WSZYSTKIE pozycje mają stan 4,
i `refunded` ("Zwrot"), gdy wszystkie 5/6; zamówienia częściowo anulowane zachowują stan z API. Stany pozycji (`BM_ORDERLINE_STATES`) widać na karcie
("Stan pozycji"), a SQL poprawia stare wiersze. Ogólna zasada dla nowych kanałów: nie ufaj samemu stanowi zamówienia — sprawdź stany pozycji,
płatność (COD) i anulowania.
**Octopia** (`marketplace = 'octopia'`, `lib/octopia.ts`, `app/api/orders/octopia-sync`, surowe dane w `octopia_orders`) — marketplace'y typu
**Cdiscount**. `GET https://api.octopia-io.net/seller/v2/orders`, sortowanie po `updatedAt` rosnąco, paginacja numerem strony (koniec listy = strona
krótsza niż 100). Autoryzacja OAuth2 client_credentials na OSOBNYM serwerze (`POST https://auth.octopia-io.net/auth/realms/maas/protocol/openid-connect/token`,
`application/x-www-form-urlencoded`), token ważny 2h, limit **500 tokenów/h** — dlatego pobieramy JEDEN token na cały przebieg synchronizacji, nie na
każde zapytanie. Zapytania do danych niosą `Authorization: Bearer <token>` i `SellerId: <numer sprzedawcy>`. Numer zamówienia = `orderId`, data =
`purchasedAt` (a gdy brak — `createdAt`), status = `status` (Processing/WaitingAcceptance/Accepted/Refused/InPreparation/Shipped/Delivered/Cancelled/Rejected,
etykiety w `OCTOPIA_ORDER_STATES`), SKU = `lines[].offer.sellerProductId`; pozycja z `quantity` > 1 rozbijana na sztuki jak w pozostałych kanałach. Numer
przesyłki = pierwszy `parcels[].parcelNumber` znaleziony w dowolnej pozycji. **`Refused` ("Odrzucone") liczył się jako "Nowe" zamiast "Anulowane"
do 30.09.2026** — zgłoszone przez właściciela (lista pełna odrzuconych zamówień z sierpnia/września w "Nowe"); sprawdzone na żywych danych: 56 z
872 zsynchronizowanych zamówień Octopia miało status `Refused`. Dodane do `CANCELLED_STATUS.octopia` (`statusBucket`, obok już tam będących
`Cancelled`/`Rejected`) i do `NOT_COUNTED.octopia` — **Octopia w ogóle nie miała wpisu w `NOT_COUNTED`**, więc nawet `Cancelled`/`Rejected` liczyły
się dotąd w kafelkach "Zamówienia dzisiaj/wczoraj" jak żywe zamówienia (poprawione przy okazji tego samego zgłoszenia, ten sam brakujący wzorzec).
**Akceptacja i wysyłka z aplikacji (06.10.2026, na prośbę właściciela — "podobnie jak Back Market"):** (1) **"Zaakceptuj zamówienie →"** na karcie zamówienia Octopia, widoczne tylko w stanie `WaitingAcceptance` (dotyczy wyłącznie Cdiscount; przy włączonej automatycznej akceptacji w OSP — a tak jest dziś, na 906 zamówieniach nie ma ani jednego `WaitingAcceptance` — zamówienie od razu ma `InPreparation` i przycisku nie ma) -> `orders/validate` -> `POST /orders/{id}/approval-status` `{approval_status: "Accepted"}` (`octopiaApproveOrder` w `lib/octopia.ts`), potem odświeżenie zamówienia (`GET /orders/{id}` + `saveOctopiaOrders` z `lib/octopiaServer.ts`, wspólne z synchronizacją).
(2) **Numer przesyłki wraca po API po nadaniu** (`notifyMarketplace` -> `octopiaShipOrder`, ten sam mechanizm co BM/refurbed: nigdy nie failuje nadania, błąd w `shipments.marketplace_sync_error` + "Ponów"): `POST /orders/{id}/shipments` z paczką `{parcelNumber, carrierName, trackingUrl, orderLineIds}`; przewoźnik zgłaszany jako "DHL Express" / "DHL" (Parcel) / "UPS" (`OCTOPIA_CARRIER_BY_CARRIER`; pole `carrierName` to wolny tekst, te same nazwy już są na wysłanych zamówieniach). Przed zgłoszeniem funkcja czyta zamówienie na żywo: zgłasza pozycje w stanie `InPreparation` z `supplyMode = Seller` (inne nie przyjmą wysyłki), gdy zamówienie jest jeszcze `WaitingAcceptance`/`Accepted` — czytelny błąd "zaakceptuj i ponów", a gdy paczka o tym numerze już jest na zamówieniu — uznaje za zgłoszone (bezpieczne ponowienie). Wymóg Octopii: zgłosić PRZED odbiorem paczki przez kuriera. Po zgłoszeniu wiersz zamówienia jest odświeżany (status Shipped).
Nie testowane na żywym API (brak danych dostępowych w środowisku asystenta) — zweryfikowane na atrapie `fetch` wg specyfikacji OpenAPI (developer.octopia-io.net); akceptacja i zgłoszenie przesyłki zmieniają prawdziwe zamówienie, więc pierwsze nadanie warto sprawdzić na mało ważnym zamówieniu.
**Amazon** (`marketplace = 'amazon'`, `lib/amazon.ts`, `app/api/orders/amazon-sync`, surowe dane w `amazon_orders`) — **bezpośrednia integracja
z Amazon Selling Partner API (SP-API)**, zastąpiła dawny most przez Apilo (integracja Apilo wycofana 28.09.2026 — patrz niżej). Amazon dzieli sprzedawców na REGIONY (EU/NA/FE), nie kraje —
konto zarejestrowane w Europie obsługuje wszystkie rynki UE (PL, DE, FR, ES, IT, BE, NL, IE, SE — pełna lista `AMAZON_EU_MARKETPLACE_IDS`) jednym
zestawem danych; `AMAZON_MARKETPLACE_IDS` (kody krajów po przecinku) pozwala zawęzić, domyślnie wszystkie. **Rejestracja i autoryzacja:** aplikacja
PRYWATNA (Seller Central → Apps and Services → Develop Apps), self-authorization (Apps and Services → Develop Apps → Authorize) daje jeden,
**długotrwały, NIEROTUJĄCY refresh token** — wystarczy wkleić go raz do env, żadnego "Połącz z…" w aplikacji nie ma. Od 2023 SP-API nie wymaga już
podpisu AWS SigV4 — autoryzacja to tylko nagłówek `x-amz-access-token` (LWA access token, ważny 1h, wymieniany z refresh tokena przy każdym przebiegu
synchronizacji — nie trzymamy go w bazie, w odróżnieniu od Allegro). **Limity szybkości są bardzo restrykcyjne i RÓŻNE dla dwóch operacji**, dlatego
synchronizacja ma DWIE fazy w jednym przebiegu: FAZA 1 `GET /orders/v0/orders` (0,0167 req/s, czyli ~1 zapytanie na 60 s, zapas 20) pobiera zamówienia
BEZ SKU — `mapAmazonToSales` celowo nie ustawia pola `sku` wcale, żeby upsert nigdy nie nadpisał go pustą wartością; kursor to prawdziwy `NextToken` z API
(`sales_orders_sync_meta.scan_cursor`, prefiks `NT:`). FAZA 2 `GET /orders/v0/orders/{id}/orderItems` (0,5 req/s) dogania SKU i pozycje dla zamówień, które
go jeszcze nie mają (`sales_orders.sku is null`), do `ITEMS_MAX_PER_RUN` (60) na przebieg — reszta poczeka na kolejny cron (15 min). Przez ciasny limit fazy 1
pierwszy przebieg pobiera świadomie tylko **ostatnie `FIRST_RUN_LOOKBACK_DAYS` (7) dni**, nie całą historię od początku roku — przy tym limicie pełny rok
zająłby dni cronów, a starsza historia nie jest potrzebna do bieżącej pracy (decyzja właściciela); dalej już zwykła synchronizacja przyrostowa. **Nawet ten
tydzień może zająć kilka przebiegów cron** — to oczekiwane, nie błąd. Retry na 429 honoruje nagłówek `Retry-After`. Zarejestrowane w Amazon Solution Provider
Portal (nie klasyczny "Apps and Services" — Amazon w 2026 skonsolidował rejestrację SP-API tam, także dla aplikacji prywatnych jednego sprzedawcy), zatwierdzone,
z rolą "Inventory and Order Tracking". Nie testowane na żywym API z tego środowiska (brak dostępu) — zweryfikowane na atrapie `fetch` wg
oficjalnego modelu OpenAPI (github.com/amzn/selling-partner-api-models, orders-api-model).

**Swopify — zamówienia RĘCZNE** (`marketplace = 'swopify'`, 03.10.2026, na prośbę właściciela): marketplace BEZ integracji API (nie ma
jeszcze połączenia) — zamówienia dopisujemy ręcznie z maili "Klient opłacił zamówienie". Wybrane podejście: **jednorazowe dopisanie jednego
zamówienia (C6L9EFR8)** plikiem SQL, bez formularza (wybór właściciela; formularz "Dodaj zamówienie ręcznie" odrzucony na tym etapie — każde następne
zamówienie ze Swopify wymaga na razie dopisania przez asystenta albo zbudowania tego formularza). Dane klienta i adresy, których nie ma w żadnej
tabeli surowej, siedzą w nowej kolumnie `sales_orders.manual_details` (jsonb, `sales-orders.sql`; null = zamówienie z API): `product_id`, `seller`,
`condition`, `customer{name,phone,email}`, `shipping{name,company,street,houseNumber,apartment,postalCode,city,countryCode}`, `billing{...,taxNo}`
(ulica i numer domu rozdzielone przy wpisywaniu). Na niej opierają się: sekcja "Dane zamówienia ręcznego" na karcie zamówienia, **przycisk "Nadaj
przesyłkę DHL"** (`buildManualShipPrefill` w `lib/shipping.ts`) i **faktura** (gałąź `swopify` w `buildInvoiceBuyerPrefill` + `invoices/prefill`: adres do
faktury, a gdy go brak — dostawy). Statusy ustawiamy sami: `PAID` ("Opłacone", liczy się jako Nowe i jako sprzedaż), `SHIPPED` (Wysłane), `CANCELLED`
(Anulowane, nie liczy się) — `SWOPIFY_ORDER_STATES`, wpisy w `SHIPPED_STATUS`/`CANCELLED_STATUS`/`NOT_COUNTED` i lustro w `ai.sql` (test parytetu).
**Nic nie synchronizuje i nic nie nadpisuje** tego zamówienia — status trzeba zmienić ręcznie w bazie, jeśli ma wyjść z "Opłacone" (zgłoszenie
numeru przesyłki do Swopify nie istnieje: `notifyMarketplace` dla tego kanału nic nie robi, więc numer trzeba wpisać u nich ręcznie). Data zamówienia z maila
to sama data (godzina nieznana — wpisane południe czasu polskiego); kraj DK wyprowadzony z adresu i waluty DKK, nie z maila.
**Apilo** — dawny tymczasowy most do Amazon (sprzed integracji SP-API powyżej); **integracja wycofana 28.09.2026** (kod usunięty: `lib/apilo.ts`,
`lib/apiloServer.ts`, `app/api/orders/apilo-{sync,connect}`, wpis w `vercel.json`, mappery w `lib/salesOrders.ts`, zmienne `APILO_*`), na wyraźną prośbę
właściciela — Amazon ma już własną, bezpośrednią integrację, most nie był potrzebny. **Zostaje tylko historia:** tabela `apilo_orders` i zamówienia
`sales_orders`/`sales_order_items` z `marketplace = 'apilo'` w bazie (dane, nie kod — nie usuwane), etykieta `apilo` w `MARKETPLACES` (`lib/salesOrders.ts`)
i podgląd na karcie zamówienia (`SalesOrderCard.tsx`) wciąż działają, żeby dawne zamówienia dało się otworzyć i przeczytać.
Nowy marketplace = nowa wartość `marketplace`, własna tabela surowa, własny mapper i sync; lista pozostaje wspólna.

**Backlog** (`BacklogView.tsx`, `lib/backlog.ts`, `backlog.sql`, tabela `backlog_items`): wspólna lista zadań i pomysłów zespołu, widoczna dla
wszystkich ról. Zadanie: tytuł, typ (funkcja/usprawnienie/błąd/zadanie), priorytet (P1 pilne / P2 ważne / P3 kiedyś), status (backlog / do zrobienia /
w toku / do sprawdzenia / zrobione), obszar (moduł; lista w kodzie), opis, kryteria akceptacji, osoba, autor i data dodania oraz log zmian. Widok: pigułki
statusów z licznikami (domyślnie "Aktywne" = bez zrobionych), filtry (priorytet, typ, obszar, osoba, wyszukiwanie po tytule/opisie/ZAD-numerze), szybka
zmiana statusu/priorytetu/osoby w wierszu i karta zadania (panel boczny). Dodawać i edytować może każdy zalogowany (autor ustawiany tylko z własnej sesji,
niezmienny), **usuwać tylko Admin** (polityka + `audit_delete`). Zmiany idą przez funkcję bazy `backlog_apply` (patch tylko zmienianych pól + wpis do logu
w jednej transakcji, historia dopisywana po stronie bazy); `updated_at` i `done_at` ustawia trigger.
**Załączniki zadań** (zrzuty ekranu, PDF, TXT, CSV, DOCX, XLSX; do 10 MB, max 10 na zadanie): pliki w **prywatnym** buckecie Supabase Storage
`backlog-attachments` (bez publicznych linków — widok przez podpisane adresy ważne godzinę), metadane w `backlog_attachments`. Dodawanie: przy tworzeniu
zadania i na karcie — wybór z dysku, przeciągnięcie albo **wklejenie zrzutu ze schowka (Ctrl+V)**. Limity rozmiaru i typów pilnuje też sam bucket (`backlog.sql`).
Usuwa załącznik jego autor albo Admin; kolejność usuwania to **najpierw plik, potem wiersz** (polityka `storage.objects` sprawdza wiersz). Usunięcie zadania
usuwa też jego pliki ze Storage (wiersze znikają kaskadowo, ale pliki same by zostały). Dodanie/usunięcie załącznika trafia do logu zadania. Storage na
darmowym planie Supabase ma łącznie 1 GB — warto go pilnować.

**Wysyłka** (`ShippingView.tsx`, `lib/dhlExpress.ts`, `lib/dhlParcel.ts`, `lib/shipping.ts`, `lib/shipmentInput.ts`, `shipping.sql`, `app/api/shipping/*`) — nadawanie przesyłek
przez **dwóch przewoźników** (wybór w formularzu; domyślnie DHL Parcel) — najpierw opis **DHL Express** (MyDHL API REST, OpenAPI 3.3.1, nagłówek `x-version: 3.3.1`); dostęp Admin, Manager i Zamówienia (`lib/serverAuth.ts` `requireRole`, polityki `is_admin_or_manager()` — nazwa historyczna, dziś obejmuje też rolę Zamówienia). Nadawcę (dane firmy) zmienia tylko Admin, szablony paczek usuwa tylko Admin — reszta (wycena, nadanie, anulowanie, szablony) tak samo dla Manager i Zamówienia.
Logowanie Basic: API Key (Username / site ID) : API Secret (Password) z aplikacji MyDHL na developer.dhl.com — ta sama para dla testu i produkcji; środowisko wybiera
adres (`express.api.dhl.com/mydhlapi/test` vs `/mydhlapi`), **domyślnie testowe**, produkcja tylko przy `DHL_EXPRESS_ENV=production`. Numer konta i klucze tylko w env.
Przepływ: formularz (odbiorca z zamówienia albo ręcznie, paczka z **szablonu** albo ręcznie, data nadania) → **wycena** `GET /rates` (produkty na naszym koncie z ceną
w walucie rozliczeniowej i PLN, waga taryfowa, składniki ceny; Economy Select = kod `W`/`H`, domyślnie zaznaczony) → wybór produktu → `POST /shipments` (bez okna potwierdzenia
w przeglądarce — usunięte 30.09.2026 na prośbę właściciela, zbędny dodatkowy klik; info o środowisku testowym/produkcyjnym zostaje jako zwykły tekst pod tabelą wyceny) →
etykieta **ZPL (szablon `ECOM26_64_001`, zmienna `DHL_EXPRESS_LABEL_TEMPLATE`; PDF zamieniony na ZPL 30.09.2026 —
patrz niżej, druk bezpośredni) → zapis w `shipments` (numer, link śledzenia, odbiorca, paczka, opłaty, etykieta base64). Zabezpieczenia: wymagane `confirm: true` w body żądania (parametr API,
niezależny od usuniętego okna w przeglądarce); `client_request_id` (unikalny) chroni
przed podwójnym nadaniem tym samym kliknięciem; gdy DHL nada, a zapis w bazie się nie uda, odpowiedź zwraca numer i etykietę, żeby nic się nie zmarnowało; e-mail autora z konta, nie z żądania;
tabela `shipments` bez UPDATE/DELETE (zapis księgowy, tylko serwer). **Blok "PRZEWOŹNICY" u góry zakładki (status konfiguracji DHL Parcel/Express)
jest ukryty, dopóki wszystko działa — pokazuje się tylko, gdy któryś przewoźnik nie jest skonfigurowany, usługa DHL chwilowo nie odpowiada albo
brakuje danych nadawcy** (30.09.2026, na prośbę właściciela — w normalnym stanie zajmował miejsce bez informacji wartej uwagi); linijka z adresem
nadawcy w tym miejscu usunięta na stałe (dane nadawcy i tak są dostępne pod "Zmień dane nadawcy (Admin)" niżej). **Lista "Nadane przesyłki" ma
paginację (`.range()`, 20/stronę) i wyszukiwarkę po numerze przesyłki** (`ilike` na `tracking_number`, z debounce 300 ms — wcześniej `.limit(50)`
bez offsetu pokazywał tylko najświeższe 50 przesyłek bez możliwości przejścia dalej). **Numer zamówienia w kolumnie
"Zamówienie" jest linkiem do karty zamówienia** (`SalesOrderCard.tsx`, ten sam komponent co w Zamówieniach —
`ShippingView` dostał do tego prop `members`, przekazywany z `page.tsx`) — tylko gdy wiersz ma zarówno marketplace,
jak i numer zamówienia (nie każda przesyłka ma zamówienie, np. nadana ręcznie bez `order`).

**Drukowanie bezpośrednie (30.09.2026)** — etykieta na etykieciarkę Zebra i delivery note (packing slip Back
Marketu) na zwykłą drukarkę A4, bez okna drukowania przeglądarki. Jeden lokalny agent obsługuje oba przypadki:
**QZ Tray** (qz.io, darmowy, open-source; paczka npm `qz-tray`, wrapper w `lib/printAgent.ts`) — Admin/pracownik
musi go RĘCZNIE zainstalować na każdym komputerze, który ma drukować (instrukcja Windows: patrz sekcja niżej w
tym pliku albo poproś asystenta o jej ponowne wysłanie). **Żądania są podpisywane** (`qz.security.setCertificatePromise`/
`setSignaturePromise`, `lib/printAgent.ts`) — pierwsza wersja (30.09.2026) była świadomie BEZ podpisu, w założeniu że
QZ Tray zapyta raz o zgodę i zapamięta ("checkbox zapamiętaj"), ale to się nie potwierdziło na żywym teście: bez
podpisu okno z prośbą o zgodę wracało przy **każdym** druku (zgłoszone przez właściciela), a dokumentacja QZ Tray
wprost mówi, że trwałe "Allow" + "Remember this decision" wymaga podpisanych żądań — bez podpisu zaufanie jest
tylko tymczasowe. Naprawione tego samego dnia: certyfikat self-signed (openssl, RSA 2048, ważny 10 lat) — publiczna
część (`QZ_CERT` w `lib/printAgent.ts`, nie jest sekretem) zwracana przez `setCertificatePromise`; prywatny klucz
tylko na serwerze (`QZ_TRAY_PRIVATE_KEY`, nowa zmienna środowiskowa), używany w `app/api/shipping/qz-sign`
(nowy route, też Admin/Manager/Zamówienia) do podpisania stringa, który QZ Tray samo już zhashowało (SHA-256 z
`{call, params, timestamp}`) — dokładnie odtworzone z kodu `qz-tray.js`: `createSign("SHA1")` (domyślny
`signAlgorithm` w bibliotece — nie zmienialiśmy go po stronie klienta, więc musi się zgadzać po obu stronach),
wynik base64. `setSignaturePromise` w `printAgent.ts` dogrywa **aktualny** token sesji z supabase-js przy każdym
podpisie (nie raz przy starcie), żeby nie podpisywać przeterminowanym tokenem po dłuższej bezczynności.

**Samo podpisywanie NIE wystarczyło** (przewidywanie z pierwszej wersji tego akapitu było błędne — poprawione po
żywym teście właściciela tego samego dnia): certyfikat self-signed jest kryptograficznie poprawny (druk działa,
podpis się weryfikuje), ale QZ Tray i tak traktuje go jako niezaufany, bo nie pochodzi z jego zaufanego roota —
efekt: w oknie zgody da się zaznaczyć "Remember this decision" **tylko razem z "Block"**, nie z "Allow" ("Allow"
trzeba klikać przy każdym druku — to świadome zabezpieczenie QZ Tray, nie błąd). Naprawione dopiero `override.crt`
(patrz instrukcja instalacji niżej, krok 4) — plik z naszym certyfikatem w folderze instalacyjnym QZ Tray, który
nadpisuje jego zaufany root NA DANYM KOMPUTERZE własnym certyfikatem; to darmowa alternatywa dla płatnego podpisu
certyfikatu przez QZ Industries, udokumentowana wprost w ich wiki (`docs/signing#to-override-the-trusted-root-certificate`).
Dopiero po tym kroku "Remember this decision" + "Allow" działa trwale.
**Etykieta = ZPL, nie PDF:** DHL Express nie pozwala doćiągnąć etykiety w innym formacie PO utworzeniu przesyłki
(format wybiera się raz, przy tworzeniu — `outputImageProperties.encodingFormat` w `lib/dhlExpress.ts`, zmienione
z `"pdf"` na `"zpl"`), więc etykieta DHL Express jest teraz ZAWSZE w ZPL. DHL Parcel (`lib/dhlParcel.ts`,
`dhlParcelLabel(cfg, shipmentId, labelType)`) zostaje przy PDF (BLP) przy tworzeniu — bez zmiany, zero ryzyka dla
działającego procesu — a ZPL (ZBLP) dociąga NA ŻĄDANIE dopiero przy kliknięciu druku bezpośredniego (niezależnie
od tworzenia przesyłki, więc bez zmiany schematu; nie zapisywane w bazie — świeże przy każdym druku). **Podgląd
PDF w trybie "Generuj PDF"** dla etykiety w ZPL (czyli zawsze dla DHL Express) idzie przez darmowe publiczne API
**Labelary** (`app/api/shipping/render-zpl`, `api.labelary.com/v1/printers/8dpmm/labels/4x6/0/`, `Accept:
application/pdf`) zamiast prosić DHL o PDF wprost. **Wybór trybu druku ("Generuj PDF" / "Drukowanie bezpośrednie")**
w `ShippingView.tsx` (localStorage `shipping-direct-print`, per przeglądarkę/stanowisko, nie w bazie) — na wyraźną
prośbę właściciela, "na wszelki wypadek": "Generuj PDF" (domyślne) wraca do dzisiejszego zachowania (otwórz PDF,
ręczny Ctrl+P). **Dwie pigułki, nie suwak** — pierwsza wersja (suwak bez stałego opisu obok) myliła: nie było
widać, który stan jest który, tylko sam tekst się zmieniał (zgłoszone przez właściciela po pierwszym teście na
żywo — suwak w pozycji "wyłączone" pokazał PDF-y, co było poprawnym zachowaniem, tylko nieczytelnie pokazanym).
**Auto-druk po nadaniu (30.09.2026)** — gdy tryb "Drukowanie bezpośrednie" jest włączony, etykieta i delivery note
drukują się same, od razu po udanym nadaniu (`create()` w `ShippingView.tsx` woła `handleLabel`/`handlePackingSlip`
zaraz po `setDone(...)`), bez czekania na osobne kliknięcie — zgłoszone przez właściciela: wcześniej trzeba było
kliknąć "Drukuj etykietę"/"Drukuj packing slip" ręcznie, tak jak w trybie PDF. Przyciski w panelu "Przesyłka
nadana" zostają jako ręczny fallback (np. gdyby auto-druk się nie udał). **Telefon odbiorcy bez spacji (05.10.2026, na prośbę właściciela):** `stripPhoneSpaces` (`lib/shipping.ts`) usuwa wszystkie spacje (też twarde i niewidoczne) z numeru — przy wypełnianiu formularza z zamówienia, przy wpisywaniu/wklejaniu w polu "Telefon odbiorcy" oraz po stronie serwera w `parseShipmentBody` (`06 66 97 01 81` -> `0666970181`, `+48 600 100 200` -> `+48600100200`). Myślniki, kropki i nawiasy zostają.
**Drukarki per pracownik (05.10.2026, na prośbę właściciela — pola z nazwami drukarek są tylko w Admin-owym panelu "Zmień dane nadawcy" na dole Wysyłki i dotyczyły wszystkich naraz):** `members.zebra_printer_name`/`a4_printer_name` (`schema.sql`), Admin ustawia je w Zespół → Edytuj (sekcja "Drukarki", zapis przy wyjściu z pola; polityka `admin update members` obejmuje nowe kolumny). Wysyłka bierze drukarki ZALOGOWANEJ osoby, a gdy puste — wspólne z `shipping_settings`
(`printerZebra`/`printerA4` w `ShippingView.tsx`); lista zespołu ma awaryjny odczyt bez nowych kolumn (do uruchomienia `schema.sql`). Nazwy trzeba wpisać ręcznie — "Wykryj drukarki" widzi tylko komputer, na którym klika Admin.
**Nazwy drukarek** (dokładnie jak w Windowsie) w `shipping_settings.zebra_printer_name`/`a4_printer_name` —
nowe nullable kolumny, Admin ustawia w panelu "Zmień dane nadawcy", z przyciskiem "Wykryj drukarki" (`listPrinters()`
w `lib/printAgent.ts`, wymaga uruchomionego QZ Tray na komputerze, na którym klika Admin). **Delivery note przez
serwerowy proxy** (`app/api/shipping/fetch-remote-pdf`) zamiast fetch wprost z przeglądarki — omija nieprzewidywalne
CORS na S3 Back Marketu; prosta ochrona przed SSRF (tylko https, blokada hostów prywatnych/lokalnych), route i tak
dostępny tylko dla zalogowanego, uprawnionego zespołu. Etykiety bez ZPL (dziś: Erli) w trybie bezpośrednim lecą jako
PDF wprost na drukarkę Zebra przez jej sterownik Windows (`printPdf` w `lib/printAgent.ts`, ta sama funkcja co dla
A4 — nazwa drukarki decyduje, nie funkcja). **`next.config.mjs` bez żadnego aliasu webpack dla `qz-tray`** — próbowano
`resolve.alias: { lna: false }`, żeby wyciszyć ostrzeżenie buildu o brakującym opcjonalnym pakiecie `lna` (biblioteka
Local Network Access dla nowszych Chrome, celowo nieinstalowana), ale to była **realna regresja, nie tylko kosmetyka**:
`false` w aliasie webpacka podmienia moduł na pusty obiekt `{}` zamiast dać `require()` rzucić wyjątek — a kod qz-tray
(`loadLna()`) jest napisany dokładnie pod rzucający wyjątek (`try { return require('lna'); } catch { warn(...) }`,
komentarz wprost: "Use require if available so that bundlers can detect the dependency"). Z aliasem `_qz.tools.lna`
wychodziło z tej funkcji jako `{}` (prawda logiczna) zamiast `undefined`, więc późniejsze wywołanie
`_qz.tools.lna.detectLna(...)` wybuchało `"n.detectLna is not a function"` — QZ Tray nie łączył się wcale (błąd
zgłoszony przez właściciela na żywym teście 30.09.2026). Cofnięte: `next build` bez aliasu kończy się sukcesem
(potwierdzone lokalnie — samo ostrzeżenie "Module not found: Can't resolve 'lna'" nie przerywa builda), a moduł
faktycznie rzuca wyjątek przy `require()`, tak jak qz-tray oczekuje. Nie testowane z prawdziwą drukarką/QZ Tray
(brak dostępu do sprzętu w środowisku asystenta) — zweryfikowane budowaniem projektu (`next build`, sukces) i
testami jednostkowymi (`dhl.test.js`/`shipping.test.js`/`parcel.test.js` w scratchpadzie).

**Etykiety DHL Express na drukarce innej niż Zebra (06.10.2026, zgłoszenie: Kinga drukowała nieczytelne etykiety):** Kinga ma drukarkę "HPRT HD100 - ZPL" — drukarkę HPRT z emulacją ZPL, nie Zebrę. Etykieta DHL Express to ZPL z fontami skalowalnymi w formie `^A0N,,24` (pusta wysokość), które prawdziwa Zebra renderuje poprawnie, a emulacja HPRT nie — tekst wychodził jako nieczytelne znaki, choć kody kreskowe (`^BC`) i grafiki (`^GFA`) były dobre; pozostałe osoby drukują na Zebrach (ZDesigner), więc u nich działało. **Naprawa:** dla drukarek, których nazwa NIE zawiera "ZDesigner"/"Zebra" (`printerNeedsImageLabel` w `lib/printAgent.ts`), etykieta ZPL idzie do `POST /api/shipping/zpl-to-image`: renderuje ją Labelary (PNG, 203 dpi, 10x15 cm — ta sama usługa co podgląd PDF), `lib/pngToMono.ts` (własny dekoder PNG, bez zależności) zamienia obraz na czerń/biel, a `monoToGfa` (ta sama funkcja co dla etykiet UPS-GIF) na ZPL zawierający tylko grafikę `^GFA` — drukowaną przez każdą drukarkę ZPL. Przetestowane na etykiecie próbnej: obraz -> ZPL -> ponowne renderowanie daje 0 różnych pikseli; **nie testowane na fizycznej HPRT** (brak dostępu do drukarki). Wymaga połączenia z Labelary przy każdym wydruku (jak podgląd). Dotyczy też ponownego drukowania starych przesyłek (etykieta z bazy). Nazwa drukarki w ustawieniach decyduje o trybie — drukarka Zebra o niestandardowej nazwie też zadziała (jako obraz, trochę wolniej).
**Test druku (02.10.2026; od 05.10.2026 UKRYTY za pigułką "Test druku" obok "Drukowanie bezpośrednie" — domyślnie schowany, pigułka go pokazuje/chowa)** — ramka "Test druku" w Wysyłce, tuż pod pigułkami trybu druku, z dwoma przyciskami:
próbna etykieta ZPL 100x150 mm na Zebrę i próbny delivery note (ręcznie składany PDF A4) na drukarkę A4, zawsze
BEZPOŚREDNIO przez QZ Tray (niezależnie od wybranego trybu), na drukarki z ustawień nadawcy. **Nic nie nadaje w DHL, nic
nie zapisuje w bazie i nic nie zgłasza do marketplace'u** — to nie "zamówienie testowe", tylko same próbne dokumenty
(`lib/printTest.ts`, `testPrint` w `ShippingView.tsx`); same ASCII, bez polskich znaków. Do usunięcia, gdy drukowanie
bezpośrednie zostanie sprawdzone na stanowiskach.

**Instrukcja instalacji QZ Tray (Windows, dla każdego stanowiska, które ma drukować bezpośrednio):**
1. Pobierz instalator ze strony **qz.io/download** (oficjalna strona QZ Tray — nie z innego źródła).
2. Uruchom instalator, zaakceptuj domyślne ustawienia (instalacja jako aplikacja w tle + start z Windowsem).
3. Po instalacji QZ Tray pojawia się jako ikona w zasobniku systemowym (obok zegara) — musi tam być widoczna,
   żeby drukowanie bezpośrednie działało (uruchamia się automatycznie przy starcie Windows).
4. **Skopiuj `override.crt`** (nasz certyfikat — poproś asystenta o ten plik) do `C:\Program Files\QZ Tray\override.crt`,
   potem zrestartuj QZ Tray (prawy klik na ikonę w zasobniku → Exit, uruchom ponownie). **Ten krok jest konieczny** —
   bez niego certyfikat self-signed jest kryptograficznie poprawny (druk działa), ale QZ Tray traktuje go jako
   niezaufany i **blokuje trwałe zapamiętanie "Allow"** — w oknie zgody da się wtedy zapamiętać tylko "Block", "Allow"
   trzeba klikać przy każdym druku (zgłoszone przez właściciela 30.09.2026, potwierdzone w dokumentacji QZ Tray:
   `override.crt` w folderze instalacyjnym nadpisuje zaufany root QZ Tray na TYM komputerze własnym certyfikatem —
   darmowa alternatywa dla płatnego podpisu certyfikatu przez QZ Industries).
5. W Magazyn ERP, w zakładce Wysyłka → "Zmień dane nadawcy (Admin)" → "Wykryj drukarki na tym komputerze" —
   powinna pokazać się lista drukarek zainstalowanych w Windows na TYM komputerze; wybierz dokładną nazwę
   drukarki etykiet (Zebra) i drukarki A4.
6. Przy pierwszym wydruku z tej przeglądarki QZ Tray pokaże okienko z prośbą o zgodę na połączenie —
   zaznacz "Remember this decision" razem z "Allow" (dopiero po kroku 4 to w ogóle możliwe do zaznaczenia).
7. Gotowe — przełącznik "Drukowanie bezpośrednie" w Wysyłce włącza druk bez okna dialogowego.

Uwaga: `override.crt` zastępuje domyślny zaufany root QZ Tray NA TYM KOMPUTERZE — nieszkodliwe, dopóki QZ Tray na
danym stanowisku służy wyłącznie do drukowania z naszej aplikacji (nie z innej strony korzystającej z QZ Tray).

Uwaga: nazwy drukarek trzeba ustawić OSOBNO na każdym stanowisku, jeśli różne komputery mają różne drukarki
podłączone pod inną nazwą w Windows — `shipping_settings` to dziś jeden wspólny wiersz w bazie (jedna para nazw
dla wszystkich), więc jeśli w magazynie pracuje więcej niż jedno stanowisko z różnymi drukarkami, trzeba to
uwzględnić osobno (np. jedna nazwa drukarki ustawiona tak samo w Windows na każdym stanowisku).

**Na razie tylko kraje UE** (bez odprawy celnej, `isCustomsDeclarable: false`, incoterm DAP), **w tym Polska** (`DHL_EU_COUNTRIES`
w `lib/dhlExpress.ts` — była z niej wcześniej wyłączona, bo krajowe zamówienia Allegro/Erli mają inną obsługę, ale to
wykluczało też Back Market/refurbed z odbiorcą w Polsce, które takiej alternatywy nie mają; poprawione, zgłoszone przez
właściciela na realnym zamówieniu refurbed do Polski); poza UE wymaga danych
celnych (opis, wartość, kod HS) — do zrobienia. Nadawca (`shipping_settings`, jeden wiersz; Admin zmienia w zakładce) i szablony (`shipping_templates`; dodaje Admin/Manager, usuwa Admin)
są w bazie. Z karty zamówienia (Back Market, Refurbed, Octopia, kraj UE) przycisk "Nadaj przesyłkę DHL" wypełnia formularz
(`buildShipPrefill` w `lib/shipping.ts`; Octopia dołączona 29.09.2026 — adres per-pozycja z `lines[0].shippingAddress`, kompletny,
zwykły brakujący branch, nie ograniczenie API). **Amazon świadomie bez tego przycisku:** SP-API zwraca `ShippingAddress` bez
imienia/nazwiska, linii adresu i telefonu — tylko `City`/`PostalCode`/`CountryCode` — niezależnie od stanu zamówienia (sprawdzone na
30 żywych zamówieniach, także "Shipped"); to efekt roli "Inventory and Order Tracking" bez dostępu do PII, nie błąd po naszej stronie.
Pełny adres wymaga osobnego zatwierdzenia w Seller Central (dostęp do danych PII) i osobnego mechanizmu (Restricted Data Token:
`POST /tokens/.../restrictedDataToken` + `GET /orders/v0/orders/{id}/address`) — do zrobienia, gdy właściciel uzyska tę zgodę. Linie adresu DHL to max 3 x 45 znaków (`splitAddressLines` łamie na
spacjach, za długi adres = czytelny błąd, nie ucinanie). **Packing slip Back Marketu** (`bm_orders.delivery_note`, pole API "Document to add in package which
contains useful information for the customer" — link do PDF na S3, podpisany, ważny 5 dni **od momentu synchronizacji**, nie od
utworzenia dokumentu, potwierdzone na żywo: `Expires` w URL = `synced_at` + 5 dni): pojawia się w API dopiero **po akceptacji
zamówienia** i to **BEZ opóźnienia po stronie Back Marketu** (sprawdzone 29.09.2026 na próbce 20 zamówień w stanie "Do wysyłki" —
20/20 miało już `delivery_note`; dla "Do zaakceptowania" zawsze puste). Zgłoszony przez właściciela przypadek "czasem jest, czasem
nie" okazał się więc naszym opóźnieniem synchronizacji, nie Back Marketu: jeśli akceptacja i nadanie nastąpiły w odstępie krótszym
niż cron (15 min), `bm_orders.delivery_note` mógł jeszcze nie złapać świeżej wartości. Po udanym nadaniu (obojętnie który
przewoźnik) najpierw sprawdzamy już zsynchronizowaną wartość, a jeśli jej brak — dociągamy zamówienie NA ŻĄDANIE
(`POST /api/orders/bm-refresh`, `GET /ws/orders/{id}` na żywo, przy okazji odświeża cały wiersz w `bm_orders`/`sales_orders`) zamiast
czekać na kolejny cron. Przycisk "Otwórz packing slip (PDF)" obok "Otwórz etykietę"; nic nie pokazuje, gdy pole naprawdę jest puste
(refurbed i inne kanały nie mają tego pola — brak przycisku). **Po nadaniu numer przesyłki wraca do marketplace'u**
(`lib/shipmentMarketplaceSync.ts`, wołane z obu route'ów `create`, obojętnie który przewoźnik): dla Back Market
`POST /ws/orders/{id}` (`lib/backmarket.ts`, `new_state: 3` "Do wysyłki" + `tracking_number`/`tracking_url`/`shipper` —
**`new_state: 9` ("wysłane") zwraca błąd 400 na produkcji** (`"new_state 9 must be in 2,3,4,5,6"`), mimo że schema
`OrderState` wymienia 9 jako wartość w ogóle dopuszczalną — to tylko stan, jaki BM może zwrócić przy odczycie, nie
który wolno ustawić tym zapytaniem; najwyraźniej Back Market sam przestawia zamówienie na 9, gdy zweryfikuje
przesyłkę u przewoźnika;
bez SKU w body, więc wszystkie pozycje zamówienia przechodzą naraz — jedna przesyłka = całe zamówienie), dla refurbed
`OrderItemService/BatchUpdateOrderItemsState` (stan `SHIPPED` na każdej pozycji zamówienia — pozycje dochodzą z
`sales_order_items`, `parcel_tracking_url` jest tam wymagany; nazwa przewoźnika przez `ShippingProfileService/ListAvailableCarriers`
jest tylko kosmetyczna, brak dopasowania nie blokuje zgłoszenia). Mapa nazw przewoźnika dla Back Market
(`BM_SHIPPER_BY_CARRIER`) nie ma dokładnego wpisu dla DHL Parcel Polska w ich słowniku `Shipper` — użyte ogólne "DHL".

**Koszt wysyłki nigdzie się nie zapisywał do 01.10.2026 — naprawione, zgłoszone przez właściciela.** `shipments.charges`
miało wyglądać jak zawsze puste (`[]` dla DHL Express) albo `null` (DHL Parcel, kod miał wprost komentarz "DHL24 nie
zwraca opłaty przy tworzeniu przesyłki" — świadomie zaakceptowany brak, nie przeoczenie). Powód: **cena jest znana
TYLKO na etapie wyceny** (`/rates` dla Express, `getPrice` dla Parcel), tuż PRZED kliknięciem "Nadaj przesyłkę" —
sama odpowiedź przewoźnika na `POST /shipments`/`createShipments` jej nie niesie z powrotem (sprawdzone na żywych
danych: 4/4 zapisanych przesyłek DHL Express miało `charges: []`, wszystkie przesyłki DHL Parcel miały `charges:
null`). Naprawione przekazaniem WYBRANEJ ceny (już policzonej przy wycenie, trzymanej w stanie `quote`/`chosen` w
`ShippingView.tsx`) z przeglądarki do route'a `create` (pola `billing`/`local` w body, kształt `DhlMoney` — ten sam
dla obu przewoźników) — `parseQuotedCharges` (`lib/shipmentInput.ts`) zamienia je na kształt `charges` już używany
przez `dhlCharge()`. DHL Express dalej PRZEDKŁADA własną odpowiedź, gdyby kiedyś faktycznie coś zwróciła (`created.
charges?.length ? created.charges : parseQuotedCharges(...)`); DHL Parcel zawsze bierze wycenę, bo DHL24 nigdy nic
w tym polu nie zwraca. Dotyczy tylko przesyłek nadanych PO tej poprawce — starsze zostają z pustymi/`null` `charges`. **Przesyłka nadana z nieodświeżonej karty przeglądarki nadal zapisze się bez ceny** (02.10.2026: cztery
przesyłki Bartosza, mimo że ta sama poprawka działała już u Kingi i Olki — stary kod w otwartej karcie nie wysyła
`billing`/`local`, a nowy serwer zapisuje wtedy `charges: []`). Dlatego w liście "Nadane przesyłki" przy pustej
cenie DHL Parcel jest link **"Dolicz cenę"** (`backfillPrice` w `ShippingView.tsx` -> `POST /api/shipping/dhl-parcel/backfill-price`):
serwer pyta DHL24 o wycenę (`getPrice`) dla ZAPISANEJ trasy i paczki i zapisuje ją w `charges` — to wycena z chwili
kliknięcia, nie z chwili nadania; nie nadpisuje istniejącej ceny ani nie rusza anulowanych. Wzór ceny (baza + dopłata
paliwowa jako procent) siedzi w `parcelQuoteTotal` (`lib/shipping.ts`, współdzielone z formularzem wyceny). Tylko
DHL Parcel — dla DHL Express z pustymi `charges` odpowiednika nie ma. **Kolumna "Zamówienie" jest w tej liście
pierwsza po dacie, przed "Przewoźnik"** (02.10.2026, na prośbę właściciela).

**Koszt wysyłki na karcie zamówienia** (`SalesOrderCard.tsx`, sekcja "Dane wprowadzone przez pracownika") — nowe
pole, **tylko dla zamówień ZAGRANICZNYCH** (`sales_orders.country_code` inny niż `"PL"`; brak kraju = pole się nie
pokazuje). Auto-wartość z najnowszej przesyłki DHL tego zamówienia (`shipments.charges` przez `dhlCharge()`, patrz
wyżej) — gdy jest, pole jest TYLKO DO ODCZYTU (cena z DHL jest autorytatywna, nie do nadpisania ręcznie). Gdy
auto-wartości brak (przesyłka sprzed poprawki, zamówienie jeszcze nienadane, albo wysłane poza naszą integracją
DHL — np. Erli Paczkomat) — zwykłe, edytowalne pole liczbowe w PLN, zapisywane do `sales_orders.shipping_cost`
(zapis przy wyjściu z pola, jak `InlineEditCell` gdzie indziej) + wpis do logu zmian karty zamówienia (ten sam
wzorzec co `acceptOrder`/`refreshErliOrder` — RPC `sales_order_add_log` z sesji przeglądarki). `shipping_cost`
celowo NIE jest w `sales_orders_protect_api_fields` — to pole pracownika, nie z API marketplace'u, więc edycja
przez zalogowanego jest dozwolona (w odróżnieniu od `tracking_number`/`status`/`sku`/`country_code`).

**Razem z numerem przesyłki idzie IMEI/numer seryjny pozycji, gdy zespół go wpisał** (`sales_order_items.serial_number`
— pole nazywa się "Numer seryjny" wszędzie w aplikacji, ale to samo pole niesie IMEI dla produktów, które go mają).
Obydwa marketplace'y tego wymagają dla kategorii Smartfony (Back Market od 1.01.2022 — kara za brak; refurbed
podobnie) i **tylko dla pozycji z ilością = 1 w oryginalnym zamówieniu** — to twarde ograniczenie ich API, nie nasze.
Typ (IMEI vs zwykły numer seryjny) rozpoznajemy automatycznie w `classifyIdentifier` (`lib/shipmentMarketplaceSync.ts`):
dokładnie 15 cyfr = IMEI (norma GSMA), każda inna wartość = numer seryjny. Back Market: `imei`/`serial_number` na
`POST /ws/orders/{id}` dla zamówień z JEDNĄ pozycją (bez `sku` trafiłby tam jednoznacznie), a dla kilku pozycji osobne
`PATCH /ws/orderlines/{orderline_id}` (`bmSetOrderlineIdentifier`) per pozycja — pozycje rozbite z ilości > 1 (klucze
`"id"`, `"id-2"`...) są pomijane, bo dzielą jedną prawdziwą pozycję u Back Marketu. refurbed: `item_identifiers:
[{identifier_type: IMEI|SERIAL_NUMBER, value}]` na tym samym `BatchUpdateOrderItemsState` — kwalifikują się wszystkie
pozycje (refurbed nie rozbija ilości > 1, każda pozycja to zawsze jedna sztuka). Błąd zgłoszenia samego IMEI/numeru
(np. kategoria niezgodna) **nie cofa już zgłoszonego numeru przesyłki** — `synced` zostaje `true`, a błąd trafia do
`marketplace_sync_error` z osobnym opisem. To zgłoszenie **nigdy nie failuje samego nadania** (przesyłka w DHL już
istnieje i jest płatna): wynik zapisuje się w
`shipments.marketplace_synced_at`/`marketplace_sync_error`, UI pokazuje ostrzeżenie z przyciskiem "Ponów"
(`POST /api/shipping/sync-marketplace`). Zweryfikowane w produkcji na Back Markecie (na atrapie `fetch` wg
dokumentacji sam błąd `new_state: 9` się nie ujawnił — realny test na żywym API był potrzebny, żeby go złapać;
asystent nie ma dostępu do kluczy Back Market/refurbed, więc testuje tylko na atrapie `fetch`, a właściciel na
produkcji). **Ograniczenia DHL Express:** środowisko testowe ma limit 500 wywołań dziennie; API **nie pozwala anulować przesyłki**
(tylko w panelu DHL); Economy Select zależy od trasy i umowy; kuriera nie zamawiamy z aplikacji (`pickup.isRequested: false`). Wcześniej rozważane DHL Parcel Polska (DHL24 WebAPI2, SOAP)
— porzucone (dokumentacja niedostępna, umowa jest na Express). Nie testowane na żywym API do nadawania — zweryfikowane na atrapie `fetch` wg specyfikacji.

**DHL Parcel** (`lib/dhlParcel.ts`, DHL24 WebAPI2, **SOAP**, WSDL `https://dhl24.com.pl/webapi2?wsdl`, endpoint `https://dhl24.com.pl/webapi2/provider/service.html?ws=1`): koperta
document/literal składana ręcznie (`el()` — UWAGA: zagnieżdżone elementy podawać jako tablicę, tekst jest escapowany), odpowiedź czytana `fast-xml-parser`. Logowanie: `authData` (klucz
użytkownika = "klucz APIv2" + hasło) w każdej metodzie oprócz `getVersion`; płatnik po numerze SAP (BANK_TRANSFER, SHIPPER). Produkty międzynarodowe: **EK (Connect)**, **PI (International)** i **CP (Connect Plus)**
— lista `PARCEL_PRODUCTS` w `lib/dhlParcel.ts`, wspólna dla wyceny (`check/route.ts`) i nadania (`create/route.ts`), żeby
nie powtórzyć błędu sprzed wprowadzenia Connect Plus (produkt istniał w API DHL24 od dawna, ale nie było go w żadnej
z tych list osobno trzymanych w obu route'ach, więc nie dało się go wybrać). Kody wg dokumentacji DHL24 (struktura
`ServiceDefinition`, pole `product`; jest tam też `CM` — Connect Plus Pallet, niezaimplementowane — osobna usługa na
paletach). **Przesyłki wieloelementowe (30.09.2026, na prośbę właściciela — zamówienie wymagające 2 paczek):**
`pieceList` w `getPrice`/`createShipments` przyjmuje TABLICĘ pozycji w JEDNEJ przesyłce (jeden `shipmentId`/
waybill) — potwierdzone wprost w oficjalnym przykładzie dokumentacji DHL24 dla `createShipments` (paleta + koperta
w jednym `pieceList` tej samej przesyłki), nie zgadywane. `dhlParcelPrice`/`CreateParcelInput` w `lib/dhlParcel.ts`
przyjmują teraz `packages: ParcelPackage[]` (wcześniej pojedynczy `package`) — `pieceList` buduje się z `packages.
map(pieceXml)`. **Żaden produkt nie jest sztucznie ograniczony do jednej paczki** — dokumentacja `ServiceDefinition`
mówi wprost, że WebAPI samo odrzuci niedozwoloną kombinację produkt/usługi czytelnym błędem przy nadaniu, więc nie
zgadujemy limitu po stronie klienta ani nie wymuszamy Connect Plus dla >1 paczki (choć to on jest do tego pomyślany,
do 15 sztuk). W formularzu (`ShippingView.tsx`, tylko gdy `carrier === "parcel"`) przycisk "+ Dodaj kolejną paczkę
do tej przesyłki" dokłada wiersz waga/wymiary (`extraPackages`, osobny stan od głównego `form`) — opis zawartości
(`content`) zostaje WSPÓLNY dla całej przesyłki (jedno pole na poziomie `shipments.item`, nie per paczka — zgodnie
z dokumentacją DHL24). Walidacja dodatkowych paczek: `parseExtraPackages` w `lib/shipmentInput.ts` (nowa funkcja,
osobna od `parseShipmentBody` — ten się nie zmienił, więc DHL Express, który multi-piece nie dotyczy, jest
nietknięty), żądanie niesie je jako `extraPackages` (tablica, opcjonalna) obok istniejącego pojedynczego `package`
(pierwsza paczka). `shipments.package` dla DHL Parcel to teraz TABLICA wszystkich sztuk (nie pojedynczy obiekt jak
przy DHL Express) — nic poza tym route'em nie czyta tej kolumny z powrotem (sam zapis księgowy), więc różny kształt
między przewoźnikami jest bezpieczny. Nie testowane na żywym API (brak dostępu) — zweryfikowane na atrapie `fetch`
(`parcel.test.js`: dwie pozycje w `pieceList` jednego zgłoszenia, `shipmentId` zostaje jeden).
wycena `getPrice` (`price` to cena BAZOWA w PLN, **`fuelSurcharge` to PROCENT, nie kwota w PLN** — mimo że w WSDL oba
pola to `xsd:float`, nic tego nie odróżnia; do 28.09.2026 kod traktował ją jak złotówki i wcale nie doliczał do
pokazywanej ceny, więc cena na liście wychodziła zaniżona o ~20-25% — poprawione w `ShippingView.tsx`: cena na
liście to już `price * (1 + fuelSurcharge/100)`, "składniki ceny" pokazują bazę i dopłatę osobno, z procentem w
nazwie; zweryfikowane na żywo, matematyka zgadza się co do grosza z panelem DHL24 dla tej samej trasy (to jest
"Cena netto" z ich panelu — kolumny wyceny i opis pod tabelą wprost mówią "netto" dla DHL Parcel, bez VAT); produkt
niedostępny na trasie = wiersz "niedostępny: <powód>"), tworzenie `createShipments`, etykieta `getLabels` **BLP = PDF**
(ZBLP = ZPL dla Zebry, nieużywany), anulowanie `deleteShipments` (**możliwe przez API**, dopóki nie zamówiono kuriera; wiersz w `shipments` dostaje `cancelled_at`). **DHL Parcel nie ma
środowiska testowego dostępnego dla nas** — każde nadanie jest prawdziwe, więc test = nadaj + od razu anuluj. Adres w DHL24 wymaga ulicy i numeru domu w OSOBNYCH polach oraz limitów:
miejscowość max **17** znaków (potwierdzone wprost w ich dokumentacji, struktura Address), ulica 35, nazwa 60, telefon 20, **suma numeru domu i numeru lokalu razem max 15 znaków** (osobny limit od 10 znaków każdego pola z osobna) — za długie = czytelny błąd, nie ucinanie; opis zawartości ucinany do 30. Nadawcę rozdziela `loadShipper`
(`lib/parcelServer.ts`, kod pocztowy bez myślnika). Wspólna serwerowa walidacja formularza: `lib/shipmentInput.ts` (`parseShipmentBody`, numer domu wyciągany z ulicy przez
`splitStreet`). Numer przesyłki DHL24 (shipmentId) = numer do śledzenia. **Odbiorca prywatny (bez firmy) na etykiecie:**
`contactPerson` wysyłamy tylko, gdy jest osobna firma (`receiver.company`) — inaczej `name` i `contactPerson` to ta sama
osoba i etykieta drukuje ją dwa razy (znalezione na żywej etykiecie DHL Parcel; ten sam wzorzec poprawiony też w DHL
Express — `contactInformation.fullName` tylko z firmą). Nie testowane na żywym API poza tym przypadkiem — zweryfikowane na atrapie `fetch` wg WSDL.

**UPS** (04.10.2026, na prośbę właściciela; `lib/ups.ts`, `lib/upsServer.ts`, `app/api/shipping/ups/{check,create,cancel}`, czwarty przycisk przewoźnika w formularzu Wysyłki) — trzeci przewoźnik obok DHL Express/Parcel, na koncie własnym (nie Erli).
Specyfikacje OpenAPI UPS: `github.com/UPS-API/api-documentation` (portal developer.ups.com jest ciężki w JS i nie czyta się go automatycznie). **Autoryzacja:** OAuth2 client_credentials — `POST /security/v1/oauth/token`, Basic Client ID:Secret, nagłówek `x-merchant-id` = numer konta;
token trzymany w pamięci procesu do wygaśnięcia (test 1 h, produkcja 4 h), nie w bazie. Aplikacja zarejestrowana jako "integrate UPS technology into my business" (jedno konto własne), produkty: Authorization, Rating, Shipping (+ Tracking opcjonalnie); konto UPS (`741Y6V`) ma **stawki wynegocjowane** — na produkcji
wycena zwraca je w PLN (`NegotiatedRateCharges`), a gdy ich brak, pokazujemy cennik katalogowy z ostrzeżeniem. **Środowiska:** test (`wwwcie.ups.com`) i produkcja (`onlinetools.ups.com`), domyślnie TEST, produkcja tylko przy `UPS_ENV=production` — **środowisko testowe UPS to atrapa**
(numery `1ZXXXXXXXXXXXXXXXX`, stała cena, wycena odrzuca większość tras, anulowanie "nie znaleziono"), przydatna tylko do sprawdzenia kształtu żądania nadania; prawdziwą wycenę widać wyłącznie na produkcji (wycena niczego nie tworzy i nic nie kosztuje).
**Wycena** `POST /api/rating/v2409/Shop` zwraca usługi dostępne na trasie (u nas z Kielc: 07 Express, 11 Standard, 54 Express Plus, 65 Express Saver — nazwy w `UPS_SERVICES`); w żądaniu wycenia opakowanie nazywa się `PackagingType`, w żądaniu nadania `Packaging` (pomylenie daje błąd 111212 "Package Type is unavailable").
Cena = kwota NETTO w PLN (bez VAT), składniki: opłata podstawowa + dopłata paliwowa (kod 375). Przykład z produkcji: 3 kg PL→DE, Standard 48,32 zł (cena katalogowa 831,64 zł). **Nadanie** `POST /api/shipments/v2409/ship`: płatnik = konto (`BillShipper`), etykieta **ZPL 4x6** (base64 w `shipments.label_data`,
`label_format = "zpl"` — ta sama ścieżka druku bezpośredniego/podglądu przez Labelary co DHL Express); **wiele paczek w jednej przesyłce** (jak DHL Parcel: dodatkowe paczki w formularzu), etykiety wszystkich paczek sklejone w jedną porcję ZPL. `tracking_number` = `ShipmentIdentificationNumber` (1Z…), link `ups.com/track`.
Cena zapisywana w `charges` (BILLC) z odpowiedzi nadania (stawka wynegocjowana), a gdy jej brak — z wyceny; trafia do kosztu wysyłki w Marży (`margin.sql` ma `ups` na liście przewoźników, uruchom ponownie) i na kartę zamówienia. **Anulowanie** `DELETE …/void/cancel/{id}` — możliwe, dopóki UPS nie odbierze paczki;
przycisk "Anuluj" na liście, route sprawdza zgodność środowiska przesyłki z aktywnym (`UPS_ENV`). **Adres:** nazwa i linie adresu po max 35 znaków (do 3 linii), miasto 30 — za długie = czytelny błąd, nie ucinanie (jak DHL24); polski kod pocztowy uzupełniany myślnikiem (NN-NNN).
**Marketplace:** po nadaniu numer wraca do Back Market (`shipper: "UPS"` — nazwa NIEPOTWIERDZONA na żywym API BM; gdyby odrzucili, błąd widać przy przesyłce z "Ponów", nadanie się nie psuje) i refurbed (przewoźnik "UPS" z listy, gdy jest). Bez migracji SQL (carrier/product_code to zwykły tekst).
**Pobranie (COD) w UPS i wysyłki krajowe (04.10.2026, na prośbę właściciela — sprzedaż do Polski, w tym zamówienia za pobraniem z Erli/Allegro):** UPS dostępny też dla odbiorców w Polsce (PL→PL; potwierdzone wyceną: Standard 27,09 zł, Express Saver 34,84 zł, Express 57,72 zł, Express Plus 115,38 zł dla 2,5 kg). **COD** = `ShipmentServiceOptions.COD`
(`upsCodOptions` w `lib/ups.ts`), kod środków `1` = gotówka (na koncie przyjęte kody 1 i 9, kody 0 i 8 UPS odrzuca: "Invalid COD funds code for Shipment Level"), kwota w PLN **10–50 000 zł** (pole MonetaryValue ma min. 5 znaków), **tylko przesyłki krajowe PL→PL** (`parseUpsCod` w `lib/upsServer.ts` odrzuca zagraniczne).
Pobranie idzie i do WYCENY (cena zawiera opłatę za pobranie: na koncie ≈ +2,17 zł netto), i do nadania; w formularzu Wysyłki checkbox "Pobranie (COD)" + kwota pojawia się dla UPS i kraju PL, zmiana unieważnia wycenę. Kwota zapisana w `shipments.package` (dla UPS obiekt `{ pieces, cod }`, nie tablica), lista przesyłek pokazuje znacznik "COD … zł".
**Wpłatę pobrania przekazuje UPS wg Waszej umowy (przelew na konto) — aplikacja tego nie śledzi ani nie uzgadnia z zamówieniem.** Kwota COD nie jest weryfikowana z zamówieniem po stronie serwera (UI podpowiada ją z zamówienia).
**Wypełnianie formularza z zamówień krajowych Erli i Allegro** (`buildDomesticShipPrefill` w `lib/shipping.ts`, przycisk "Nadaj przesyłkę (DHL / UPS)" na karcie zamówienia): Erli — `user.deliveryAddress` (ulica + `buildingNumber` + `flatNumber`, firma, telefon, e-mail), COD gdy `delivery.cod` (kwota = `totalPrice`/100 razem z dostawą; metody Erli "Kurier UPS Pobranie" / `upsCod` to 142 z 843 zamówień); Allegro — `delivery.address` (ulica z numerem w jednym polu, rozdzielana `splitStreet`),
COD gdy `payment.type = CASH_ON_DELIVERY` (kwota = `summary.totalToPay` razem z dostawą). Zamówienia z odbiorem w PUNKCIE/PACZKOMACIE (Erli `delivery.pickupPlace`, Allegro `delivery.pickupPoint` — ok. 6 na 10) NIE dostają przycisku: adres w zamówieniu to adres kupującego, nie punktu, więc kurier pod adres byłby pomyłką. Zamówienie z COD proponuje od razu UPS z włączonym pobraniem
(można zmienić przewoźnika i wyłączyć). Osobno od `rawBuyerAddress`, który jest wspólny z fakturami (tam Erli/Allegro mają własne, fakturowe pola). DHL Parcel nie dostał obsługi COD (nie było prośby).
**Etykieta UPS z pobraniem to GIF, nie ZPL (06.10.2026, zgłoszone przez właściciela: Labelary "ZPL generated no labels (404)" przy podglądzie etykiety):** dla przesyłki z POBRANIEM (etykieta "EDI-COD") UPS zwraca w `ShippingLabel.GraphicImage` obraz **GIF** (1400×800, leżąca etykieta 6×4 cala z białym marginesem po prawej) mimo `LabelImageFormat: ZPL` — odpowiedź nawet deklaruje format "zpl". Sprawdzone na produkcji (Label Recovery z formatami ZPL/EPL/SPL/GIF zwraca ten sam GIF);
środowisko testowe UPS (atrapa) zwracało prawdziwy ZPL, więc wcześniejsze testy tego nie wykryły. Nie wiemy, czy zwykłe przesyłki bez pobrania dostają ZPL (nie testowano nadania na produkcji). **Naprawa przy nadaniu:** `lib/gifToZpl.ts` (bez zależności) — własny dekoder GIF (LZW) -> czerń/biel -> przycięcie do zawartości -> obrót o 90° w prawo (etykieta leży) -> ZPL `^GFA` 812×1218 z kompresją ZPL;
`upsCreate` robi to automatycznie, gdy `GraphicImage` zaczyna się od `GIF8` (prawdziwy ZPL przechodzi bez zmian), więc `label_data`/`label_format = "zpl"`, podgląd Labelary i druk na Zebrę działają jak dotychczas. Zweryfikowane: dekompresja wygenerowanego ZPL zgadza się z bitmapą co do piksela, obrócona etykieta jest pionowa i czytelna (obejrzana). Nie testowane na fizycznej drukarce Zebra.
Jedyna dotychczasowa etykieta GIF (1Z741Y6V7994378076) została zamieniona w bazie na ZPL jednorazowym skryptem.
Nie robione: zamawianie kuriera z aplikacji (`Pickup API`), UPS Access Point (punkty odbioru), odprawa celna/kraje poza UE (jak DHL), śledzenie (Tracking API), czas dostawy w wycenie. Zweryfikowane: logowanie i wycena na produkcji (kilka tras, 1–2 paczki), nadanie ZPL 2 paczek na środowisku testowym, testy jednostkowe na atrapie `fetch` (`ups.test.js`); prawdziwego nadania na produkcji nie wykonywano.

**Erli — Paczkomaty InPost 24/7** (`lib/erliShipping.ts`, `app/api/shipping/erli/{create,label,cancel}`, `ErliParcelPanel.tsx`) — trzeci, zupełnie inny sposób nadawania: to **Erli** zleca przesyłkę InPost na SWOIM koncie/rozliczeniu (`POST /shipping/parcels/` w tym samym "Marketplace API" co synchronizacja zamówień — ten sam `ERLI_API_KEY`/`ERLI_UA`, żadnych nowych zmiennych), nie my przez DHL. Dlatego przycisk **"Nadaj przez Erli (Paczkomat) →" siedzi wprost na karcie zamówienia Erli** (`SalesOrderCard.tsx`), nie w zakładce Wysyłka — widoczny tylko gdy klient faktycznie wybrał punkt InPost przy składaniu zamówienia w Erli (`order.raw.delivery.pickupPlace.provider === "inpost"`). **Adresu odbiorcy nie podajemy wcale** — Erli bierze go z zamówienia; wystarczy waga/wymiary (szablon albo ręcznie), w **milimetrach i gramach** (limity API: 1–2000 mm, 10–700 000 g), nie cm/kg jak w DHL — konwersja w `app/api/shipping/erli/create`. `typeId` = `erliPaczkomat` (pełny słownik metod: `GET /dictionaries/shippingMethods`, nieużywany — mamy tylko tę jedną). **Etykieta i numer śledzenia nie wracają od razu** przy tworzeniu — trzeba dopytać `POST /shipping/parcels/_search` (filter `field:"orderId", operator:"="`), ten sam wzorzec co "Pobierz etykietę ponownie" przy DHL Parcel; `notifyMarketplace` (patrz wyżej) tu nie ma zastosowania (to nie DHL). **Nadanie NIE musi wcale ruszyć pola `updated` zamówienia po stronie Erli** — okazało się błędnym założeniem (do 30.09.2026 dokumentacja tu mówiła "numer śledzenia i tak sam dojdzie przy kolejnej synchronizacji", bez pokrycia na żywych danych): zwykły cykliczny skan (`orders/erli-sync`) idzie kursorem po `updated`, więc zamówienie z realnie nadaną przesyłką (przez naszą integrację ALBO całkiem poza naszą aplikacją, np. wprost z panelu Erli) mogło zostać trwale niewidoczne dla tego skanu — ten sam wzorzec problemu co przy zmianie statusu płatności (`erli_paid`, patrz `orders/erli-sync/route.ts`). Zgłoszone przez właściciela 30.09.2026 na kilku takich zamówieniach (część sprzed prawie roku). Naprawione dwutorowo: **(1)** `app/api/orders/erli-refresh` — dogrywa NA ŻĄDANIE jedno zamówienie (`POST /orders/_search`, filter `field:"id", operator:"="`) i odświeża jego wiersz w `erli_orders`/`sales_orders`/`sales_order_items` (analogiczne do `bm-refresh` dla Back Marketu), wołane automatycznie (best-effort) zaraz po udanym nadaniu w `shipping/erli/create`; **(2)** przycisk **"Odśwież status z Erli ↻"** na karcie KAŻDEGO zamówienia Erli (`SalesOrderCard.tsx`, obok plakietki statusu) — dla zamówień wysłanych całkiem poza naszą integracją, gdzie nie ma żadnego momentu, w którym moglibyśmy odświeżyć automatycznie. **Anulowanie działa** (`DELETE /shipping/parcels/{id}`), dopóki przesyłka nie trafiła do sieci InPost — tak jak DHL Parcel, żaden test/sandbox nie istnieje, każde nadanie jest prawdziwe i płatne. **Bez migracji SQL:** carrier (`erli_paczkomat`) i product_code w `shipments` to zwykły tekst bez ograniczeń; id paczki Erli (potrzebny do anulowania) trzyma się w istniejącej kolumnie `charges` (`{erli_parcel_id}`) zamiast dodawać nową kolumnę tylko dla tego pola — stąd `dhlCharge()` (`lib/shipping.ts`, współdzielone z `SalesOrderCard.tsx` — patrz "Koszt wysyłki" w sekcji Zamówienia) sprawdza `Array.isArray` przed odczytem ceny DHL, żeby nie wywalić się na innym kształcie danych Erli. Nie testowane na żywym API (brak danych dostępowych w środowisku asystenta) — zweryfikowane na atrapie `fetch` wg `swagger.json` (`erli.pl/svc/shop-api/doc/swagger.json`).

**Faktury** (zakładka Faktury, `InvoicesView.tsx`, `lib/invoices.ts`, `invoices.sql`, `app/api/invoices/{create,prefill}`) — wystawianie
faktur VAT w Fakturowni dla zamówień, które mają już KOMPLET: numer przesyłki (`sales_orders.tracking_number`) ORAZ numer
seryjny/IMEI na KAŻDEJ pozycji (`sales_order_items.serial_number`). Dostęp Admin, Manager i Zamówienia (`is_admin_or_manager()`
z `shipping.sql`, ta sama funkcja co w Wysyłce). **Wyzwalacz jest RĘCZNY, nie automatyczny** — świadoma decyzja właściciela
(01.10.2026): faktura to prawdziwy dokument księgowo-podatkowy, trudny do cofnięcia (korekta to osobny dokument, nie
usunięcie), więc nie generujemy jej bez przeglądu człowieka, nawet gdy warunki są spełnione. Układ listy wzorowany na dawnym
podglądzie faktur w Apilo (Numer dokumentu / Powiązane zamówienie / Data wystawienia / Data sprzedaży / Nabywca / Kwota
brutto / Status dokumentu) — na wyraźną prośbę właściciela.
- **Dwie pigułki:** *Do wystawienia* — zamówienia spełniające oba warunki, jeszcze bez faktury (widok `invoices_ready_orders`
  w `invoices.sql`: `tracking_number is not null` AND żadna pozycja z pustym `serial_number` AND brak wiersza w `invoices` —
  liczone raz po stronie bazy, nie w przeglądarce, bo `sales_orders`/`sales_order_items` mogą mieć tysiące wierszy; ten sam
  powód co stronicowanie w innych raw-listach). *Wystawione* — lista z tabeli `invoices` (kolumny jak w Apilo wyżej).
  `invoices_ready_orders` jest czytelny dla każdego `authenticated` (ten sam, szeroki dostęp co `sales_orders`/
  `sales_order_items` — nie dokłada nowej ekspozycji danych, tylko filtruje już czytelne tabele), ale sama tabela `invoices`
  (dane nabywcy, kwoty) jest już zawężona do `is_admin_or_manager()`, tak jak `shipments`.
- **"Wystaw fakturę →"** otwiera panel boczny z podglądem pozycji (produkt + SKU + numer seryjny + cena) i EDYTOWALNYM
  formularzem nabywcy — nie wysyła na ślepo. Wstępne wypełnienie (`app/api/invoices/prefill`, GET;
  `buildInvoiceBuyerPrefill` w `lib/invoices.ts`) czyta dane z surowej tabeli kanału (`bm_orders`/`refurbed_orders`/
  `allegro_orders`/`octopia_orders`/`erli_orders`). **Dla faktury czytamy inne pole niż dla wysyłki** — zgłoszone przez
  właściciela 01.10.2026 na żywym zamówieniu refurbed z firmą i NIP-em, które na karcie zamówienia
  (`SalesOrderCard.tsx`) nie pokazywały się wcale, bo adres do PACZKI i dane do FAKTURY to często osobne pola tego
  samego zamówienia — właściciel trafnie zauważył, że to wzorzec powtarzający się w większości kanałów, nie tylko w
  refurbed, więc sprawdzone systematycznie we WSZYSTKICH kanałach (bezpośrednio w danych z Supabase, nie zgadywane):
  - **refurbed**: `invoice_address` (NIE `shipping_address`) — pole `entity` rozstrzyga firma/osoba: `"COMPANY"` niesie
    `company_name`/`company_vatin` (np. `"EE102125100"`), `"MALE"`/`"FEMALE"` to osoba prywatna (`first_name`/
    `family_name`, bez NIP-u). `invoice_address` jest zawsze obecne (sprawdzone na 1000 zamówień — zero braków).
  - **Back Market**: `billing_address` (NIE `shipping_address`, choć adres zwykle identyczny — e-mail-przekaźnik ma
    inny prefiks, `invoice_...` vs `shipping_...`) — pola `company` i `customer_id_number` są NIEZALEŻNE od siebie i
    od pola z imieniem/nazwiskiem (sprawdzone: 34/1000 zamówień miało `company`, 12/1000 `customer_id_number`, różne
    podzbiory) — `customer_id_number` to numer identyfikacyjny podatkowy nabywcy (np. hiszpański NIF), NIE tylko dla
    firm: Hiszpania/Włochy wymagają go też od osób prywatnych.
  - **Allegro**: `invoice.required` mówi, czy kupujący w ogóle poprosił o fakturę (większość zamówień: nie — wtedy
    fallback na `buyer.address`/`buyer.firstName`/`buyer.lastName`/`buyer.companyName`, zwykle bez firmy). Gdy
    `true`, `invoice.address` ma ALBO `company` (`{ids, name, taxId}`) ALBO `naturalPerson` (`{firstName,
    lastName}`) — i to inny adres niż `buyer.address` (potwierdzone na żywym zamówieniu: różne miasta).
  - **Octopia**: `billingAddress` NA POZIOMIE ZAMÓWIENIA (nie `lines[].shippingAddress` — pierwsza wersja tej
    funkcji sprawdzała zły, zagnieżdżony poziom i stąd błędnie wyglądała jak "brak takiego pola"; poprawione przy
    tym samym zgłoszeniu) — zawsze obecne (880/880 sprawdzonych zamówień), ma `companyName`, ale bez osobnego numeru
    VAT/NIP mimo dokładnego przeszukania (pole `businessOrder` na poziomie zamówienia też istnieje, ale w całej
    próbce zawsze `false`, nawet przy wypełnionym `companyName` — nieprzydatne jako sygnał).
  - **Erli**: `user.invoiceAddress` istnieje TYLKO gdy kupujący poprosił o fakturę w Erli (sprawdzone: 81/834
    zamówień) — `type` to `"company"` (wtedy `companyName` + pole **dosłownie nazwane `nip`**) albo `"person"`
    (zwykłe imię/nazwisko, bez NIP). Gdy brak `invoiceAddress` (zdecydowana większość), fallback na
    `user.deliveryAddress` (tam `companyName` bywa ustawione niezależnie, jako nieformalna nazwa "u kogo", bez
    żadnego NIP-u — ten sam wzorzec co Back Market/Octopia).
  - **Amazon**: sprawdzone jeszcze raz pod kątem tego zgłoszenia — `IsBusinessOrder` istnieje jako pole, ale
    `BuyerInfo` jest ZAWSZE pustym obiektem w naszych danych (nawet dla jedynego znalezionego zamówienia
    biznesowego) — potwierdza już znane ograniczenie roli SP-API "Inventory and Order Tracking" bez dostępu do PII
    (patrz sekcja Wysyłka); żadnych nowych, dostępnych bez Restricted Data Token pól nie ma. Formularz zostaje pusty.
  Zweryfikowane bezpośrednio w `invoices.test.js` (scratchpad) na dosłownych kształtach pól z żywych zamówień (nie na
  wymyślonych fixture'ach) — jedyna rzecz, której NIE dało się sprawdzić na żywym API, to samo wystawienie faktury
  (brak kluczy Fakturowni w środowisku asystenta).
- **Stawka VAT jest jedna, stała dla wszystkich pozycji i kanałów** (`INVOICE_VAT_RATE` w `lib/invoices.ts`, 23% —
  świadoma decyzja właściciela 01.10.2026, BEZ logiki OSS per kraj nabywcy, mimo sprzedaży też do DE/ES/FR/IT i innych
  krajów UE) — jedna stała w kodzie, nie rozsiana, żeby ewentualne przejście na OSS było zmianą w jednym miejscu, nie
  polowaniem po repo. Cena pozycji = `sales_order_items.price` (już potwierdzona jako cena BRUTTO konsumencka przy
  dodawaniu kolumny "Cena" w Zamówieniach) wprost jako `total_price_gross`, `quantity` zawsze 1 (ten sam powód co w
  Zamówieniach: jedna pozycja = jedna sztuka, rozbite wcześniej z `quantity` > 1).
- **Jedna faktura na zamówienie** (`invoices` ma `unique (marketplace, external_id)`), NIE na pozycję — wszystkie sztuki
  zamówienia trafiają na jedną fakturę jako osobne pozycje: `name` = `sales_order_items.name` (prawdziwa nazwa produktu
  z marketplace'u, patrz sekcja Zamówienia wyżej — zgłoszone przez właściciela 01.10.2026, wcześniej było tylko
  `"Produkt {SKU}"`), `additional_info` = numer seryjny/IMEI. **SKU świadomie NIE jest wysyłane do Fakturowni**
  (na wyraźną prośbę właściciela 01.10.2026 — ani jako `code` pozycji, ani nigdzie indziej w payloadzie; `InvoicePosition`
  w `lib/invoices.ts` w ogóle nie ma już pola `code`). W panelu "Wystaw fakturę" (`InvoicesView.tsx`) SKU też usunięte
  z podglądu pozycji (zostaje tylko jako fallback wyświetlania, gdy `sales_order_items.name` jest puste — stare
  wiersze sprzed uzupełnienia nazwy produktu) — na liście "Pozycje" widać tylko nazwę produktu i numer seryjny/IMEI.
  Serwer sprawdza WSZYSTKO jeszcze raz przy wystawianiu (nie ufa przeglądarce): numer przesyłki, komplet numerów
  seryjnych, brak już istniejącej faktury — nawet jeśli UI pokazało zamówienie na liście "Do wystawienia".
- **Sprzedawca** = domyślny department konta Fakturowni (ten sam `FAKTUROWNIA_DOMAIN`/`FAKTUROWNIA_API_TOKEN` co
  `fakturownia/sync` w Magazynie — jedno konto, nie dodano nowych zmiennych środowiskowych). **Nabywca zawsze inline**
  (`buyer_name`/`buyer_tax_no`/...), NIGDY `client_id` — świadomie nie zakładamy osobnej kartoteki klienta w Fakturowni
  dla każdego kupującego z marketplace'u, to zaśmieciłoby listę kontrahentów setkami jednorazowych wpisów.
- **Numer wewnętrzny `ERP/{nr}/{MM}/{YYYY}`** (01.10.2026, na prośbę właściciela — żeby na liście faktur w
  Fakturowni od razu było widać, co przyszło z naszej appki, a co jest wystawione ręcznie w panelu Fakturowni).
  Wysyłany jako `invoice.number` wprost w żądaniu (dokumentacja: "Auto-generated if null" — czyli jawne podanie
  numeru nadpisuje auto-numerację Fakturowni dla tej jednej faktury, resztę kontrahenta to nie dotyczy). **Zeruje
  się co miesiąc** (świadoma decyzja właściciela, potwierdzona przez AskUserQuestion — alternatywa "narasta bez
  końca" odrzucona) — liczone wg daty WYSTAWIENIA (nie sprzedaży). Licznik: `invoice_number_counter` (klucz
  `period` = `"YYYY-MM"`) + funkcja `next_invoice_number(p_period)` w `invoices.sql` — atomowy upsert (`on conflict
  ... do update set last_number = last_number + 1 returning`), bezpieczny przy równoczesnych wystawieniach mimo że
  w praktyce to rzadkie (ręczny przycisk, jedna osoba na raz). Tabela licznika **bez żadnej polityki RLS** (jak
  `oauth_tokens` — niedostępna dla zalogowanych w ogóle, tylko `service_role`) — numeracja faktur nie powinna być
  osiągalna z przeglądarki żadną drogą. `formatErpInvoiceNumber(n, month, year)` w `lib/invoices.ts` tylko
  formatuje napis (miesiąc dopełniony zerem do dwóch cyfr); samą liczbę kolejną zawsze bierzemy z bazy, nigdy nie
  liczymy jej po stronie aplikacji (race condition przy dwóch równoczesnych kliknięciach).
- **Log zmian**: po sukcesie front-end (`InvoicesView.tsx`) dopisuje wpis do `sales_orders.history` przez RPC
  `sales_order_add_log` z sesji przeglądarki — ten sam wzorzec co przycisk "Zaakceptuj zamówienie" w `SalesOrderCard.tsx`
  (nie serwer — `by_email` bierze się z `session.user.email`, prościej niż dociąganie e-maila po stronie route'u).
- **Świadomie NIE zrobione:** synchronizacja statusu płatności z Fakturowni (`invoices.status` to dziś zawsze
  `'wystawiono'` zaraz po utworzeniu — kolumna ma też wartość `'zaplacone'`, ale nic jeszcze jej tam nie ustawia; wymaga
  osobnego wywołania API Fakturowni per faktura albo webhooka) i procedura OSS/VAT-marża (patrz wyżej). Obie rzeczy są
  świadomymi uproszczeniami pierwszej wersji, nie przeoczeniami.
- Nie testowane na żywym API Fakturowni (brak kluczy w środowisku asystenta) — zweryfikowane wg oficjalnej dokumentacji
  (`app.fakturownia.pl/api`, `github.com/fakturownia/api`), nie na atrapie `fetch` (brak czasu na testy jednostkowe przy
  pierwszej wersji tego modułu — właściciel powinien przetestować pierwsze kilka faktur na produkcji ostrożnie, najlepiej
  na mało istotnym zamówieniu, i porównać wynik w panelu Fakturowni z oczekiwaniem).

**AI — asystent do pytań o dane** (zakładka `ai`, `AiView.tsx`, `lib/aiAgent.ts`, `lib/aiSchema.ts`, `ai.sql`, `app/api/ai/ask`; 03.10.2026,
na prośbę właściciela). Okno, w którym wpisuje się polecenie po polsku (np. "wygeneruj raport sprzedaży za poprzedni miesiąc"), a model
Claude sam układa zapytania SQL do bazy i pisze odpowiedź (markdown: podsumowanie, tabele, "Uwagi i założenia"). **Dostęp: tylko Admin**
(decyzja właściciela "na tym etapie") — wymusza to serwer (`requireRole(["Admin"])`), nie tylko ukrycie zakładki (Admin może jej nie
nadać nikomu innemu; nadanie zakładki innej osobie w Zespole NIE da jej dostępu do API). **Zakres pierwszej wersji: sprzedaż, zamówienia, magazyn.**
**Wybrane podejście: dowolne zapytania SQL tylko do odczytu** (świadomie zamiast gotowych narzędzi per raport) — dlatego bezpieczeństwo
siedzi w bazie, nie w prompcie (`supabase/ai.sql`, cztery warstwy): (1) model widzi WYŁĄCZNIE widoki schematu `ai` — `ai.orders`,
`ai.order_items`, `ai.stock`, `ai.nbp_rates` — bez danych osobowych (adresy, nazwiska, e-maile, surowe odpowiedzi API, faktury z nabywcami,
tokeny, członkowie zespołu, historia zmian z e-mailami); (2) zapytanie wykonuje `ai_query(q)` jako rola `ai_reader` (nologin, tylko SELECT na
tych widokach) — funkcja jest zwykłym `security invoker` i przełącza rolę lokalnie (`SET ROLE` jest zabroniony w `security definer`; sprawdzone
testem); (3) transakcja READ ONLY, 15 s, 500 wierszy, tylko `SELECT`/`WITH`, jedna instrukcja (bez średników w środku); (4) `ai_query`
wolno wołać tylko `service_role`. Aliasy w opakowaniu to `__q`/`__t` — zwykłe `t`/`q` kolidowały z kolumnami zapytania i `jsonb_agg(t)`
zwracało kolumnę zamiast wiersza (znalezione testem). **Reguły liczenia siedzą w widokach, nie w prompcie**, żeby liczby zgadzały się z
Przeglądem: `is_counted` i `stage` to SQL-owe LUSTRO `isCountedOrder`/`statusBucket` z `lib/salesOrders.ts` (zmiana list statusów w TS wymaga
zmiany w `ai.sql` — test w repo porównuje oba po wszystkich statusach), `value_pln`/`price_pln` przeliczone kursem NBP z dnia poprzedniego (data
zamówienia w UTC jak w `overview/sales-stats`), `order_day_pl` = dzień wg Europe/Warsaw do grupowania. Prompt (`aiSchema.ts`) zawiera słownik
widoków, dzisiejszą datę wg Warszawy, zasady okresów ("ostatnie 30 dni" = 30 pełnych dni przed dzisiaj) i styl odpowiedzi; każda liczba ma
pochodzić z wyniku zapytania, a zamówienia bez ceny/kursu mają być policzone osobno i wymienione. **Przebieg:** `ai/ask` (maxDuration 300) woła
Anthropic Messages API zwykłym `fetch` (bez SDK; `ANTHROPIC_API_KEY`, model `AI_MODEL` albo `claude-sonnet-5-5`; prompt z `cache_control`),
pętla narzędzia `run_sql` do 12 kroków, błędy SQL wracają do modelu, który zwykle poprawia zapytanie. Cała rozmowa idzie w body (serwer nie
trzyma stanu między wywołaniami, a model przy pytaniach uzupełniających odpytuje bazę od nowa); od 03.10.2026 rozmowy są też zapisywane w historii (niżej). Pod każdą odpowiedzią
"Użyte zapytania do bazy (n)" do weryfikacji liczb oraz zużycie tokenów. **Każde pytanie ląduje w `ai_log`** (kto, pytanie, odpowiedź,
zapytania, model, tokeny, błąd) — audyt i kontrola kosztów; odczyt tylko Admin, zapis tylko serwer. **Licznik kosztów** (03.10.2026, na prośbę właściciela): pasek nad rozmową pokazuje koszt tej rozmowy i sumę od początku bieżącego miesiąca
z `ai_log` (Admin czyta `ai_log` wprost przez RLS), a pod każdą odpowiedzią "koszt ≈ $…" z podziałem tokenów (wejście / wyjście / cache zapis i odczyt).
Cennik w `lib/aiPricing.ts` (USD za 1M tokenów, wg strony cennika Anthropic z 03.10.2026: Sonnet 5.5 2/10, Opus 5.5 4/20, Fable 5.1 10/50, Haiku
4.5 1/5; cache: zapis 5-min 1,25x ceny wejścia, odczyt 0,1x — Opus 5.5 0,05x, Fable 5.1 0,025x) — **to SZACUNEK po stronie aplikacji, faktyczne
rozliczenie jest w konsoli Anthropic**; po zmianie modelu (`AI_MODEL`) albo cennika trzeba zaktualizować tabelę, a dla modelu spoza niej licznik
pokazuje "—" i tokeny, nie zgaduje. `input_tokens` z API NIE zawiera tokenów cache, dlatego agent zlicza `cache_creation_input_tokens` i
`cache_read_input_tokens` osobno (inne stawki). Koszt zapisywany w `ai_log.cost_usd` (+ `cache_write_tokens`/`cache_read_tokens`, kolumny
dodane w `ai.sql`); wiersze sprzed tej zmiany mają `cost_usd = null` i nie wchodzą do sumy. Waluta to USD (tak rozlicza Anthropic) — bez przeliczenia
na PLN (kursów USD nie synchronizujemy, `NBP_CURRENCIES` ma tylko EUR/DKK).
**Historia rozmów** (03.10.2026, na prośbę właściciela): lista "Historia rozmów" po lewej stronie okna (nowe "+ Nowa", otwarcie
klikiem, usuwanie "✕" z potwierdzeniem). Tabela `ai_conversations` (`ai.sql`): jedna rozmowa = jeden wiersz z całą wymianą w `messages`
(jsonb: pytania, odpowiedzi, użyte zapytania SQL, tokeny, koszt i model każdej odpowiedzi), tytuł = początek pierwszego pytania (80 znaków;
zmiany tytułu w UI nie ma, choć RLS pozwala na update własnego wiersza), `cost_usd` = suma kosztów rozmowy. **Każdy Admin widzi, zmienia tytuł
i usuwa TYLKO własne rozmowy** (`user_id = auth.uid()` + `is_admin()`); **zapis (utworzenie i dopisanie wymiany) robi wyłącznie serwer**
(`ai/ask` po udanej odpowiedzi — zero polityki insert, żeby przeglądarka nie mogła podrobić odpowiedzi "asystenta"). Klient przekazuje
`conversationId`; serwer dopisuje tylko do rozmowy należącej do wołającego (cudza/nieistniejąca = tworzy nową), a odpowiedź niesie
`conversationId` nowej rozmowy. Nieudana odpowiedź nie zapisuje wymiany do historii (błąd i tak trafia do `ai_log`). Przy pytaniach
uzupełniających model dostaje tekst poprzednich wiadomości, ale NIE ich surowe wyniki SQL (odpytuje bazę od nowa). Użytkownik usunięty z
Auth traci rozmowy (`on delete cascade`, inaczej niż historia pracy w innych modułach — to dane osobiste, nie ewidencja).
**Świadomie NIE zrobione:** zapisywanie
raportów/eksport do pliku (jest "Kopiuj"), streaming odpowiedzi, dostęp dla innych ról, zakres Zespół/Faktury/Wysyłki
(wymaga dodania kolejnych widoków `ai.*` BEZ danych osobowych), wykresy w odpowiedziach. Brak marży per zamówienie — nie mamy kosztów zakupu per
zamówienie ani prowizji marketplace'ów, prompt każe tego nie wymyślać. Nie testowane na żywym API Anthropic (brak klucza w środowisku
asystenta) — pętla zweryfikowana na atrapie `fetch`, warstwa SQL w PGlite (odmowa dostępu do `members`/tabel/zapisu/średników).

**Marża** (zakładka `margin`, `MarginView.tsx`, `lib/margin.ts`, `margin.sql`, `app/api/margin/{list,summary,bm-invoice}`; 03.10.2026, na prośbę właściciela; Admin i Manager).
Lista SPRZEDANYCH sztuk z wprowadzonym numerem seryjnym/IMEI (jedna pozycja zamówienia = jeden wiersz, jak w Zamówieniach, ale kolumny finansowe) z marżą po kosztach:
Data, Marketplace, Nr zamówienia (link do karty), Numer seryjny (link do karty produktu, 05.10.2026), SKU, Cena sprzedaży (PLN + oryginał), Cena zakupu, VAT od marży, Wysyłka, Koszty dodatkowe, Prowizja, Serwis, Marża, Marża %;
pod tabelą podsumowanie całego wyniku filtra (marża łącznie, marża %, **średnia marża na produkcie** = marża łączna ÷ liczba pozycji z policzoną marżą; sprzedaż/zakup/koszty usunięte z podsumowania 04.10.2026 na prośbę właściciela — widać je w wierszach i po rozwinięciu), filtry Wszystkie/Back Market/Refurbed, wyszukiwarka (numer seryjny, zamówienie, SKU), stronicowanie 25/50/100.
**Zakres: Back Market, refurbed i (od 05.10.2026) Octopia** (decyzja właściciela — tam mamy rzetelne źródło prowizji; Allegro/Erli/Amazon dojdą po ustaleniu prowizji), tylko zamówienia liczone jako sprzedaż (`isCountedOrder`, bez anulowanych/zwróconych).
**Towary na V23 (06.10.2026) liczą się innym wzorem** — patrz "Pozycje ręczne w magazynie" w sekcji Magazyn (zakup netto, VAT należny od pełnej ceny); poniższy wzór dotyczy pozostałych sztuk.
**Wzór (decyzja właściciela):** Marża = cena sprzedaży (PLN, brutto) − cena zakupu − **VAT od marży** − wysyłka − koszty dodatkowe − prowizja − serwis, gdzie **VAT od marży = (cena sprzedaży − cena zakupu, BEZ kosztów dodatkowych) × 23/123**, nigdy ujemny.
Źródła: **cena sprzedaży** — `sales_order_items.price` przeliczona kursem NBP z dnia poprzedniego względem daty zamówienia; **cena zakupu** — cena zakupu sztuki z Fakturowni po numerze seryjnym
(bez rozróżniania wielkości liter; przy odkupie tego samego numeru bierzemy zakup SPRZED zamówienia); **wysyłka** — cena DHL z wyceny zapisana przy nadaniu (jak na karcie zamówienia), a gdy jej nie ma, ręczny `shipping_cost`;
**koszty dodatkowe** — Trade-in (prowizja BM + logistyka wg regulaminu + PCC, `lib/buybackCosts.ts`) po numerze zamówienia z opisu sztuki w Fakturowni; sztuka spoza Trade-in ma 0; **serwis** — koszt części przypisanych do numeru seryjnego (Serwis -> Części, od 04.10.2026; patrz sekcja Serwis). Koszty poziomu ZAMÓWIENIA (wysyłka, opłaty z faktury BM) dzielone na pozycje proporcjonalnie do ceny pozycji.
**Brakujące składniki:** marża nie jest liczona (— i flaga), gdy brak ceny sprzedaży/kursu NBP albo ceny zakupu; brak wysyłki/prowizji liczy się jako 0, ALE wiersz dostaje ⚠ z listą braków (najechanie), a podsumowanie liczy takie pozycje i podaje ich liczbę.
**Fakturownia: historia zakupów.** `fakturownia_stock_cache` trzyma tylko sztuki ze stanem 1 i KASUJE sprzedane, więc cena zakupu sprzedanej sztuki przepadała. Synchronizacja (`fakturownia/sync`) zapisuje teraz WSZYSTKIE produkty także do
`fakturownia_purchases` (też sprzedane, ze `stock_level`); `margin.sql` jednorazowo kasuje `last_synced_at`, więc najbliższe "Odśwież" w Magazynie robi pełny skan (~minuta) i wypełnia tabelę — **do tego czasu zakładka Marża pokazuje "brak ceny zakupu"**.
**Pobieranie historii zakupów (03.10.2026, poprawka):** `fakturownia_purchases` zapisuje produkty utworzone od **01.01.2025** (`PURCHASES_FROM` w `fakturownia/sync`; sam skan Fakturowni
dalej obejmuje cały katalog, bo cache magazynu musi widzieć też starsze sztuki wciąż leżące w magazynie). Tabela jest PUSTA, dopóki nie przejdzie pełna synchronizacja — zakładka Marża pokazuje wtedy czerwony komunikat i przycisk
**"Pobierz z Fakturowni"** (woła `fakturownia/sync`, a przy pustej tabeli z `?full=1`, które wymusza pełny skan mimo zapisanej daty ostatniej synchronizacji); odpowiedź niesie `purchasesSaved`. Błąd zapisu do `fakturownia_purchases`
przerywa synchronizację i jest widoczny (połykamy wyłącznie BRAK tabeli, czyli nieuruchomione `margin.sql`). Zakładka pokazuje też, ile produktów mamy w historii zakupów.
**Filtr okresu** (03.10.2026, na prośbę właściciela; przyciski obok filtrów marketplace'ów, rozdzielone kreską): **Cały okres** (domyślnie) / **Bieżący miesiąc** / **Ubiegły miesiąc** (w podpowiedzi nazwa miesiąca). To miesiące KALENDARZOWE
wg czasu polskiego (`periodRange`/`inPeriod` w `lib/margin.ts`, parametr `period` route'a `margin/list`), liczone po dacie zamówienia w czasie polskim — zamówienie z 1. dnia miesiąca o 00:30 czasu polskiego należy do tego miesiąca (w UTC byłoby jeszcze w poprzednim);
styczeń → ubiegły = grudzień poprzedniego roku. Filtr działa razem z marketplace'em i wyszukiwarką, a podsumowanie pod tabelą liczy się dla wybranego okresu.
**Kolumna i filtr "Kategoria z SKU" (07.10.2026, na prośbę właściciela):** kolumna zaraz po "SKU" = pierwszy człon SKU przed pierwszym myślnikiem (`skuCategoryOf` w `lib/margin.ts`, np. `XSX-1TB-BK-B-1M` -> `XSX`; ta sama zasada co `sku_category` w Magazynie), liczona z SKU **zamówienia** (`sales_orders`/pozycja), nie z SKU magazynowego sztuki. Obok wyszukiwarki lista rozwijana "Kategoria z SKU: wszystkie" z licznikami (np. `PS5 (120)`) i opcją "Bez SKU"; filtr działa łącznie z marketplace'em, okresem i wyszukiwarką (parametr `skuCategory` route'a `margin/list`), a podsumowanie pod tabelą liczy się dla wybranej kategorii. Liczniki odzwierciedlają pozostałe filtry, ale NIE sam filtr kategorii (wybór jednej nie zawęża listy do niej). Bez zmian w bazie.
**Rozwijane wyliczenie marży** (03.10.2026, na prośbę właściciela): na końcu każdego wiersza przycisk ▸/▾ rozwija pod nim szczegółowe wyliczenie — tabela składników (znak + / − / =, kwota w zł i **opis skąd się wzięła**):
cena sprzedaży (cena w walucie × kurs NBP z datą notowania), cena zakupu (z Fakturowni, z numerem zamówienia/dokumentu), VAT od marży (wzór z liczbami), wysyłka (DHL z wyceny albo ręczny koszt, z udziałem pozycji przy wielu pozycjach w zamówieniu),
koszty dodatkowe (Trade-in: cena po kontrofercie → prowizja BM 10% + logistyka z kategorią + kurs i data + PCC z wartością zakupu w zł; albo "zakup nie z Trade-in"), prowizja marketplace'u (z faktury BM: prowizja + opłata płatnicza + CCBM; SZACUNEK: stawka z reguły
z uzasadnieniem — np. "konsola do FR w okresie programu Accelerator" — + opłata płatnicza + CCBM; refurbed z danych zamówienia), koszty serwisu ("jeszcze nieuwzględniane") i wynik "= Marża". Pod tabelą lista ostrzeżeń (⚠ — czego brakuje). Opisy buduje serwer razem z liczeniem
(`MarginDetail`/`details` w `computeMargin`, `lib/margin.ts`; kwoty w szczegółach są tymi samymi liczbami co w wierszu — test to pilnuje), więc UI niczego nie przelicza; stan rozwinięcia jest tylko w przeglądarce.
**Szacunek prowizji BM idzie WG REGUŁ, nie wg średniej (zmiana 03.10.2026, po informacji właściciela o programie Accelerator):** w faktach prowizja okazała się zależna od kraju, okresu i rodzaju produktu — właściciel uczestniczy w
**Accelerator for Sellers** (zaproszenie BM): **obniżka prowizji o 5 pkt proc. na KONSOLACH sprzedawanych do FR/DE/ES/IT w okresie 15.08–31.12.2026**, bez konsol retro, gier i akcesoriów konsolowych, bez łączenia z innymi ofertami w tej kategorii.
Reguły (`bmCommissionPct`/`bmKind` w `lib/margin.ts`): **konsole 11% standardowo (art. 15.1 regulaminu, "pozostałe produkty") → 6% w programie** (kraj odbiorcy FR/DE/ES/IT i data zamówienia 15.08–31.12.2026; poza tym 11%); **akcesoria konsolowe (pady, Joy-Cony) 20%** zawsze;
**pozostałe (aparaty, zegarki, telefony) 11%** (stawek 10% MacBooki i 12% smartfony ES/FR z regulaminu nie rozróżniamy — poza zakresem listy). Do tego opłata płatnicza (średnia z faktur albo 1% z regulaminu) i stała opłata CCBM za pozycję (średnia z faktur
osobno dla akcesoriów i reszty albo 6,99 €/1,99 € z regulaminu). **Sprawdzone na 707 zamówieniach z faktur dopasowanych do naszej bazy po kraju i dacie: reguły trafiają w stawkę co do grosza w 98,7% zamówień, a suma prowizji różni się o 0,63%** (niezgodne to głównie zamówienia z mieszanymi pozycjami).
Szacunek działa TEŻ BEZ wgranych faktur (wartości z regulaminu); po 31.12.2026 konsole wracają automatycznie do 11% (program trzeba przedłużyć stałą `BM_ACCELERATOR.to`, gdy BM go przedłuży). Kraj to `sales_orders.country_code` (adres dostawy), data to data zamówienia. Dokładne wartości z faktury
(dla zamówień na wgranych fakturach) mają pierwszeństwo przed szacunkiem. Poniższy opis średnich dotyczy już tylko opłaty płatniczej i CCBM, a "średnia prowizja" w `BmRates.commissionPct` służy wyłącznie podglądowi.
**Smartwatche w rozszerzonym programie Accelerator (05.10.2026, mail BM "Commission reduction is extended"):** **0% prowizji** od **01.09 do 30.11.2026** dla smartwatchy sprzedawanych do **FR/DE/ES/IT**; **NIE dotyczy zegarków Apple** — Apple Watch ma SKU zaczynające się od `AW`, po tym je odróżniamy (dodatkowo wyłączamy nazwy z "Apple"). Rodzaj `smartwatch` w `bmKind` (`lib/margin.ts`, `BM_ACCELERATOR_SMARTWATCH`, `isNonAppleSmartwatch`): nazwa z "watch"/"montre"/"uhr"/"reloj"/"orologio"/Fitbit/Garmin/Amazfit, bez słów akcesoriów
(kabel/ładowarka/pasek/etui) i bez Apple; konsole sprawdzane PIERWSZE (tytuł zestawu z grą "Watch Dogs" nie robi z konsoli zegarka). Poza okresem/krajami — standardowe 11%. Opłata płatnicza (1%) i stała CCBM zostają jak dla pozostałych produktów. Na danych: 53 z 6142 pozycji BM to smartwatche nie-Apple (Samsung Galaxy Watch, SKU `SGW…`); kabel Apple Watch (`A2515`) i Apple Watch (`AW…`) zostają 11%.
**Ten sam mail wymienia Apple Pencil: 5% prowizji — NIE zaimplementowane** (właściciel podał tylko smartwatche; nie wiemy, jakie SKU ma Apple Pencil). Dotyczy to wyłącznie SZACUNKU (zamówienia bez wgranej faktury); faktura BM ma pierwszeństwo.
**Prowizja Back Market (z faktur):** właściciel wgrywa tygodniowe faktury CSV (`invoice_YYYYMMDD-EU-H-*.csv`, przycisk "Wgraj fakturę BM (CSV)", wiele plików naraz; numer faktury z nazwy pliku, ponowne wgranie nie dubluje — klucz `(invoice_ref, line_no)`) do `bm_invoice_lines`.
Sprawdzone na 3 prawdziwych fakturach (sumy z CSV zgadzają się z PDF-ami co do grosza): **prowizja NIE jest stała** — na zamówieniu 6%, 11% albo 20% (akcesoria) sprzedaży, do tego **opłata płatnicza 1%** i **stała opłata CCBM za pozycję** (6,99 € dla konsol, 1,99 € akcesoria, 6,49 €), a "Platform Adjustment" (dynamiczne ceny) faktura sama kompensuje wpisem w portfelu (pomijamy go jako kosztem neutralny; netto lekko dodatni).
Faktury są bez VAT (odwrotne obciążenie, "AE"). Liczymy **dokładnie z faktury** dla zamówień na niej (prowizja + opłata płatnicza + CCBM zsumowane z kilku faktur po `order_id`; gdy CCBM jeszcze nie fakturowano — średnia stała), a **dla pozostałych szacujemy** (patrz wyżej: reguły; średnie z `deriveBmRates` tylko dla opłaty płatniczej i CCBM:
ostatnie 8 tygodni faktur, tylko zamówienia sprzedane i niezwrócone; na dzień wdrożenia z 3 faktur ≈ 7,1% prowizji + 1,0% płatności + ≈ 6,2 € CCBM za pozycję, z 635 zamówień) — szacunek oznaczony w tabeli "szacunek", średnie aktualizują się same przy kolejnym wgraniu faktury ("aktualizowane co tydzień" wg decyzji właściciela).
Miesięczna opłata abonamentowa BM (75 €) i korekty/credit notes nie są rozdzielane na zamówienia. **refurbed:** prowizja wprost z danych zamówienia (`settlement_total_commission` pozycji = baza + płatność + dynamiczna, w walucie rozliczenia, przeliczana NBP).
Widok `margin_items` czyta tabele z danymi finansowymi, więc jest dostępny TYLKO dla `service_role`; route `margin/list` wpuszcza Admina i Managera i liczy wszystkie wiersze naraz po stronie serwera (stronicowanie/sumy na wyniku). Kursy NBP muszą sięgać stycznia 2026 ("Odśwież" w zakładce NBP).

**Marża — Octopia (05.10.2026, na prośbę właściciela):** trzeci kanał w Marży (`MARGIN_MARKETPLACES`: Back Market, refurbed, Octopia; pigułka "Octopia", kolor fioletowy na wykresie Przeglądu). **Prowizja wprost z danych zamówienia** (`lines[].offerPrice.commission`: `rate` w SETNYCH procenta — 800 = 8%, 1000 = 10% — oraz `amountWithVat`/`amountWithoutVat`, zawsze równe, bo VAT od prowizji = 0; waluta zamówienia, u nas EUR) —
nie szacujemy: pole jest w 902 z 906 zapisanych pozycji (brakuje tylko 4 pozycji anulowanych/dostarczonych bez wyliczenia). **Sprawdzone na wszystkich 902 liniach: kwota = `rate` × (cena × ilość + koszt dostawy zapłacony przez kupującego)** — 816 pozycji zgadza się z samą ceną, a 86 (z płatną dostawą) z ceną plus dostawą co do grosza, więc Octopia nalicza prowizję także od dostawy.
Kwota dotyczy CAŁEJ pozycji, więc na sztukę dzielimy ją przez `quantity`; sztuki rozbite z ilości > 1 (klucze `id`, `id-2`…) łączymy z pozycją po `orderLineId` (widok `margin_items`, kolumny `octopia_commission`/`octopia_commission_currency` — uruchom ponownie `margin.sql`). Przeliczenie na PLN kursem NBP z dnia poprzedniego, jak przy refurbed. Częste stawki: 10% (471 pozycji), 8% (423), pojedyncze 7/9/15/17%.
**`serviceFees` ("Frais de traitement", ok. 13 € na zamówienie) to opłata płacona przez KUPUJĄCEGO** (cena kupującego `sellingPrice` jest o nią wyższa od `offerPrice`, którą dostaje sprzedawca) — nie jest naszym kosztem i nie wchodzi do marży. Koszt dostawy zapłacony przez kupującego (przychód) nie jest doliczany do ceny sprzedaży — tak samo jak w pozostałych kanałach (prowizja od niego jest jednak w kwocie prowizji).
**Kolumna "Marża netto" (05.10.2026, na prośbę właściciela):** `netMarginPln` w `computeMargin` = **cena sprzedaży − cena zakupu − VAT od marży**, czyli marża PRZED kosztami wysyłki, dodatkowymi, prowizją i serwisem (kolumna zaraz po "VAT od marży", przed "Wysyłka"). Nie do policzenia (—), gdy brak ceny sprzedaży/kursu albo zakupu; gdy sprzedaż nie przekracza zakupu, VAT od marży = 0, a marża netto bywa ujemna. W rozwijanym wyliczeniu jest jako wiersz sumy "= Marża netto" po VAT, a w podsumowaniu pod tabelą "Marża netto łącznie" (`totals.netMargin`). Pełna "Marża" i "Marża %" zostają bez zmian.
**Punktacja pracowników (zakładka `points`, 06.10.2026, na prośbę właściciela — "podsumowanie punktacji zgodne z regulaminem, na razie tylko dla Admina"; `PointsView.tsx`, `lib/points.ts`, `GET /api/points/summary`):** miesięczne zestawienie punktów każdego pracownika z **Serwisu** ("naprawiony"), **Testów** ("przetestowane") i **Trade-in** (obsłużona/kontroferta/ok. dok./problem) — **tylko prawidłowo zakończone procesy** (Regulamin §2 ust. 4), **każda paczka/urządzenie raz** (miesiąc = data PIERWSZEGO zaliczenia `points_awarded_at`, zmiana statusu go nie przesuwa — patrz "Punktacja liczona tylko raz"),
**obszary sumują się w jeden wynik miesięczny** (§2 ust. 6). Widok: pigułki ostatnich 6 miesięcy (domyślnie bieżący), kafelki (razem + każdy obszar z liczbą sztuk), tabela pracowników posortowana malejąco po punktach (punkty i w nawiasie liczba sztuk per obszar, kolumna "Razem", pasek udziału, **mini-wykres słupkowy z 6 miesięcy**), rozwijane rozbicie napraw wg typu czynności.
Miesiące KALENDARZOWE wg czasu polskiego (`monthRange` w `lib/points.ts`, uwzględnia zmianę czasu — październik zaczyna się 30.09 o 22:00 UTC, a kończy 31.10 o 23:00 UTC; test). **Admin i Manager także po stronie serwera** (`requireRole(["Admin", "Manager"])`, od 06.10.2026 — początkowo tylko Admin), nie tylko ukrycie zakładki. Bez nowego SQL (przed uruchomieniem `points_awarded_at` w tabelach awaryjnie po `finished_at` — widać ostrzeżenie).
**Czego NIE ma (świadomie):** kolumna "Zwroty" (17 pkt — zakładka Zwroty to szkielet) i **wszystko oparte na godzinach pracy** — wydajność pkt/h, norma 45 pkt/h (§4), wskaźnik kwalifikacyjny 80% (§6), kwota premii wg §5 (200 zł przy 45 pkt/h do 1500 zł przy ≥100 pkt/h) i proporcjonalne rozliczenie niepełnego miesiąca (§7) — brak ewidencji czasu (RCP); dokładnego wzoru interpolacji między 200 a 1500 zł nie mamy w kodzie.
Pierwsze realne liczby za 10.2026 (6.10): 12 osób, od 40 do 665 pkt, przy czym Serwis/Testy/Trade-in zwykle prowadzą inne osoby (kilka osób ma punkty w dwóch obszarach).
**Wykres marży na Przeglądzie** (`OverviewMarginChart.tsx`, `GET /api/margin/summary`; 03.10.2026, na prośbę właściciela) — pod dashboardem sprzedaży: kafelki **Łączna marża**, **Średnia marża (% sprzedaży)** (= łączna marża ÷ suma sprzedaży z tych samych pozycji), **Średnia marża na sztukę** i **Sprzedane sztuki z marżą** (z liczbą pozycji z ⚠ niepełnymi kosztami) oraz poziome słupki marży per marketplace (tylko Back Market i refurbed, bo tylko tam znamy prowizje; ujemna marża w kolorze rust). Pigułki okresu: Bieżący miesiąc (domyślnie) / Ubiegły miesiąc / Cały okres — miesiące wg czasu polskiego, jak w zakładce Marża. Serwer liczy wszystkie trzy okresy naraz (przełączanie bez ponownego zapytania). **Liczby pochodzą z tego samego kodu co zakładka Marża** — wspólny `lib/marginServer.ts` (`loadMarginResults` + `aggregateMargin`), `margin/list` też z niego korzysta; do sum wchodzą tylko pozycje z policzoną marżą (brak ceny sprzedaży/zakupu = poza sumą). Route tylko Admin/Manager (403 -> sekcja się w ogóle nie pokazuje, np. gdy Admin dał komuś Przegląd bez uprawnień do marży). Koszty serwisu (części z Serwis -> Części) są w marży od 04.10.2026.

**RCP — rejestracja czasu pracy (06.10.2026, etap 1; `RcpView.tsx`, `RcpWidget.tsx`, `lib/rcp.ts`, `lib/rcpServer.ts`, `supabase/rcp.sql`, `app/api/rcp/{state,action,settings,edit,close-stale}`).** Moduł ma być prosty i czytelny; zakładka RCP widoczna dla wszystkich ról. **Widżet na górze lewego paska bocznego** (od 06.10.2026, na prośbę właściciela; początkowo w prawym górnym rogu; każda zakładka, każda osoba z rolą): zegar i **jeden duży przycisk, którego kolor mówi o stanie — czerwony gdy nie pracujesz, zielony gdy pracujesz, pomarańczowy gdy przerwa (lub wyjście)**, z napisem ("▶ Rozpocznij pracę" / "● W pracy · Serwis" / "⏸ Przerwa") i licznikiem czasu bieżącego odcinka. **Stan trwającego odcinka widżet czyta wprost z bazy przez RLS (własny wiersz, to samo co lista "Teraz w pracy"), a z `api/rcp/state` bierze tylko adres IP i ograniczenie do biura** (poprawka 06.10.2026: widżet pokazywał czerwony "Rozpocznij pracę", gdy w bazie trwał odcinek — odpowiedź z serwera nie odświeżała stanu; po każdej akcji stan ustawia się od razu z odpowiedzi serwera; błąd pobrania stanu jest widoczny pod przyciskiem). Zakończenie pracy potwierdza się w menu ("Tak, zakończ"), nie oknem `confirm()` przeglądarki, które da się wyłączyć. Kliknięcie otwiera menu akcji dla stanu: poza pracą — wybór obszaru (Serwis, Testy, Trade-in, Magazyn, Zamówienia, Inne; pierwszy na liście wg roli; pracownik MUSI się zarejestrować, żeby pracować w danym obszarze); w pracy — **Przerwa**, **Wyjście służbowe**, **Wyjście prywatne**, **Zmień obszar ›**, **Zakończ pracę** (z potwierdzeniem); w przerwie/wyjściu — **Wróć do pracy**, Zakończ pracę. Pod przyciskiem link "Mój czas ›" otwiera zakładkę RCP.
**Model:** czas to ODCINKI (`rcp_segments`: `praca`/`przerwa`/`wyjscie_prywatne`/`wyjscie_sluzbowe`, `started_at`/`ended_at`, `area`, `ip`, `needs_review`, `source` app/manual, `history` korekt); pracownik ma najwyżej JEDEN otwarty odcinek (indeks częściowy); **do czasu pracy liczą się praca i wyjścia służbowe**, przerwy i wyjścia prywatne nie. Dni liczone wg czasu polskiego (odcinek przez północ dzieli się na doby; zmiana czasu uwzględniona — doba 25.10.2026 ma 25 h; test). Zmiany stanu robi **atomowa funkcja bazy `rcp_act`** (blokada na pracownika, zegar serwera, błędy po polsku) wołana TYLKO przez serwer (`api/rcp/action`, service_role); tabela nie ma polityk zapisu, więc nikt nie wpisze sobie czasu z przeglądarki. **Zaległe odcinki** (nikt nie kliknął "Zakończ") to takie, które trwają od poprzedniego dnia (wg czasu polskiego) **i dłużej niż 10 godzin** — zamyka się je o 23:59:59 dnia rozpoczęcia i oznacza `needs_review` (⚠); **warunek wieku (poprawka 07.10.2026) chroni pracę przez północ** (np. 23:20–01:30) — pierwsza wersja zamykała każdy odcinek z "wczoraj" zaraz po 00:00, więc pracownik pracujący po północy nie mógł przerwać ani zakończyć pracy ("Nie masz rozpoczętej pracy"), a dane znikały z widżetu — przy każdej akcji/odczycie stanu danej osoby oraz cronem `api/rcp/close-stale` (`vercel.json`, 23:30 UTC).
**Tylko komputery w firmie (decyzja właściciela 06.10.2026):** serwer sprawdza adres IP klienta (`x-forwarded-for` Vercela) względem listy `rcp_settings.allowed_ips`; poza listą akcje są odrzucane (widżet pokazuje zablokowane przyciski i wyjaśnienie z adresem). **Pusta lista = bez ograniczenia** (żeby nikt nie został zablokowany, zanim Admin ją ustawi). Admin ustawia ją w RCP -> Ustawienia, najprościej otwierając stronę z komputera w biurze i klikając "Dodaj adres tego komputera" (publiczny adres całej sieci firmy obejmuje wszystkie komputery w biurze; po zmianie dostawcy internetu trzeba go zaktualizować). Obejmuje też Admina/Managera przy własnej rejestracji; korekty cudzego czasu mogą iść z dowolnego miejsca. Ograniczenie po IP jest zabezpieczeniem organizacyjnym, nie kryptograficznym (adres może się zmienić, VPN firmowy da ten sam adres).
**Pracownik** ("Mój czas"): kafelki (dziś praca/przerwy, miesiąc, dni pracy), oś odcinków dzisiaj, tabela dni miesiąca (początek, koniec, praca, przerwy, wyjścia prywatne, obszary; nawigacja po miesiącach). **Widzi tylko swoje** (RLS `user_id = auth.uid()`, decyzja właściciela). **Admin i Manager** dodatkowo: **"Teraz w pracy"** (kafelki i lista: kto pracuje / przerwa / zakończył / nie rozpoczął, od kiedy, w jakim obszarze, ile dziś; odświeżanie co 30 s), **"Ewidencja"** (miesiąc: osoba × dzień w godzinach h:mm, weekendy podświetlone, suma, ⚠ przy wpisach do sprawdzenia, **eksport CSV** średnikami z BOM do Excela; klik w komórkę = szczegóły dnia z historią korekt, **"Popraw"** i **"+ Dodaj brakujący wpis"** — korekta wymaga uzasadnienia i trafia do `history` odcinka, bez nakładania się na inne wpisy tej osoby, bez przyszłości; po korekcie wpis przestaje być ⚠; `api/rcp/edit`), **"Mój czas"** i **"Ustawienia"**. **Usuwanie wpisu tylko Admin** (polityka + `audit_delete` -> `deleted_records`). Manager nie usuwa i nie zmienia ustawień (`rcp_is_manager()` = Admin lub Manager — nie rola Zamówienia, w odróżnieniu od `is_admin_or_manager()` z shipping.sql).
**Decyzje odłożone na później (właściciel):** forma zatrudnienia a nadgodziny (Kodeks pracy tylko dla umowy o pracę — dla zlecenia same godziny?) i czy przerwa jest płatna (dziś NIE wlicza się do czasu pracy). **Jeszcze nie zrobione (kolejne etapy):** grafik i porównanie z rzeczywistością (spóźnienia, wcześniejsze wyjścia, "+17 min"), korekty zgłaszane przez pracownika (dziś poprawia Manager), nadgodziny dobowe/tygodniowe, praca w dni wolne/niedziele/święta, **punkty na godzinę** (każda sesja ma obszar, więc da się liczyć pkt/h per obszar i dokończyć wydajność/premię z regulaminu — plan rozwoju, punkt 8). Wymaga uruchomienia `rcp.sql`; do tego czasu widżet się nie pokazuje, a zakładki RCP mówią, że brakuje tabel. Nie testowane w przeglądarce z prawdziwym logowaniem (brak sesji w środowisku asystenta) — zweryfikowane testami logiki (`rcp.ts`: odcinki, doby, DST, IP, CSV), testem bazy w PGlite (przejścia `rcp_act`, jeden otwarty odcinek, zamykanie zaległych, RLS, usuwanie) i pełnym `next build`.

**RCP — wnioski urlopowe i nieobecności (07.10.2026, etap 3; `RcpAbsences.tsx`, `lib/rcpAbsence.ts`, `lib/holidays.ts`, `app/api/rcp/absence`, tabele `rcp_absences` i `rcp_leave_balances` w `rcp.sql`).** **Pracownik** (pigułka "Urlopy"): saldo (limit / wykorzystano / oczekuje / pozostało, wybór roku), formularz wniosku (rodzaj, od–do, uwagi; podgląd liczby dni roboczych) i lista własnych wniosków ze statusem, decyzją i przyciskiem "Wycofaj" (tylko oczekujące). **Admin i Manager** (pigułka "Wnioski (n)", n = oczekujące): wnioski do rozpatrzenia z informacją, kto jeszcze jest wtedy nieobecny (zaakceptowani i oczekujący), "Zatwierdź" / "Odrzuć" (powód wymagany), **dodawanie nieobecności za pracownika** (np. L4; od razu zaakceptowana, przekroczenie limitu to tylko ostrzeżenie), historia z filtrem osoby i statusu oraz "Anuluj" dla zaakceptowanych (powód wymagany), tabela limitów. **Rodzaje:** urlop wypoczynkowy (U), na żądanie (UŻ), okolicznościowy (UO), bezpłatny (UB), L4, inna (N); **do limitu zaliczają się tylko wypoczynkowy i na żądanie** (zaakceptowane + oczekujące). **Dni robocze** = pn–pt bez polskich świąt (`lib/holidays.ts`: stałe + Wielkanoc/Zielone Świątki/Boże Ciało; **24.12 wolny od 2025**), liczone przez serwer, urlop przez Nowy Rok liczy się do limitu roku, w którym przypadają dni. **Limit urlopowy ustawia ręcznie Admin** per osoba i rok (tabela "Limity", `rcp_leave_balances`; bez wpisu wniosek nie jest sprawdzany pod kątem limitu — decyzja domyślna, bo właściciel nie wskazał liczenia automatycznego z wymiaru/stażu). **Zasady:** nakładające się aktywne nieobecności tej samej osoby blokuje trigger w bazie; początek nie wcześniej niż 60 dni wstecz, okres max 120 dni i min. 1 dzień roboczy; **Manager nie rozpatruje własnego wniosku (robi to Admin; Admin może własny)**; zapis wyłącznie przez serwer (tabele bez polityk zapisu, poza limitami dla Admina), odczyt: pracownik swoje, Admin/Manager wszystkie, usuwanie tylko Admin z audytem; każda akcja dopisuje się do `history`. **Ewidencja** pokazuje kody nieobecności w pustych komórkach dni (podpowiedź z nazwą), weekendy i święta mają szare tło, CSV zawiera te same kody. **Powiadomienia tylko w aplikacji** (licznik na pigułce "Wnioski", status widoczny u pracownika) — bez e-maili (nie było decyzji). **Nie zrobione:** grafik i godziny planowe (nieobecność nie zmienia jeszcze normy czasu), wymiar urlopu liczony z umowy/stażu, nieobecności niewliczane do godzin przy braku grafiku. Wymaga ponownego uruchomienia `rcp.sql`. Zweryfikowane testami logiki (dni robocze/święta/wykorzystanie limitu), bazy w PGlite (RLS, nakładanie, limity tylko Admin, audyt) i `tsc`; interfejs nie był klikany z prawdziwym logowaniem.

**RCP — prace administracyjne kierowników (07.10.2026, na prośbę właściciela — "rozpoczyna i zatrzymuje się ten czas podobnie jak przerwę").** Nowy rodzaj odcinka `administracja` (`rcp_segments.kind`, akcja `admin` w `rcp_act`): w menu widżetu pozycja "🗂 Prace administracyjne" obok Przerwy (tylko w trakcie pracy), przycisk robi się niebieski, a "Zakończ prace administracyjne" (= `resume`) wraca do pracy w tym samym obszarze; z administracji nie da się zacząć przerwy ani wyjścia (najpierw wróć do pracy), można zakończyć dzień. **Kto:** `ADMIN_WORK_ROLES` w `lib/rcp.ts` — Admin, Manager, Kierownik serwisu i Kierownik trade-in; pilnuje serwer (`api/rcp/action`, 403 dla innych). **Czas administracji LICZY SIĘ do czasu pracy** (to płatna praca, w przeciwieństwie do przerwy), ale jest wykazywany osobno: `adminMs` w podsumowaniu dnia, kolumna "w tym admin." w "Mój czas" (pojawia się, gdy są takie wpisy) i obszar "Administracja" w rozbiciu obszarów — żeby przyszłe punkty na godzinę (etap 4) dało się liczyć bez administracji. W "Teraz w pracy" osoba na administracji liczy się jako "w pracy". Korekty Managera mogą ustawić ten rodzaj ręcznie. Wymaga ponownego uruchomienia `rcp.sql` (zmienia ograniczenie rodzajów i `rcp_act`).
**Rola "Kierownik trade-in" (07.10.2026):** zakładki jak Trade-in (`ROLE_ACCESS`: Trade-in, Backlog, RCP, Zwroty), domyślny obszar w RCP "Trade-in", prace administracyjne w RCP; w samym Trade-in nie dostała osobnych uprawnień (lista paczek jest wspólna dla wszystkich, usuwa tylko Admin) — daj znać, jeśli ma np. usuwać paczki czy widzieć kolumnę "Czas". Rola to zwykły tekst w `members.role` — bez SQL; nadaje ją Admin w Zespół (dokładna nazwa: `Kierownik trade-in`).

**Zwroty** (`ReturnsView.tsx`) — **na razie tylko pusta zakładka-szkielet** (dodana 30.09.2026), widoczna dla wszystkich ról, ten sam wzorzec co RCP.
Docelowo: rejestr fizycznej obsługi zwrotu (przyjęcie zwróconej paczki, sprawdzenie stanu sprzętu, decyzja co dalej — powrót do magazynu / naprawa /
utylizacja), wzorem Serwisu/Testów/Trade-in — **nie** zestawienie zwrotów z marketplace'ów (te już są widoczne w Zamówieniach jako część kubełka
"Anulowane", patrz `statusBucket`/`CANCELLED_STATUS` w `lib/salesOrders.ts`).

**Serwis** (`ServiceView.tsx`, `service_log`). Rejestr napraw wg tabeli z regulaminu (`SERVICE_TASKS`
w `lib/workLog.ts`, patrz sekcja Regulamin premiowania niżej za aktualne stawki). Jeden wiersz = jedna
naprawa: `started_at`, status (w_naprawie / **oczekuje_na_czesci** / naprawiony / uszkodzony),
`finished_at`. Pracownik = zawsze zalogowana osoba (nie do wyboru). Wpisy może usuwać
tylko Admin (przycisk "Usuń", tak samo w Testach i Trade-in). Podsumowanie punktacji u góry (Dziś/7/30 dni) liczy tylko "naprawiony".
**Status "Oczekuje na części"** (01.10.2026, na prośbę właściciela) — naprawa WSTRZYMANA, nie zakończona:
tak jak "W naprawie", `finished_at` zostaje `null` (`SERVICE_ACTIVE_STATUSES` w `lib/workLog.ts` — lista
statusów, które NIE kończą naprawy; `changeStatus` w `ServiceView.tsx` sprawdza przynależność do tej
listy zamiast porównania tylko z "w_naprawie", żeby dodanie kolejnego aktywnego statusu w przyszłości nie
wymagało zmiany logiki w dwóch miejscach). Nie liczy się do punktów (tylko "naprawiony" się liczy).
**Typ czynności "Poprawka"** (02.10.2026, na prośbę właściciela) — `correction` w `SERVICE_TASKS`, **0 punktów** (poza tabelą punktową regulaminu). Zwykły wpis jak każdy inny (numer seryjny, status, czas), tylko migawka punktów to 0, więc nie wpływa na podsumowanie punktacji; bez zmian w bazie (`task_type` to zwykły tekst).
**Wiersz jest edytowalny tylko w statusie "W naprawie"** (02.10.2026, na prośbę właściciela — żeby nic nie zmienić przez
przypadek): w każdym innym statusie (oczekuje na części, wstrzymane, naprawiony, uszkodzony) numer seryjny, części i
uwagi są zwykłym tekstem (`readOnly` w `InlineEditCell`/`PartsCell`), a lista części bez przycisków +/−. **Zmiana
statusu zostaje zawsze dostępna** — inaczej nie dałoby się wrócić do "W naprawie" ani zakończyć naprawy. Tylko UI
(RLS dalej pozwala na UPDATE każdemu zalogowanemu). Przycisk "↗" do karty produktu i "Usuń" (Admin) działają zawsze.
**Status "Wstrzymane"** (02.10.2026, na prośbę właściciela) — **zatrzymuje naliczany czas**. Też należy do
`SERVICE_ACTIVE_STATUSES` (nie kończy naprawy, `finished_at` zostaje `null`, bez punktów). Mechanizm w bazie
(`service_log_track_pause` w `service.sql`, trigger `before update`, zegar serwera): `paused_at` ustawiane przy
wejściu w "wstrzymane", a przy wyjściu (do dowolnego innego statusu, także wprost do naprawiony/uszkodzony) długość
przerwy dolicza się do `paused_seconds` i `paused_at` się czyści. Czas netto = `finished_at - started_at -
paused_seconds` (`fmtDuration(..., pausedSeconds)` w `lib/workLog.ts`); w kolumnie "Czas" (Admin/Manager) wiersz
aktualnie wstrzymany pokazuje "wstrzymane". Kolumny czasu jest informacyjny, jak dotąd (punkty od niego nie zależą).
Ten sam mechanizm NIE obejmuje "Oczekuje na części" — ten status czas dalej liczy (nie było takiej prośby).
**Numer seryjny / IMEI jest wymagany, żeby ROZPOCZĄĆ naprawę** (01.10.2026, na prośbę właściciela) — pole w formularzu
ma gwiazdkę, przycisk "Rozpocznij naprawę" jest zablokowany, dopóki pole jest puste, a pilnuje tego też trigger
`service_log_require_device_ref` w bazie (serwer nie ufa przeglądarce). **Wymóg dotyczy tylko INSERT, nie UPDATE** —
`device_ref` jest edytowalny w wierszu listy (`InlineEditCell`, obok przycisk "↗" do karty produktu, widoczny tylko
gdy pole niepuste) i da się go później poprawić albo nawet wyczyścić bez blokady — inaczej niż w Testach przed 02.10.2026, gdzie
numer seryjny był tylko do odczytu po rozpoczęciu testu (dziś w Testach też jest edytowalny). Dzięki temu stare wpisy sprzed tej zmiany (z pustym
`device_ref`) nadal da się normalnie edytować (status, uwagi, części) — trigger sprawdza tylko moment startu.
**Punktacja tylko raz (05.10.2026, ten sam mechanizm co w Trade-in):** `service_log.points_awarded_at` = chwila PIERWSZEGO wejścia w status "naprawiony", ustawiana triggerem `service_log_points_once` (zalogowani nie zmieniają jej); podsumowanie Dziś/7/30 dni liczy po niej, nie po `finished_at` (które UI ustawia przy każdej zmianie statusu) — naprawiony -> uszkodzony/w naprawie -> naprawiony nie przesuwa punktów do nowego dnia/miesiąca
(przed uruchomieniem `service.sql` awaryjnie po `finished_at`). Wiersze sprzed zmiany dostały datę z `finished_at`. W przeciwieństwie do Trade-in `finished_at` NIE jest zamrażane (naprawa "uszkodzona", potem naprawiona ma mieć czas do ostatniego zakończenia).
**Kolumna "Części"** (30.09.2026, `part_serials text[]`) — numery seryjne części wykorzystanych w naprawie,
dowolna liczba (często zero, czasem kilka). W odróżnieniu od Padów w Trade-in (pole "ilość" generuje tyle
slotów) tu wprost przyciski **+/- przy każdym polu** (`PartsCell.tsx`, nowy współdzielony komponent): "+"
dokłada kolejne puste pole zaraz pod tym, "-" usuwa TO pole; przy zerze części widać tylko mały przycisk
"+ część". Dodanie/usunięcie pola zapisuje całą tablicę od razu, sama treść pola dopiero przy wyjściu z
niego/Enterem (`InlineEditCell` per pole, ten sam wzorzec zapisu co reszta kolumn edytowanych w wierszu).
Nie wymagane do żadnego statusu — czysto informacyjne, nie wpływa na punkty ani na warunek "naprawiony".
**Rola "Kierownik serwisu" (05.10.2026, na prośbę właściciela):** zakładki jak Serwis (`ROLE_ACCESS`: Serwis, Backlog, RCP, Zwroty). W Serwisie (`isServiceLead` w `ServiceHub`/`ServiceView`) **widzi naprawy wszystkich** (jak Admin/Manager, nie tylko własne) i **edytuje wiersz w KAŻDYM statusie** — numer seryjny, części i uwagi (zwykła blokada "tylko w statusie W naprawie" go nie obejmuje); zmiana statusu dostępna dla wszystkich jak dotąd.
Nie widzi kolumny "Czas" (tylko Admin/Manager). **Usuwa naprawy (06.10.2026, na prośbę właściciela)** — przycisk "Usuń" w wierszu i polityka `admin or service lead delete service_log` w `service.sql` (`is_admin() or is_service_lead()`, nowa funkcja `is_service_lead()` — security definer jak `is_admin()`; usunięcie nadal zapisuje trigger `audit_delete` w `deleted_records`); to prawo dotyczy WYŁĄCZNIE Serwisu — Testy i Trade-in usuwa dalej tylko Admin. Typu czynności nie edytuje nikt (migawka punktów). Rola to zwykły tekst w `members.role` — bez SQL; nadaje ją Admin w Zespół. Tylko UI (RLS `service_log` i tak pozwala każdemu zalogowanemu na update, jak reszta uprawnień w MVP).
**Każdy widzi tylko własne naprawy** (02.10.2026, na prośbę właściciela) — lista i podsumowanie punktów filtrowane po `employee_user_id = zalogowana osoba`, chyba że to Admin/Manager (widzą wszystkich; `ownOnly = !isAdminOrManager` w `ServiceView.tsx`). **Tylko UI/zapytanie, nie RLS** (zgodnie z resztą uprawnień w projekcie): polityka `select` na `service_log` dalej pozwala każdemu zalogowanemu czytać wszystko, a karta produktu (`ProductCardDrawer`) pokazuje naprawy danego numeru seryjnego niezależnie od autora. **Wyszukiwarka po numerze seryjnym** (02.10.2026) nad listą napraw, po lewej, bez nagłówka "Ostatnie naprawy" (usunięty na prośbę właściciela) — `device_ref ilike` (`escapeLike`, debounce 300 ms, jak w Trade-in); bez niej lista to najświeższe 50 wpisów, przy wyszukiwaniu limit rośnie do 200, żeby trafić we wpis spoza najświeższych.

**Serwis -> Części** (04.10.2026, na prośbę właściciela; `ServiceHub.tsx` z pigułkami Naprawy / Części, `PartsView.tsx`, `supabase/service-parts.sql`, `scripts/import-parts.mjs`) — rejestr części do napraw z ceną zakupu i przypisanym numerem seryjnym/IMEI urządzenia.
Źródło: arkusz `parts.numbers` właściciela (~17,6 tys. wierszy od 2021; wiersz = jedna sztuka części, w starszych zakupach pierwszy wiersz partii ma `batch_qty`). Tabela `service_parts`: data przyjęcia, faktura/data, dostawca, status (Dotarło / Demontaż /
Reklamacja / Zareklamowane / Uszkodzony), nazwa, kod (SKU części), cena netto + waluta + kurs, **`price_pln` = cena JEDNOSTKOWA netto w PLN z arkusza** (null, gdy w arkuszu brak kursu — 8 wierszy z 2021), `device_ref`, `usage_notes`. Dane z arkusza wczytane przez REST skryptem
(`node scripts/import-parts.mjs parts.json`, odmawia nadpisania bez `--replace`, bo `--replace` kasuje też ręczne przypisania); czyszczenie: kolumna IMEI z arkusza trafia do `device_ref` tylko gdy wygląda jak identyfikator (wielkie litery, wiele numerów po przecinku), a tekst
(„reklamacja", „pękło przy montażu", imiona) idzie do `usage_notes`; gdy w „uwagi" był identyfikator, a kolumna IMEI miała tekst, identyfikator trafia do `device_ref`. Bez nowych wierszy z aplikacji (brak polityki insert i formularza „Dodaj część" — na razie tylko import).
Lista: wyszukiwanie (nazwa, kod, numer seryjny/IMEI, faktura, dostawca, uwagi), filtr Wszystkie/Przypisane/Nieprzypisane, stronicowanie, podsumowanie wyniku (liczba, wartość netto PLN). **Zespół zmienia tylko `usage_notes`**; **numer seryjny/IMEI urządzenia (`device_ref`) NIE jest już edytowalny w Częściach (06.10.2026, na prośbę właściciela) — wyświetla się ten, który serwisant przypisał do kodu części w czasie naprawy** (↗ otwiera kartę produktu); dane zakupowe są tylko do
odczytu (trigger `service_parts_guard`, który też normalizuje numer: trim + wielkie litery i zapisuje „zmienił: kto/kiedy"); usuwa tylko Admin z audytem (`deleted_records`).
**Przypisanie części do urządzenia z napraw (06.10.2026):** serwisant wpisuje w Naprawy -> kolumna "Części" (`service_log.part_serials`) kody użytych części; trigger `service_log_sync_parts` -> `service_parts_sync_from_repair` (`service-parts.sql`, security definer) nadaje części o tym samym kodzie (`part_code`, bez rozróżniania wielkości liter i spacji) numer `service_log.device_ref` naprawianego urządzenia.
**Tylko kody jednoznaczne** — dokładnie jeden wiersz z takim kodem (kody partii z arkusza, np. `6741` na 139 sztukach, są pomijane, bo nie wiadomo, którą sztukę wbudowano). **Ostatnia edycja naprawy wygrywa** (także nad przypisaniem z arkusza); usunięcie kodu z naprawy, zmiana urządzenia w naprawie albo usunięcie naprawy zwalnia część (tylko gdy wciąż jest przypisana do TEGO urządzenia). Ręcznej edycji z listy Części broni `service_parts_guard` (zmiana `device_ref` przez zalogowanego jest odrzucana, chyba że idzie z triggera — flaga `parts.repair_sync`); SQL Editor/service_role przechodzą. Ślad "zmienił" = serwisant, który wpisał kod.
Plik jednorazowo uzupełnia przypisania z istniejących napraw (na dzień wdrożenia 42 z 192 kodów w naprawach pasuje do części: 32 już miało to samo urządzenie, 10 było puste; reszta to opisy tekstowe albo części jeszcze niezaimportowane — dla nich służy import z faktury). Koszt serwisu w Marży dalej czyta `device_ref`, więc przypisanie z naprawy od razu wchodzi do marży.
**Import z faktury zakupu (06.10.2026, na prośbę właściciela; przycisk "+ Importuj z faktury" nad listą Części, `PartsImportDialog.tsx`, `lib/partsInvoice.ts`, `lib/partsServer.ts`, `app/api/parts/{parse-invoice,rate,import}`):** pracownik wgrywa plik (PDF, zdjęcie JPG/PNG/WebP albo CSV/TXT, do 3,5 MB — limit body na Vercelu; Excel zapisać jako PDF/CSV) -> `parse-invoice` wysyła go do Claude (`ANTHROPIC_API_KEY` i `AI_MODEL` jak w zakładce AI; narzędzie `report_invoice` (tryb auto — `tool_choice: {type: "tool"}` odrzuca ten model błędem 400; gdy model odpowie tekstem, jedno ponowienie z prośbą o narzędzie) zwraca dostawcę, numer i datę faktury, walutę oraz pozycje: nazwa, kod, ilość, cena jednostkowa NETTO — z brutto przelicza po stawce VAT i oznacza to uwagą; pomija dostawę i rabaty ogólne) -> okno z **listą do edycji i akceptacji** (nagłówek: dostawca, nr i data faktury, data przyjęcia = dziś; wiersze: nazwa, kod, ilość, waluta, cena netto, kurs NBP, netto PLN — wszystko edytowalne, można usuwać i dodawać pozycje, albo zacząć od "Dodaj pozycje ręcznie" bez pliku) -> "Zapisz" -> `parts/import`.
**Kody części nadawane automatycznie (06.10.2026, na prośbę właściciela):** każda zapisywana sztuka dostaje **własny, unikalny kod** z serii `10xxxxxx` (ostatni użyty przed wdrożeniem: `10013681`; seria 10xxxxxx to nasze kody — w tabeli są też obce kody 979…/989…). Kody idą **kolejno i atomowo** — funkcja bazy `service_parts_import(jsonb)` (`service-parts.sql`, tylko service_role) w jednej transakcji bierze licznik `service_part_code_counter` (blokada wiersza), liczy start jako max(licznik, największy kod z serii) i wstawia wiersze; dwa równoległe importy nie dostaną tych samych numerów, nieudany zapis nie zostawia dziur. 40 sztuk = 40 kolejnych kodów (np. 10013682–10013721). Kod z faktury (symbol dostawcy, np. JDM-011) NIE jest kodem części — trafia do `notes` jako "Kod dostawcy: …" (pole w oknie: "Kod dostawcy", opcjonalne). W oknie widać pierwszy wolny kod (`GET parts/import`, podgląd nieblokujący), a po zapisaniu **ekran z nadanymi zakresami kodów** (per pozycja) i przyciskiem "Kopiuj listę" — kody trzeba nakleić na sztuki, bo serwisant wpisuje je w naprawie (Części), co przypisuje część do urządzenia. Import wymaga uruchomionego `service-parts.sql` (bez funkcji zwraca czytelny błąd, nie zapisuje nic bez kodu).
**Nic nie trafia do bazy bez kliknięcia "Zapisz"** (odczyt tylko proponuje). Kurs NBP dla waluty innej niż PLN: ostatni dzień roboczy PRZED datą faktury (zasada księgowa jak wszędzie; `nbpRateFor` pobiera z API NBP dowolną walutę tabeli A, nie tylko EUR/DKK z `nbp_rates`); zmiana waluty w wierszu dociąga kurs (`parts/rate`), brak kursu = wpisujesz ręcznie; netto PLN liczy się jako cena × kurs, ale pole można poprawić. Pozycja z ilością N zapisuje się jako **N wierszy** (jedna sztuka = jeden wiersz jak w arkuszu; pierwszy wiersz partii dostaje `batch_qty`), status "Dotarło", `source = 'invoice'`, `created_by_email` (nowa kolumna w `service-parts.sql`, część chroniona triggerem; bez niej zapis działa, tylko bez autora — uruchom ponownie `service-parts.sql`). Pozycja bez ceny w PLN zapisze się po potwierdzeniu (w Marży da ⚠ i koszt 0).
Zapisuje wyłącznie serwer (tabela nie ma polityki insert — dane zakupowe zostają niezmienne dla zalogowanych) i **waliduje wszystko jeszcze raz**: nazwa, ilość 1–100, max 200 pozycji i 500 sztuk naraz, ceny/kursy dodatnie. **Duplikat faktury:** gdy ten numer faktury (i dostawca) jest już w `service_parts`, serwer odpowiada 409 i okno pokazuje "Zapisz mimo to". Dostęp: Admin, Manager, Serwis, Kierownik serwisu. Oryginał pliku nie jest przechowywany (tylko wyciągnięte dane). Koszt odczytu to zwykłe zużycie API Anthropic (kilka–kilkanaście groszy na fakturę; nie trafia do `ai_log` ani licznika w zakładce AI).
Nie testowane na żywym API Anthropic ani na prawdziwej fakturze (brak klucza w środowisku asystenta) — logika zweryfikowana na atrapie `fetch`, walidacja i rozwijanie ilości testami jednostkowymi, tabela w PGlite; jakość odczytu zdjęć zależy od faktury, dlatego lista jest do sprawdzenia przez człowieka.
**Koszt serwisu w Marży** (04.10.2026): `ServicePart`/`partsBySerial` w `computeMargin` (`lib/margin.ts`), ładowane przez `loadPartsBySerial` w `lib/marginServer.ts`. Koszt serwisu sztuki = suma `price_pln` części przypisanych do jej numeru seryjnego (bez rozróżniania wielkości liter; pole z kilkoma
numerami dzieli koszt po równo), **cena NETTO** (części to koszt firmowy bez VAT). Liczą się części przyjęte NIE PÓŹNIEJ niż w dniu zamówienia (część kupiona po sprzedaży należy do późniejszej naprawy; uwaga: sztuka sprzedana, zwrócona i znów sprzedana dostanie te same części przy obu sprzedażach) i bez wierszy
„Demontaż" (część wyjęta z innego urządzenia, nie kupowana). Część bez ceny: ostrzeżenie ⚠ i koszt 0. Serwis pomniejsza marżę, **nie wchodzi do podstawy VAT od marży** (jak koszty dodatkowe). Kolumna „Serwis" i rozwijane wyliczenie pokazują kwotę i listę części; zakładka Przegląd (wykres marży) bierze to
automatycznie. Brak tabeli (nieuruchomiony `service-parts.sql`) = serwis 0 jak dotąd. Zweryfikowane w PGlite (uprawnienia, trigger) i testem logiki (`margin.test.js`).

**Testy** (`TestsView.tsx`, `test_log`). Rejestr testów urządzeń: pole numer seryjny +
"Rozpocznij test". Jeden wiersz = jeden test: status (w_trakcie / przetestowane / przerwany),
czas, punkty 200/13 (= 100/6,5) po "przetestowane", bez zaokrąglania. Punkty są niezależne od
wyniku testu — potwierdzone właśnie dzięki kolumnie "Wynik" niżej (01.10.2026): to osobne pole,
nie podstatus, i w ogóle nie wchodzi do logiki punktów/aktywnego wpisu.
**Urządzenia mogą trafiać na testy wielokrotnie** (01.10.2026, zgłoszone przez właściciela — indeks
częściowy na `serial_number` blokuje tylko DWA TRWAJĄCE testy naraz, `status = 'w_trakcie'`, nie kolejny
test po "przetestowane"). **Do 01.10.2026 indeks blokował też ponowny test po "przetestowane"** — błędne
założenie z Regulaminu §2 ust. 3/§9 ust. 2 ("wielokrotne rejestrowanie to manipulowanie wynikiem"), mylące
zduplikowane zaliczenie TEGO SAMEGO przebiegu z osobnym, kolejnym testem w innym momencie — a kolejne testy
to realny scenariusz biznesowy wprost nazwany w `TEST_KINDS` niżej (po serwisie, ponowny test z magazynu,
przed wystawieniem na OLX/Allegro/Vinted) — każdy taki test to osobna, prawdziwie wykonana praca i osobne
punkty. Test "przerwany" nigdy nie blokował ponownego podejścia, to się nie zmieniło.
**Kolumna "Rodzaj testu"** (01.10.2026, `test_log.test_kind`, `TEST_KINDS` w `lib/workLog.ts`) — skąd/czemu
urządzenie trafiło do testu: Po dostawie / Po serwisie / Ponowny test z magazynu / OLX / Allegro / Vinted.
Wybierane w formularzu "Rozpocznij test" (select, domyślnie pierwsza wartość — zawsze coś wybrane, bez pustej
opcji) i edytowalne potem w wierszu listy (zwykły `<select>`, zapis od razu po zmianie, bez „Zapisz”). Zwykły
tekst jak `role`/`employment_type` w innych modułach — dodanie kolejnej wartości to tylko wpis w `TEST_KINDS`,
bez SQL; stare wiersze dostały default `'po_dostawie'` przy dodaniu kolumny. **Kolumna "Wynik"** (tabela,
`test_log.result`, `TEST_RESULTS` w `lib/workLog.ts`) — stan urządzenia ustalony podczas testu: Sprawny /
Serwis / RMA / Do poprawy / Outlet. Nullable (puste "—" dla starych wierszy i dopóki nikt nie wybierze),
edytowalne w dowolnym momencie przez cały cykl życia testu, **całkowicie niezależne od statusu** (w_trakcie /
przetestowane / przerwany, który dalej sam rządzi punktami i unikalnością aktywnego wpisu) — np. wpis może być
"przetestowane" + "RMA" naraz, to nie sprzeczność. Żadne z tych dwóch pól nie jest wymagane do żadnego
statusu — czysto informacyjne, podobnie jak "Części" w Serwisie.
**Punktacja tylko raz (05.10.2026):** `test_log.points_awarded_at` = chwila PIERWSZEGO wejścia w "przetestowane" (trigger `test_log_points_once`, niezmienne dla zalogowanych); podsumowanie liczy po niej (przed uruchomieniem `tests.sql` awaryjnie po `finished_at`), więc przetestowane -> przerwany -> przetestowane nie przesuwa punktów do nowego dnia/miesiąca. Kolejny, osobny test tego samego urządzenia (nowy wiersz) nadal liczy się jako nowa praca.
**Kolumna "SKU"** (02.10.2026, `test_log.sku`, nullable tekst, edytowalna w wierszu przez `InlineEditCell`, zaraz po
Numerze seryjnym) — ręcznie wpisywana, jak SKU w Trade-in; nic jej nie waliduje i nie wypełnia automatycznie.
**Numer seryjny jest teraz edytowalny w wierszu** (02.10.2026, wcześniej tylko do odczytu po rozpoczęciu testu —
patrz porównanie z Serwisem w sekcji Serwis): zapis zamienia wartość na WIELKIE litery (jak przy rozpoczynaniu),
pusta wartość jest odrzucana (kolumna NOT NULL), a zmiana na numer, który ma już trwający test, dostaje czytelny
komunikat zamiast błędu bazy (indeks częściowy). Obok pola przycisk "↗" otwiera kartę produktu. Kolor "Po serwisie"
w Rodzaju testu jest celowo nasycony (żółty), żeby odcinał się od pozostałych pasteli.
**Kolory kolumn (02.10.2026, na prośbę właściciela)** — Pracownik, Rodzaj testu i Wynik w liście "Ostatnie testy"
mają kolorowe tło plakietki, tak jak Status. Pracownik: kolor osoby z `lib/userColors.ts` (`colorForUser`, ta
sama mapa e-mail -> kolor co podświetlanie wierszy w Trade-in; osoba spoza mapy dostaje neutralną plakietkę).
Rodzaj testu i Wynik: stałe pary tło/tekst w `TEST_KIND_COLORS`/`TEST_RESULT_COLORS` (`lib/workLog.ts`) —
dodając nową wartość do `TEST_KINDS`/`TEST_RESULTS`, dopisz jej kolor, inaczej select zostanie bez tła.
Pusty Wynik ("—") zostaje zwykłym białym polem. Hardkodowane heksy, niezależne od motywu (jak plakietki marketplace'ów).

**Karta produktu** (`ProductCardDrawer.tsx`). Klik w numer seryjny w Testach i Serwisie (strzałka ↗
przy polu) albo w Magazynie → Raw data otwiera panel. **W Trade-in (Wprowadzanie) ten odnośnik usunięty
30.09.2026** na prośbę właściciela — niepotrzebny obok kolumny Numer seryjny. Nie ma własnej tabeli: składa się na żywo z
`fakturownia_stock_with_sku` (magazyn, widok z `inventory.sql` — ta sama co w Magazynie -> Raw data, więc **sekcja "Magazyn (Fakturownia)" pokazuje też SKU i VAT**, 02.10.2026; widoczne tylko dla sztuk, które są w magazynie), `buyback_orders` (zamówienie z opisu sztuki lub z obsługi paczki),
`test_log`, `service_log` (po `device_ref`) i `history` z `buyback_order_intake`. **Log** to te zdarzenia
w kolejności czasu ("Test rozpoczęty przez…", "Serwis (…) zakończony: Naprawiony", zmiany w Trade-in).
Numery łączy bez rozróżniania wielkości liter, ale muszą być wpisane identycznie w każdym module.
Nie ma jeszcze własnych, edytowalnych danych produktu — to odczyt.

## Recoo Sklep — backoffice sklepu (od 30.09.2026)

Sklep internetowy to osobne repo (`~/Downloads/recoo-sklep`, `github.com/max-power-666/recoo-sklep`, https://recoo-sklep.vercel.app),
ale jego **backoffice jest w tym ERP** (decyzja właściciela: wspólne logowanie, role, dostęp per osoba, dziennik; zamówienia i
wysyłka i tak są tutaj). **Przełącznik ERP / SKLEP** (od 06.10.2026: na górze paska bocznego napis "Recoo", a pod nim dwa przyciski obok siebie "ERP" i "SKLEP" — wcześniej rozwijana nazwa "Recoo ERP ▾"; `SpaceSwitcher`
w `app/page.tsx`): zakładki mają pole `space` (`TABS`), pasek pokazuje tylko zakładki bieżącej przestrzeni, ostatnia zakładka
każdej przestrzeni pamiętana w `localStorage` (`magazyn-view-erp`/`magazyn-view-shop`). Osoba z dostępem tylko do jednej
przestrzeni widzi sam napis "Recoo" z nazwą tej przestrzeni zamiast przycisków. Zakładki sklepu: **Produkty** (`shop_products`, `ShopProductsView.tsx` +
panel `ShopProductEditor.tsx`) i **Magazyn** (`shop_stock`, `ShopStockView.tsx`): lista wszystkich wariantów ze stanem, kafelki (sztuki na stanie,
wartość wg cen sprzedaży, warianty w sprzedaży, brak na stanie), szybkie − / + (wydanie/przyjęcie 1 szt.) i „Więcej…”
(przyjęcie / wydanie / korekta do konkretnej liczby + notatka), historia ruchów (ostatnie albo jednego SKU). **Stan zmienia
wyłącznie funkcja bazy `shop_stock_change(variant, kind, qty, note)`** (security definer, `can_edit_shop()`, `select … for update`
— dwie osoby naraz nie nadpiszą wyniku, pilnuje zera, zapisuje ruch w `shop_stock_moves` w tej samej transakcji); bezpośredni
UPDATE `stock` odrzuca trigger `shop_stock_guard` (flaga `shop.stock_rpc` ustawiana tylko w tej funkcji), więc historia ruchów
jest zawsze kompletna — przyszłe zamówienia ze sklepu też muszą zdejmować stan tą funkcją. Ruchy są nieedytowalne (brak polityk
zapisu). Dostęp domyślnie
Admin, Manager i nowa rola **"Sklep"**; w Zespole checkboxy z prefiksem "Sklep:".

Dane: `supabase/shop.sql` — `shop_categories` (ukryta = nie ma jej w sklepie), `shop_models` (published = widoczny; nowy startuje
jako szkic), `shop_variants` (opcja × stan wizualny jak-nowy/bardzo-dobry/dobry, cena, cena nowego, **ręczny stan `stock`** —
decyzja właściciela, BEZ powiązania z numerami seryjnymi z Fakturowni), `shop_images` (url względny `/produkty/...` = plik w repo
sklepu, albo pełny adres z publicznego bucketu Storage `shop-images`), `shop_log` (dziennik zmian zapisywany przez TRIGGERY —
pola, które się zmieniły, autor z `auth.jwt()`; przy usunięciu modelu jeden wpis, bez szumu z kaskady). Uprawnienia:
`can_edit_shop()` (Admin/Manager/Sklep) edytuje, usuwanie modelu i kategorii tylko Admin; anon (sklep) czyta tylko opublikowane
modele, aktywne warianty i kategorie. Dane startowe w tym samym pliku = katalog przeniesiony 1:1 z `lib/catalog.ts` sklepu (te same
slugi i SKU), `on conflict do nothing`, więc ponowne uruchomienie nie nadpisuje zmian z backoffice. Zdjęcia dodawane w ERP są
**automatycznie przycinane** z przezroczystych marginesów (`trimTransparent` w `ShopProductEditor.tsx`) — sklep opiera na tym
efekt "produkt wychodzi ponad kolorowy panel". SKU: `PREFIKS-OPCJA-STAN` (`skuFor` w `lib/shop.ts`, ta sama zasada co w sklepie).
Zweryfikowane w PGlite (idempotentność, log z autorem, RLS: Manager nie usunie modelu, Magazyn nie edytuje, anon nie widzi szkiców).
**Konsole z Katalogu konsol (06.10.2026, na prośbę właściciela; `supabase/shop-console-import.sql`, jednorazowy, uruchamiać PO `shop.sql`):** z `console_catalog` (75 wierszy) powstało 13 modeli sklepu — **rodzina konsoli = model** (PS5 Slim Digital, PS5 Slim, PS5 Pro, PS5 Digital, PS5, PS4 Slim, PS4 Pro, PS4, Xbox Series X/S, Xbox One X/S, Xbox One), a **wariant = dysk · kolor · pady × klasa** (225 wariantów). **Opcja wielowymiarowa:** `option_value` = "1 TB · Biały · 1 pad", `option_label` = "Dysk · Kolor · Pady" — separator " · " (`OPTION_SEPARATOR`/`optionDimensions` w `lib/catalog.ts` sklepu); karta produktu pokazuje wtedy osobny rząd przycisków na każdy wymiar (wybór niedostępnej kombinacji przeskakuje na najbliższą istniejącą), bez zmian w schemacie. **Klasy:** A = bardzo dobry, B = dobry, nowa **C = zadowalający** (`zadowalajacy`, w `shop.sql` nowy CHECK, w `lib/shop.ts` i sklepie czwarta klasa; "jak nowy" A+ zostaje dla innych produktów). **SKU wariantu = SKU z katalogu** (z końcówką `-0M/-1M/-2M`); brakujące SKU (PS5 Pro 2TB, Xbox Series S 1TB) wygenerowane tym samym wzorem (`PS5P-2TB-WE-A-0M`, `XSS-1TB-BK-B-1M`…), a PS4 Pro Biały dostał `-WE-` zamiast błędnego `-BK-` z arkusza (sam katalog nie zmieniony). **Ceny 0 i stan 0** — wariant z ceną 0 jest NIEWIDOCZNY w sklepie (RLS `shop read variants`: `price > 0`, plus filtr `price=gt.0` w `lib/catalogServer.ts`; w edytorze ERP pomarańczowa ramka i podpowiedź). Nowe modele są szkicami; pięć modeli, które już były w sklepie (PS5 Slim, PS5, PS4 Pro, Xbox Series X/S), dostało nowe warianty, a ich przykładowe warianty (stary jednowymiarowy kształt opcji) zostały **wyłączone, nie usunięte** — te modele znikają ze sklepu, dopóki warianty z katalogu nie dostaną cen. Plik wygenerowany ze stanu katalogu z dnia importu (zmiany w katalogu po imporcie NIE przechodzą same do sklepu). Zweryfikowane w PGlite (stary `shop.sql` → nowy → import dwa razy, identyczny wynik; anon widzi tylko wyceniony wariant).
**Zdjęcia przypisane do wartości opcji (07.10.2026, na prośbę właściciela — "jedna galeria dla wariantów w różnych kolorach"):** `shop_images.option_value` (null = zdjęcie wspólne). W edytorze pod każdym zdjęciem lista **"Pokazuj dla"**: "Wszystkie warianty" albo każda wartość każdego wymiaru opcji (np. "Kolor: Biały", "Pady: 2 pady"; `imageOptionChoices` w `lib/shop.ts`), zapis od razu; na miniaturze plakietka z wartością. Przypisujemy do WARTOŚCI, nie do pojedynczego wariantu (świadomie: jedno zdjęcie białej konsoli pasuje do 9 wariantów). W sklepie (`imagesForParts` w `lib/catalog.ts`) galeria pokazuje najpierw zdjęcia pasujące do wybranego wariantu, potem wspólne, a gdy nic nie pasuje — wszystkie; zmiana koloru w BuyBox przełącza galerię (wspólny stan `Selection.tsx` na stronie produktu), miniatura na listach = wariant domyślny (`initialVariant`: pierwszy dostępny). Przed uruchomieniem `shop.sql` sklep czyta zdjęcia bez tej kolumny (wszystkie wspólne). **Edytor wariantów:** opcja wielowymiarowa ma osobne pole na każdy wymiar (Dysk / Kolor / Pady), sklejane separatorem " · " (`splitOption`/`joinOption`/`normalizeOption`).
**Dane startowe `shop.sql` tylko do PUSTEJ tabeli (07.10.2026):** wcześniej `on conflict do nothing` — ponowne uruchomienie przywracało usunięte w backoffice modele/warianty/zdjęcia, a po zmianie SKU wariantu (np. Xbox Series X) kończyło się błędem unikalności (model, opcja, stan).

## Regulamin premiowania (12.10.2026, wersja zaktualizowana przez właściciela 01.10.2026) — co z niego wynika dla kodu

Zasady, które kształtują Serwis i Trade-in (pełny PDF ma właściciel):
- punkty tylko po **prawidłowym zakończeniu** procesu (§2 ust. 4) → liczymy dopiero dla
  statusu końcowego "naprawiony" / "obsłużona";
- jedna paczka/urządzenie zaliczone **raz** (w ramach TEGO SAMEGO przebiegu), zakaz przypisywania
  sobie cudzej pracy i wielokrotnego rejestrowania tej samej czynności (§2 ust. 3, §9) →
  unikalność aktywnego/trwającego wpisu, pracownik z sesji, usuwanie wpisów tylko przez Admina z
  zapisem w `deleted_records`. **Nie dotyczy to kolejnego, osobnego testu/paczki w innym
  momencie** (np. Testy: urządzenie retestowane po serwisie — patrz sekcja Testy wyżej, zmiana
  01.10.2026) — to osobna, prawdziwie wykonana praca, nie "wielokrotne rejestrowanie tego samego";
- **Punkty flat, nie ułamki** (tabela §2 ust. 6, zaktualizowana 01.10.2026 — wcześniej 100/6 pkt za
  paczkę Trade-In, 100/6,5 za urządzenie testera): **Trade-In - paczka 17 pkt**, **Obsługa zwrotu
  17 pkt** (regulamin już to przewiduje, ale zakładka Zwroty to wciąż tylko pusty szkielet —
  `ReturnsView.tsx` — więc 17 pkt za zwrot NIE jest jeszcze nigdzie naliczane w kodzie; do zrobienia
  razem z punktem 11 planu rozwoju), **Tester - urządzenie 15 pkt**. Serwis (bez zmian w zasadzie,
  tylko w tabeli — patrz `SERVICE_TASKS` w `lib/workLog.ts`): Joy-Con para 15, PS4 25, Xbox One 35,
  **Xbox Series S/X 25 (nowy typ)**, PS5 12, czyszczenie konsoli **40 (obniżone z 45)** (od 06.10.2026 nazwa w UI: "Czyszczenie konsoli/naprawa", klucz `console_cleaning` i 40 pkt bez zmian — stare wpisy dostają nową nazwę), **Trudne
  konsole 60 (nowy typ)**. Zmieniamy tylko `default`/stałą dla NOWYCH wpisów — stare wpisy
  zachowują swoją migawkę punktów sprzed aktualizacji (ten sam wzorzec co przy każdej wcześniejszej
  zmianie stawek w tym projekcie, patrz komentarze w `tests.sql`/`buyback-orders.sql`);
- "Czas" naprawy/paczki jest **tylko informacyjny** — wydajność w regulaminie to punkty /
  godziny *przepracowane* z ewidencji czasu pracy (§4), nie suma czasów zadań.
- **Kolumna "Czas" widoczna tylko dla Admina i Managera** (30.09.2026, na prośbę właściciela) w Serwisie, Testach
  i Trade-in (podwidok Wprowadzanie) — zwykli pracownicy jej nie widzą. Prop `isAdminOrManager` (obok już
  istniejącego `isAdmin`, który steruje osobno przyciskiem "Usuń") w `ServiceView.tsx`/`TestsView.tsx`/
  `TradeInHub.tsx`, liczony w `page.tsx` jako `role === "Admin" || role === "Manager"`. Tylko UI (ten sam,
  świadomy stan MVP co reszta uprawnień — patrz sekcja Uprawnienia) — dane i tak są w bazie, tylko kolumna
  schowana z tabeli i `colSpan` pustego stanu dostosowany.

Świadomie **nie zrobione**: kwota premii w zł wg wzoru §5 (200 zł przy 45 pkt/h do 1500 zł przy 100
pkt/h i więcej), norma wydajności 45 pkt/h (§4), wskaźnik kwalifikacyjny **80%** (§6 — w wersji
regulaminu sprzed 01.10.2026 było 90%, poprawione w aktualizacji), proporcjonalne rozliczenie
niepełnego miesiąca (§7) — wszystko to wymaga ewidencji godzin pracy, urlopów i nieobecności
neutralnych, której apka nie ma (zakładka RCP to wciąż tylko pusty szkielet, plan rozwoju punkt 8).
Punkty z różnych obszarów mają się sumować w jeden wynik miesięczny (§2 ust. 6) — dziś każdy obszar
ma osobną tabelę i podsumowanie.

## Motyw kolorystyczny (30.09.2026)

Dwa motywy, przełączane jednym **switchem** (słońce/księżyc, nie pigułki — zmienione tego samego dnia na wyraźną
prośbę) — **sama kolorystyka, układ ekranów bez zmian** (świadoma decyzja właściciela: pełny redesign na wzór
panelu refurbed to osobny, dużo większy projekt, nie zrobiony). Trzecia opcja "Obecny" (dotychczasowe, ziemiste
kolory) została **usunięta tego samego dnia** na wyraźną prośbę — "Nowy" jest teraz motywem domyślnym/bazowym.
`ThemeSwitcher.tsx`/`lib/theme.ts` pokazuje się na ekranie logowania (pod przyciskiem) i w stopce paska bocznego
(pod "Wyloguj") — w obu miejscach, bo wybór w `localStorage` (`erp-theme`, nie w bazie — jak `magazyn-view`)
przetrwa między niezalogowanym a zalogowanym stanem. Warianty: **Nowy** (jasny, inspirowany insight-panelem
refurbed — biel/jasny fiolet, `teal`→indygo `#4F46E5` jako główny akcent), **Tryb nocny** (przygaszony, świadomie
BEZ czystej czerni/bieli — stonowane grafitowo-zielone odcienie, nie kontrastowe skrajności, żeby nie męczyć oczu).

**Automatyczny wybór wg pory dnia** (30.09.2026, na wyraźną prośbę): dopóki nikt nie kliknął switcha ręcznie, motyw
sam jest ciemny w godzinach **21:00–5:00** (czas lokalny przeglądarki), poza tym jasny — `autoTheme()` w
`lib/theme.ts`. `ThemeSwitcher` sprawdza zegar co 60 s (`setInterval`) i podmienia atrybut na żywo, gdyby ktoś
zostawił kartę otwartą na noc — nie tylko przy odświeżeniu. **Ręczne kliknięcie switcha zapisuje jawny wybór w
`localStorage`** i od tej chwili ma pierwszeństwo przed zegarem na stałe (aż do kolejnego ręcznego przełączenia) —
nie ma osobnego trzeciego stanu "auto" widocznego w UI, "auto" to po prostu "nikt jeszcze nie kliknął".

**Mechanizm:** wszystkie nazwane kolory z `tailwind.config.ts` (`paper`, `panel`, `ink`, `inksoft`, `line`, `amber`,
`ambersoft`, `teal`, `tealsoft`, `rust`, `rustsoft`) wskazują na zmienne CSS (`app/globals.css`), zdefiniowane raz
pod `:root` (motyw "Nowy"/domyślny) i nadpisane pod `:root[data-theme="dark"]`. Przełącznik (`applyTheme` w
`lib/theme.ts`) tylko ustawia atrybut `data-theme` na `<html>` — **żaden plik komponentu nie został dotknięty**
(klasy typu `bg-paper`/`text-inksoft` zostają identyczne, ~770 użyć w całym `app/`), zmienia się tylko wartość
zmiennej, którą przeglądarka już renderuje. `app/layout.tsx` ma dodatkowo synchroniczny inline `<script>`
(`THEME_INIT_SCRIPT`) czytający `localStorage`/zegar PRZED hydracją Reacta (logika godzin 1:1 z `autoTheme()`,
celowo zduplikowana — inline script musi być samodzielny, bez importów) — bez tego przy twardym odświeżeniu
strona mignęłaby na ułamek sekundy złym motywem, zanim JS zdążyłby przełączyć atrybut.

**`white` jest specjalnie nadpisane w `tailwind.config.ts`** (`white: "var(--color-card)"`) — w tym kodzie
`bg-white` nigdzie nie oznacza dosłownej bieli, tylko "powierzchnia karty/tabeli/inputu" (potwierdzone: `text-white`
nie występuje ani razu w całym `app/`, więc nadpisanie nie psuje kontrastu tekstu na kolorowych przyciskach). Bez
tego 16 plików z `bg-white` zostałoby jaskrawo białych na ciemnym tle Trybu nocnego, mimo reszty motywu.

**Świadomie NIE objęte motywem** (rozważone, odrzucone jako zbyt duży dodatkowy zakres na tę prośbę): kolorowe
plakietki marketplace'ów/statusów w `SalesOrdersHub.tsx`/`BacklogView.tsx` (hardkodowane heksy typu
`bg-[#e3ecf9] text-[#2a6bb5]`, jedna stała paleta niezależna od motywu) i palety wykresów kołowych/liniowych
(`FAKTUROWNIA_PALETTE`, `MARKET_COLORS` w `page.tsx`/`TradeInView.tsx`) — w Trybie nocnym będą wyglądać jak
jasne plakietki na ciemnym tle (czytelne, tylko niespójne z resztą motywu). Dwa hardkodowane heksy siatki i linii
najechania na wykresie Biddera (`TradeInView.tsx`, `#C7CCB9`/`#57614F`) zostały przestawione na `var(--color-line)`/
`var(--color-inksoft)` przy okazji tej zmiany, bo inaczej byłyby całkiem niewidoczne na ciemnym tle.

## Wzorce w kodzie (używaj ich przy nowych modułach)

- **Log zmian w jsonb:** `history` = `[{action: "created"|"edited", by_email, at, changes?:
  [{field, from, to}]}]` (karta zamówienia; wcześniej `units.history`). Docelowo ten sam
  wzorzec dla kart towarów z magazynu i zamówień marketplace.
- **Dane zewnętrzne:** cron Vercela → route serwerowy woła API → zapis do tabeli
  w Supabase kluczem `service_role` → UI czyta tabelę (plus realtime). Zespół ma
  tylko `select`. Sekrety wyłącznie w route'ach.
- **Autoryzacja route'ów:** `isAuthorized` (sekret crona albo token zalogowanego użytkownika
  w `Authorization: Bearer`).
- **Kto to zrobił:** zapisujemy e-mail (stały identyfikator), a wyświetlamy przez
  `displayNameForEmail(email, members)` → skrócone imię, w razie braku imienia e-mail.
- **Uwagi w wierszu listy:** kolumna "Uwagi" (między Statusem a Czasem) w Serwisie, Testach i Trade-in
  to `InlineEditCell` (tak samo kolumny "Numer seryjny", "SKU" i "Pady" w Trade-in) — zapis przy wyjściu z pola/Enterem,
  Escape porzuca. W Trade-in edycja trafia też do logu zmian karty zamówienia; zapisy z listy Trade-in idą
  jedną kolejką na najświeższym wierszu (szybkie skanowanie nie nadpisuje poprzednich pól). **Serwis i Testy ->
  Uwagi (01.10.2026, zgłoszone przez właściciela — dłuższe uwagi obcinały się w jednowierszowym polu)** dostały
  prop `multiline`: `InlineEditCell` renderuje wtedy `<textarea>` zawijający tekst i rosnący w pionie do treści
  (JS liczy `scrollHeight`) zamiast jednowierszowego `<input>`; Enter wstawia nową linię zamiast zapisywać, zapis
  dalej przy wyjściu z pola/Escape jak w trybie domyślnym. Trade-in (Wprowadzanie) zostało przy jednowierszowym
  trybie domyślnym — nie zgłoszone, krótsze uwagi.
- **Cykl życia rekordu:** status + `started_at`/`finished_at`, `finished_at` czyszczone przy
  powrocie do statusu początkowego (wzór: `service_log`, `buyback_order_intake`).

## Uprawnienia

Filtrowanie zakładek według roli to **tylko UI** (chowa pozycje w menu). RLS w Supabase
nadal pozwala każdemu `authenticated` czytać prawie wszystko, a wiele tabel także zapisywać
(`units`, ceny max i włącznik biddera, wpisy w `service_log`, `test_log`, `buyback_order_intake`).
To świadomy stan MVP — twarde uprawnienia per rola są zaplanowane.

**Twarde (w bazie, działają też przy wołaniu API bez UI) są dziś tylko:**
- `is_admin()` (SECURITY DEFINER, `schema.sql`) — sprawdza rolę Admin w `members`;
- usuwanie wpisów w Serwisie (Admin i Kierownik serwisu od 06.10.2026), Testach i Trade-in (tylko Admin), a każde usunięcie zapisuje trigger
  `audit_delete()` w `deleted_records` (cały wiersz jako json, kto, kiedy; odczyt tylko Admin — brak UI,
  przegląd w Supabase → Table Editor);
- `members`: role i imiona zmienia tylko Admin, a nowa osoba może założyć wyłącznie własny wiersz
  z pustą rolą. Bez tego każdy mógłby nadać sobie Admina i obejść resztę.
Pliki SQL innych modułów używają `is_admin()`, więc `schema.sql` musi być uruchomiony pierwszy.
Ważne przy Bidderze: zmienia ceny na żywym Back Markecie, więc to pierwszy kandydat do kolejnego zaostrzenia.

**Usuwanie użytkownika w Supabase Auth (Authentication → Users → Delete) do 30.09.2026 kończyło się "Database
error deleting user"** — zgłoszone przez właściciela. Przyczyna: `auth.users` jest referencjonowane z ośmiu
kolumn (`members.user_id`, `units.created_by`, `service_log`/`test_log.employee_user_id`,
`buyback_order_intake.entered_by_user_id`, `backlog_items.created_by_user_id`,
`backlog_attachments.uploaded_by_user_id`, `shipments.created_by_user_id`) bez `on delete`, czyli domyślnym
`NO ACTION` — Postgres blokował kasowanie, dopóki istniał choć jeden odwołujący się wiersz (w praktyce zawsze,
bo `members` ma wiersz dla każdego, kto się kiedykolwiek zalogował). Naprawione: `members.user_id` dostał
**`ON DELETE CASCADE`** (wiersz w members traci sens bez żywego konta, kasuje się razem z nim), reszta —
**`ON DELETE SET NULL`** (historia pracy/zamówień zostaje, tylko traci link do konta; każda z tych tabel ma
osobno zapisany e-mail — `employee_email`/`created_by_email`/`entered_by_email`/`uploaded_by_email` — więc
"kto to zrobił" zostaje widoczne). `service_log.employee_user_id`/`test_log.employee_user_id` musiały dodatkowo
stracić `NOT NULL` (wymagane dla `SET NULL`). Migracja idempotentna (`drop constraint if exists` + `add
constraint`) w każdym z odpowiednich plików — nazwy ograniczeń to domyślne Postgresowe `<tabela>_<kolumna>_fkey`.
Zweryfikowane testem w PGlite (usunięcie z `auth.users`, sprawdzenie że `members` znika, a `service_log`/
`shipments` zostają z wyzerowanym `*_user_id`).

**Magic link — "email rate limit exceeded"**: to nie błąd kodu, tylko limit wbudowanego (darmowego) mailera
Supabase — bardzo restrykcyjny, pomyślany do testów, nie do realnego użytku zespołu. Jedyna trwała naprawa:
Supabase → Authentication → Settings → SMTP Settings — podłączyć własny SMTP (Resend, Postmark, SendGrid,
skrzynka firmowa...). Bez tego magic linki będą się od czasu do czasu blokować przy kilku logowaniach pod rząd.

## Zmienne środowiskowe (tylko nazwy; wartości w `.env.local` i w Vercel)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`CRON_SECRET`, `FAKTUROWNIA_DOMAIN` (sama subdomena, np. `recoo`), `FAKTUROWNIA_API_TOKEN`,
`BACKMARKET_AUTH`, `BACKMARKET_LANG`, `BACKMARKET_UA`, `BACKMARKET_BASE_URL`, `REFURBED_API_TOKEN` (z supplier.refurbed.com; bez niego sync refurbed jest pomijany; nieużywany wygasa po 2 miesiącach), `REFURBED_UA`, `ERLI_API_KEY` (panel Erli: Metoda integracji > Własna integracja po API; bez niego sync Erli jest pomijany), `ERLI_UA`, `ALLEGRO_CLIENT_ID`, `ALLEGRO_CLIENT_SECRET` (aplikacja z apps.developer.allegro.pl), `ALLEGRO_REDIRECT_URI` (opcjonalny, sztywny adres przekierowania), `DHL_PARCEL_USERNAME` (klucz APIv2 z panelu DHL24), `DHL_PARCEL_PASSWORD`, `DHL_PARCEL_SAP` (numer klienta SAP, 7 cyfr; tylko w env), `DHL_EXPRESS_API_KEY`, `DHL_EXPRESS_API_SECRET`, `DHL_EXPRESS_ACCOUNT` (numer konta nadawcy DHL Express — tylko w env, nie w repo), `DHL_EXPRESS_ENV` (`test` domyślnie / `production`), `DHL_EXPRESS_LABEL_TEMPLATE` (opcjonalnie, domyślnie `ECOM26_64_001`), `ALLEGRO_UA` (**wymagany**, bez wartości domyślnej: User-Agent z generatora w panelu aplikacji — Allegro blokuje klucz przy nieprawidłowym; bez niego sync Allegro jest pomijany)`, `OCTOPIA_CLIENT_ID`, `OCTOPIA_CLIENT_SECRET`, `OCTOPIA_SELLER_ID` (marketplace'y typu Cdiscount; bez nich sync Octopia jest pomijany), `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_REFRESH_TOKEN` (bezpośrednia integracja SP-API, patrz niżej), `AMAZON_MARKETPLACE_IDS` (opcjonalnie), `AMAZON_ENDPOINT`/`AMAZON_USER_AGENT` (opcjonalnie), `ANTHROPIC_API_KEY` (asystent AI, zakładka AI — bez niego route `ai/ask` zwraca czytelny błąd; klucz z console.anthropic.com), `AI_MODEL` (opcjonalnie, domyślnie `claude-sonnet-5-5`), `UPS_CLIENT_ID`, `UPS_CLIENT_SECRET`, `UPS_ACCOUNT_NUMBER` (aplikacja z developer.ups.com, patrz sekcja UPS), `UPS_ENV` (`test` domyślnie / `production`), `QZ_TRAY_PRIVATE_KEY`
(klucz prywatny PEM do podpisywania żądań drukowania bezpośredniego — patrz sekcja Wysyłka; wklej wielolinijkowo,
kod sam usuwa literalne `\n`, gdyby jakiś krok po drodze spłaszczył PEM do jednej linii).
Zmiana zmiennej na Vercelu wymaga nowego deployu. W Supabase (Authentication → URL
Configuration) musi być aktualny adres produkcyjny, inaczej magic link nie zadziała.

## Rzeczy, o które trzeba dbać

- `.env.local` **nigdy** nie trafia do gita (jest w `.gitignore`). Nie wklejać prawdziwych
  kluczy do `.env.local.example`.
- **Migracje SQL uruchamia człowiek** w Supabase → SQL Editor (asystent ma tylko REST po
  service role, bez DDL). Po każdej zmianie schematu przypomnij, który plik uruchomić.
  Pliki `supabase/*.sql` są idempotentne i trzymają aktualny kształt tabel.
- Supabase (PostgREST) zwraca domyślnie **max 1000 wierszy** na zapytanie — przy większych
  tabelach paginuj przez `.range()` (tak robi cache Fakturowni).
- Synchronizacja zamówień BuyBack (`orders-sync`) idzie w **porcjach z kursorem** (`lib/scanOrders.ts`,
  `buyback_orders_sync_meta.scan_page`): pełny skan od 1 stycznia trwa kilka minut, więc po wyczerpaniu
  budżetu czasu zapisuje kursor i kontynuuje przy następnym wywołaniu (cron co 15 min albo "Odśwież").
  Skan jest ukończony tylko wtedy, gdy API samo zakończy listę. Powód: do 2026-09-25 twardy limit 200
  stron (x 10 zamówień) urywał pierwsze pobranie po cichu na 2000 zamówieniach (do 15 lutego) i oznaczał je
  jako gotowe, więc zamówień z marca–sierpnia w bazie nie było. Nie wracać do "limitu stron = koniec".
- **Realtime + synchronizacja:** listy zasilane masowo przez serwer (np. Zamówienia) nie mogą przeładowywać się po każdym
  zdarzeniu realtime — sync zapisuje setki wierszy naraz i przeglądarka dostaje "Failed to fetch". Zdarzenia zbieramy w jedno
  odświeżenie (debounce 1,5 s), a starsze odpowiedzi ignorujemy (`loadSeq`) — patrz `OrdersList` w `SalesOrdersHub.tsx`.
- **Duplikaty w paczce upsertu:** jedna operacja upsert nie może zawierać dwóch wierszy o tym samym kluczu (błąd "ON CONFLICT DO UPDATE
  command cannot affect row a second time"). Paczki pobranych zamówień mają duplikaty (kursor po dacie jest włączny; lista ze stronami
  przesuwa się w trakcie), więc każdy `saveOrders` w `app/api/orders/*-sync` przepuszcza dane przez `uniqueBy` (`lib/salesOrders.ts`) —
  zamówienia po id, pozycje po `external_id#item_key`. Nowy kanał musi robić to samo.
- Back Market najpewniej filtruje po IP — endpointów nie da się testować z sandboxa
  asystenta (401 nawet dla działających). Testuje się na Vercelu albo na komputerze
  właściciela.
- Cron Vercela liczy w UTC; "północ" polska to `23:00`/`22:00` UTC zależnie od czasu.
- Bidder: nie włączać drugiej instancji (np. starego programu) — nadpisywałyby sobie ceny.
- Przy każdej nowej funkcji: jedna zmiana na raz, sprawdzona przed przejściem dalej
  (`npx tsc --noEmit`, lokalnie `npm run dev`). Po każdej działającej zmianie: commit i push
  (Vercel deployuje z `main`).

## Plan rozwoju

1. ✅ Magazyn / inwentarz + podsumowanie z Fakturowni
2. ⬜ Zamówienia z marketplace (karta jak w Trade-in, ten sam wzorzec logu)
3. ✅ Serwis: rejestr napraw i punktacja · ⬜ Serwis jako moduł napraw sprzętu z magazynu
4. ✅ Bidder skupu Back Market (na produkcji)
5. ✅ Trade-in: zamówienia BuyBack + obsługa paczek z punktacją + rola "Trade-in"
6. 🟡 Karta produktu po numerze seryjnym: odczyt + log z testów/serwisu/Trade-in zrobione · ⬜ własne edytowalne dane produktu
7. ✅ Testy: rejestr i punktacja · ⬜ łączne podsumowanie miesięczne ze wszystkich obszarów
8. 🟡 Ewidencja czasu pracy (RCP): rejestracja, ewidencja, korekty zrobione (etap 1) · ✅ wnioski urlopowe i nieobecności (etap 3) · ⬜ grafik, nadgodziny, wydajność pkt/h i premia z regulaminu
9. ⬜ Integracje z kanałami sprzedaży (Allegro, eBay) — osobny etap, wymaga kluczy API
10. ⬜ Twarde uprawnienia per rola (RLS)
11. ⬜ Zwroty: rejestr fizycznej obsługi zwrotu (przyjęcie, ocena stanu, decyzja co dalej)
12. 🟡 Faktury: wystawianie faktur VAT w Fakturowni (ręczny przycisk), dane fakturowe (firma/NIP gdzie dostępne) ze
    wszystkich kanałów poza Amazon, numer wewnętrzny ERP/{nr}/{MM}/{YYYY} zrobione · ⬜ synchronizacja statusu
    płatności, ⬜ adres nabywcy dla Amazon (PII niedostępne bez Restricted Data Token), ⬜ procedura OSS/VAT-marża
    per kraj nabywcy (dziś jedna stała stawka)
13. ✅ Przegląd: dashboard sprzedaży (kafelki Dziś/30 dni, wykres dzienny, udział kanałów) + NBP: kursy walut do
    przeliczania na PLN (01.10.2026)
15. 🟡 Marża: lista sprzedanych sztuk z marżą (BM i refurbed; serwis z części) zrobiona · ⬜ pozostałe kanały (Allegro/Erli/Octopia/Amazon), koszty części/serwisu, PCC, eksport
14. 🟡 AI: asystent do pytań o dane (Admin, sprzedaż/zamówienia/magazyn) zrobiony · ⬜ pozostałe role, zakresy Zespół/Faktury/Wysyłki, zapis raportów, streaming
