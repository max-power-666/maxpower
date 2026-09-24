-- Magazyn ERP — schemat startowy
-- Uruchom ten plik w Supabase: Dashboard -> SQL Editor -> New query -> wklej -> Run

create extension if not exists "pgcrypto";

-- Członkowie zespołu i ich role (Magazyn / Serwis / Obsługa klienta / Manager)
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null unique,
  role text not null,
  email text default '',                -- zapisywany przy wyborze roli, żeby zakładka Zespół mogła pokazać kto jest kim
  name text default '',                 -- imię i nazwisko, ustawiane przez Admina w Zespole; skrócone (np. "Maksymilian J.") w logach
  created_at timestamptz default now()
);

-- Jednostki magazynowe (każde fizyczne urządzenie)
create table if not exists units (
  id uuid primary key default gen_random_uuid(),
  category text not null,               -- smartfon | tablet | laptop | konsola | inne
  name text not null,
  location text default '',
  price_cost numeric default 0,
  price_sell numeric default 0,
  notes text default '',
  fields jsonb default '{}'::jsonb,      -- pola zależne od kategorii (imei, grade, battery, ...)
  status text not null default 'Przyjęte',
  history jsonb default '[]'::jsonb,     -- [{status, user_id, at}]
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create index if not exists units_status_idx on units (status);
create index if not exists units_category_idx on units (category);

-- Podgląd stanu z Fakturowni (tylko sztuki ze stanem magazynowym = 1) — trzymany
-- trwale w bazie, żeby zakładka Magazyn nie znikała po odświeżeniu strony i nie
-- musiała za każdym razem pytać Fakturowni. Zapisywany wyłącznie przez
-- app/api/fakturownia/sync/route.ts (kluczem service_role, z pominięciem RLS) —
-- ani przycisk "Odśwież", ani cron Vercela nie mają bezpośredniego dostępu do bazy.
create table if not exists fakturownia_stock_cache (
  id bigint primary key,                          -- id produktu w Fakturowni
  category_id bigint,
  category_name text not null default 'Bez kategorii',
  purchase_price_gross numeric not null default 0,
  name text,                                      -- numer seryjny (w Fakturowni nazwa produktu = kod = numer seryjny)
  description text,                               -- numer zamówienia Back Market, z którego pochodzi sztuka (np. FR-26225-RKXHR)
  product_created_at timestamptz,                 -- kiedy produkt dodano w Fakturowni
  updated_at timestamptz not null default now()
);
alter table fakturownia_stock_cache add column if not exists name text;
alter table fakturownia_stock_cache add column if not exists description text;
alter table fakturownia_stock_cache add column if not exists product_created_at timestamptz;
create index if not exists fakturownia_stock_cache_created_idx on fakturownia_stock_cache (product_created_at desc);

-- Jeden wiersz: kiedy ostatnio zsynchronizowano dane z Fakturowni, i od jakiego
-- momentu liczyć kolejną synchronizację przyrostową (parametr date_from API).
create table if not exists fakturownia_sync_meta (
  id int primary key default 1,
  last_synced_at timestamptz,
  constraint fakturownia_sync_meta_singleton check (id = 1)
);

-- Sztuki zsynchronizowane przed dodaniem kolumn name/description/product_created_at ich nie mają,
-- a synchronizacja przyrostowa dotyka tylko zmienionych produktów. Kasujemy więc datę ostatniej
-- synchronizacji, żeby następne "Odśwież" zrobiło jeden pełny skan i uzupełniło braki.
-- Warunek pilnuje, żeby ponowne uruchomienie pliku nie wymuszało pełnego skanu bez potrzeby.
insert into fakturownia_sync_meta (id) values (1) on conflict (id) do nothing;
update fakturownia_sync_meta set last_synced_at = null
  where id = 1 and exists (select 1 from fakturownia_stock_cache where name is null);

alter table members enable row level security;
alter table units enable row level security;
alter table fakturownia_stock_cache enable row level security;
alter table fakturownia_sync_meta enable row level security;

-- Uwaga: to jest model "jedna firma = jeden projekt Supabase".
-- Każdy zalogowany użytkownik Twojego projektu widzi i edytuje wszystko —
-- dokładnie tak jak w prototypie. Twardsze uprawnienia per-rola (np. tylko
-- Manager może usuwać) to kolejny krok, gdy będzie potrzebny.

create policy "authenticated read members" on members
  for select using (auth.role() = 'authenticated');

create policy "user upserts own member row" on members
  for insert with check (auth.uid() = user_id);

-- Każdy zalogowany może zmienić rolę każdemu (nie tylko swoją) — potrzebne, żeby
-- Admin mógł przypisywać role innym z zakładki Zespół. Tak samo jak przy units:
-- to nie jest twarde zabezpieczenie, tylko UI (zakładka Zespół) chowa tę możliwość
-- przed osobami bez roli Admin.
create policy "authenticated update members" on members
  for update using (auth.role() = 'authenticated');

create policy "authenticated read units" on units
  for select using (auth.role() = 'authenticated');

create policy "authenticated insert units" on units
  for insert with check (auth.role() = 'authenticated');

create policy "authenticated update units" on units
  for update using (auth.role() = 'authenticated');

create policy "authenticated delete units" on units
  for delete using (auth.role() = 'authenticated');

-- Tylko odczyt dla zespołu — brak polityk insert/update/delete dla "authenticated"
-- to celowe: te dwie tabele zapisuje wyłącznie serwer (service_role, poza RLS).
create policy "authenticated read fakturownia_stock_cache" on fakturownia_stock_cache
  for select using (auth.role() = 'authenticated');

create policy "authenticated read fakturownia_sync_meta" on fakturownia_sync_meta
  for select using (auth.role() = 'authenticated');
