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
  `TradeInView.tsx` (Bidder), `SalesOrdersHub.tsx` (Zamówienia, karta zamówienia w `SalesOrderCard.tsx`), `ErliParcelPanel.tsx` (nadawanie Paczkomatów InPost 24/7 przez Erli, osadzony na karcie zamówienia Erli), `ShippingView.tsx` (Wysyłka DHL).
- `app/api/*/route.ts` — endpointy serwerowe (sekrety tylko tu, nigdy w przeglądarce):
  `fakturownia/sync`, `tradein/bidder`, `tradein/competitors`, `tradein/orders-sync`, `tradein/validate`, `orders/bm-sync`, `orders/refurbed-sync`, `orders/erli-sync`, `orders/allegro-sync`, `orders/allegro-auth`, `orders/allegro-callback`, `orders/octopia-sync`, `orders/amazon-sync`, `orders/validate`, `orders/bm-refresh`, `orders/erli-refresh`, `shipping/dhl-express/{check,create}`, `shipping/dhl-parcel/{check,create,label,cancel}`, `shipping/erli/{create,label,cancel}`, `shipping/sync-marketplace`, `shipping/render-zpl`, `shipping/fetch-remote-pdf`, `shipping/qz-sign`.
- `lib/` — `supabaseClient.ts`, `buyback.ts` (logika biddera + `isAuthorized`),
  `displayName.ts` (skrócone imię: "Maksymilian J."), `workLog.ts` (interwały Dziś/7/30 dni,
  liczenie czasu i **etykiety typów czynności/statusów** — jedno źródło dla list i karty produktu),
  `search.ts` (`escapeLike` do wyszukiwania po numerze seryjnym), `scanOrders.ts` (stronicowany skan
  zamówień Back Market z budżetem czasu i kursorem).
- `supabase/*.sql` — schemat, każdy plik idempotentny: `schema.sql` (units, members,
  cache Fakturowni), `tradein.sql` (bidder), `buyback-orders.sql` (zamówienia + obsługa
  paczek), `backlog.sql` (zakładka Backlog), `shipping.sql` (Wysyłka: nadawca, szablony, przesyłki), `sales-orders.sql` (zamówienia sprzedaży Back Market, refurbed, Erli, Allegro, Octopia i Amazon, plus archiwum Apilo; tokeny OAuth), `service.sql` (rejestr napraw), `tests.sql` (rejestr testów).
- `scripts/import-buyback.mjs` — jednorazowy import ze starego programu Buyback Bidder.

## Zakładki i role

Role: **Admin, Manager, Magazyn, Zamówienia, Serwis, Testy, Bidder, Trade-in**. Rolę nadaje Admin w zakładce Zespół (tam też
imię i nazwisko — `members.name`). Nowa osoba po pierwszym logowaniu dostaje pusty wiersz
w `members` i ekran "poproś administratora o rolę" (`NoRoleScreen`); sama roli nie wybiera.
Rola odświeża się sama po nadaniu/zmianie przez Admina (realtime na `members` — wymaga bloku publikacji z `schema.sql`;
do tego odczyt przy powrocie do karty i co 15 s na ekranie "brak roli"). Błąd odczytu roli to NIE brak roli — pokazujemy "Spróbuj ponownie".
Przegląd jest wspólną stroną startową. Mapa dostępu: `ROLE_ACCESS` w `app/page.tsx`.
Manager widzi wszystkie zakładki (Zespół tylko do odczytu), ale niczego nie usuwa i nie zmienia ról ani imion (to tylko Admin, także w bazie).
Rola jest zwykłym tekstem w `members.role` — dodanie roli nie wymaga SQL.

