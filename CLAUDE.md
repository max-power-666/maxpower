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
  sync zamówień BuyBack `*/15 * * * *`, sync zamówień sprzedaży Back Market i refurbed `*/15 * * * *` (osobne route'y). Autoryzacja crona: nagłówek `Bearer CRON_SECRET`.

## Struktura kodu

- `app/page.tsx` — jeden duży client component: logowanie, nawigacja, role, zakładki
  Przegląd / Magazyn / Zespół. Większe moduły są osobno w `app/_components/`:
  `ServiceView.tsx` (Serwis), `TestsView.tsx` (Testy), `ProductCardDrawer.tsx` (karta produktu), `TradeInHub.tsx` + `TradeInOrdersView.tsx` (Trade-in),
  `TradeInView.tsx` (Bidder), `SalesOrdersHub.tsx` (Zamówienia).
- `app/api/*/route.ts` — endpointy serwerowe (sekrety tylko tu, nigdy w przeglądarce):
  `fakturownia/sync`, `tradein/bidder`, `tradein/competitors`, `tradein/orders-sync`, `tradein/validate`, `orders/bm-sync`, `orders/refurbed-sync`.
- `lib/` — `supabaseClient.ts`, `buyback.ts` (logika biddera + `isAuthorized`),
  `displayName.ts` (skrócone imię: "Maksymilian J."), `workLog.ts` (interwały Dziś/7/30 dni,
  liczenie czasu i **etykiety typów czynności/statusów** — jedno źródło dla list i karty produktu),
  `search.ts` (`escapeLike` do wyszukiwania po numerze seryjnym), `scanOrders.ts` (stronicowany skan
  zamówień Back Market z budżetem czasu i kursorem).
- `supabase/*.sql` — schemat, każdy plik idempotentny: `schema.sql` (units, members,
  cache Fakturowni), `tradein.sql` (bidder), `buyback-orders.sql` (zamówienia + obsługa
  paczek), `sales-orders.sql` (zamówienia sprzedaży Back Market i refurbed), `service.sql` (rejestr napraw), `tests.sql` (rejestr testów).
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
| Zamówienia | `sales` | Admin, Manager |
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
  0 jest poprawną wartością), Numery seryjne padów (`pad_serials text[]`, element i = pad i+1; osobne pole na każdy pad, tyle ile wpisano w Pady, max 20; Enter w polu — skaner — zapisuje i przechodzi do następnego; nie wymagane do "Obsłużona"), Uwagi. **Warunek:** status "Obsłużona" wymaga numeru seryjnego, SKU i padów —
  pilnuje tego UI (`changeStatus`, komunikat co brakuje) i trigger `buyback_order_intake_require_complete`
  w bazie (sprawdza przy przejściu na "Obsłużona" i przy czyszczeniu pola w już obsłużonej paczce,
  więc stare obsłużone wiersze bez danych można uzupełniać po jednym polu).
- Kolumna **Dok.** = checkbox `docs` (boolean, domyślnie false; nie jest wymagana do "Obsłużona"; zmiany w logu jako "tak"/"nie").
- **Walidacja w Back Market przy "Obsłużona"** (`app/api/tradein/validate/route.ts`, `PUT /ws/buyback/v1/orders/{id}/validate`,
  bez body): najpierw ostrzeżenie (`confirm`: nieodwracalne, uruchamia wypłatę dla klienta, kwota, status BM), potem serwer
  waliduje w BM i dopiero po sukcesie zapisuje status paczki. Odmowa BM (np. status inny niż RECEIVED) = status się nie
  zmienia, błąd widać nad listą. Serwer nie ufa przeglądarce: wymaga zalogowanego użytkownika (sekret crona nie wystarcza)
  oraz kompletu numer seryjny/SKU/pady w bazie; zamówienie już VALIDATED/PAID/MONEY_TRANSFERED nie jest walidowane drugi raz
  (ponowna próba po błędzie zapisu statusu jest bezpieczna). Wynik ląduje w logu ("Walidacja Back Market: zwalidowano").
  Cofnięcie statusu paczki NIE cofa walidacji w BM. Mapper zamówienia jest wspólny: `lib/buybackOrders.ts`.
- Numer zamówienia jest linkiem do **karty zamówienia** (panel boczny): dane z API + dane
  pracownika (numer seryjny, SKU, pady, uwagi — edytowalne) + numerowany log zmian.
  Na górze karty link "Otwórz w Back Market" → `https://www.backmarket.fr/bo-seller/buyback/orders/{numer}`
  (jedna domena .fr dla wszystkich rynków).

