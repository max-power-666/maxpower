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
create table if not exists buyback_orders_sync_meta (
  id int primary key default 1,
  last_synced_at timestamptz,
  constraint buyback_orders_sync_meta_singleton check (id = 1)
);

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

-- Ręczne wprowadzanie zamówień przez pracowników — pracownik podaje numer zamówienia
-- (musi już istnieć w buyback_orders, stąd klucz obcy) i uzupełnia numer seryjny + SKU.
-- Wpisy nie są edytowalne z UI (tylko insert) — to log tego, kto i kiedy co wprowadził,
-- tak jak history w units.
create table if not exists buyback_order_intake (
  id bigint generated always as identity primary key,
  order_public_id text not null references buyback_orders(order_public_id),
  serial_number text not null,
  sku text not null,
  notes text default '',
  entered_by_user_id uuid references auth.users(id),
  entered_by_email text,
  entered_at timestamptz not null default now()
);
create index if not exists buyback_order_intake_order_idx on buyback_order_intake (order_public_id);
create index if not exists buyback_order_intake_entered_idx on buyback_order_intake (entered_at desc);

alter table buyback_order_intake enable row level security;

drop policy if exists "authenticated read buyback_order_intake" on buyback_order_intake;
create policy "authenticated read buyback_order_intake" on buyback_order_intake
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated insert buyback_order_intake" on buyback_order_intake;
create policy "authenticated insert buyback_order_intake" on buyback_order_intake
  for insert with check (auth.role() = 'authenticated');

do $$
begin
  begin alter publication supabase_realtime add table buyback_orders; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table buyback_order_intake; exception when duplicate_object then null; end;
end $$;
