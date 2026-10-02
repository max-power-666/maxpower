-- Magazyn -> Raw data: widok sztuk z kolumną SKU (02.10.2026).
-- Uruchom PO schema.sql, buyback-orders.sql i tests.sql (korzysta z test_log.sku i buyback_order_intake.sku).
-- Plik jest idempotentny.
--
-- SKU sztuki nie ma w Fakturowni (tam numer seryjny = nazwa produktu = kod) — bierzemy je z naszej bazy po numerze
-- seryjnym: z Testów (test_log.sku) albo z Trade-in (buyback_order_intake.sku), a gdy są oba, WYGRYWA WPIS WCZEŚNIEJSZY
-- (test_log.started_at vs buyback_order_intake.entered_at) — decyzja właściciela. Wpisy z pustym SKU są pomijane, żeby
-- wcześniejszy, ale nieuzupełniony wpis nie zasłaniał późniejszego z wpisanym SKU. Numery porównywane bez rozróżniania
-- wielkości liter i bez spacji na brzegach (Testy zapisują wielkimi literami, Trade-in i Fakturownia — jak wpisano).

create index if not exists test_log_serial_norm_idx on test_log (lower(btrim(serial_number)));
create index if not exists buyback_order_intake_serial_norm_idx on buyback_order_intake (lower(btrim(serial_number)));

create or replace view fakturownia_stock_with_sku as
select
  c.id,
  c.category_id,
  c.category_name,
  c.purchase_price_gross,
  c.name,
  c.description,
  c.product_created_at,
  c.vat,
  (
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
  ) as sku
from fakturownia_stock_cache c;

-- Widok czyta tabele czytelne dla każdego zalogowanego — nie dokłada nowej ekspozycji danych; grant jawny, bo PostgREST
-- eksponuje widoki tak jak tabele.
grant select on fakturownia_stock_with_sku to authenticated;
