# Magazyn ERP — prototyp (Next.js + Supabase)

Aplikacja odwzorowuje moduł magazynowy z prototypu: kategorie urządzeń
z własnymi polami (IMEI, bateria, ocena...), statusy (Przyjęte → Kontrola
jakości → Gotowe do sprzedaży → Sprzedane / W naprawie / Złom), historia
zmian, logowanie e-mailem (magic link) i role zespołu.

## 1. Załóż projekt w Supabase (baza danych + logowanie)

1. Wejdź na https://supabase.com → "New project" (konto zakładasz przez GitHub albo e-mail).
2. Poczekaj ok. 2 minuty, aż projekt się utworzy.
3. W panelu projektu wejdź w **SQL Editor** → **New query**.
4. Wklej całą zawartość pliku `supabase/schema.sql` z tego repo i kliknij **Run**.
   To tworzy tabele `units` i `members` oraz reguły dostępu.
5. Wejdź w **Authentication → Providers** i upewnij się, że **Email** jest włączony
   (jest domyślnie). W **Authentication → URL Configuration** dodaj adres, pod którym
   aplikacja będzie działać (na razie możesz zostawić `http://localhost:3000`,
   dopiszesz adres z Vercela w kroku 4).
6. **Ważne dla własnej firmy:** w **Authentication → Providers → Email** możesz
   wyłączyć "Allow new users to sign up", jeśli chcesz sam ręcznie zapraszać
   konkretne osoby z zespołu (Authentication → Users → Invite user) zamiast
   pozwalać każdemu się zarejestrować.
7. Wejdź w **Project Settings → API** — będą Ci potrzebne dwie wartości:
   `Project URL` i `anon public` key.

## 2. Uruchom aplikację lokalnie (żeby sprawdzić, że działa)

```bash
cd magazyn-erp
cp .env.local.example .env.local
# wklej do .env.local wartości z kroku 1.7
npm install
npm run dev
```

Otwórz `http://localhost:3000`, zaloguj się swoim e-mailem (przyjdzie link),
wybierz rolę i dodaj pierwsze urządzenie.

## 3. Wrzuć kod na GitHub

```bash
git init
git add .
git commit -m "Magazyn ERP - pierwszy prototyp"
```

Załóż puste repozytorium na https://github.com/new i wypchnij kod zgodnie
z instrukcją, którą GitHub pokaże po utworzeniu repo (`git remote add origin ...`,
`git push -u origin main`).

## 4. Wdróż na Vercel

1. Wejdź na https://vercel.com → zaloguj się przez GitHub.
2. **Add New → Project** → wybierz repozytorium `magazyn-erp`.
3. W sekcji **Environment Variables** dodaj te same dwie zmienne co w `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Kliknij **Deploy**. Po ok. minucie dostaniesz publiczny adres
   (np. `magazyn-erp.vercel.app`).
5. Wróć do Supabase → **Authentication → URL Configuration** i dopisz ten
   adres jako dozwolony (Site URL / Redirect URLs), żeby logowanie linkiem
   działało też na produkcji.

Od tego momentu Ty i Twój zespół logujecie się pod tym adresem, z dowolnego
miejsca — dane są współdzielone i zapisują się na żywo w Supabase.

## Zakładka Trade-in (bidder Back Market)

1. Supabase → **SQL Editor** → wklej `supabase/tradein.sql` → **Run**.
2. Dopisz do `.env.local` zmienne `BACKMARKET_*` (patrz `.env.local.example`).
3. `node scripts/import-buyback.mjs` — przenosi SKU, ceny max, ignorowane SKU
   i ostatnie ceny ze starego programu (`~/Documents/Buyback Bidder 2`).
4. Na Vercelu: plan **Pro** (cron co minutę) i te same zmienne `BACKMARKET_*`
   w Environment Variables.
5. Wyłącz stary bidder na Macu, potem w zakładce Trade-in kliknij „włącz”.

## Co dalej

- Zaproś resztę zespołu: Supabase → Authentication → Users → Invite user.
- Kolejne moduły (Zamówienia, Serwis, integracje marketplace) dobudowujemy
  tak samo — najlepiej przez Claude Code, wskazując mu ten projekt jako
  punkt startowy.
- To wciąż wersja jednofirmowa, bez twardych uprawnień per-rola (każdy
  zalogowany może edytować wszystko) — dopracujemy to w kolejnym kroku,
  jeśli będzie potrzebne.
