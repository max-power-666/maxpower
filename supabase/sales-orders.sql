-- Magazyn ERP — zakładka Zamówienia (sprzedaż z marketplace'ów)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów.
--
-- Dwie warstwy:
--  * bm_orders    — surowe dane zamówień Back Market (GET /ws/orders), podgląd w "BM raw data".
--                   To zamówienia SPRZEDAŻY (klient kupuje u nas), nie skupu — skup to buyback_orders.
--  * sales_orders — wspólna lista zamówień ze wszystkich marketplace'ów (dziś tylko Back Market;
--                   Allegro/eBay dojdą jako kolejne wartości `marketplace`). Zapisuje ją ten sam
--                   serwer, który wypełnia surową tabelę danego kanału.
-- Zapisuje wyłącznie serwer (service_role, poza RLS); zespół ma tylko odczyt.

create table if not exists bm_orders (
  order_id bigint primary key,
  state int not null,                        -- 0 nowe | 10 oczekuje na płatność | 1 opłacone | 3 do wysyłki | 8 nieopłacone | 9 wysłane
  country_code text,
  date_creation timestamptz,
  date_modification timestamptz,
  date_payment timestamptz,
  date_shipping timestamptz,
  expected_dispatch_date timestamptz,
  price numeric,                             -- suma zamówienia z podatkami, bez wysyłki
  shipping_price numeric,
  currency text,
  sales_taxes numeric,
  payment_method text,
  installment_payment boolean,
  paypal_reference text,
  delivery_mode text,
  delivery_note text,
  tracking_number text,
  tracking_url text,
  shipper_display text,
  is_backship boolean,
  orderlines jsonb,
  shipping_address jsonb,
  billing_address jsonb,
  raw jsonb not null,                        -- pełna odpowiedź API — bufor na pola, których nie wyciągnęliśmy do kolumn
  synced_at timestamptz not null default now()
);
create index if not exists bm_orders_creation_idx on bm_orders (date_creation desc);
create index if not exists bm_orders_modification_idx on bm_orders (date_modification desc);

create table if not exists sales_orders (
  marketplace text not null,                 -- 'backmarket' (kolejne kanały później)
  external_id text not null,                 -- numer zamówienia w danym kanale
  order_date timestamptz,
  status text not null,                      -- surowy status kanału (Back Market: kod stanu "1", "3", "9"...)
  sku text,                                  -- SKU pozycji; kilka pozycji -> po przecinku
  synced_at timestamptz not null default now(),
  -- Dane wpisywane przez pracowników (nie pochodzą z API; synchronizacja ich nie rusza):
  serial_number text,                        -- numer seryjny urządzenia
  pads int check (pads is null or pads >= 0),  -- liczba padów w zestawie (konsole); 0 = bez padów
  pad_serials text[],                        -- numery seryjne padów: element i = pad i+1
  primary key (marketplace, external_id)
);
alter table sales_orders add column if not exists serial_number text;
alter table sales_orders add column if not exists pads int;
alter table sales_orders add column if not exists pad_serials text[];
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_orders_pads_check') then
    alter table sales_orders add constraint sales_orders_pads_check check (pads is null or pads >= 0);
  end if;
end $$;
create index if not exists sales_orders_date_idx on sales_orders (order_date desc);

-- Kursor synchronizacji per kanał: od kiedy liczyć kolejną synchronizację przyrostową,
-- oraz stan pełnego skanu (w porcjach, jak przy zamówieniach BuyBack — patrz lib/scanOrders.ts).
create table if not exists sales_orders_sync_meta (
  marketplace text primary key,
  last_synced_at timestamptz,
  full_scan_done boolean not null default false,
  scan_page int not null default 1,
  scan_started_at timestamptz
);
insert into sales_orders_sync_meta (marketplace) values ('backmarket') on conflict (marketplace) do nothing;

alter table bm_orders enable row level security;
alter table sales_orders enable row level security;
alter table sales_orders_sync_meta enable row level security;

drop policy if exists "authenticated read bm_orders" on bm_orders;
create policy "authenticated read bm_orders" on bm_orders
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated read sales_orders" on sales_orders;
create policy "authenticated read sales_orders" on sales_orders
  for select using (auth.role() = 'authenticated');
-- Zespół może edytować tylko dane własne (numer seryjny, pady); pola z API zmienia wyłącznie serwer.
-- RLS nie umie ograniczać kolumn, więc pilnuje tego trigger (zapis service_role przechodzi bez zmian).
drop policy if exists "authenticated update sales_orders" on sales_orders;
create policy "authenticated update sales_orders" on sales_orders
  for update using (auth.role() = 'authenticated');

create or replace function sales_orders_protect_api_fields() returns trigger
language plpgsql as $$
begin
  if auth.role() = 'authenticated' and (
       new.marketplace is distinct from old.marketplace or new.external_id is distinct from old.external_id
       or new.order_date is distinct from old.order_date or new.status is distinct from old.status
       or new.sku is distinct from old.sku or new.synced_at is distinct from old.synced_at) then
    raise exception 'Pola pochodzące z marketplace (numer, data, status, SKU) zmienia tylko synchronizacja.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists sales_orders_protect_api_fields on sales_orders;
create trigger sales_orders_protect_api_fields before update on sales_orders
  for each row execute function sales_orders_protect_api_fields();

drop policy if exists "authenticated read sales_orders_sync_meta" on sales_orders_sync_meta;
create policy "authenticated read sales_orders_sync_meta" on sales_orders_sync_meta
  for select using (auth.role() = 'authenticated');

do $$
begin
  begin alter publication supabase_realtime add table sales_orders; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table bm_orders; exception when duplicate_object then null; end;
end $$;
