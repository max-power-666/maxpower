-- Towar: kolumna "Dostępny" (14.10.2026, na prośbę właściciela). Pozycja jest dostępna, gdy jej numer seryjny jest w magazynie Fakturowni
-- (fakturownia_stock_cache = sztuki ze stanem 1). Porównanie bez rozróżniania wielkości liter i spacji oraz BEZ zer wiodących, a numer jest szukany nie tylko
-- w całej nazwie produktu, ale też w jej częściach: pierwszym członie ("353042093435183 IPX-256-D"), numerze w nawiasie na końcu
-- ("Canon 550D z obiektywem 18-135mm (2633349527)") i końcowym członie ("Playstation 4 pro 02274526441464614") — tak Fakturownia przechowuje część nazw.
-- Widok jest TYLKO nakładką na goods_register: `security_invoker = true`, więc RLS tabeli (goods_can_read()) dalej obowiązuje — kto nie ma dostępu do Towaru,
-- nie zobaczy żadnego wiersza. Kolumny product_status_* (14.10.2026) = najświeższy status produktu z Serwisu / Testów (wynik) / Trade-in po numerze seryjnym — ta sama
-- funkcja product_status_for() co w Magazynie -> Raw data (wymaga uruchomionego inventory.sql). Idempotentny; po dodaniu kolumn do goods_register uruchom ponownie (widok trzeba odświeżyć, by objął nowe kolumny).
set lock_timeout = '5s';
drop view if exists goods_register_available;
-- Wydajność (15.10.2026): klucze magazynu i historii zakupów Fakturowni liczone RAZ na zapytanie (CTE materialized + hash), a "najnowszy zakup numeru" to jedno okno
-- (row_number) zamiast skorelowanego not exists. Poprzednia wersja liczyła dostępność osobno dla każdej kolumny i filtra (available, pending) i kończyła się
-- "statement timeout" na liście Skupu. Status produktu (podzapytania skalarne) liczy się tylko dla wierszy, które trafiają na stronę.
create view goods_register_available with (security_invoker = true) as
with stock_keys as materialized (
  -- znormalizowane (bez zer wiodących, małe litery) numery, pod jakimi sztuka może występować w nazwie produktu w Fakturowni
  select distinct ltrim(k.key, '0') as key
  from fakturownia_stock_cache c
  cross join lateral (values
    (lower(btrim(c.name))),
    (lower(split_part(btrim(regexp_replace(c.name, '\s+', ' ', 'g')), ' ', 1))),
    (lower(substring(c.name from '\(([A-Za-z0-9]+)\)\s*$'))),
    (lower((regexp_match(btrim(c.name), '([A-Za-z0-9]+)$'))[1]))
  ) k(key)
  where k.key is not null and k.key <> ''
),
purchase_keys as materialized (
  select distinct lower(btrim(name)) as key from fakturownia_purchases where name is not null
),
ranked as (
  select g.*,
         ltrim(lower(btrim(coalesce(g.serial, ''))), '0') as serial_key,
         -- ten sam numer seryjny w Towarze wielokrotnie (np. sztuka sprzedana i odkupiona): dostępny jest tylko NAJNOWSZY zakup (data zakupu, a przy równych id)
         row_number() over (
           partition by ltrim(lower(btrim(coalesce(g.serial, ''))), '0')
           order by coalesce(g.purchased_on, date '0001-01-01') desc, g.id desc
         ) as serial_rank
  from goods_register g
),
flagged as (
  select r.*,
         (btrim(coalesce(r.serial, '')) <> '' and r.serial_rank = 1 and r.serial_key in (select key from stock_keys)) as available
  from ranked r
)
select f.*,
       -- "Oczekuje": opłacony zakup z Buyback (auto), który nie jest jeszcze w magazynie i nigdy w nim nie był (brak numeru w historii zakupów Fakturowni) — paczka jeszcze nie
       -- dotarła/nie została wprowadzona. Tylko 30 dni od zakupu, żeby porzucone wpisy nie wisiały wiecznie. Odróżnia je od sztuk już sprzedanych (te są w historii Fakturowni).
       (f.source = 'buyback'
        and not f.available
        and f.purchased_on >= current_date - 30
        and not (btrim(coalesce(f.serial, '')) <> '' and lower(btrim(f.serial)) in (select key from purchase_keys))) as pending,
       (select ps.source from product_status_for(f.serial) ps) as product_status_source,
       (select ps.status from product_status_for(f.serial) ps) as product_status,
       (select ps.at from product_status_for(f.serial) ps) as product_status_at
from flagged f;
grant select on goods_register_available to authenticated;
