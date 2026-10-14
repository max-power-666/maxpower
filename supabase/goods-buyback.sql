-- Lekka paczka dla zakładki Towar -> Skup (14.10.2026): kolumny `source` i `commission` + unikalny indeks zamówień automatycznych. Ta sama treść jest w goods.sql.
-- Idempotentna; bezpieczna do ponownego uruchomienia. Wymaga istniejącej tabeli goods_register.
set lock_timeout = '5s';

-- ===== Skup: automatyczne wiersze z opłaconych zamówień Buyback (14.10.2026) =====
-- `source`: skąd jest wiersz — 'arkusz' (import z arkusza, WSZYSTKIE dotychczasowe wiersze; wartości zamrożone) albo 'buyback' (dopisany automatycznie przez
-- app/api/goods/sync-buyback z opłaconego zamówienia Buyback + wpisu pracownika w Trade-in). `commission` = "Prowizja" w PLN (10% ceny + opłata logistyczna wg regulaminu);
-- "Prowizja + PCC" (commission_pcc) to dalej prowizja + PCC. Dla wierszy z arkusza commission jest puste (widok wylicza je jako commission_pcc - pcc).
alter table goods_register add column if not exists source text not null default 'arkusz';
alter table goods_register drop constraint if exists goods_register_source_check;
alter table goods_register add constraint goods_register_source_check check (source in ('arkusz', 'buyback'));
alter table goods_register add column if not exists commission numeric(12,2);
-- jedno zamówienie = najwyżej jeden wiersz automatyczny (idempotencja synchronizacji)
create unique index if not exists goods_register_buyback_order_idx on goods_register (order_no) where source = 'buyback';
