-- Magazyn ERP — Asystent AI (zakładka "AI", 03.10.2026): bezpieczny dostęp TYLKO DO ODCZYTU do danych sprzedaży,
-- zamówień i magazynu dla zapytań SQL układanych przez model.
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Idempotentny.
-- Wymaga wcześniej: schema.sql, sales-orders.sql, overview.sql, nbp.sql, inventory.sql (+ is_admin() z schema.sql).
--
-- Model bezpieczeństwa (warstwy, każda wystarcza sama dla swojej klasy zagrożeń):
--  1. Model NIE dostaje dostępu do tabel — tylko do widoków w schemacie `ai` (lista poniżej), bez danych osobowych
--     (adresy, nazwiska, e-maile, surowe odpowiedzi API marketplace'ów, historia zmian z e-mailami pracowników, faktury
--     z danymi nabywców, tokeny, członkowie zespołu — NIE są w tym schemacie).
--  2. Zapytanie wykonuje funkcja ai_query() jako dedykowana rola `ai_reader` (nologin), która ma wyłącznie SELECT na widokach
--     schematu `ai` — więc nawet zapytanie "wymykające się" z widoków nie ma uprawnień do niczego innego.
--  3. Transakcja jest READ ONLY (nic nie da się zapisać, także przez funkcje security definer z innych schematów),
--     z limitem czasu 15 s i limitem 500 wierszy; dozwolone tylko SELECT/WITH, bez średników (jedna instrukcja).
--  4. ai_query() wolno wywołać tylko serwerowi (service_role) — przeglądarka nie ma do niej dostępu; route
--     app/api/ai/ask wpuszcza wyłącznie rolę Admin.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ai_reader') then
    create role ai_reader nologin;
  end if;
end $$;
-- Rola wołająca ai_query (service_role — serwer aplikacji) musi móc przełączyć się na ai_reader (SET ROLE w ai_query;
-- w funkcji security definer Postgres tego zabrania, dlatego ai_query jest zwykłą funkcją security invoker).
grant ai_reader to postgres;
grant ai_reader to service_role;

create schema if not exists ai;
grant usage on schema ai to ai_reader;

-- Klasyfikacja statusów — LUSTRO lib/salesOrders.ts (SHIPPED_STATUS / CANCELLED_STATUS / NOT_COUNTED). Przy zmianie
-- list w TS trzeba zmienić tutaj (test w repo porównuje oba po wszystkich statusach).
create or replace function ai.stage(p_marketplace text, p_status text) returns text
language sql immutable as $$
  select case
    when (p_marketplace = 'backmarket' and p_status in ('9'))
      or (p_marketplace = 'refurbed' and p_status in ('SHIPPED', 'FULFILLED'))
      or (p_marketplace = 'erli' and p_status in ('sent'))
      or (p_marketplace = 'allegro' and p_status in ('SENT'))
      or (p_marketplace = 'octopia' and p_status in ('Shipped', 'Delivered'))
      or (p_marketplace = 'amazon' and p_status in ('Shipped')) then 'wyslane'
    when (p_marketplace = 'backmarket' and p_status in ('cancelled', 'refunded'))
      or (p_marketplace = 'refurbed' and p_status in ('CANCELLED', 'REJECTED', 'RETURNED'))
      or (p_marketplace = 'erli' and p_status in ('cancelled', 'returned'))
      or (p_marketplace = 'allegro' and p_status in ('CANCELLED', 'RETURNED'))
      or (p_marketplace = 'octopia' and p_status in ('Cancelled', 'Rejected', 'Refused'))
      or (p_marketplace = 'amazon' and p_status in ('Canceled')) then 'anulowane'
    else 'nowe'
  end
$$;

