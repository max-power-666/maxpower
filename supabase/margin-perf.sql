-- Magazyn ERP — przyspieszenie zakładki Marża (16.10.2026). Dwa brakujące indeksy dla widoku margin_items; nie zmieniają żadnych danych ani wyników.
-- Uruchom w Supabase: SQL Editor -> wklej CAŁY plik -> Run. Można uruchomić wielokrotnie.
--
-- Widok margin_items liczy się dla każdej sprzedanej sztuki osobno (ok. 5 ms na wiersz, 3-4 s na ~700 wierszy), bo dwa połączenia nie mogły użyć indeksu:
--  1) goods_register: porównanie numeru seryjnego w postaci ltrim(lower(btrim(serial)), '0') (bez zer wiodących) — istniejący indeks był na lower(btrim(serial)), więc każda sztuka przeglądała cały rejestr Towar;
--  2) bm_orders: order_id::text = external_id — rzutowanie bigint na tekst wyłączało indeks klucza głównego, więc każda sztuka Back Market przeglądała wszystkie zamówienia BM razem z ich JSON-ami.
create index if not exists goods_register_serial_norm_idx on goods_register (ltrim(lower(btrim(serial)), '0'));
create index if not exists bm_orders_order_id_text_idx on bm_orders ((order_id::text));
analyze goods_register;
analyze bm_orders;
