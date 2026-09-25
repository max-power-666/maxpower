-- Magazyn ERP — zakładka Zamówienia (sprzedaż z marketplace'ów)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów.
--
-- Dwie warstwy:
--  * bm_orders    — surowe dane zamówień Back Market (GET /ws/orders), podgląd w "BM raw data".
--                   To zamówienia SPRZEDAŻY (klient kupuje u nas), nie skupu — skup to buyback_orders.
--  * refurbed_orders — surowe zamówienia refurbed (OrderService/ListOrders); pełna odpowiedź w kolumnie raw.
--  * sales_orders — wspólna lista zamówień ze wszystkich marketplace'ów (dziś Back Market i refurbed;
--                   Allegro/eBay dojdą jako kolejne wartości `marketplace`). Zapisuje ją ten sam
--                   serwer, który wypełnia surową tabelę danego kanału.
-- Dane z API zapisuje wyłącznie serwer (service_role, poza RLS); zespół czyta wszystko, a edytuje tylko
-- własne dane pozycji (numer seryjny, pady) i log zmian — patrz triggery niżej.

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

-- Surowe zamówienia refurbed (OrderService/ListOrders). Pozycje (items), adresy, prowizje itd. są w `raw`.
create table if not exists refurbed_orders (
  id text primary key,                       -- Order.id (int64 jako tekst)
  state text not null,                       -- NEW | ACCEPTED | SHIPPED | FULFILLED | PARTIALLY_FULFILLED | UNFULFILLED | REJECTED | CANCELLED | RETURNED
  released_at timestamptz,                   -- kiedy zamówienie trafiło do sprzedawcy
  customer_email text,
  currency_code text,
  total_charged numeric,
  payment_method text,
  raw jsonb not null,
  synced_at timestamptz not null default now()
);
create index if not exists refurbed_orders_released_idx on refurbed_orders (released_at desc);

create table if not exists sales_orders (
  marketplace text not null,                 -- 'backmarket' (kolejne kanały później)
  external_id text not null,                 -- numer zamówienia w danym kanale
  order_date timestamptz,
  status text not null,                      -- surowy status kanału (Back Market: kod stanu "1", "3", "9"...)
  sku text,                                  -- SKU-i wszystkich pozycji po przecinku (podsumowanie; szczegóły w sales_order_items)
  tracking_number text,                      -- numer przesyłki z API (Back Market: tracking_number zamówienia)
  synced_at timestamptz not null default now(),
  -- Nasz wewnętrzny status realizacji (niezależny od statusu kanału): nowe | w_realizacji | wyslane
  our_status text not null default 'nowe' check (our_status in ('nowe', 'w_realizacji', 'wyslane')),
  history jsonb not null default '[]'::jsonb,  -- log zmian danych pracowniczych: [{action:"edited", by_email, at, changes:[{field,from,to}]}]
  primary key (marketplace, external_id)
);
alter table sales_orders add column if not exists history jsonb not null default '[]'::jsonb;
alter table sales_orders add column if not exists tracking_number text;
alter table sales_orders add column if not exists our_status text not null default 'nowe';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_orders_our_status_check') then
    alter table sales_orders add constraint sales_orders_our_status_check check (our_status in ('nowe', 'w_realizacji', 'wyslane'));
  end if;
end $$;
-- Uzupełnienie numeru przesyłki dla zamówień pobranych wcześniej (z surowych danych).
update sales_orders s set tracking_number = o.tracking_number
  from bm_orders o
 where s.marketplace = 'backmarket' and o.order_id::text = s.external_id
   and s.tracking_number is distinct from o.tracking_number;
create index if not exists sales_orders_date_idx on sales_orders (order_date desc);