create or replace function ai.is_counted(p_marketplace text, p_status text) returns boolean
language sql immutable as $$
  select not (
    (p_marketplace = 'backmarket' and p_status in ('cancelled', 'refunded', '10', '0', '8'))
    or (p_marketplace = 'refurbed' and p_status in ('CANCELLED', 'REJECTED', 'RETURNED'))
    or (p_marketplace = 'erli' and p_status in ('cancelled', 'returned', 'pending'))
    or (p_marketplace = 'allegro' and p_status in ('CANCELLED', 'BOUGHT', 'FILLED_IN', 'RETURNED'))
    or (p_marketplace = 'octopia' and p_status in ('Cancelled', 'Rejected', 'Refused'))
  )
$$;

-- Zamówienia: jeden wiersz = jedno zamówienie, z wartością (suma cen pozycji) w walucie oryginalnej i w PLN.
-- Przeliczenie wg kursu NBP z OSTATNIEGO dnia roboczego PRZED dniem zamówienia (data zamówienia w UTC — tak samo jak
-- Przegląd, app/api/overview/sales-stats); null, gdy brak ceny pozycji albo kursu.
create or replace view ai.orders as
select
  s.marketplace,
  s.external_id as order_id,
  s.order_date,
  (s.order_date at time zone 'Europe/Warsaw')::date as order_day_pl,
  s.status,
  ai.stage(s.marketplace, s.status) as stage,
  ai.is_counted(s.marketplace, s.status) as is_counted,
  s.country_code,
  s.shipping_method,
  s.planned_shipping_date,
  (s.tracking_number is not null) as has_tracking,
  s.shipping_cost,
  v.total_value,
  upper(coalesce(v.currency, 'PLN')) as currency,
  case
    when v.total_value is null then null
    when upper(coalesce(v.currency, 'PLN')) = 'PLN' then v.total_value
    else v.total_value * fx.mid
  end as value_pln
from sales_orders s
left join sales_order_values v on v.marketplace = s.marketplace and v.external_id = s.external_id
left join lateral (
  select r.mid from nbp_rates r
  where r.currency = upper(coalesce(v.currency, 'PLN'))
    and r.rate_date < (s.order_date at time zone 'UTC')::date
  order by r.rate_date desc
  limit 1
) fx on true;

-- Pozycje zamówień: jedna sztuka = jeden wiersz (cena JEDNOSTKOWA).
create or replace view ai.order_items as
select
  i.marketplace,
  i.external_id as order_id,
  i.item_key,
  o.order_date,
  o.order_day_pl,
  o.status,
  o.stage,
  o.is_counted,
  o.country_code,
  i.sku,
  split_part(i.sku, '-', 1) as sku_category,
  i.name as product_name,
  i.serial_number,
  i.pads,
  i.price,
  upper(coalesce(i.currency, o.currency, 'PLN')) as currency,
  case
    when i.price is null then null
    when upper(coalesce(i.currency, o.currency, 'PLN')) = 'PLN' then i.price
    else i.price * fx.mid
  end as price_pln
from sales_order_items i
join ai.orders o on o.marketplace = i.marketplace and o.order_id = i.external_id
left join lateral (
  select r.mid from nbp_rates r
  where r.currency = upper(coalesce(i.currency, o.currency, 'PLN'))
    and r.rate_date < (o.order_date at time zone 'UTC')::date
  order by r.rate_date desc
  limit 1
) fx on true;

-- Magazyn: sztuki ze stanem 1 w Fakturowni (cache), z SKU z naszej bazy (Testy/Trade-in/import) i kategorią z SKU.
create or replace view ai.stock as
select
  id,
  name as serial_number,
  category_name as category,
  sku,
  sku_category,
  purchase_price_gross,
  vat,
  description as source_order,
  product_created_at as added_at,
  sku_class
from fakturownia_stock_with_sku;

create or replace view ai.nbp_rates as
select currency, rate_date, mid from nbp_rates;

grant select on ai.orders, ai.order_items, ai.stock, ai.nbp_rates to ai_reader;
grant execute on function ai.stage(text, text), ai.is_counted(text, text) to ai_reader;

