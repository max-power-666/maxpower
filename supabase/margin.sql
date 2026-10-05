-- Magazyn ERP — zakładka Marża (03.10.2026): dane do liczenia marży na sprzedanych sztukach z numerem seryjnym.
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Idempotentny.
-- Wymaga wcześniej: schema.sql, sales-orders.sql, shipping.sql, buyback-orders.sql, nbp.sql, tests.sql, inventory.sql (+ is_admin_or_manager() z shipping.sql).
--
-- 1) fakturownia_purchases — WSZYSTKIE produkty z Fakturowni (także sprzedane, stan 0), bo fakturownia_stock_cache trzyma tylko sztuki ze
--    stanem 1 i kasuje sprzedane, a do marży potrzebna jest cena zakupu sprzedanej sztuki. Wypełnia ją synchronizacja
--    (app/api/fakturownia/sync); poniżej jednorazowo kasujemy last_synced_at, żeby najbliższe "Odśwież" w Magazynie zrobiło pełny skan.
-- 2) bm_invoice_lines — wiersze faktur tygodniowych Back Market (CSV "invoice_*-EU-H-*.csv" wgrywany w zakładce Marża): prowizja,
--    opłata płatnicza, CCBM per zamówienie — pozwala liczyć prowizję DOKŁADNIE dla zamówień z faktury i szacować resztę średnią.
-- 3) margin_items — widok jednej sprzedanej sztuki ze wszystkim, czego potrzeba do marży (zakup, wysyłka, Trade-in, prowizja).
--    Widok czyta tabele z danymi finansowymi, więc dostęp ma TYLKO serwer (service_role); route app/api/margin/list wpuszcza Admina i Managera.

