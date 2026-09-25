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
  sync zamówień BuyBack `*/15 * * * *`. Autoryzacja crona: nagłówek `Bearer CRON_SECRET`.

## Struktura kodu

- `app/page.tsx` — jeden duży client component: logowanie, nawigacja, role, zakładki
  Przegląd / Magazyn / Zespół. Większe moduły są osobno w `app/_components/`:
  `ServiceView.tsx` (Serwis), `TestsView.tsx` (Testy), `ProductCardDrawer.tsx` (karta produktu), `TradeInHub.tsx` + `TradeInOrdersView.tsx` (Trade-in),
  `TradeInView.tsx` (Bidder).
- `app/api/*/route.ts` — endpointy serwerowe (sekrety tylko tu, nigdy w przeglądarce):
  `fakturownia/sync`, `tradein/bidder`, `tradein/competitors`, `tradein/orders-sync`.
- `lib/` — `supabaseClient.ts`, `buyback.ts` (logika biddera + `isAuthorized`),
  `displayName.ts` (skrócone imię: "Maksymilian J."), `workLog.ts` (interwały Dziś/7/30 dni,
  liczenie czasu i **etykiety typów czynności/statusów** — jedno źródło dla list i karty produktu),
  `search.ts` (`escapeLike` do wyszukiwania po numerze seryjnym), `scanOrders.ts` (stronicowany skan
  zamówień Back Market z budżetem czasu i kursorem).
- `supabase/*.sql` — schemat, każdy plik idempotentny: `schema.sql` (units, members,
  cache Fakturowni), `tradein.sql` (bidder), `buyback-orders.sql` (zamówienia + obsługa
  paczek), `service.sql` (rejestr napraw), `tests.sql` (rejestr testów).
- `scripts/import-buyback.mjs` — jednorazowy import ze starego programu Buyback Bidder.

## Zakładki i role

Role: **Admin, Manager, Magazyn, Serwis, Testy, Bidder**. Rolę nadaje Admin w zakładce Zespół (tam też
imię i nazwisko — `members.name`). Nowa osoba po pierwszym logowaniu dostaje pusty wiersz
w `members` i ekran "poproś administratora o rolę" (`NoRoleScreen`); sama roli nie wybiera.
Przegląd jest wspólną stroną startową. Mapa dostępu: `ROLE_ACCESS` w `app/page.tsx`.
Manager widzi wszystkie zakładki (Zespół tylko do odczytu), ale niczego nie usuwa i nie zmienia ról ani imion (to tylko Admin, także w bazie).
Rola jest zwykłym tekstem w `members.role` — dodanie roli nie wymaga SQL.

| Zakładka | Klucz widoku | Kto widzi |
|---|---|---|
| Przegląd | `overview` | wszyscy |
| Magazyn | `inventory` | Admin, Manager, Magazyn |
| Zespół | `team` | Admin (edycja), Manager (tylko odczyt) |
| Serwis | `service` | Admin, Manager, Serwis |
| Testy | `tests` | Admin, Manager, Testy |
| Bidder | `tradein` | Admin, Manager, Bidder |
| Trade-in | `orders` | Admin, Manager (nie ma jeszcze roli "Trade-in") |

Uwaga: nazwa zakładki "Bidder" to klucz `tradein`, a zakładka "Trade-in" to klucz `orders` —
historyczne, nie mylić. Aktywna zakładka jest zapamiętywana w `localStorage`.

## Model danych i moduły

