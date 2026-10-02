-- Magazyn -> Raw data: widok sztuk z kolumną SKU (02.10.2026).
-- Uruchom PO schema.sql, buyback-orders.sql i tests.sql (korzysta z test_log.sku i buyback_order_intake.sku).
-- Plik jest idempotentny.
--
-- SKU sztuki nie ma w Fakturowni (tam numer seryjny = nazwa produktu = kod) — bierzemy je z naszej bazy po numerze
-- seryjnym: z Testów (test_log.sku) albo z Trade-in (buyback_order_intake.sku), a gdy są oba, WYGRYWA WPIS WCZEŚNIEJSZY
-- (test_log.started_at vs buyback_order_intake.entered_at) — decyzja właściciela. Wpisy z pustym SKU są pomijane, żeby
-- wcześniejszy, ale nieuzupełniony wpis nie zasłaniał późniejszego z wpisanym SKU. Numery porównywane bez rozróżniania
-- wielkości liter i bez spacji na brzegach (Testy zapisują wielkimi literami, Trade-in i Fakturownia — jak wpisano).
--
-- serial_skus (02.10.2026) — jednorazowo zaimportowane przypisania numer seryjny -> SKU z arkusza właściciela (~4,5 tys.
-- historycznych sztuk, które nigdy nie przeszły przez Testy/Trade-in w aplikacji). To WARSTWA REZERWOWA: SKU z tej
-- tabeli pokazuje się tylko wtedy, gdy ani Testy, ani Trade-in nie mają dla sztuki wpisanego SKU (świeży wpis
-- zespołu ma pierwszeństwo przed historycznym importem). Dane wgrywa osobny plik jednorazowy, nie ten.
create table if not exists serial_skus (
  id bigint generated always as identity primary key,
  serial_number text not null check (btrim(serial_number) <> ''),
  sku text not null check (btrim(sku) <> ''),
  source text not null default 'import',
  created_at timestamptz not null default now()
);
create unique index if not exists serial_skus_serial_norm_idx on serial_skus (lower(btrim(serial_number)));
alter table serial_skus enable row level security;
drop policy if exists "authenticated read serial_skus" on serial_skus;
create policy "authenticated read serial_skus" on serial_skus for select using (auth.role() = 'authenticated');
-- Zmiany tylko Admin (import idzie przez SQL Editor / service_role, które RLS omijają).
drop policy if exists "admin write serial_skus" on serial_skus;
create policy "admin write serial_skus" on serial_skus for all using (is_admin()) with check (is_admin());

create index if not exists test_log_serial_norm_idx on test_log (lower(btrim(serial_number)));
create index if not exists buyback_order_intake_serial_norm_idx on buyback_order_intake (lower(btrim(serial_number)));

-- sku_category (02.10.2026) — "Kategoria z SKU" = pierwszy człon SKU przed pierwszym myślnikiem (XSX-1TB-BK-A -> XSX,
-- PS4S-1TB-BK-AB -> PS4S, NS-32-V1-D -> NS); SKU bez myślnika -> cała wartość; brak SKU -> null. Kolumna dopisana NA KOŃCU
-- widoku (create or replace view pozwala tylko dopisywać kolumny na końcu).
create or replace view fakturownia_stock_with_sku as
select v.*, nullif(btrim(split_part(v.sku, '-', 1)), '') as sku_category
from (
select
  c.id,
  c.category_id,
  c.category_name,
  c.purchase_price_gross,
  c.name,
  c.description,
  c.product_created_at,
  c.vat,
  coalesce((
    select x.sku
    from (
      select btrim(t.sku) as sku, t.started_at as at
        from test_log t
        where lower(btrim(t.serial_number)) = lower(btrim(c.name)) and btrim(coalesce(t.sku, '')) <> ''
      union all
      select btrim(i.sku) as sku, i.entered_at as at
        from buyback_order_intake i
        where lower(btrim(i.serial_number)) = lower(btrim(c.name)) and btrim(coalesce(i.sku, '')) <> ''
    ) x
    order by x.at asc
    limit 1
  ), (
    select b.sku from serial_skus b where lower(btrim(b.serial_number)) = lower(btrim(c.name)) limit 1
  )) as sku
from fakturownia_stock_cache c
) v;

-- Widok czyta tabele czytelne dla każdego zalogowanego — nie dokłada nowej ekspozycji danych; grant jawny, bo PostgREST
-- eksponuje widoki tak jak tabele.
grant select on fakturownia_stock_with_sku to authenticated;