| Zakładka | Klucz widoku | Kto widzi |
|---|---|---|
| Przegląd | `overview` | wszyscy |
| Magazyn | `inventory` | Admin, Manager, Magazyn |
| Zamówienia | `sales` | Admin, Manager, Zamówienia |
| Backlog | `backlog` | wszyscy (każda rola) |
| Wysyłka | `shipping` | Admin, Manager, Zamówienia |
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
w `app/page.tsx`) — Admin może go nadpisać dla KAŻDEJ osoby z osobna w zakładce Zespół: przy każdym członku zespołu
checkbox przy każdej zakładce, zapisywane w `members.view_access` (`text[]`, `null` = jeszcze nikt nie dotykał, więc
liczy się domyślny zestaw dla roli). `effectiveAccess(role, viewAccess)` w `app/page.tsx` liczy efektywny dostęp
(nadpisanie, jeśli jest, inaczej `ROLE_ACCESS[role]`) i jest jedynym miejscem, które o tym decyduje — użyte zarówno
przy filtrowaniu nawigacji/gate'owaniu widoku dla zalogowanej osoby, jak i przy renderowaniu checkboxów w Zespole
dla każdego wiersza. "Przegląd" jest zawsze wymuszony (checkbox zablokowany, zaznaczony) — nie da się nikogo całkiem
zablokować z aplikacji. Przycisk "Resetuj do domyślnych (rola)" czyści nadpisanie (`view_access = null`) — zmiana
samej roli NIE resetuje automatycznie nadpisania (świadomie, żeby poprawka literówki w roli nie kasowała starannie
dobranego dostępu; do zresetowania służy ten przycisk). Nadal tylko UI (RLS pozwala każdemu `authenticated` na
wszystko) — twarde uprawnienia per rola są w planie rozwoju, punkt 10.

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
- *Raw data* (`TradeInOrdersView.tsx`): podgląd zsynchronizowanych zamówień BuyBack (`buyback_orders`, sync co 15 min
  z `GET /ws/buyback/v1/orders`: pełny skan od 1 stycznia przez `creationDate` w porcjach z kursorem,
  potem przyrostowo przez `modificationDate` — łapie nowe i zmiany statusu). Zapis tylko serwer. Lista jest
  stronicowana po stronie serwera (`.range()`, 10/20/50, przyciski Poprzednia/Następna — 30.09.2026, wcześniej
  `.limit()` bez offsetu pokazywał zawsze tylko pierwszą stronę z 17 tys.+ zamówień, wzorzec jak w `InventoryRawView.tsx`).
  Pigułki filtra **Wszystkie / Wysłane** nad listą (30.09.2026, `smallPill` jak w `SalesOrdersHub.tsx`) — "Wysłane"
  to `.eq("status", "SENT")` (surowy status BuyBack API, `buyback_orders.status`; wartości potwierdzone na żywych
  danych: `TO_SEND`/`SENT`/`RECEIVED`/`PAID`/`MONEY_TRANSFERED`/`VALIDATED`/`CANCELED`/`SUSPENDED`/
  `COUNTER_PROPOSAL` — na razie bez własnego mappera etykiet, status pokazuje się na liście surowy). Zmiana filtra
  resetuje stronę na 1, jak zmiana rozmiaru strony.
  Nad listą kafelki **Zamówienia dzisiaj / wczoraj** (`TradeInDaySummary`, po dacie utworzenia, podział na rynek
  DE/ES/FR/IT zamiast marketplace'u — analogiczny wzorzec do `DaySummary` w `SalesOrdersHub.tsx`, ale bez filtrowania
  statusów, bo to skup, nie sprzedaż).
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
`marketplace` + `external_id`; kolumny z API: marketplace (etykieta z `MARKETPLACES` w `lib/salesOrders.ts`), nr zamówienia, data, status, **Kraj** (`sales_orders.country_code`, kod ISO 3166-1 alpha-2 odbiorcy/adresu dostawy, tylko odczyt, chroniony jak inne pola API; źródło per kanał: Back Market `shipping_address.country`, refurbed `shipping_address.country_code`, Erli `user.deliveryAddress.country`, Allegro `delivery.address.countryCode`, Octopia pierwsza pozycja z `lines[].shippingAddress.countryCode` — adres jest tylko per-pozycja, Amazon `ShippingAddress.CountryCode`; wartość spoza wzorca dwóch liter albo brak adresu -> `null`, pokazane jako "—"; **zamówienia zsynchronizowane przed dodaniem tej kolumny mają go uzupełnionego jednorazowym `update` w `sales-orders.sql` z już zapisanych surowych danych** — przyrostowa synchronizacja rusza tylko zmienione zamówienia, więc same by go nie dostały), **Metoda wysyłki** (`sales_orders.shipping_method`, tylko odczyt; na razie tylko Back Market — inne kanały `null`, pokazane jako "—") — Back Market API nie ma osobnego pola "standard/express"; jedyny sygnał to `shipper_display` (nazwa przewoźnika/usługi wybrana dla zamówienia, już ustalona ZANIM cokolwiek wyślemy — nie echo naszego zgłoszenia), potwierdzone na żywych danych: "DHL" dla zdecydowanej większości zamówień, "DHL Express" dla nielicznych — `bmShippingMethodLabel` w `lib/salesOrders.ts` rozpoznaje "Express"/"Standard" po słowie "express" w nazwie (nie po sztywnej liście przewoźników, żeby nowy przewoźnik bez "express" w nazwie sam trafił do "Standard"; etykiety skrócone z "Ekspresowa"/"Standardowa" 30.09.2026 na prośbę właściciela); `delivery_mode` to coś zupełnie innego (HOME_DELIVERY/COLLECTION_POINT — sposób ODBIORU, pokazywany na karcie zamówienia jako "Sposób dostawy", nie mylić). Uzupełnienie dla starych wierszy jest w `sales-orders.sql` (ten sam wzorzec co przy numerze przesyłki — odświeża się przy każdym uruchomieniu pliku, nie tylko raz). **Planowana wysyłka** (`sales_orders.planned_shipping_date`, tylko odczyt, dodana 30.09.2026 na prośbę właściciela) — termin wysyłki wg kanału, **tylko dwa kanały to udostępniają** (sprawdzone na żywych danych z każdej z pięciu surowych tabel przed dodaniem kolumny, nie zgadywane): Back Market `expected_dispatch_date` (populowane przed wysyłką, **znika/`null` po realnym nadaniu** — wtedy realny termin już niesie `date_shipping`/nr przesyłki, nie ta kolumna) i Amazon `LatestShipDate` (deadline ustalony na starcie zamówienia, **zostaje widoczny nawet po `OrderStatus = "Shipped"`** — inaczej niż Back Market, potwierdzone na żywym zamówieniu). refurbed, Erli, Allegro i Octopia nie mają odpowiednika w swoim API (sprawdzone: `raw` zamówienia, `delivery`/`fulfillment` u Erli/Allegro) — kolumna zawsze `null`, pokazane jako "—". Uzupełnienie dla starych wierszy w `sales-orders.sql`, ten sam wzorzec co przy pozostałych kolumnach dosyntezowanych po fakcie. Kolumna na liście ma mniejszą czcionkę (`text-xs`, jak "Data zamówienia" i "Nr zamówienia" obok niej), a "Nr zamówienia" dostało też ograniczoną szerokość z obcinaniem (`truncate`, pełny numer w `title` na najechanie) — na prośbę właściciela, długie UUID-y Allegro rozciągały kolumnę. SKU. **Nr przesyłki i "Etap" (kubełek statusu, patrz niżej) ukryte z listy 30.09.2026** — na prośbę właściciela, żeby lista była mniej zatłoczona; dane
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
skutek uboczny nadania to `notifyMarketplace` (patrz niżej); do tego dane pracownicze edytowane w wierszu: numer seryjny, pady i numery seryjne padów — jak w Trade-in, wspólny komponent `PadSerialsCell.tsx`; log zmian w `sales_orders.history`). **Dane pracownicze są per pozycja:** zamówienie ma jedną lub więcej pozycji (`sales_order_items`, jedna sztuka = jeden wiersz, ilość > 1 rozbijana; klucz `item_key` = id pozycji z API, `id-2`… dla kolejnych sztuk; `mapBmItems` w `lib/salesOrders.ts` i jednorazowe uzupełnienie w SQL muszą trzymać tę samą zasadę). Na liście każda pozycja ma własny wiersz (numer, data i status zamówienia to `rowSpan`). Zapis pozycji + wpis do logu to funkcja bazy `sales_item_update` (jedna transakcja, dopisanie do historii po stronie bazy); zespół zmienia tylko numer seryjny i pady — pola z API (SKU, kolejność, status zamówienia) tylko synchronizacja, pilnują tego triggery `*_protect_api_fields`, a upsert synchronizacji nie rusza kolumn pracowniczych; nad listą wyszukiwarka po numerze zamówienia (fragment, bez rozróżniania wielkości liter), pigułki filtra po marketplace (Wszystkie + każdy aktywny kanał z `MARKETPLACES` poza Apilo — integracja wycofana, filtrowanie po niej nie ma sensu, ale etykieta w `MARKETPLACES` zostaje dla podpisu na liście, własny wiersz nad Pagerem)
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
Nie testowane na żywym API (brak danych dostępowych w środowisku asystenta) — zweryfikowane na atrapie `fetch` wg specyfikacji OpenAPI (developer.octopia-io.net).
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
nadana" zostają jako ręczny fallback (np. gdyby auto-druk się nie udał). **Nazwy drukarek** (dokładnie jak w Windowsie) w `shipping_settings.zebra_printer_name`/`a4_printer_name` —
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
paletach). Connect Plus w DHL24 obsługuje przesyłki wieloelementowe (do 15 sztuk), ale nasza integracja zawsze
wysyła jedną paczkę — to i tak działa (przesyłka jednoelementowa jest prawidłowym przypadkiem tego produktu), tylko
nie wykorzystuje jego przewagi nad Connect/International;
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