**Magazyn.** Zakładka ma dwa podwidoki: *Podsumowanie* (liczba sztuk ze `stock_level = 1`, wartość
wg **ceny zakupu brutto** — `price_gross` jest w Fakturowni puste dla prawie wszystkich sztuk —
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

Ręczna ewidencja sztuk w tabeli `units` została **wycofana z Magazynu** na prośbę właściciela
i jej kod usunięto z `page.tsx` (lista, dodawanie, panel szczegółów, `CATEGORIES` z polami per
kategoria). Sama tabela `units` zostaje w `schema.sql`, a zakładka Przegląd wciąż liczy z niej
cztery kafelki (dziś same zera, bo nic do niej nie zapisuje). Planowana karta towaru z magazynu
ma ją zastąpić (wzorzec: karta zamówienia Trade-in) — wtedy kafelki Przeglądu trzeba przełączyć
na nowe źródło.

**Bidder** (zakładka Bidder, `TradeInView.tsx`). Automat cen skupu Back Market (DE/ES/FR/IT):
dla każdego SKU ustawia chwilowo 10 €, czyta `price_to_win` i ustawia `min(price_to_win, cena max)`.
Tabele `buyback_skus`, `buyback_runs`, `buyback_log`, `buyback_price_history`,
`buyback_settings` (`tradein.sql`). Logika `lib/buyback.ts`, route `tradein/bidder`
(GET = cron, POST = "Uruchom teraz"). Przebieg (~135 SKU × ~3 s) dzielony na "ticki" po
max ~2 min; kursor to `last_attempt_at < run.started_at`. `in_progress_since` pilnuje
przywrócenia cen po ubitej funkcji. Historia cen tylko przy zmianie ceny. Stary program na
Macu jest wyłączony; bidder działa na produkcji, włącznik: `buyback_settings.enabled`.

**Trade-in** (zakładka Trade-in, `TradeInHub.tsx`) — dwa podwidoki:
- *Raw data*: podgląd zsynchronizowanych zamówień BuyBack (`buyback_orders`, sync co 15 min
  z `GET /ws/buyback/v1/orders`: pełny skan od 1 stycznia przez `creationDate` w porcjach z kursorem,
  potem przyrostowo przez `modificationDate` — łapie nowe i zmiany statusu). Zapis tylko serwer.
- *Wprowadzanie*: obsługa paczek przez pracowników. Pracownik podaje numer zamówienia LUB
  przesyłki, aplikacja znajduje zamówienie (`buyback_order_intake`, unikalne na
  `order_public_id` — ta sama paczka nie zaliczy się dwa razy). Status:
  W trakcie / Obsłużona / Problem, czas obsługi, punkty 100/6 za paczkę tylko po
  "Obsłużona", podsumowanie punktacji Dziś/7/30 dni. Numer przesyłki służy tylko do
  znalezienia zamówienia przy rozpoczynaniu (w liście nie ma kolumny przesyłki; jest na karcie).
- Kolumny edytowane w wierszu: Numer seryjny, SKU, Pady (liczba padów w zestawie — konsole; int >= 0,
  0 jest poprawną wartością), Nr seryjny padów (`pad_serials`, jedno pole tekstowe, kilka numerów po przecinku; widoczne tylko gdy Pady > 0; nie jest wymagane do "Obsłużona"), Uwagi. **Warunek:** status "Obsłużona" wymaga numeru seryjnego, SKU i padów —
  pilnuje tego UI (`changeStatus`, komunikat co brakuje) i trigger `buyback_order_intake_require_complete`
  w bazie (sprawdza przy przejściu na "Obsłużona" i przy czyszczeniu pola w już obsłużonej paczce,
  więc stare obsłużone wiersze bez danych można uzupełniać po jednym polu).
- Numer zamówienia jest linkiem do **karty zamówienia** (panel boczny): dane z API + dane
  pracownika (numer seryjny, SKU, pady, uwagi — edytowalne) + numerowany log zmian.
  Na górze karty link "Otwórz w Back Market" → `https://www.backmarket.fr/bo-seller/buyback/orders/{numer}`
  (jedna domena .fr dla wszystkich rynków).

**Serwis** (`ServiceView.tsx`, `service_log`). Rejestr napraw wg tabeli z regulaminu:
Joy-Con para 15 pkt, kontroler PS4 25, Xbox One 35, PS5 12, czyszczenie konsoli 45.
Jeden wiersz = jedna naprawa: `started_at`, status (w_naprawie / naprawiony / uszkodzony),
`finished_at`. Pracownik = zawsze zalogowana osoba (nie do wyboru). Wpisy może usuwać
tylko Admin (przycisk "Usuń", tak samo w Testach i Trade-in). Podsumowanie punktacji u góry (Dziś/7/30 dni) liczy tylko "naprawiony".

**Testy** (`TestsView.tsx`, `test_log`). Rejestr testów urządzeń: pole numer seryjny +
"Rozpocznij test". Jeden wiersz = jeden test: status (w_trakcie / przetestowane / przerwany),
czas, punkty 200/13 (= 100/6,5) po "przetestowane", bez zaokrąglania. To samo urządzenie nie
może mieć dwóch aktywnych wpisów naraz (indeks częściowy na `serial_number`); test
"przerwany" nie blokuje ponownego podejścia. Punkty są niezależne od wyniku testu (sprawny /
wadliwy) — do potwierdzenia z właścicielem.

**Karta produktu** (`ProductCardDrawer.tsx`). Klik w numer seryjny w Testach, Serwisie, Trade-in (strzałka ↗
przy polu) albo w Magazynie → Raw data otwiera panel. Nie ma własnej tabeli: składa się na żywo z
`fakturownia_stock_cache` (magazyn), `buyback_orders` (zamówienie z opisu sztuki lub z obsługi paczki),
`test_log`, `service_log` (po `device_ref`) i `history` z `buyback_order_intake`. **Log** to te zdarzenia
w kolejności czasu ("Test rozpoczęty przez…", "Serwis (…) zakończony: Naprawiony", zmiany w Trade-in).
Numery łączy bez rozróżniania wielkości liter, ale muszą być wpisane identycznie w każdym module.
Nie ma jeszcze własnych, edytowalnych danych produktu — to odczyt.

## Regulamin premiowania (12.10.2026) — co z niego wynika dla kodu

Zasady, które kształtują Serwis i Trade-in (pełny PDF ma właściciel):
- punkty tylko po **prawidłowym zakończeniu** procesu (§2 ust. 4) → liczymy dopiero dla
  statusu końcowego "naprawiony" / "obsłużona";
- jedna paczka/urządzenie zaliczone **raz**, zakaz przypisywania sobie cudzej pracy i
  wielokrotnego rejestrowania (§2 ust. 3, §9) → unikalność paczki, pracownik z sesji,
  usuwanie wpisów tylko przez Admina z zapisem w `deleted_records`;
- Trade-in i testerzy: dokładne ułamki (100/6 pkt za paczkę, 100/6,5 za urządzenie), **bez
  zaokrąglania** przed ustaleniem progu (§2 ust. 7, §4 ust. 8);
- "Czas" naprawy/paczki jest **tylko informacyjny** — wydajność w regulaminie to punkty /
  godziny *przepracowane* z ewidencji czasu pracy (§4), nie suma czasów zadań.

Świadomie **nie zrobione**: kwota premii w zł, wydajność pkt/h, wskaźnik kwalifikacyjny 90%
(§4-§7) — wymagają ewidencji godzin pracy, urlopów i nieobecności, której apka nie ma.
Punkty z różnych obszarów mają się sumować w jeden wynik
miesięczny (§2 ust. 6) — dziś każdy obszar ma osobną tabelę i podsumowanie.

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
  Escape porzuca. W Trade-in edycja trafia też do logu zmian karty zamówienia.
- **Cykl życia rekordu:** status + `started_at`/`finished_at`, `finished_at` czyszczone przy
  powrocie do statusu początkowego (wzór: `service_log`, `buyback_order_intake`).

## Uprawnienia

Filtrowanie zakładek według roli to **tylko UI** (chowa pozycje w menu). RLS w Supabase
nadal pozwala każdemu `authenticated` czytać prawie wszystko, a wiele tabel także zapisywać
(`units`, ceny max i włącznik biddera, wpisy w `service_log`, `test_log`, `buyback_order_intake`).
To świadomy stan MVP — twarde uprawnienia per rola są zaplanowane.

**Twarde (w bazie, działają też przy wołaniu API bez UI) są dziś tylko:**
- `is_admin()` (SECURITY DEFINER, `schema.sql`) — sprawdza rolę Admin w `members`;
- usuwanie wpisów w Serwisie, Testach i Trade-in: tylko Admin, a każde usunięcie zapisuje trigger
  `audit_delete()` w `deleted_records` (cały wiersz jako json, kto, kiedy; odczyt tylko Admin — brak UI,
  przegląd w Supabase → Table Editor);
- `members`: role i imiona zmienia tylko Admin, a nowa osoba może założyć wyłącznie własny wiersz
  z pustą rolą. Bez tego każdy mógłby nadać sobie Admina i obejść resztę.
Pliki SQL innych modułów używają `is_admin()`, więc `schema.sql` musi być uruchomiony pierwszy.
Ważne przy Bidderze: zmienia ceny na żywym Back Markecie, więc to pierwszy kandydat do kolejnego zaostrzenia.

## Zmienne środowiskowe (tylko nazwy; wartości w `.env.local` i w Vercel)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`CRON_SECRET`, `FAKTUROWNIA_DOMAIN` (sama subdomena, np. `recoo`), `FAKTUROWNIA_API_TOKEN`,
`BACKMARKET_AUTH`, `BACKMARKET_LANG`, `BACKMARKET_UA`, `BACKMARKET_BASE_URL`.
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
5. ✅ Trade-in: zamówienia BuyBack + obsługa paczek z punktacją · ⬜ rola "Trade-in"
6. 🟡 Karta produktu po numerze seryjnym: odczyt + log z testów/serwisu/Trade-in zrobione · ⬜ własne edytowalne dane produktu
7. ✅ Testy: rejestr i punktacja · ⬜ łączne podsumowanie miesięczne ze wszystkich obszarów
8. ⬜ Ewidencja czasu pracy → wydajność pkt/h i premia z regulaminu
9. ⬜ Integracje z kanałami sprzedaży (Allegro, eBay) — osobny etap, wymaga kluczy API
10. ⬜ Twarde uprawnienia per rola (RLS)
