-- Marża: ceny zakupu z rejestru Towar (14.10.2026, na prośbę właściciela). Lekka paczka: tylko widok margin_items (ta sama treść jest w margin.sql).
-- Wymaga istniejących tabel margin.sql (bm_invoice_lines itd.) oraz goods_register (goods.sql). Idempotentna.
set lock_timeout = '5s';

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
  oct.currency as octopia_commission_currency,
  p.vat as purchase_vat,
  -- dostawa opłacona przez klienta (09.10.2026) — NA KOŃCU widoku, bo create or replace view nie pozwala wstawiać kolumn w środku
  coalesce(oct.shipping_revenue, bm.shipping_revenue) as shipping_revenue,
  coalesce(oct.currency, bm.currency) as shipping_revenue_currency,
  -- cena zakupu z Towaru dla V23 jest już NETTO (14.10.2026) — NA KOŃCU widoku (create or replace view)
  coalesce(p.is_net, false) as purchase_is_net
from sales_order_items it
join sales_orders o on o.marketplace = it.marketplace and o.external_id = it.external_id
join order_agg oa on oa.marketplace = it.marketplace and oa.external_id = it.external_id
-- zakup (14.10.2026, na prośbę właściciela — "ceny zakupu bierzmy z Towaru"): pozycja rejestru Towar (goods_register) o tym numerze seryjnym; cena = "Cena PLN" z Towaru,
-- numer zamówienia/dokumentu = order_no (dla Skupu numer zamówienia Buyback — z niego liczone są koszty Trade-in), VAT = vat z Towaru. Gdy numer wystąpił kilka razy (odkup),
-- bierzemy zakup sprzed zamówienia, najnowszy. Wiersze V23 mają w Towarze cenę NETTO (kolumna purchase_is_net) — wcześniej Fakturownia podawała brutto.
-- Numery porównujemy bez zer wiodących (część numerów w Towarze straciła je przy imporcie z arkusza). Fakturownia nie jest już źródłem ceny zakupu w Marży.
left join lateral (
  select g.price_pln as purchase_price_gross,
         g.order_no as description,
         nullif(btrim(g.vat), '') as vat,
         (upper(nullif(btrim(g.vat), '')) = 'V23') as is_net
  from goods_register g
  where nullif(btrim(g.serial), '') is not null
    and ltrim(lower(btrim(g.serial)), '0') = ltrim(lower(btrim(it.serial_number)), '0')
  order by (g.purchased_on <= o.order_date::date) desc nulls last, g.purchased_on desc nulls last, g.id desc
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
         -- dostawa opłacona przez kupującego (offerPrice.shippingCost, kwota dla CAŁEJ pozycji; totalPrice.offerPrice = cena x ilość + dostawa, sprawdzone na wszystkich 89 pozycjach z płatną dostawą)
         nullif(l -> 'offerPrice' ->> 'shippingCost', '')::numeric / greatest(coalesce(nullif(l ->> 'quantity', '')::numeric, 1), 1) as shipping_revenue,
         upper(oc.raw ->> 'currencyCode') as currency
  from octopia_orders oc, jsonb_array_elements(case when jsonb_typeof(oc.raw -> 'lines') = 'array' then oc.raw -> 'lines' else '[]'::jsonb end) l
  where it.marketplace = 'octopia' and oc.id = it.external_id
    and (l ->> 'orderLineId') = regexp_replace(it.item_key, '-[0-9]+$', '')
  limit 1
) oct on true
-- Back Market (09.10.2026): dostawa opłacona przez klienta — orderlines[].shipping_price (kwota dla pozycji; order.price jej NIE zawiera, a na fakturze BM wiersz "sales" = cena + dostawa,
-- prowizja liczona od sumy). Pozycje rozbite z ilości > 1 mają klucze "id", "id-2"... — łączymy po podstawie klucza (id pozycji), kwotę dzielimy przez ilość.
left join lateral (
  select nullif(l ->> 'shipping_price', '')::numeric / greatest(coalesce(nullif(l ->> 'quantity', '')::numeric, 1), 1) as shipping_revenue,
         upper(b.currency) as currency
  from bm_orders b, jsonb_array_elements(case when jsonb_typeof(b.orderlines) = 'array' then b.orderlines else '[]'::jsonb end) l
  where it.marketplace = 'backmarket' and b.order_id::text = it.external_id
    and (l ->> 'id') = regexp_replace(it.item_key, '-[0-9]+$', '')
  limit 1
) bm on true
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
