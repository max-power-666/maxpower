-- Towar: kolumna "Dostępny" (14.10.2026, na prośbę właściciela). Pozycja jest dostępna, gdy jej numer seryjny jest w magazynie Fakturowni
-- (fakturownia_stock_cache = sztuki ze stanem 1). Porównanie bez rozróżniania wielkości liter i spacji oraz BEZ zer wiodących, a numer jest szukany nie tylko
-- w całej nazwie produktu, ale też w jej częściach: pierwszym członie ("353042093435183 IPX-256-D"), numerze w nawiasie na końcu
-- ("Canon 550D z obiektywem 18-135mm (2633349527)") i końcowym członie ("Playstation 4 pro 02274526441464614") — tak Fakturownia przechowuje część nazw.
-- Widok jest TYLKO nakładką na goods_register: `security_invoker = true`, więc RLS tabeli (goods_can_read()) dalej obowiązuje — kto nie ma dostępu do Towaru,
-- nie zobaczy żadnego wiersza. Kolumny product_status_* (14.10.2026) = najświeższy status produktu z Serwisu / Testów (wynik) / Trade-in po numerze seryjnym — ta sama
-- funkcja product_status_for() co w Magazynie -> Raw data (wymaga uruchomionego inventory.sql). Idempotentny; po dodaniu kolumn do goods_register uruchom ponownie (widok trzeba odświeżyć, by objął nowe kolumny).
set lock_timeout = '5s';
drop view if exists goods_register_available;
create view goods_register_available with (security_invoker = true) as
select g.*,
       (btrim(coalesce(g.serial, '')) <> ''
        and exists (
          select 1
          from fakturownia_stock_cache c
          cross join lateral (values
            (lower(btrim(c.name))),
            (lower(split_part(btrim(regexp_replace(c.name, '\s+', ' ', 'g')), ' ', 1))),
            (lower(substring(c.name from '\(([A-Za-z0-9]+)\)\s*$'))),
            (lower((regexp_match(btrim(c.name), '([A-Za-z0-9]+)$'))[1]))
          ) k(key)
          where k.key is not null and k.key <> ''
            and ltrim(k.key, '0') = ltrim(lower(btrim(g.serial)), '0')
        )) as available,
       (select ps.source from product_status_for(g.serial) ps) as product_status_source,
       (select ps.status from product_status_for(g.serial) ps) as product_status,
       (select ps.at from product_status_for(g.serial) ps) as product_status_at
from goods_register g;
grant select on goods_register_available to authenticated;