**Erli — Paczkomaty InPost 24/7** (`lib/erliShipping.ts`, `app/api/shipping/erli/{create,label,cancel}`, `ErliParcelPanel.tsx`) — trzeci, zupełnie inny sposób nadawania: to **Erli** zleca przesyłkę InPost na SWOIM koncie/rozliczeniu (`POST /shipping/parcels/` w tym samym "Marketplace API" co synchronizacja zamówień — ten sam `ERLI_API_KEY`/`ERLI_UA`, żadnych nowych zmiennych), nie my przez DHL. Dlatego przycisk **"Nadaj przez Erli (Paczkomat) →" siedzi wprost na karcie zamówienia Erli** (`SalesOrderCard.tsx`), nie w zakładce Wysyłka — widoczny tylko gdy klient faktycznie wybrał punkt InPost przy składaniu zamówienia w Erli (`order.raw.delivery.pickupPlace.provider === "inpost"`). **Adresu odbiorcy nie podajemy wcale** — Erli bierze go z zamówienia; wystarczy waga/wymiary (szablon albo ręcznie), w **milimetrach i gramach** (limity API: 1–2000 mm, 10–700 000 g), nie cm/kg jak w DHL — konwersja w `app/api/shipping/erli/create`. `typeId` = `erliPaczkomat` (pełny słownik metod: `GET /dictionaries/shippingMethods`, nieużywany — mamy tylko tę jedną). **Etykieta i numer śledzenia nie wracają od razu** przy tworzeniu — trzeba dopytać `POST /shipping/parcels/_search` (filter `field:"orderId", operator:"="`), ten sam wzorzec co "Pobierz etykietę ponownie" przy DHL Parcel; `notifyMarketplace` (patrz wyżej) tu nie ma zastosowania (to nie DHL). **Nadanie NIE musi wcale ruszyć pola `updated` zamówienia po stronie Erli** — okazało się błędnym założeniem (do 30.09.2026 dokumentacja tu mówiła "numer śledzenia i tak sam dojdzie przy kolejnej synchronizacji", bez pokrycia na żywych danych): zwykły cykliczny skan (`orders/erli-sync`) idzie kursorem po `updated`, więc zamówienie z realnie nadaną przesyłką (przez naszą integrację ALBO całkiem poza naszą aplikacją, np. wprost z panelu Erli) mogło zostać trwale niewidoczne dla tego skanu — ten sam wzorzec problemu co przy zmianie statusu płatności (`erli_paid`, patrz `orders/erli-sync/route.ts`). Zgłoszone przez właściciela 30.09.2026 na kilku takich zamówieniach (część sprzed prawie roku). Naprawione dwutorowo: **(1)** `app/api/orders/erli-refresh` — dogrywa NA ŻĄDANIE jedno zamówienie (`POST /orders/_search`, filter `field:"id", operator:"="`) i odświeża jego wiersz w `erli_orders`/`sales_orders`/`sales_order_items` (analogiczne do `bm-refresh` dla Back Marketu), wołane automatycznie (best-effort) zaraz po udanym nadaniu w `shipping/erli/create`; **(2)** przycisk **"Odśwież status z Erli ↻"** na karcie KAŻDEGO zamówienia Erli (`SalesOrderCard.tsx`, obok plakietki statusu) — dla zamówień wysłanych całkiem poza naszą integracją, gdzie nie ma żadnego momentu, w którym moglibyśmy odświeżyć automatycznie. **Anulowanie działa** (`DELETE /shipping/parcels/{id}`), dopóki przesyłka nie trafiła do sieci InPost — tak jak DHL Parcel, żaden test/sandbox nie istnieje, każde nadanie jest prawdziwe i płatne. **Bez migracji SQL:** carrier (`erli_paczkomat`) i product_code w `shipments` to zwykły tekst bez ograniczeń; id paczki Erli (potrzebny do anulowania) trzyma się w istniejącej kolumnie `charges` (`{erli_parcel_id}`) zamiast dodawać nową kolumnę tylko dla tego pola — stąd `dhlCharge()` w `ShippingView.tsx` sprawdza `Array.isArray` przed odczytem ceny DHL, żeby nie wywalić się na innym kształcie danych Erli. Nie testowane na żywym API (brak danych dostępowych w środowisku asystenta) — zweryfikowane na atrapie `fetch` wg `swagger.json` (`erli.pl/svc/shop-api/doc/swagger.json`).