-- Pozycje zamówienia: jedna sztuka = jeden wiersz. Zamówienie może mieć kilka pozycji (i pozycję z ilością > 1
-- rozbijamy na osobne sztuki — każda ma własny numer seryjny). Dane pracownicze (numer seryjny, pady) są PER POZYCJA.
-- item_key: Back Market -> id pozycji (orderline), a dla ilości > 1 "id-2", "id-3"... (stały klucz, więc
-- zmiana kolejności pozycji w API nie przesuwa wpisanych numerów). Wiersze zakłada synchronizacja (sku, position);
-- zespół zmienia tylko numer seryjny i pady.
create table if not exists sales_order_items (
  marketplace text not null,
  external_id text not null,
  item_key text not null,
  position int not null,                     -- kolejność na zamówieniu, od 1
  sku text,
  serial_number text,                        -- numer seryjny urządzenia
  pads int check (pads is null or pads >= 0),  -- liczba padów w zestawie (konsole); 0 = bez padów
  pad_serials text[],                        -- numery seryjne padów: element i = pad i+1
  primary key (marketplace, external_id, item_key),
  foreign key (marketplace, external_id) references sales_orders (marketplace, external_id) on delete cascade
);
create index if not exists sales_order_items_order_idx on sales_order_items (marketplace, external_id, position);

-- Jednorazowe uzupełnienie pozycji dla zamówień pobranych zanim ta tabela powstała (z surowych danych bm_orders).
-- Ta sama zasada kluczy i kolejności co w lib/salesOrders.ts (mapBmItems); powtórne uruchomienie niczego nie zmienia.
insert into sales_order_items (marketplace, external_id, item_key, position, sku)
select 'backmarket', x.external_id, x.item_key, row_number() over (partition by x.external_id order by x.n, x.k), x.sku
from (
  select s.external_id, t.n, k.k,
         coalesce(t.l->>'id', t.n::text) || case when k.k > 1 then '-' || k.k else '' end as item_key,
         nullif(btrim(t.l->>'listing'), '') as sku
  from sales_orders s
  join bm_orders o on s.marketplace = 'backmarket' and o.order_id::text = s.external_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(o.orderlines) = 'array' then o.orderlines else '[]'::jsonb end)
       with ordinality as t(l, n)
  cross join lateral generate_series(1, greatest(coalesce((t.l->>'quantity')::int, 1), 1)) as k(k)
) x
on conflict (marketplace, external_id, item_key) do nothing;

-- Migracja z poprzedniej wersji, w której numer seryjny i pady były na całym zamówieniu (sales_orders):
-- przenieś je na pierwszą pozycję i usuń stare kolumny. Powtórne uruchomienie: kolumn już nie ma, więc nic się nie dzieje.
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'sales_orders' and column_name = 'pads') then
    execute $q$
      update sales_order_items i
         set serial_number = o.serial_number, pads = o.pads, pad_serials = o.pad_serials
        from sales_orders o
       where o.marketplace = i.marketplace and o.external_id = i.external_id
         and (o.serial_number is not null or o.pads is not null or o.pad_serials is not null)
         and i.position = (select min(position) from sales_order_items m where m.marketplace = i.marketplace and m.external_id = i.external_id)
    $q$;
    alter table sales_orders drop column if exists serial_number;
    alter table sales_orders drop column if exists pads;
    alter table sales_orders drop column if exists pad_serials;
  end if;
end $$;

-- Kursor synchronizacji per kanał: od kiedy liczyć kolejną synchronizację przyrostową,
-- oraz stan pełnego skanu (w porcjach, jak przy zamówieniach BuyBack — patrz lib/scanOrders.ts).
create table if not exists sales_orders_sync_meta (
  marketplace text primary key,
  last_synced_at timestamptz,
  full_scan_done boolean not null default false,
  scan_page int not null default 1,
  scan_started_at timestamptz,
  scan_cursor text                           -- refurbed: id ostatniego pobranego zamówienia (paginacja kursorem zamiast numeru strony)
);
alter table sales_orders_sync_meta add column if not exists scan_cursor text;
insert into sales_orders_sync_meta (marketplace) values ('backmarket'), ('refurbed') on conflict (marketplace) do nothing;

alter table bm_orders enable row level security;
alter table refurbed_orders enable row level security;
alter table sales_orders enable row level security;
alter table sales_order_items enable row level security;
alter table sales_orders_sync_meta enable row level security;

