-- Magazyn ERP — moduł Trade-in (bidder cen skupu Back Market)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów (wszystko jest "if not exists" / "or replace").
--
-- Zastępuje pliki JSON starego programu "Buyback Bidder":
--   data.json + max-prices.json + ignored-skus.json + bidder-state.json -> buyback_skus
--   history.json   -> buyback_price_history (tylko ZMIANY ceny, nie każdy przebieg —
--                     inaczej tabela rośnie o ~70 tys. wierszy dziennie)
--   bidder.log     -> buyback_runs + buyback_log (log czyszczony po 7 dniach)
--   bidder.lock    -> buyback_settings.lock_until

-- Każdy listing skupu na Back Markecie (jeden SKU = jeden listing, 4 rynki)
create table if not exists buyback_skus (
  sku text primary key,
  listing_id text not null,
  product_id text,
  max_price numeric,                         -- null / 0 = bidder pomija ten SKU
  ignored boolean not null default false,    -- "ignored-skus.json"
  last_set jsonb,                            -- {"DE": 510, "FR": 498, ...} — ostatnio ustawione ceny
  last_run_at timestamptz,                   -- ostatni udany przebieg dla tego SKU
  last_attempt_at timestamptz,               -- ostatnia próba (udana lub nie) — kursor przebiegu
  last_error text,
  in_progress_since timestamptz,             -- ustawione na czas "ceny 10 €" — jeśli zostanie, następny tick przywraca last_set
  updated_at timestamptz not null default now()
);

create table if not exists buyback_runs (
  id bigint generated always as identity primary key,
  source text not null,                      -- cron | manual
  status text not null default 'running',    -- running | finished
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  total int not null default 0,
  updated int not null default 0,
  failed int not null default 0
);
create index if not exists buyback_runs_started_idx on buyback_runs (started_at desc);

create table if not exists buyback_log (
  id bigint generated always as identity primary key,
  run_id bigint references buyback_runs(id) on delete cascade,
  at timestamptz not null default now(),
  level text not null default 'info',        -- info | warn | error
  sku text,
  message text not null
);
create index if not exists buyback_log_run_idx on buyback_log (run_id, at);
create index if not exists buyback_log_at_idx on buyback_log (at);

create table if not exists buyback_price_history (
  id bigint generated always as identity primary key,
  sku text not null,
  market text not null,                      -- DE | ES | FR | IT
  price numeric not null,                    -- ustawiona przez nas cena
  price_to_win numeric,                      -- cena do wygrania w momencie ustawienia
  at timestamptz not null default now()
);
create index if not exists buyback_price_history_sku_idx on buyback_price_history (sku, at);

-- Jeden wiersz: włącznik biddera, interwał, żądanie ręcznego uruchomienia i blokada
create table if not exists buyback_settings (
  id int primary key default 1,
  enabled boolean not null default false,    -- dopóki false, cron NIE startuje nowych przebiegów
  interval_minutes int not null default 15,
  run_requested_at timestamptz,
  lock_until timestamptz,
  constraint buyback_settings_singleton check (id = 1)
);
insert into buyback_settings (id) values (1) on conflict (id) do nothing;

alter table buyback_skus enable row level security;
alter table buyback_runs enable row level security;
alter table buyback_log enable row level security;
alter table buyback_price_history enable row level security;
alter table buyback_settings enable row level security;

-- Jak reszta aplikacji: każdy zalogowany czyta wszystko. Zespół może zmieniać ceny
-- max / ignorowanie SKU i włącznik biddera; przebiegi, log i historię zapisuje
-- wyłącznie serwer (service_role, poza RLS).
drop policy if exists "authenticated read buyback_skus" on buyback_skus;
create policy "authenticated read buyback_skus" on buyback_skus
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated update buyback_skus" on buyback_skus;
create policy "authenticated update buyback_skus" on buyback_skus
  for update using (auth.role() = 'authenticated');

drop policy if exists "authenticated read buyback_runs" on buyback_runs;
create policy "authenticated read buyback_runs" on buyback_runs
  for select using (auth.role() = 'authenticated');

drop policy if exists "authenticated read buyback_log" on buyback_log;
create policy "authenticated read buyback_log" on buyback_log
  for select using (auth.role() = 'authenticated');

drop policy if exists "authenticated read buyback_price_history" on buyback_price_history;
create policy "authenticated read buyback_price_history" on buyback_price_history
  for select using (auth.role() = 'authenticated');

drop policy if exists "authenticated read buyback_settings" on buyback_settings;
create policy "authenticated read buyback_settings" on buyback_settings
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated update buyback_settings" on buyback_settings;
create policy "authenticated update buyback_settings" on buyback_settings
  for update using (auth.role() = 'authenticated');

-- Zmiany na żywo w zakładce Trade-in (status przebiegu, włącznik)
do $$
begin
  begin alter publication supabase_realtime add table buyback_runs; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table buyback_settings; exception when duplicate_object then null; end;
end $$;
