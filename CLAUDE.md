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
  `fakturownia/sync`, `tradein/bidder`, `tradein/competitors`, `tradein/orders-sync`, `tradein/validate`, `orders/bm-sync`, `orders/refurbed-sync`, `orders/erli-sync`, `orders/allegro-sync`, `orders/allegro-auth`, `orders/allegro-callback`, `orders/octopia-sync`, `orders/amazon-sync`, `orders/validate`, `shipping/dhl-express/{check,create}`, `shipping/dhl-parcel/{check,create,label,cancel}`, `shipping/erli/{create,label,cancel}`, `shipping/sync-marketplace`.
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

Role: **Admin, Manager, Magazyn, Zamówienia, Serwis, Testy, Bidder**. Rolę nadaje Admin w zakładce Zespół (tam też
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
`marketplace` + `external_id`; kolumny z API: marketplace (etykieta z `MARKETPLACES` w `lib/salesOrders.ts`), nr zamówienia, data, status, **Kraj** (`sales_orders.country_code`, kod ISO 3166-1 alpha-2 odbiorcy/adresu dostawy, tylko odczyt, chroniony jak inne pola API; źródło per kanał: Back Market `shipping_address.country`, refurbed `shipping_address.country_code`, Erli `user.deliveryAddress.country`, Allegro `delivery.address.countryCode`, Octopia pierwsza pozycja z `lines[].shippingAddress.countryCode` — adres jest tylko per-pozycja, Amazon `ShippingAddress.CountryCode`; wartość spoza wzorca dwóch liter albo brak adresu -> `null`, pokazane jako "—"; **zamówienia zsynchronizowane przed dodaniem tej kolumny mają go uzupełnionego jednorazowym `update` w `sales-orders.sql` z już zapisanych surowych danych** — przyrostowa synchronizacja rusza tylko zmienione zamówienia, więc same by go nie dostały), nr przesyłki (`sales_orders.tracking_number`, tylko odczyt), SKU; **Nasz status** = wewnętrzny status realizacji `sales_orders.our_status` (nowe / w realizacji / wysłane / anulowane, domyślnie nowe, select na liście, zmiana + log przez funkcję bazy `sales_order_set_status`; niezależny od statusu marketplace'u i nie jest z nim synchronizowany — "anulowane" to też tylko nasze pole, nic z niego nie wraca do kanału). **28.09.2026: jednorazowe porządki** (uruchomione ręcznie w Supabase SQL Editor, poza plikami schematu — nie powtarzają się same przy kolejnych migracjach) ustawiły "Wysłane"/"Anulowane" na starszych zamówieniach, których surowy status kanału już na to wskazywał (Back Market "9"/`cancelled`, refurbed `SHIPPED`/`CANCELLED`, Erli `cancelled`, Allegro `CANCELLED`, Octopia `Shipped`/`Cancelled`, Amazon `Shipped`/`Canceled`), bez żadnego wywołania API do marketplace'u — dalej "Nasz status" ustawia się wyłącznie ręcznie albo automatycznie (patrz akapit o nadaniu przesyłki niżej). **Zmiana na "w realizacji" akceptuje zamówienie u marketplace'u** (`app/api/orders/validate/route.ts`, wołane z `changeOurStatus` w `SalesOrdersHub.tsx`) — dziś tylko Back Market (`POST /ws/orders/{id}`, `new_state: 2`, patrz `lib/backmarket.ts` `bmAcceptOrder`); inne kanały: route nic nie robi (nie błąd). Nigdy nie cofa zmiany "Nasz status", gdyby akceptacja się nie udała — tylko ostrzeżenie w UI. **Obserwacja (niepotwierdzona w dokumentacji):** zamówienia w stanie "Do zaakceptowania" bywają niekompletne w danych odbiorcy zwracanych przez `GET /ws/orders` (brak imienia/nazwiska, kodu pocztowego, telefonu — mimo że ulica/miasto/kraj są), co utrudnia "Nadaj przesyłkę DHL"; akceptacja może to odblokować, kolejny sync dociągnie pełne dane, gdy się pojawią. Formularz Wysyłki pokazuje ostrzeżenie, gdy wypełnienie z zamówienia wypadło niekompletne (`prefillNote` w `ShippingView.tsx`), zamiast cicho zostawiać puste wymagane pola. **Udane nadanie przesyłki (dhl-express/create, dhl-parcel/create) samo przestawia "Nasz status" na "Wysłane"**
(`markOurStatusShipped` w `lib/shipmentMarketplaceSync.ts`) — działa dla dowolnego marketplace'u (to nasze wewnętrzne
pole, bez wywołania API kanału) i niezależnie od tego, czy zgłoszenie numeru do marketplace'u się udało (dwa osobne
skutki tego samego nadania); pomija zamówienia już oznaczone jako wysłane (nie woła RPC drugi raz przy ponownym
nadaniu po błędzie) i nigdy nie failuje odpowiedzi — błąd trafia do `ourStatusError` w odpowiedzi, UI każe poprawić
status ręcznie z listy Zamówień. Nasz status: dziś tylko Back Market; do tego dane pracownicze edytowane w wierszu: numer seryjny, pady i numery seryjne padów — jak w Trade-in, wspólny komponent `PadSerialsCell.tsx`; log zmian w `sales_orders.history`). **Dane pracownicze są per pozycja:** zamówienie ma jedną lub więcej pozycji (`sales_order_items`, jedna sztuka = jeden wiersz, ilość > 1 rozbijana; klucz `item_key` = id pozycji z API, `id-2`… dla kolejnych sztuk; `mapBmItems` w `lib/salesOrders.ts` i jednorazowe uzupełnienie w SQL muszą trzymać tę samą zasadę). Na liście każda pozycja ma własny wiersz (numer, data i status zamówienia to `rowSpan`). Zapis pozycji + wpis do logu to funkcja bazy `sales_item_update` (jedna transakcja, dopisanie do historii po stronie bazy); zespół zmienia tylko numer seryjny i pady — pola z API (SKU, kolejność, status zamówienia) tylko synchronizacja, pilnują tego triggery `*_protect_api_fields`, a upsert synchronizacji nie rusza kolumn pracowniczych; nad listą wyszukiwarka po numerze zamówienia (fragment, bez rozróżniania wielkości liter) oraz filtr po "Nasz status"
(pigułki Wszystkie/Nowe/W realizacji/Wysłane w pasku stron, między "Pokaż"/liczbą zamówień a "strona X z Y" —
`middle` w `Pager`, współdzielony komponent stron; filtr resetuje stronę na 1, tak jak zmiana wyszukiwania). Podstrona
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
**Erli** (`marketplace = 'erli'`, `lib/erli.ts`, `app/api/orders/erli-sync`, surowe dane w `erli_orders`): `POST https://erli.pl/svc/shop-api/orders/_search`,
`Authorization: Bearer <klucz>`, odpowiedź to zwykła tablica zamówień (bez has_more — koniec listy = strona krótsza niż limit 200).
**Sortujemy po `updated` rosnąco i idziemy kursorem** (`pagination.after` = pole `cursor` ostatniego zamówienia), a kursor trzymamy w
`sales_orders_sync_meta.scan_cursor` — jeden mechanizm łapie i nowe zamówienia, i zmiany statusu w starych (bez osobnego "sprawdzania
otwartych"). Numer zamówienia = `Order.id`, data = `created`, status = `status` (pending/purchased/cancelled/returned, etykiety w
`ERLI_ORDER_STATES`), SKU = `items[].sku`, a gdy brak — `items[].externalId`; pozycja z ilością > 1 rozbijana na sztuki jak w Back Market.
Numer przesyłki = `deliveryTracking.trackingNumber` (dla przesyłek Erli uzupełnia go system po wygenerowaniu etykiety), a gdy brak — link.
**Uwaga: zamówienie za pobraniem (COD) ma w API ten sam status `purchased` co opłacone** — dlatego w `sales_orders` zapisujemy je jako
własny status `purchased_cod` ("Za pobraniem", czerwona plakietka), a SQL poprawia stare wiersze. Kwoty w API są w groszach (dzielimy przez 100 przy wyświetlaniu). **Niezapłacone zamówienia Erli (`status = 'pending'`, "Oczekuje na płatność") są ukryte z listy "Zamówienia"
w ogóle** (`OrdersList` w `SalesOrdersHub.tsx`, filtr PostgREST `marketplace.neq.erli,status.in.(purchased,purchased_cod)`) — klient
może się jeszcze rozmyślić i nigdy nie zapłacić, więc zaśmiecały widok "Nowe"; wciąż są zapisywane w bazie (sync ich nie pomija), tylko
niewidoczne w UI, dopóki status nie zmieni się na `purchased`/`purchased_cod` (albo `cancelled`/`returned` — te też zostają ukryte,
bo i tak nigdy nie doszły do realizacji). Dotyczy tylko listy — kafelki "Zamówienia dzisiaj/wczoraj" już wcześniej pomijały `pending`
przez `NOT_COUNTED`. Nie testowane na żywym API (brak klucza w środowisku asystenta) —
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
je jako `READY_FOR_PROCESSING_COD` ("Za pobraniem"). Nie testowane na żywym API (brak konta/aplikacji w środowisku asystenta) — zweryfikowane na atrapie
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
przesyłki = pierwszy `parcels[].parcelNumber` znaleziony w dowolnej pozycji. Nie testowane na żywym API (brak danych dostępowych w środowisku asystenta) —
zweryfikowane na atrapie `fetch` wg specyfikacji OpenAPI (developer.octopia-io.net).
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
w walucie rozliczeniowej i PLN, waga taryfowa, składniki ceny; Economy Select = kod `W`/`H`, domyślnie zaznaczony) → wybór produktu → **potwierdzenie z ostrzeżeniem** →
`POST /shipments` → etykieta **PDF 6x4 cala (10x15 cm, szablon `ECOM26_64_001`, zmienna `DHL_EXPRESS_LABEL_TEMPLATE`)** do wydruku na Zebrze przez sterownik (rozmiar strony
100x150 mm) → zapis w `shipments` (numer, link śledzenia, odbiorca, paczka, opłaty, etykieta base64). Zabezpieczenia: wymagane `confirm: true`; `client_request_id` (unikalny) chroni
przed podwójnym nadaniem tym samym kliknięciem; gdy DHL nada, a zapis w bazie się nie uda, odpowiedź zwraca numer i etykietę, żeby nic się nie zmarnowało; e-mail autora z konta, nie z żądania;
tabela `shipments` bez UPDATE/DELETE (zapis księgowy, tylko serwer). **Na razie tylko kraje UE** (bez odprawy celnej, `isCustomsDeclarable: false`, incoterm DAP), **w tym Polska** (`DHL_EU_COUNTRIES`
w `lib/dhlExpress.ts` — była z niej wcześniej wyłączona, bo krajowe zamówienia Allegro/Erli mają inną obsługę, ale to
wykluczało też Back Market/refurbed z odbiorcą w Polsce, które takiej alternatywy nie mają; poprawione, zgłoszone przez
właściciela na realnym zamówieniu refurbed do Polski); poza UE wymaga danych
celnych (opis, wartość, kod HS) — do zrobienia. Nadawca (`shipping_settings`, jeden wiersz; Admin zmienia w zakładce) i szablony (`shipping_templates`; dodaje Admin/Manager, usuwa Admin)
są w bazie. Z karty zamówienia (Back Market, Refurbed, kraj UE) przycisk "Nadaj przesyłkę DHL" wypełnia formularz. Linie adresu DHL to max 3 x 45 znaków (`splitAddressLines` łamie na
spacjach, za długi adres = czytelny błąd, nie ucinanie). **Po nadaniu numer przesyłki wraca do marketplace'u**
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
wycena `getPrice` (cena w PLN + dopłata paliwowa; produkt niedostępny na trasie = wiersz "niedostępny: <powód>"), tworzenie `createShipments`, etykieta `getLabels` **BLP = PDF**
(ZBLP = ZPL dla Zebry, nieużywany), anulowanie `deleteShipments` (**możliwe przez API**, dopóki nie zamówiono kuriera; wiersz w `shipments` dostaje `cancelled_at`). **DHL Parcel nie ma
środowiska testowego dostępnego dla nas** — każde nadanie jest prawdziwe, więc test = nadaj + od razu anuluj. Adres w DHL24 wymaga ulicy i numeru domu w OSOBNYCH polach oraz limitów:
miejscowość max **17** znaków (potwierdzone wprost w ich dokumentacji, struktura Address), ulica 35, nazwa 60, telefon 20, **suma numeru domu i numeru lokalu razem max 15 znaków** (osobny limit od 10 znaków każdego pola z osobna) — za długie = czytelny błąd, nie ucinanie; opis zawartości ucinany do 30. Nadawcę rozdziela `loadShipper`
(`lib/parcelServer.ts`, kod pocztowy bez myślnika). Wspólna serwerowa walidacja formularza: `lib/shipmentInput.ts` (`parseShipmentBody`, numer domu wyciągany z ulicy przez
`splitStreet`). Numer przesyłki DHL24 (shipmentId) = numer do śledzenia. **Odbiorca prywatny (bez firmy) na etykiecie:**
`contactPerson` wysyłamy tylko, gdy jest osobna firma (`receiver.company`) — inaczej `name` i `contactPerson` to ta sama
osoba i etykieta drukuje ją dwa razy (znalezione na żywej etykiecie DHL Parcel; ten sam wzorzec poprawiony też w DHL
Express — `contactInformation.fullName` tylko z firmą). Nie testowane na żywym API poza tym przypadkiem — zweryfikowane na atrapie `fetch` wg WSDL.