**Zamówienia** (zakładka Zamówienia, `SalesOrdersHub.tsx`) — sprzedaż z marketplace'ów (NIE mylić z zakładką Trade-in,
która obsługuje skup). Dwie podstrony: *Zamówienia* — wspólna lista ze wszystkich kanałów (`sales_orders`, klucz
`marketplace` + `external_id`; kolumny z API: marketplace (etykieta z `MARKETPLACES` w `lib/salesOrders.ts`), nr zamówienia, data, status, nr przesyłki (`sales_orders.tracking_number`, tylko odczyt), SKU; **Nasz status** = wewnętrzny status realizacji `sales_orders.our_status` (nowe / w realizacji / wysłane, domyślnie nowe, select na liście, zmiana + log przez funkcję bazy `sales_order_set_status`; niezależny od statusu Back Market i nie jest z nim synchronizowany); dziś tylko Back Market; do tego dane pracownicze edytowane w wierszu: numer seryjny, pady i numery seryjne padów — jak w Trade-in, wspólny komponent `PadSerialsCell.tsx`; log zmian w `sales_orders.history`). **Dane pracownicze są per pozycja:** zamówienie ma jedną lub więcej pozycji (`sales_order_items`, jedna sztuka = jeden wiersz, ilość > 1 rozbijana; klucz `item_key` = id pozycji z API, `id-2`… dla kolejnych sztuk; `mapBmItems` w `lib/salesOrders.ts` i jednorazowe uzupełnienie w SQL muszą trzymać tę samą zasadę). Na liście każda pozycja ma własny wiersz (numer, data i status zamówienia to `rowSpan`). Zapis pozycji + wpis do logu to funkcja bazy `sales_item_update` (jedna transakcja, dopisanie do historii po stronie bazy); zespół zmienia tylko numer seryjny i pady — pola z API (SKU, kolejność, status zamówienia) tylko synchronizacja, pilnują tego triggery `*_protect_api_fields`, a upsert synchronizacji nie rusza kolumn pracowniczych; nad listą wyszukiwarka po numerze zamówienia (fragment, bez rozróżniania wielkości liter) i *BM raw data* —
wszystkie pola z API Back Market (`bm_orders`, kolumny nazwane jak w API + rozwijany JSON z pełną odpowiedzią, także
adresy). Sync: `app/api/orders/bm-sync` (`GET /ws/orders`, cron co 15 min + "Odśwież"): pełny skan od 1 stycznia
w porcjach z kursorem (`sales_orders_sync_meta`, wiersz per kanał), potem przyrostowo po `date_modification`; ten sam
`lib/scanOrders.ts` co przy skupie. Dodatkowo każdy przebieg odświeża pojedynczo (`GET /ws/orders/{id}`) do 25 zamówień w stanach
nieskończonych (0/10/1/3), nieodświeżanych od godziny — siatka bezpieczeństwa, gdyby `date_modification` pominęło zmianę statusu. Surowy status Back Market to kod stanu ("1", "3", "9"), etykiety w `lib/salesOrders.ts`
(`BM_ORDER_STATES`); API nie zwraca stanów 0 i 8. SKU = `orderlines[].listing`, kilka pozycji po przecinku.
Numer zamówienia na liście jest linkiem do **karty zamówienia** (`SalesOrderCard.tsx`, panel boczny): dane z API
(pozycje, daty, dostawa, adres dostawy — z surowej tabeli kanału), dane pracownicze (edytowalne) i numerowany log zmian;
edycje z listy i z karty trafiają do tego samego logu (wzór: karta zamówienia Trade-in). Na górze karty link "Otwórz w Back Market" (`https://www.backmarket.fr/bo-seller/orders/all?page=1&pageSize=10&endDate={dziś}&orderId={numer}`).
**refurbed** (`marketplace = 'refurbed'`, `lib/refurbed.ts`, `app/api/orders/refurbed-sync`, surowe dane w `refurbed_orders`): API tylko POST,
`https://api.refurbed.com/refb.merchant.v1.OrderService/ListOrders`, nagłówek `Authorization: Plain <token>`, limit 10 zapytań/s
(429 -> ponowienie), paginacja kursorem (`starting_after` = id, `has_more`), sortujemy po ID rosnąco. Numer zamówienia = `Order.id`,
data = `released_at`, status = `state` (NEW/ACCEPTED/SHIPPED/...; etykiety w `REFURBED_ORDER_STATES`), SKU = `items[].sku`; **każda
pozycja API to jedna sztuka** (klucz = `item.id`). "Nr przesyłki" to link `parcel_tracking_url` pozycji (refurbed nie ma numeru) — lista
pokazuje go jako "śledzenie". **refurbed nie ma filtra po dacie modyfikacji**, więc przyrostowo pobieramy (A) nowe po `released_at`
(z zapasem 10 min) i (B) ponownie zamówienia w stanach NEW/ACCEPTED/SHIPPED z ostatnich 60 dni; pełny skan od 1 stycznia idzie
z kursorem `sales_orders_sync_meta.scan_cursor`. Nie testowane na żywym API (brak tokena w środowisku asystenta) — zweryfikowane
na atrapie `fetch` wg swaggera (gitlab.com/refurbed-community/public-apis).
Nowy marketplace = nowa wartość `marketplace`, własna tabela surowa, własny mapper i sync; lista pozostaje wspólna.

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
  Escape porzuca. W Trade-in edycja trafia też do logu zmian karty zamówienia; zapisy z listy Trade-in idą
  jedną kolejką na najświeższym wierszu (szybkie skanowanie nie nadpisuje poprzednich pól).
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
`BACKMARKET_AUTH`, `BACKMARKET_LANG`, `BACKMARKET_UA`, `BACKMARKET_BASE_URL`, `REFURBED_API_TOKEN` (z supplier.refurbed.com; bez niego sync refurbed jest pomijany; nieużywany wygasa po 2 miesiącach), `REFURBED_UA`.
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