**RCP** (`RcpView.tsx`) — rejestracja czasu pracy; **na razie tylko pusta zakładka-szkielet**, widoczna dla wszystkich ról. Docelowo z niej ma wyjść ewidencja godzin
potrzebna do wydajności (punkty na godzinę) i premii z regulaminu (plan rozwoju, punkt 8).

**Zwroty** (`ReturnsView.tsx`) — **na razie tylko pusta zakładka-szkielet** (dodana 30.09.2026), widoczna dla wszystkich ról, ten sam wzorzec co RCP.
Docelowo: rejestr fizycznej obsługi zwrotu (przyjęcie zwróconej paczki, sprawdzenie stanu sprzętu, decyzja co dalej — powrót do magazynu / naprawa /
utylizacja), wzorem Serwisu/Testów/Trade-in — **nie** zestawienie zwrotów z marketplace'ów (te już są widoczne w Zamówieniach jako część kubełka
"Anulowane", patrz `statusBucket`/`CANCELLED_STATUS` w `lib/salesOrders.ts`).

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
`BACKMARKET_AUTH`, `BACKMARKET_LANG`, `BACKMARKET_UA`, `BACKMARKET_BASE_URL`, `REFURBED_API_TOKEN` (z supplier.refurbed.com; bez niego sync refurbed jest pomijany; nieużywany wygasa po 2 miesiącach), `REFURBED_UA`, `ERLI_API_KEY` (panel Erli: Metoda integracji > Własna integracja po API; bez niego sync Erli jest pomijany), `ERLI_UA`, `ALLEGRO_CLIENT_ID`, `ALLEGRO_CLIENT_SECRET` (aplikacja z apps.developer.allegro.pl), `ALLEGRO_REDIRECT_URI` (opcjonalny, sztywny adres przekierowania), `DHL_PARCEL_USERNAME` (klucz APIv2 z panelu DHL24), `DHL_PARCEL_PASSWORD`, `DHL_PARCEL_SAP` (numer klienta SAP, 7 cyfr; tylko w env), `DHL_EXPRESS_API_KEY`, `DHL_EXPRESS_API_SECRET`, `DHL_EXPRESS_ACCOUNT` (numer konta nadawcy DHL Express — tylko w env, nie w repo), `DHL_EXPRESS_ENV` (`test` domyślnie / `production`), `DHL_EXPRESS_LABEL_TEMPLATE` (opcjonalnie, domyślnie `ECOM26_64_001`), `ALLEGRO_UA` (**wymagany**, bez wartości domyślnej: User-Agent z generatora w panelu aplikacji — Allegro blokuje klucz przy nieprawidłowym; bez niego sync Allegro jest pomijany)`, `OCTOPIA_CLIENT_ID`, `OCTOPIA_CLIENT_SECRET`, `OCTOPIA_SELLER_ID` (marketplace'y typu Cdiscount; bez nich sync Octopia jest pomijany), `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_REFRESH_TOKEN` (bezpośrednia integracja SP-API, patrz niżej), `AMAZON_MARKETPLACE_IDS` (opcjonalnie), `AMAZON_ENDPOINT`/`AMAZON_USER_AGENT` (opcjonalnie), `QZ_TRAY_PRIVATE_KEY`
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
8. ⬜ Ewidencja czasu pracy → wydajność pkt/h i premia z regulaminu
9. ⬜ Integracje z kanałami sprzedaży (Allegro, eBay) — osobny etap, wymaga kluczy API
10. ⬜ Twarde uprawnienia per rola (RLS)
11. ⬜ Zwroty: rejestr fizycznej obsługi zwrotu (przyjęcie, ocena stanu, decyzja co dalej)
