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

-- sku_class (03.10.2026) — "Klasa" = OSTATNI człon SKU po ostatnim myślniku, jeśli składa się wyłącznie z liter (NS-32-V1-D -> D,
-- NS-32-V2-BC -> BC, NS-32-V1-C -> C, PS4P-1TB-BK-A -> A); inaczej null — np. SKU bez myślnika albo ze starego schematu, gdzie ostatni
-- człon to liczba pad-ów/gwarancji ("PS4-500-B-2M" -> null, bo "2M" nie jest klasą). Dopisana na końcu widoku jak sku_category.
-- APARATY (07.10.2026): SKU w postaci "237387 (3/5)" (numer + ocena stanu w nawiasie z ukośnikiem) dają kategorię APARAT i klasę "3/5" — wzorzec to nawias z ukośnikiem na końcu
-- (nie sam ukośnik: zwykłe SKU z pamięcią, np. SGS22U51-12/256-E, zostają bez zmian); to samo robi lib/skuParts.ts.
-- sku_category (02.10.2026) — "Kategoria z SKU" = pierwszy człon SKU przed pierwszym myślnikiem (XSX-1TB-BK-A -> XSX,
-- PS4S-1TB-BK-AB -> PS4S, NS-32-V1-D -> NS); SKU bez myślnika -> cała wartość; brak SKU -> null. Kolumna dopisana NA KOŃCU
-- widoku (create or replace view pozwala tylko dopisywać kolumny na końcu).
-- Kolumny statusu w widokach to PODZAPYTANIA skalarne (nie LATERAL JOIN): Postgres liczy je dopiero dla wierszy zwróconych na stronie (po sortowaniu i LIMIT)
-- i pomija w zapytaniu zliczającym — lateral join liczyłby je dla wszystkich ~18 tys. produktów przy każdym wczytaniu listy.
-- Status produktu (05.10.2026, na prośbę właściciela): OSTATNI status ustawiony w Serwisie (kolumna Status), Testach (kolumna WYNIK) albo Trade-in (kolumna Status)
-- dla danego numeru seryjnego (bez rozróżniania wielkości liter). Najświeższy wg chwili zmiany (status_changed_at / result_changed_at); zwraca źródło
-- ('serwis' | 'testy' | 'trade_in'), klucz statusu/wyniku i chwilę zmiany. Test bez wyniku nie daje statusu.
create index if not exists service_log_device_lower_idx on service_log (lower(btrim(device_ref)));
create index if not exists test_log_serial_lower_idx on test_log (lower(btrim(serial_number)));
create index if not exists buyback_order_intake_serial_lower_idx on buyback_order_intake (lower(btrim(serial_number)));

create or replace function product_status_for(p_serial text)
returns table (source text, status text, at timestamptz)
-- SECURITY DEFINER (05.10.2026): funkcja wołana z widoku wykonuje się z uprawnieniami WOŁAJĄCEGO, więc dla zalogowanych przechodziła przez RLS trzech tabel
-- dla każdego wiersza listy (osobno przy każdym z ~18 tys. produktów) i lista Raw data kończyła się "statement timeout". Jako właściciel czyta tabele bez RLS (te same
-- dane są i tak czytelne dla każdego zalogowanego); zwraca tylko status jednego numeru seryjnego.
language sql stable security definer set search_path = public as $$
  select x.source, x.status, x.at
  from (
    select 'serwis'::text as source, s.status, s.status_changed_at as at from service_log s where lower(btrim(s.device_ref)) = lower(btrim(p_serial))
    union all
    select 'testy', t.result, t.result_changed_at from test_log t where lower(btrim(t.serial_number)) = lower(btrim(p_serial)) and t.result is not null
    union all
    select 'trade_in', i.status, i.status_changed_at from buyback_order_intake i where lower(btrim(i.serial_number)) = lower(btrim(p_serial))
  ) x
  where x.at is not null
  order by x.at desc
  limit 1
$$;
grant execute on function product_status_for(text) to authenticated;

create or replace view fakturownia_stock_with_sku as
select v.*,
       case when v.sku ~ '\(\s*\d+\s*/\s*\d+\s*\)\s*$' then 'APARAT' else nullif(btrim(split_part(v.sku, '-', 1)), '') end as sku_category,
       case when v.sku ~ '\(\s*\d+\s*/\s*\d+\s*\)\s*$' then regexp_replace(substring(v.sku from '\(([^)]*)\)\s*$'), '\s', '', 'g')
            when v.sku ~ '-[A-Za-z]+$' then substring(v.sku from '[A-Za-z]+$') end as sku_class,
       (select ps.source from product_status_for(v.name) ps) as product_status_source,
       (select ps.status from product_status_for(v.name) ps) as product_status,
       (select ps.at from product_status_for(v.name) ps) as product_status_at
from (
select
  c.id,
  c.category_id,
  c.category_name,
  c.purchase_price_gross,
  c.name,
  c.description,
  c.product_created_at,
  -- VAT (05.10.2026): wpis ręczny z cache ma pierwszeństwo; dla sztuk z Trade-in (opis = numer zamówienia skupu BuyBack) automatycznie "VM" = VAT-marża
  -- (zakup od osoby prywatnej). Wartość wyliczana w widoku, nie zapisywana — ręczna zmiana w cache nadal ją nadpisuje.
  coalesce(nullif(btrim(c.vat), ''), case when exists (select 1 from buyback_orders bo where bo.order_public_id = btrim(c.description)) then 'VM' end) as vat,
  -- Ręczne przypisanie (05.10.2026): wpis serial_skus ze source = 'manual' (poprawka właściciela) ma NAJWYŻSZY priorytet — wygrywa nawet z SKU z Testów/Trade-in (poprawia pomyłki w ich wpisach, nic w nich nie zmieniając).
  coalesce((
    select m.sku from serial_skus m where m.source = 'manual' and lower(btrim(m.serial_number)) = lower(btrim(c.name)) limit 1
  ), (
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