**Erli — Paczkomaty InPost 24/7** (`lib/erliShipping.ts`, `app/api/shipping/erli/{create,label,cancel}`, `ErliParcelPanel.tsx`) — trzeci, zupełnie inny sposób nadawania: to **Erli** zleca przesyłkę InPost na SWOIM koncie/rozliczeniu (`POST /shipping/parcels/` w tym samym "Marketplace API" co synchronizacja zamówień — ten sam `ERLI_API_KEY`/`ERLI_UA`, żadnych nowych zmiennych), nie my przez DHL. Dlatego przycisk **"Nadaj przez Erli (Paczkomat) →" siedzi wprost na karcie zamówienia Erli** (`SalesOrderCard.tsx`), nie w zakładce Wysyłka — widoczny tylko gdy klient faktycznie wybrał punkt InPost przy składaniu zamówienia w Erli (`order.raw.delivery.pickupPlace.provider === "inpost"`). **Adresu odbiorcy nie podajemy wcale** — Erli bierze go z zamówienia; wystarczy waga/wymiary (szablon albo ręcznie), w **milimetrach i gramach** (limity API: 1–2000 mm, 10–700 000 g), nie cm/kg jak w DHL — konwersja w `app/api/shipping/erli/create`. `typeId` = `erliPaczkomat` (pełny słownik metod: `GET /dictionaries/shippingMethods`, nieużywany — mamy tylko tę jedną). **Etykieta i numer śledzenia nie wracają od razu** przy tworzeniu — trzeba dopytać `POST /shipping/parcels/_search` (filter `field:"orderId", operator:"="`), ten sam wzorzec co "Pobierz etykietę ponownie" przy DHL Parcel; numer śledzenia i tak sam dojdzie przy kolejnej synchronizacji zamówień Erli (`deliveryTracking.trackingNumber`), więc `notifyMarketplace`/`markOurStatusShipped` (patrz wyżej) tu nie mają zastosowania. **Anulowanie działa** (`DELETE /shipping/parcels/{id}`), dopóki przesyłka nie trafiła do sieci InPost — tak jak DHL Parcel, żaden test/sandbox nie istnieje, każde nadanie jest prawdziwe i płatne. **Bez migracji SQL:** carrier (`erli_paczkomat`) i product_code w `shipments` to zwykły tekst bez ograniczeń; id paczki Erli (potrzebny do anulowania) trzyma się w istniejącej kolumnie `charges` (`{erli_parcel_id}`) zamiast dodawać nową kolumnę tylko dla tego pola — stąd `dhlCharge()` w `ShippingView.tsx` sprawdza `Array.isArray` przed odczytem ceny DHL, żeby nie wywalić się na innym kształcie danych Erli. Nie testowane na żywym API (brak danych dostępowych w środowisku asystenta) — zweryfikowane na atrapie `fetch` wg `swagger.json` (`erli.pl/svc/shop-api/doc/swagger.json`).

