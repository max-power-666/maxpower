# Magazyn ERP (Next.js + Supabase)

Wewnętrzny system firmy do obsługi magazynu, napraw i skupu elektroniki. Moduły:

- **Magazyn** — sztuki sprzętu ze statusami + podsumowanie stanu z Fakturowni (liczba, wartość, wykres per kategoria)
- **Zespół** — użytkownicy, role i dostęp do zakładek (rolę nadaje Admin)
- **Serwis** — rejestr napraw z punktacją wg regulaminu premiowania
- **Testy** — rejestr testów urządzeń z punktacją wg regulaminu
- **Bidder** — automat cen skupu na Back Market
- **Trade-in** — zamówienia BuyBack z Back Marketu i obsługa paczek przez pracowników

Szczegóły techniczne, model danych i decyzje projektowe: [CLAUDE.md](CLAUDE.md).

## Czego potrzebujesz

Node.js 18.17 lub nowszy, konta: Supabase, GitHub, Vercel (plan **Pro** — bidder używa crona co minutę,
a plan Hobby pozwala tylko na crony raz dziennie i deploy by się nie udał). Do integracji:
token API Fakturowni i dane dostępowe do API Back Market.

## 1. Supabase (baza danych + logowanie)

1. https://supabase.com → **New project**, poczekaj ok. 2 minuty.
2. **SQL Editor → New query** i uruchom (**Run**) kolejno pliki z `supabase/`, każdy w całości:
   1. `schema.sql` — użytkownicy, sztuki sprzętu, cache Fakturowni
   2. `tradein.sql` — bidder
   3. `buyback-orders.sql` — zamówienia BuyBack i obsługa paczek
   4. `service.sql` — rejestr napraw
   5. `tests.sql` — rejestr testów

   Pliki są idempotentne — po zmianach w repo można je uruchomić ponownie, nic nie zepsują.
   Po każdej aktualizacji kodu, która zmienia schemat, uruchom odpowiedni plik.
3. **Authentication → Providers**: Email włączony (domyślnie). Dla firmowej aplikacji warto
   wyłączyć "Allow new users to sign up" i zapraszać osoby ręcznie
   (**Authentication → Users → Invite user**).
4. **Authentication → URL Configuration**: dodaj adres aplikacji (lokalnie
   `http://localhost:3000`, na produkcji adres z Vercela) jako Site URL / Redirect URL.
   Przy każdej zmianie domeny trzeba to zaktualizować, inaczej link logowania nie zadziała.
5. **Project Settings → API**: skopiuj `Project URL`, klucz `anon` oraz `service_role`.

## 2. Zmienne środowiskowe

`cp .env.local.example .env.local` i uzupełnij:

| Zmienna | Skąd |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | to samo miejsce; **sekret** z pełnym dostępem do bazy, tylko po stronie serwera |
| `CRON_SECRET` | dowolny losowy ciąg: `openssl rand -hex 24` |
| `FAKTUROWNIA_DOMAIN` | sama subdomena, np. `recoo` dla `recoo.fakturownia.pl` |
| `FAKTUROWNIA_API_TOKEN` | Fakturownia → Ustawienia konta → Integracja → Kod autoryzacyjny API |
| `BACKMARKET_AUTH`, `BACKMARKET_LANG`, `BACKMARKET_UA`, `BACKMARKET_BASE_URL` | dane API Back Market (patrz `.env.local.example`) |

`.env.local` nie trafia do gita. Nie wpisuj prawdziwych kluczy do `.env.local.example`.

## 3. Uruchomienie lokalne

```bash
npm install
npm run dev
```

Otwórz `http://localhost:3000` i zaloguj się e-mailem (przyjdzie link).

**Pierwszy administrator.** Nowa osoba po zalogowaniu widzi komunikat "poproś administratora
o rolę", a roli nikomu nie da się nadać, dopóki nie ma żadnego Admina. Pierwszą rolę nadaj
sobie w Supabase (SQL Editor), po pierwszym zalogowaniu:

```sql
update members set role = 'Admin' where email = 'twoj@email.pl';
```

Kolejne osoby dostają role w zakładce **Zespół** (tam też wpisuje się imię i nazwisko —
w logach pokazuje się skrócone, np. "Maksymilian J."). Zespół pokazuje tylko osoby, które
zalogowały się choć raz.

## 4. Pierwsze dane

- **Fakturownia** — zakładka Magazyn → **Odśwież**. Pierwsza synchronizacja skanuje cały
  katalog (~19 tys. produktów, ok. minuty), kolejne są przyrostowe (cron codziennie ok. północy).
- **Zamówienia BuyBack** — zakładka Trade-in → Raw data → **Odśwież** (pierwszy raz pobiera
  zamówienia od 1 stycznia bieżącego roku; potem cron co 15 minut). Back Market najpewniej
  filtruje po adresie IP, więc to działa z Vercela lub z komputera właściciela, nie z każdego
  środowiska.
- **Bidder** — `node scripts/import-buyback.mjs` przenosi SKU, ceny max i ostatnie ceny ze
  starego programu (`~/Documents/Buyback Bidder 2`). Włącznik jest domyślnie wyłączony:
  wyłącz stary program, potem w zakładce Bidder kliknij "włącz". Dwa biddery naraz
  nadpisywałyby sobie ceny.

## 5. Wdrożenie na Vercel

1. Wrzuć kod na GitHub (`git push`). Przy pushu przez HTTPS zamiast hasła podaj
   **Personal Access Token** (GitHub → Settings → Developer settings → Tokens, uprawnienie `repo`).
2. https://vercel.com → **Add New → Project** → wybierz repozytorium, framework wykryje się sam.
3. W **Environment Variables** dodaj wszystkie zmienne z kroku 2 (wartości z `.env.local`).
4. **Deploy**. Kolejne pushe na `main` wdrażają się automatycznie.
5. Dopisz adres z Vercela w Supabase (krok 1.4).

Crony z `vercel.json` włączają się same po wdrożeniu (Vercel liczy je w UTC):

| Ścieżka | Harmonogram | Co robi |
|---|---|---|
| `/api/fakturownia/sync` | codziennie 23:00 | synchronizacja stanów z Fakturowni |
| `/api/tradein/bidder` | co minutę | kolejny "tick" biddera (przy wyłączonym bidderze nic nie robi, poza ręcznym "Uruchom teraz") |
| `/api/tradein/orders-sync` | co 15 minut | zamówienia BuyBack z Back Marketu |

Zmiana zmiennej środowiskowej na Vercelu wymaga nowego deployu.

## Uprawnienia

Rola decyduje tylko o tym, jakie zakładki widzisz w menu. To nie jest twarde zabezpieczenie —
reguły w Supabase pozwalają każdemu zalogowanemu czytać i w dużej mierze zapisywać dane.
Twarde uprawnienia per rola są w planie (patrz [CLAUDE.md](CLAUDE.md)).