-- Wykonanie zapytania modelu: tylko odczyt, jedna instrukcja, limity czasu i wierszy; zwraca tablicę JSON.
-- security INVOKER (patrz wyżej): wołający (service_role) przełącza się lokalnie na ai_reader i wraca do swojej roli.
create or replace function public.ai_query(q text, max_rows int default 500) returns jsonb
language plpgsql set search_path = ai, pg_catalog as $$
declare
  clean text := regexp_replace(btrim(coalesce(q, '')), ';+\s*$', '');
  caller text := current_user;
  res jsonb;
begin
  if clean = '' then raise exception 'Puste zapytanie.'; end if;
  if position(';' in clean) > 0 then raise exception 'Dozwolona jest jedna instrukcja (bez średników w środku).'; end if;
  if clean !~* '^(select|with)\M' then raise exception 'Dozwolone są tylko zapytania SELECT / WITH.'; end if;
  if max_rows is null or max_rows < 1 or max_rows > 1000 then max_rows := 500; end if;
  set local statement_timeout = '15s';
  set local transaction_read_only = on;
  set local role ai_reader;
  -- aliasy __q/__t: zwykłe `t`/`q` kolidowałyby z kolumnami o takiej nazwie w zapytaniu modelu (jsonb_agg(t) wzięłoby kolumnę zamiast wiersza)
  execute format('select coalesce(jsonb_agg(__t), ''[]''::jsonb) from (select * from (%s) __q limit %s) __t', clean, max_rows) into res;
  execute format('set local role %I', caller);
  return res;
end $$;
revoke all on function public.ai_query(text, int) from public, anon, authenticated;
grant execute on function public.ai_query(text, int) to service_role;

-- Dziennik pytań do asystenta (kto, o co, jakie zapytania poszły do bazy, zużycie tokenów) — audyt i kontrola kosztów.
-- Zapis tylko z serwera (service_role, zero polityk insert/update), odczyt tylko Admin.
create table if not exists ai_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_email text,
  question text not null,
  answer text,
  queries jsonb not null default '[]'::jsonb,
  model text,
  input_tokens int,
  output_tokens int,
  error text
);
-- Licznik kosztów (03.10.2026): tokeny cache (zapis/odczyt) i szacowany koszt w USD wg lib/aiPricing.ts (null = model bez cennika).
alter table ai_log add column if not exists cache_write_tokens int;
alter table ai_log add column if not exists cache_read_tokens int;
alter table ai_log add column if not exists cost_usd numeric;
alter table ai_log enable row level security;
drop policy if exists "admin read ai_log" on ai_log;
create policy "admin read ai_log" on ai_log for select using (is_admin());

-- Historia rozmów z asystentem (03.10.2026): jedna rozmowa = jeden wiersz z całą wymianą w jsonb (pytania, odpowiedzi, użyte
-- zapytania SQL, tokeny i koszt każdej odpowiedzi). Każdy Admin widzi i usuwa TYLKO własne rozmowy (user_id = auth.uid()).
-- Zapis (utworzenie i dopisywanie wymiany) robi wyłącznie serwer (route ai/ask, service_role) — zero polityki insert, żeby
-- przeglądarka nie mogła podrobić odpowiedzi "asystenta". Zmiana tytułu = update własnego wiersza.
create table if not exists ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  user_email text,
  title text not null,
  messages jsonb not null default '[]'::jsonb,   -- [{role, content, at, queries?, usage?, costUsd?, model?}]
  cost_usd numeric not null default 0,           -- suma kosztów odpowiedzi tej rozmowy (szacunek, USD)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_conversations_user_idx on ai_conversations (user_id, updated_at desc);
alter table ai_conversations enable row level security;
drop policy if exists "admin read own ai_conversations" on ai_conversations;
create policy "admin read own ai_conversations" on ai_conversations for select using (is_admin() and user_id = auth.uid());
drop policy if exists "admin update own ai_conversations" on ai_conversations;
create policy "admin update own ai_conversations" on ai_conversations for update using (is_admin() and user_id = auth.uid()) with check (is_admin() and user_id = auth.uid());
drop policy if exists "admin delete own ai_conversations" on ai_conversations;
create policy "admin delete own ai_conversations" on ai_conversations for delete using (is_admin() and user_id = auth.uid());