**RCP** (`RcpView.tsx`) — rejestracja czasu pracy; **na razie tylko pusta zakładka-szkielet**, widoczna dla wszystkich ról. Docelowo z niej ma wyjść ewidencja godzin
potrzebna do wydajności (punkty na godzinę) i premii z regulaminu (plan rozwoju, punkt 8).

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
`BACKMARKET_AUTH`, `BACKMARKET_LANG`, `BACKMARKET_UA`, `BACKMARKET_BASE_URL`, `REFURBED_API_TOKEN` (z supplier.refurbed.com; bez niego sync refurbed jest pomijany; nieużywany wygasa po 2 miesiącach), `REFURBED_UA`, `ERLI_API_KEY` (panel Erli: Metoda integracji > Własna integracja po API; bez niego sync Erli jest pomijany), `ERLI_UA`, `ALLEGRO_CLIENT_ID`, `ALLEGRO_CLIENT_SECRET` (aplikacja z apps.developer.allegro.pl), `ALLEGRO_REDIRECT_URI` (opcjonalny, sztywny adres przekierowania), `DHL_PARCEL_USERNAME` (klucz APIv2 z panelu DHL24), `DHL_PARCEL_PASSWORD`, `DHL_PARCEL_SAP` (numer klienta SAP, 7 cyfr; tylko w env), `DHL_EXPRESS_API_KEY`, `DHL_EXPRESS_API_SECRET`, `DHL_EXPRESS_ACCOUNT` (numer konta nadawcy DHL Express — tylko w env, nie w repo), `DHL_EXPRESS_ENV` (`test` domyślnie / `production`), `DHL_EXPRESS_LABEL_TEMPLATE` (opcjonalnie, domyślnie `ECOM26_64_001`), `ALLEGRO_UA` (**wymagany**, bez wartości domyślnej: User-Agent z generatora w panelu aplikacji — Allegro blokuje klucz przy nieprawidłowym; bez niego sync Allegro jest pomijany)`, `OCTOPIA_CLIENT_ID`, `OCTOPIA_CLIENT_SECRET`, `OCTOPIA_SELLER_ID` (marketplace'y typu Cdiscount; bez nich sync Octopia jest pomijany), `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_REFRESH_TOKEN` (bezpośrednia integracja SP-API, patrz niżej), `AMAZON_MARKETPLACE_IDS` (opcjonalnie), `AMAZON_ENDPOINT`/`AMAZON_USER_AGENT` (opcjonalnie).
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
5. ✅ Trade-in: zamówienia BuyBack + obsługa paczek z punktacją · ⬜ rola "Trade-in"
6. 🟡 Karta produktu po numerze seryjnym: odczyt + log z testów/serwisu/Trade-in zrobione · ⬜ własne edytowalne dane produktu
7. ✅ Testy: rejestr i punktacja · ⬜ łączne podsumowanie miesięczne ze wszystkich obszarów
8. ⬜ Ewidencja czasu pracy → wydajność pkt/h i premia z regulaminu
9. ⬜ Integracje z kanałami sprzedaży (Allegro, eBay) — osobny etap, wymaga kluczy API
10. ⬜ Twarde uprawnienia per rola (RLS)
