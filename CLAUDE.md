# Magazyn ERP — kontekst projektu

## Cel biznesowy

Wewnętrzny system do zarządzania magazynem sprzedaży/naprawy elektroniki
(smartfony, tablety, laptopy, konsole). Budowany na potrzeby **własnej
działalności** — na tym etapie żadnych zewnętrznych klientów korzystających
z aplikacji, tylko właściciel i mały zespół (kilka-kilkanaście osób, role:
Magazyn / Serwis / Obsługa klienta / Manager).

Docelowa inspiracja funkcjonalna: Margixa (ERP dla sprzedawców elektroniki:
magazyn po numerach seryjnych, wielokanałowa synchronizacja stanów,
naprawy, auto-wycena, obsługa klienta).

## Stack techniczny

- **Frontend + backend:** Next.js 14 (App Router), TypeScript, Tailwind CSS
- **Baza danych + auth:** Supabase (Postgres, magic link email login)
- **Hosting docelowy:** Vercel (frontend) + Supabase (baza) — oba na
  darmowych planach, bo to wciąż etap prototypu na własny użytek
- Kod aplikacji: `app/page.tsx` (jeden duży client component —
  świadomie uproszczone na etapie MVP). Wyjątek: zakładka Trade-in jest
  osobno w `app/_components/TradeInView.tsx` (duży, samodzielny moduł).

## Model danych (Supabase, patrz `supabase/schema.sql`)

**Tabela `units`** — każda fizyczna sztuka sprzętu:
- `category`: smartfon | tablet | laptop | konsola | inne
- `fields` (jsonb): pola zależne od kategorii — smartfon ma IMEI/pojemność/
  baterię/SIM, laptop ma CPU/RAM, itd. — patrz obiekt `CATEGORIES` w
  `app/page.tsx`, tam jest źródło prawdy o polach per kategoria
- `status`: Przyjęte → Kontrola jakości → Gotowe do sprzedaży →
  Sprzedane / W naprawie / Złom
- `history` (jsonb): log zmian statusu z `user_id` i `at` — "unit journey"
- `price_cost`, `price_sell`, `location`, `notes`

**Tabela `members`** — rola każdego zalogowanego użytkownika
(Magazyn / Serwis / Obsługa klienta / Manager). Przy pierwszym logowaniu
użytkownik wybiera rolę (ekran `RolePicker` w `app/page.tsx`).

**Uwaga o uprawnieniach:** obecnie każdy zalogowany użytkownik może
czytać/edytować wszystko (RLS pozwala każdemu `authenticated`). Role są na
razie tylko informacyjne, nie blokują akcji. To świadomy uproszczony stan
MVP — twarde uprawnienia per-rola to zaplanowany, ale jeszcze niezrobiony,
kolejny krok.

## Moduł Trade-in (bidder cen skupu Back Market)

Przeniesiony ze starego programu "Buyback Bidder" (Node + pliki JSON + launchd
na Macu, folder `~/Documents/Buyback Bidder 2`). Teraz:
- dane w Supabase: `buyback_skus`, `buyback_runs`, `buyback_log`,
  `buyback_price_history`, `buyback_settings` — schemat w `supabase/tradein.sql`
- logika: `lib/buyback.ts`; wołana przez `app/api/tradein/bidder/route.ts`
  (GET = Vercel Cron co minutę, POST = przycisk "Uruchom teraz")
- przebieg (~180 SKU × ~3 s) jest dzielony na "ticki" po max ~2 min, bo funkcja
  Vercela ma limit czasu; kursor to `last_attempt_at < run.started_at`
- **wymaga Vercel Pro** (cron co minutę + `maxDuration = 300`); na Hobby deploy
  z takim cronem się nie uda
- `buyback_settings.enabled` = główny włącznik; domyślnie wyłączony. Nie włączać,
  dopóki stary bidder na Macu działa — oba nadpisywałyby sobie ceny
- UWAGA: bidder na chwilę ustawia 10 € na listingu (żeby odczytać prawdziwe
  price_to_win). `in_progress_since` pilnuje, żeby po ubitej funkcji przywrócić ceny
- historia cen zapisywana tylko przy zmianie ceny (limit 500 MB bazy na darmowym Supabase)
- import danych ze starego programu: `node scripts/import-buyback.mjs`

## Historia projektu / decyzje

- Zaczęliśmy od prototypu jako artefakt HTML z bazą wbudowaną w Claude —
  ten Next.js + Supabase to jego "prawdziwa" wersja produkcyjna.
- Naprawiony bug: `role` state musi rozróżniać `undefined` (jeszcze nie
  wczytano z bazy) od `""` (wczytano, brak przypisanej roli → pokaż
  RolePicker) — wcześniej oba stany błędnie renderowały pustą stronę.
- Autoryzacja: Supabase magic link (e-mail). Rozważ wyłączenie "Allow new
  users to sign up" w Supabase i ręczne zapraszanie osób z zespołu, skoro
  to zamknięta aplikacja firmowa.

## Plan rozwoju (kolejność, jak dotąd ustalona)

1. ✅ Magazyn/Inwentarz (obecny stan)
2. ⬜ Zamówienia
3. ⬜ Serwis / naprawy
4. 🟡 Trade-in / bidder skupu Back Market — zrobione, czeka na wdrożenie
5. ⬜ Integracje z kanałami sprzedaży (Allegro, eBay, Back Market) —
   osobny etap, wymaga kluczy API tych platform
6. ⬜ Twarde uprawnienia per-rola

## Rzeczy, o które trzeba dbać

- `.env.local` (klucze Supabase) **nigdy** nie trafia do gita — sprawdź
  `.gitignore`.
- Przy każdej nowej funkcji: jedna zmiana na raz, testowana na
  `localhost:3000` (`npm run dev`) przed przejściem dalej.
- Po każdej działającej zmianie: commit, żeby można było bezpiecznie
  cofnąć eksperymenty.
