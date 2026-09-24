-- Magazyn ERP — moduł Trade-in (zamówienia BuyBack z Back Market)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów (wszystko jest "if not exists" / "or replace").
--
-- Osobne od buyback_* w tradein.sql (to jest bidder cen) — tu trzymamy same zamówienia
-- BuyBack pobierane z GET /ws/buyback/v1/orders (patrz app/api/tradein/orders-sync/route.ts).

create table if not exists buyback_orders (
  order_public_id text primary key,          -- np. "US-24527-ABCDE"
  status text not null,                      -- NEW | PENDING | TO_SEND | SENT | RECEIVED |
                                              -- COUNTER_PROPOSAL | VALIDATED | PAID | MONEY_TRANSFERED | SUSPENDED
  market text,
  creation_date timestamptz not null,
  modification_date timestamptz not null,
  shipping_date timestamptz,
  suspension_date timestamptz,
  receival_date timestamptz,
  payment_date timestamptz,
  counter_proposal_date timestamptz,
  sku text,
  product_id bigint,
  product_title text,
  grade text,                                -- DIAMOND | PLATINUM | GOLD | SILVER | BRONZE | STALLONE
  customer_first_name text,
  customer_last_name text,
  customer_phone text,
  return_address jsonb,
  original_price numeric,
  original_price_currency text,
  counter_offer_price numeric,
  counter_offer_price_currency text,
  tracking_number text,
  shipper text,
  transfer_certificate_link text,
  suspend_reasons jsonb,
  counter_offer_reasons jsonb,
  raw jsonb not null,                        -- pełna odpowiedź API — bufor na pola, których jeszcze nie wyciągnęliśmy do kolumn
  synced_at timestamptz not null default now()
);
create index if not exists buyback_orders_status_idx on buyback_orders (status);
create index if not exists buyback_orders_modification_idx on buyback_orders (modification_date desc);
create index if not exists buyback_orders_creation_idx on buyback_orders (creation_date desc);

-- Jeden wiersz: od kiedy liczyć kolejną synchronizację przyrostową (parametr modificationDate API)
-- full_scan_done = false: następne wywołanie robi pełny skan od 1 stycznia (w porcjach, z kursorem
-- scan_page); dopiero po jego ukończeniu przechodzimy na przyrostowe (last_synced_at). scan_started_at
-- to data startu trwającego skanu — od niej liczymy pierwszą synchronizację przyrostową.
-- Dla istniejącej bazy kolumna full_scan_done dostaje false, więc pierwszy przebieg po wdrożeniu
-- uzupełni zamówienia, które wcześniej urwał limit 200 stron (patrz lib/scanOrders.ts).
create table if not exists buyback_orders_sync_meta (
  id int primary key default 1,
  last_synced_at timestamptz,
  full_scan_done boolean not null default false,
  scan_page int not null default 1,
  scan_started_at timestamptz,
  constraint buyback_orders_sync_meta_singleton check (id = 1)
);
alter table buyback_orders_sync_meta add column if not exists full_scan_done boolean not null default false;
alter table buyback_orders_sync_meta add column if not exists scan_page int not null default 1;
alter table buyback_orders_sync_meta add column if not exists scan_started_at timestamptz;
insert into buyback_orders_sync_meta (id) values (1) on conflict (id) do nothing;

alter table buyback_orders enable row level security;
alter table buyback_orders_sync_meta enable row level security;

-- Tylko odczyt dla zespołu — zapisuje wyłącznie serwer (service_role, poza RLS),
-- tak samo jak fakturownia_stock_cache.
drop policy if exists "authenticated read buyback_orders" on buyback_orders;
create policy "authenticated read buyback_orders" on buyback_orders
  for select using (auth.role() = 'authenticated');

drop policy if exists "authenticated read buyback_orders_sync_meta" on buyback_orders_sync_meta;
create policy "authenticated read buyback_orders_sync_meta" on buyback_orders_sync_meta
  for select using (auth.role() = 'authenticated');

-- Obsługa paczek Trade-in przez pracowników (Regulamin premiowania z 12.10.2026, §2).
-- Pracownik podaje numer zamówienia LUB numer przesyłki — aplikacja znajduje zamówienie
-- w buyback_orders (stąd klucz obcy) i zakłada rekord ze statusem "w_trakcie".
--
-- Jeden wiersz = jedna paczka = jedna karta (unique na order_public_id). To zarazem
-- pilnuje Regulaminu §2 ust. 3 i §9 ust. 2: ta sama paczka nie może być zaliczona dwa razy.
-- entered_at = początek obsługi; finished_at ustawia się przy przejściu na status końcowy.
-- "Czas" (finished_at - entered_at) jest tylko informacyjny. Punkty do podsumowania liczą się
-- tylko dla status='obsluzona' (§2 ust. 4: po prawidłowym zakończeniu procesu).
create table if not exists buyback_order_intake (
  id bigint generated always as identity primary key,
  order_public_id text not null references buyback_orders(order_public_id),
  serial_number text,                        -- opcjonalne, uzupełniane na karcie zamówienia
  sku text,                                  -- opcjonalne, uzupełniane na karcie zamówienia
  notes text default '',
  entered_by_user_id uuid references auth.users(id),
  entered_by_email text,
  entered_at timestamptz not null default now(),
  history jsonb not null default '[]'::jsonb,  -- [{action: "created"|"edited", by_email, at, changes?}, ...]
  status text not null default 'w_trakcie',    -- w_trakcie | obsluzona | problem
  finished_at timestamptz,
  -- Migawka punktów za paczkę: 100/6 (Regulamin §2 tabela). Celowo bez zaokrąglania (§2 ust. 7,
  -- §4 ust. 8) — zaokrąglamy dopiero przy wyświetlaniu. Gdyby stawka się zmieniła, zmieniamy
  -- default; stare wiersze zachowują swoją wartość.
  points numeric not null default (100.0 / 6.0)
);

-- Migracja z poprzedniej wersji (serial_number/sku wymagane, brak statusu) — bezpieczna do
-- wielokrotnego uruchomienia.
alter table buyback_order_intake alter column serial_number drop not null;
alter table buyback_order_intake alter column sku drop not null;
alter table buyback_order_intake add column if not exists status text not null default 'w_trakcie';
alter table buyback_order_intake add column if not exists finished_at timestamptz;
alter table buyback_order_intake add column if not exists points numeric not null default (100.0 / 6.0);

create index if not exists buyback_order_intake_order_idx on buyback_order_intake (order_public_id);
create index if not exists buyback_order_intake_entered_idx on buyback_order_intake (entered_at desc);
create index if not exists buyback_order_intake_finished_idx on buyback_order_intake (finished_at desc);
create index if not exists buyback_orders_tracking_idx on buyback_orders (tracking_number);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'buyback_order_intake_order_unique') then
    alter table buyback_order_intake add constraint buyback_order_intake_order_unique unique (order_public_id);
  end if;
end $$;

alter table buyback_order_intake enable row level security;

drop policy if exists "authenticated read buyback_order_intake" on buyback_order_intake;
create policy "authenticated read buyback_order_intake" on buyback_order_intake
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated insert buyback_order_intake" on buyback_order_intake;
create policy "authenticated insert buyback_order_intake" on buyback_order_intake
  for insert with check (auth.role() = 'authenticated');
drop policy if exists "authenticated update buyback_order_intake" on buyback_order_intake;
create policy "authenticated update buyback_order_intake" on buyback_order_intake
  for update using (auth.role() = 'authenticated');

do $$
begin
  begin alter publication supabase_realtime add table buyback_orders; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table buyback_order_intake; exception when duplicate_object then null; end;
end $$;