drop policy if exists "authenticated read bm_orders" on bm_orders;
create policy "authenticated read bm_orders" on bm_orders
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated read refurbed_orders" on refurbed_orders;
create policy "authenticated read refurbed_orders" on refurbed_orders
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated read sales_orders" on sales_orders;
create policy "authenticated read sales_orders" on sales_orders
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated read sales_order_items" on sales_order_items;
create policy "authenticated read sales_order_items" on sales_order_items
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated read sales_orders_sync_meta" on sales_orders_sync_meta;
create policy "authenticated read sales_orders_sync_meta" on sales_orders_sync_meta
  for select using (auth.role() = 'authenticated');

-- Zespół może edytować tylko dane własne: log zmian (sales_orders.history) oraz numer seryjny i pady
-- pozycji. Pola z API zmienia wyłącznie serwer. RLS nie umie ograniczać kolumn, więc pilnują tego
-- triggery (zapis service_role przechodzi bez zmian).
drop policy if exists "authenticated update sales_orders" on sales_orders;
create policy "authenticated update sales_orders" on sales_orders
  for update using (auth.role() = 'authenticated');
drop policy if exists "authenticated update sales_order_items" on sales_order_items;
create policy "authenticated update sales_order_items" on sales_order_items
  for update using (auth.role() = 'authenticated');

create or replace function sales_orders_protect_api_fields() returns trigger
language plpgsql as $$
begin
  if auth.role() = 'authenticated' and (
       new.marketplace is distinct from old.marketplace or new.external_id is distinct from old.external_id
       or new.order_date is distinct from old.order_date or new.status is distinct from old.status
       or new.sku is distinct from old.sku or new.tracking_number is distinct from old.tracking_number
       or new.synced_at is distinct from old.synced_at) then
    raise exception 'Pola pochodzące z marketplace (numer, data, status, SKU, przesyłka) zmienia tylko synchronizacja.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists sales_orders_protect_api_fields on sales_orders;
create trigger sales_orders_protect_api_fields before update on sales_orders
  for each row execute function sales_orders_protect_api_fields();

create or replace function sales_order_items_protect_api_fields() returns trigger
language plpgsql as $$
begin
  if auth.role() = 'authenticated' and (
       new.marketplace is distinct from old.marketplace or new.external_id is distinct from old.external_id
       or new.item_key is distinct from old.item_key or new.position is distinct from old.position
       or new.sku is distinct from old.sku) then
    raise exception 'Pola pochodzące z marketplace (SKU, kolejność pozycji) zmienia tylko synchronizacja.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists sales_order_items_protect_api_fields on sales_order_items;
create trigger sales_order_items_protect_api_fields before update on sales_order_items
  for each row execute function sales_order_items_protect_api_fields();

-- Zapis danych pozycji razem z wpisem do logu w JEDNEJ transakcji (i dopisanie do historii po stronie bazy,
-- więc równoczesne edycje dwóch osób nie nadpisują sobie nawzajem logu). Wywołuje ją aplikacja (supabase.rpc);
-- działa z uprawnieniami wywołującego, czyli obowiązują polityki i triggery powyżej.
-- Zmiana naszego statusu realizacji zamówienia razem z wpisem do logu (jedna transakcja).
create or replace function sales_order_set_status(p_marketplace text, p_external_id text, p_status text, p_entry jsonb)
returns void
language plpgsql as $$
begin
  update sales_orders
     set our_status = p_status, history = history || jsonb_build_array(p_entry)
   where marketplace = p_marketplace and external_id = p_external_id;
  if not found then
    raise exception 'Nie ma takiego zamówienia.';
  end if;
end $$;

create or replace function sales_item_update(
  p_marketplace text, p_external_id text, p_item_key text,
  p_serial text, p_pads int, p_pad_serials text[], p_entry jsonb
) returns void
language plpgsql as $$
begin
  update sales_order_items
     set serial_number = p_serial, pads = p_pads, pad_serials = p_pad_serials
   where marketplace = p_marketplace and external_id = p_external_id and item_key = p_item_key;
  if not found then
    raise exception 'Nie ma takiej pozycji zamówienia.';
  end if;
  update sales_orders
     set history = history || jsonb_build_array(p_entry)
   where marketplace = p_marketplace and external_id = p_external_id;
end $$;

do $$
begin
  begin alter publication supabase_realtime add table sales_orders; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table sales_order_items; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table bm_orders; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table refurbed_orders; exception when duplicate_object then null; end;
end $$;
