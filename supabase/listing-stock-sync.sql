-- Magazyn ERP — synchronizacja stanów ofert Back Market <-> refurbed (16.10.2026, Magazyn -> Do wystawienia).
-- Uruchom w Supabase: SQL Editor -> wklej CAŁY plik -> Run. Można uruchomić ponownie. Wymaga schema.sql (members) i sales-orders.sql.
-- Sprzedaż sztuki na jednym marketplace'ie zmniejsza ilość oferty z tym samym SKU na drugim (app/api/listings/stock-sync, cron co 15 min). Funkcja jest WYŁĄCZONA, dopóki Admin jej nie włączy
-- (przycisk w Do wystawienia); przy włączeniu wszystkie dotychczasowe pozycje zamówień są oznaczane jako już obsłużone (baseline), więc nic z historii nie zmniejszy stanów.
-- Zapisuje wyłącznie serwer (service_role); odczyt: Admin, Manager, Księgowa.

create table if not exists listing_stock_settings (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,
  activated_at timestamptz,
  activated_by text,
  last_run_at timestamptz,
  last_result text,
  running_since timestamptz                      -- blokada przed równoległymi przebiegami
);
insert into listing_stock_settings (id) values (1) on conflict do nothing;

-- Które pozycje zamówień już uwzględniono (jedna pozycja = jedna sztuka). action: baseline | applied | skipped | claimed
create table if not exists listing_stock_synced (
  marketplace text not null,
  external_id text not null,
  item_key text not null,
  action text not null,
  note text,
  processed_at timestamptz not null default now(),
  primary key (marketplace, external_id, item_key)
);

-- Dziennik zmian ilości ofert (automat i ręczne "Zaktualizuj ilości")
create table if not exists listing_stock_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  source text not null,                          -- auto | manual
  by_email text,                                 -- null = automat
  marketplace text not null,
  external_id text not null,
  sku text,
  old_quantity int,
  new_quantity int,
  reason text,
  ok boolean not null default true,
  error text
);
create index if not exists listing_stock_log_created_idx on listing_stock_log (created_at desc);

alter table listing_stock_settings enable row level security;
alter table listing_stock_synced enable row level security;
alter table listing_stock_log enable row level security;
drop policy if exists "managers read listing_stock_settings" on listing_stock_settings;
create policy "managers read listing_stock_settings" on listing_stock_settings for select
  using (exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Księgowa')));
drop policy if exists "managers read listing_stock_log" on listing_stock_log;
create policy "managers read listing_stock_log" on listing_stock_log for select
  using (exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Księgowa')));
-- brak polityk insert/update/delete oraz brak jakiejkolwiek polityki na listing_stock_synced: zapis i odczyt tylko service_role

-- Włączenie: oznacza WSZYSTKIE dotychczasowe pozycje zamówień Back Market i refurbed jako obsłużone (baseline) i ustawia enabled.
create or replace function listing_stock_enable(p_email text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into listing_stock_synced (marketplace, external_id, item_key, action, note)
  select marketplace, external_id, item_key, 'baseline', 'stan sprzed włączenia synchronizacji'
  from sales_order_items where marketplace in ('backmarket', 'refurbed')
  on conflict do nothing;
  update listing_stock_settings set enabled = true, activated_at = now(), activated_by = p_email, running_since = null where id = 1;
end $$;
revoke all on function listing_stock_enable(text) from public, anon, authenticated;

-- Pozycje do uwzględnienia: jeszcze nieobsłużone, z zamówień z ostatnich 14 dni (starsze nigdy nie są ruszane).
create or replace function listing_stock_pending(p_limit int default 500)
returns table (marketplace text, external_id text, item_key text, sku text, order_status text, order_date timestamptz)
language sql stable security definer set search_path = public as $$
  select i.marketplace, i.external_id, i.item_key, i.sku, o.status, o.order_date
  from sales_order_items i
  join sales_orders o on o.marketplace = i.marketplace and o.external_id = i.external_id
  where i.marketplace in ('backmarket', 'refurbed')
    and o.order_date >= now() - interval '14 days'
    and not exists (select 1 from listing_stock_synced s where s.marketplace = i.marketplace and s.external_id = i.external_id and s.item_key = i.item_key)
  order by o.order_date
  limit p_limit;
$$;
revoke all on function listing_stock_pending(int) from public, anon, authenticated;