create table if not exists fakturownia_purchases (
  id bigint primary key,                          -- id produktu w Fakturowni
  name text,                                      -- numer seryjny (nazwa produktu = kod = numer seryjny)
  description text,                               -- numer zamówienia Back Market, z którego pochodzi sztuka
  purchase_price_gross numeric not null default 0,
  category_name text,
  stock_level numeric,                            -- 1 = w magazynie, 0 = sprzedane
  product_created_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists fakturownia_purchases_name_idx on fakturownia_purchases (lower(btrim(name)));
alter table fakturownia_purchases enable row level security;
-- Odczyt dla każdego zalogowanego — te same dane (numer seryjny, cena zakupu) są już czytelne dla wszystkich w fakturownia_stock_cache;
-- potrzebne też do widoku "Wszystkie" w Magazynie -> Raw data (rola Magazyn).
drop policy if exists "admin manager read fakturownia_purchases" on fakturownia_purchases;
drop policy if exists "authenticated read fakturownia_purchases" on fakturownia_purchases;
create policy "authenticated read fakturownia_purchases" on fakturownia_purchases for select using (auth.role() = 'authenticated');

-- Jednorazowy pełny skan, gdy tabela jest jeszcze pusta (ten sam wzorzec co przy nowych kolumnach cache w schema.sql).
insert into fakturownia_sync_meta (id) values (1) on conflict (id) do nothing;
update fakturownia_sync_meta set last_synced_at = null
  where id = 1 and not exists (select 1 from fakturownia_purchases);

create table if not exists bm_invoice_lines (
  id bigint generated always as identity primary key,
  invoice_ref text not null,                      -- np. 20260915-EU-H-10047685 (z nazwy pliku)
  line_no int not null,                           -- numer wiersza w pliku — ponowne wgranie tego samego pliku nie dubluje
  invoice_key text not null,                      -- sales | sales_fees | payment_fees | ccbm_fees | sales_dp_adjustment | dp_adjustment_fee | refunds | ...
  value_date timestamptz,
  sku text,
  order_id text,
  designation text,
  amount numeric not null,
  currency text,
  uploaded_by_email text,
  uploaded_at timestamptz not null default now(),
  unique (invoice_ref, line_no)
);
create index if not exists bm_invoice_lines_order_idx on bm_invoice_lines (order_id);
alter table bm_invoice_lines enable row level security;
drop policy if exists "admin manager read bm_invoice_lines" on bm_invoice_lines;
create policy "admin manager read bm_invoice_lines" on bm_invoice_lines for select using (is_admin_or_manager());
-- zapis tylko z serwera (service_role) — zero polityk insert/update/delete.

create or replace view margin_items as
with order_agg as (
  select marketplace, external_id, sum(price) as order_total, count(*) as order_items
  from sales_order_items group by marketplace, external_id
)
select
  it.marketplace,
  it.external_id as order_id,
  it.item_key,
  it.position,
  o.order_date,
  o.status,
  o.country_code,
  it.sku,
  it.name as product_name,
  it.serial_number,
  it.price,
  upper(coalesce(it.currency, 'PLN')) as currency,
  oa.order_total,
  oa.order_items,
  p.purchase_price_gross,
  p.description as purchase_ref,
  bo.status as tradein_status,
  bo.product_title as tradein_title,
  bo.sku as tradein_sku,
  bo.original_price as tradein_original_price,
  bo.original_price_currency as tradein_original_currency,
  bo.counter_offer_price as tradein_counter_price,
  bo.counter_offer_price_currency as tradein_counter_currency,
  bo.payment_date as tradein_payment_date,
  bo.creation_date as tradein_creation_date,
  ship.price as shipping_price,
  ship.currency as shipping_currency,
  o.shipping_cost as shipping_manual,
  rf.commission as refurbed_commission,
  rf.currency as refurbed_commission_currency,
  inv.sales_fees as bm_sales_fees,
  inv.payment_fees as bm_payment_fees,
  inv.ccbm_fees as bm_ccbm_fees,
  inv.has_invoice as bm_has_invoice,
  oct.commission as octopia_commission,
  oct.currency as octopia_commission_currency
from sales_order_items it
join sales_orders o on o.marketplace = it.marketplace and o.external_id = it.external_id
join order_agg oa on oa.marketplace = it.marketplace and oa.external_id = it.external_id
-- zakup: sztuka o tym numerze seryjnym w Fakturowni; gdy numer wystąpił kilka razy (odkup), bierzemy zakup sprzed zamówienia, najnowszy
left join lateral (
  select fp.purchase_price_gross, fp.description
  from fakturownia_purchases fp
  where lower(btrim(fp.name)) = lower(btrim(it.serial_number))
  order by (fp.product_created_at <= o.order_date) desc nulls last, fp.product_created_at desc nulls last
  limit 1
) p on true
left join buyback_orders bo on bo.order_public_id = btrim(p.description)
-- wysyłka: najnowsza nieanulowana przesyłka DHL/UPS tego zamówienia, cena BILLC z wyceny (patrz dhlCharge w lib/shipping.ts)
left join lateral (
  select (c ->> 'price')::numeric as price, upper(c ->> 'priceCurrency') as currency
  from shipments s, jsonb_array_elements(case when jsonb_typeof(s.charges) = 'array' then s.charges else '[]'::jsonb end) c
  where s.marketplace = it.marketplace and s.order_external_id = it.external_id
    and s.cancelled_at is null and s.carrier in ('dhl_express', 'dhl_parcel', 'ups') and c ->> 'currencyType' = 'BILLC'
  order by s.created_at desc
  limit 1
) ship on true
-- refurbed: prowizje z danych zamówienia (settlement_total_commission pozycji = baza + płatność + dynamiczna, w walucie rozliczenia)
left join lateral (
  select nullif(i ->> 'settlement_total_commission', '')::numeric as commission, i ->> 'settlement_currency_code' as currency
  from refurbed_orders r, jsonb_array_elements(case when jsonb_typeof(r.raw -> 'items') = 'array' then r.raw -> 'items' else '[]'::jsonb end) i
  where it.marketplace = 'refurbed' and r.id = it.external_id and i ->> 'id' = it.item_key
  limit 1
) rf on true
-- Octopia (Cdiscount, 05.10.2026): prowizja wprost z danych zamówienia — lines[].offerPrice.commission.amountWithoutVat to kwota dla CAŁEJ pozycji (stawka rate w setnych
-- procenta: 800 = 8%, liczona od ceny × ilość PLUS koszt dostawy zapłacony przez kupującego — sprawdzone na wszystkich 902 liniach), więc na sztukę dzielimy przez ilość.
-- Pozycje rozbite z ilości > 1 mają klucze "id", "id-2"... — łączymy po podstawie klucza (orderLineId). Waluta z zamówienia (EUR).
left join lateral (
  select (l -> 'offerPrice' -> 'commission' ->> 'amountWithoutVat')::numeric / greatest(coalesce(nullif(l ->> 'quantity', '')::numeric, 1), 1) as commission,
         upper(oc.raw ->> 'currencyCode') as currency
  from octopia_orders oc, jsonb_array_elements(case when jsonb_typeof(oc.raw -> 'lines') = 'array' then oc.raw -> 'lines' else '[]'::jsonb end) l
  where it.marketplace = 'octopia' and oc.id = it.external_id
    and (l ->> 'orderLineId') = regexp_replace(it.item_key, '-[0-9]+$', '')
  limit 1
) oct on true
-- Back Market: opłaty z wgranych faktur tygodniowych, zsumowane na zamówienie (wartości ujemne = koszt)
left join lateral (
  select
    sum(l.amount) filter (where l.invoice_key = 'sales_fees') as sales_fees,
    sum(l.amount) filter (where l.invoice_key = 'payment_fees') as payment_fees,
    sum(l.amount) filter (where l.invoice_key = 'ccbm_fees') as ccbm_fees,
    true as has_invoice
  from bm_invoice_lines l
  where it.marketplace = 'backmarket' and l.order_id = it.external_id
  having count(*) > 0
) inv on true
where nullif(btrim(it.serial_number), '') is not null;

revoke all on margin_items from public, anon, authenticated;
grant select on margin_items to service_role;

-- 4) fakturownia_products_with_sku — WSZYSTKIE produkty z Fakturowni (filtr "Wszystkie" w Magazynie -> Raw data; "Dostępne" to nadal
--    fakturownia_stock_with_sku). Te same kolumny co tamten widok (SKU z Testów/Trade-in/importu, kategoria z SKU, klasa — to samo wyliczenie,
--    test w repo porównuje oba widoki dla sztuk w magazynie) + stock_level i available. VAT tylko z cache (dla sprzedanych puste).
create or replace view fakturownia_products_with_sku as
select v.*,
       nullif(btrim(split_part(v.sku, '-', 1)), '') as sku_category,
       case when v.sku ~ '-[A-Za-z]+$' then substring(v.sku from '[A-Za-z]+$') end as sku_class
