-- Towar: kolumna "Dostępny" (14.10.2026, na prośbę właściciela). Pozycja jest dostępna, gdy jej numer seryjny jest w magazynie Fakturowni
-- (fakturownia_stock_cache = sztuki ze stanem 1; porównanie bez rozróżniania wielkości liter i spacji na brzegach). Widok jest TYLKO nakładką na goods_register:
-- `security_invoker = true`, więc RLS tabeli (goods_can_read()) dalej obowiązuje — kto nie ma dostępu do Towaru, nie zobaczy żadnego wiersza.
-- Idempotentny; po dodaniu kolumn do goods_register uruchom ponownie (widok trzeba odświeżyć, by objął nowe kolumny).
set lock_timeout = '5s';
drop view if exists goods_register_available;
create view goods_register_available with (security_invoker = true) as
select g.*,
       (btrim(coalesce(g.serial, '')) <> ''
        and exists (select 1 from fakturownia_stock_cache c where lower(btrim(c.name)) = lower(btrim(g.serial)))) as available
from goods_register g;
grant select on goods_register_available to authenticated;
