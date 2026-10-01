-- Magazyn ERP — Przegląd: statystyki sprzedaży (01.10.2026)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów. Wymaga wcześniej uruchomionego sales-orders.sql
-- (sales_orders, sales_order_items).
--
-- Widok agreguje wartość KAŻDEGO zamówienia (suma cen jego pozycji) — potrzebne do kafelków
-- "Ilość/Wartość zamówień dzisiaj/z 30 dni" i wykresów na Przeglądzie (app/api/overview/sales-stats,
-- OverviewSalesDashboard.tsx). Przeliczenie na PLN (różne kanały = różne waluty — EUR/DKK/PLN,
-- sprawdzone na żywych danych) dzieje się PO stronie route'a, kursami z nbp_rates (lib/nbp.ts) —
-- tu tylko surowa suma w walucie oryginalnej, nie ruszamy przeliczeń w SQL.

create or replace view sales_order_values as
select s.marketplace, s.external_id, s.order_date, s.status,
       sum(i.price) as total_value,  -- null, gdy żadna pozycja nie ma jeszcze ceny (np. bardzo świeże zamówienie Amazon przed fazą 2 synchronizacji)
       max(i.currency) as currency   -- wszystkie pozycje jednego zamówienia dzielą walutę; max tylko wybiera jedną wartość deterministycznie
from sales_orders s
join sales_order_items i on i.marketplace = s.marketplace and i.external_id = s.external_id
group by s.marketplace, s.external_id, s.order_date, s.status;

-- Ten sam powód co przy invoices_ready_orders (invoices.sql): sales_orders/sales_order_items mają dziś szerokie
-- select dla authenticated, więc widok nie dokłada nowej ekspozycji danych — grant jawny na wszelki wypadek
-- (PostgREST eksponuje widoki tak jak tabele).
grant select on sales_order_values to authenticated;