from (
  select
    p.id,
    p.category_name,
    p.purchase_price_gross,
    p.name,
    p.description,
    p.product_created_at,
    -- VAT (05.10.2026): wpis ręczny z cache ma pierwszeństwo; dla sztuk z Trade-in (opis = numer zamówienia skupu BuyBack) automatycznie "VM" = VAT-marża
    -- (zakup od osoby prywatnej). Wartość wyliczana w widoku, nie zapisywana — ręczna zmiana w cache nadal ją nadpisuje.
    coalesce(nullif(btrim(c.vat), ''), case when exists (select 1 from buyback_orders bo where bo.order_public_id = btrim(p.description)) then 'VM' end) as vat,
    p.stock_level,
    (p.stock_level = 1) as available,
    coalesce((
      select x.sku
      from (
        select btrim(t.sku) as sku, t.started_at as at
          from test_log t
          where lower(btrim(t.serial_number)) = lower(btrim(p.name)) and btrim(coalesce(t.sku, '')) <> ''
        union all
        select btrim(i.sku) as sku, i.entered_at as at
          from buyback_order_intake i
          where lower(btrim(i.serial_number)) = lower(btrim(p.name)) and btrim(coalesce(i.sku, '')) <> ''
      ) x
      order by x.at asc
      limit 1
    ), (
      select b.sku from serial_skus b where lower(btrim(b.serial_number)) = lower(btrim(p.name)) limit 1
    )) as sku
  from fakturownia_purchases p
  left join fakturownia_stock_cache c on c.id = p.id
) v;
grant select on fakturownia_products_with_sku to authenticated;
