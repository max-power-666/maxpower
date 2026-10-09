-- Magazyn ERP — Magazyn -> Katalog konsol (06.10.2026): katalog modeli konsol z SKU wg stanu (zadowalający / dobry / bardzo dobry).
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Można uruchomić ponownie.
-- Źródło: arkusz "katalog konsol.numbers" właściciela (75 wierszy). SKU w katalogu ma na końcu liczbę kontrolerów (-0M / -1M / -2M);
-- wersja BEZ info o kontrolerach (np. PS5S-1TB-WE-C) jest wyliczana w aplikacji (obcięcie końcówki -nM), nie przechowywana.
-- Katalog edytuje Admin w aplikacji (komórki, dodawanie/usuwanie wierszy); dane startowe z arkusza wgrywają się TYLKO do pustej tabeli,
-- więc ponowne uruchomienie pliku nie nadpisuje zmian Admina.
-- 10.10.2026: dane startowe poprawione zgodnie z katalogiem w bazie (uzupełnione SKU PS5 Pro 2 TB i Xbox Series S 1 TB, PS4 Pro Biały z kolorem WE zamiast BK) —
-- tak samo jak w sklepie (shop-console-import.sql).

create table if not exists console_catalog (
  id bigint generated always as identity primary key,
  position int not null,                 -- kolejność z arkusza
  manufacturer text not null,
  name text not null unique,
  accessories text,                      -- "bez padów" | "1 pad" | "2 pady"
  color text,
  storage text,
  sku_satisfactory text,                 -- stan "zadowalający" (klasa C)
  sku_good text,                         -- stan "dobry" (klasa B)
  sku_very_good text                     -- stan "bardzo dobry" (klasa A)
);

alter table console_catalog enable row level security;
drop policy if exists "authenticated read console_catalog" on console_catalog;
create policy "authenticated read console_catalog" on console_catalog for select using (auth.role() = 'authenticated');
-- Zapis: tylko Admin (is_admin() ze schema.sql), usunięcia z zapisem w deleted_records (audit_delete).
drop policy if exists "admin insert console_catalog" on console_catalog;
create policy "admin insert console_catalog" on console_catalog for insert with check (is_admin());
drop policy if exists "admin update console_catalog" on console_catalog;
create policy "admin update console_catalog" on console_catalog for update using (is_admin());
drop policy if exists "admin delete console_catalog" on console_catalog;
create policy "admin delete console_catalog" on console_catalog for delete using (is_admin());
drop trigger if exists console_catalog_audit_delete on console_catalog;
create trigger console_catalog_audit_delete before delete on console_catalog
  for each row execute function audit_delete();

insert into console_catalog (position, manufacturer, name, accessories, color, storage, sku_satisfactory, sku_good, sku_very_good)
select * from (values
  (1, 'Sony Playstation', 'Sony PlayStation 5 Slim Digital Edition 1TB Biały – Bez padów', 'bez padów', 'Biały', '1 TB', 'PS5SD-1TB-WE-C-0M', 'PS5SD-1TB-WE-B-0M', 'PS5SD-1TB-WE-A-0M'),
  (2, 'Sony Playstation', 'Sony PlayStation 5 Slim Digital Edition 1TB Biały – 2 pady', '2 pady', 'Biały', '1 TB', 'PS5SD-1TB-WE-C-2M', 'PS5SD-1TB-WE-B-2M', 'PS5SD-1TB-WE-A-2M'),
  (3, 'Sony Playstation', 'Sony PlayStation 5 Slim Digital Edition 1TB Biały – 1 pad', '1 pad', 'Biały', '1 TB', 'PS5SD-1TB-WE-C-1M', 'PS5SD-1TB-WE-B-1M', 'PS5SD-1TB-WE-A-1M'),
  (4, 'Sony Playstation', 'Sony PlayStation 5 Slim 1TB Biały – Bez padów', 'bez padów', 'Biały', '1 TB', 'PS5S-1TB-WE-C-0M', 'PS5S-1TB-WE-B-0M', 'PS5S-1TB-WE-A-0M'),
  (5, 'Sony Playstation', 'Sony PlayStation 5 Slim 1TB Biały – 2 pady', '2 pady', 'Biały', '1 TB', 'PS5S-1TB-WE-C-2M', 'PS5S-1TB-WE-B-2M', 'PS5S-1TB-WE-A-2M'),
  (6, 'Sony Playstation', 'Sony PlayStation 5 Slim 1TB Biały – 1 pad', '1 pad', 'Biały', '1 TB', 'PS5S-1TB-WE-C-1M', 'PS5S-1TB-WE-B-1M', 'PS5S-1TB-WE-A-1M'),
  (7, 'Sony Playstation', 'Sony PlayStation 5 Pro 2 TB Biały – Bez padów', 'bez padów', 'Biały', '2 TB', 'PS5P-2TB-WE-C-0M', 'PS5P-2TB-WE-B-0M', 'PS5P-2TB-WE-A-0M'),
  (8, 'Sony Playstation', 'Sony PlayStation 5 Pro 2 TB Biały – 2 pady', '2 pady', 'Biały', '2 TB', 'PS5P-2TB-WE-C-2M', 'PS5P-2TB-WE-B-2M', 'PS5P-2TB-WE-A-2M'),
  (9, 'Sony Playstation', 'Sony PlayStation 5 Pro 2 TB Biały – 1 pad', '1 pad', 'Biały', '2 TB', 'PS5P-2TB-WE-C-1M', 'PS5P-2TB-WE-B-1M', 'PS5P-2TB-WE-A-1M'),
  (10, 'Sony Playstation', 'Sony PlayStation 5 Digital Edition 825GB Biały – Bez padów', 'bez padów', 'Biały', '825 GB', 'PS5D-825-WE-C-0M', 'PS5D-825-WE-B-0M', 'PS5D-825-WE-A-0M'),
  (11, 'Sony Playstation', 'Sony PlayStation 5 Digital Edition 825GB Biały – 2 pady', '2 pady', 'Biały', '825 GB', 'PS5D-825-WE-C-2M', 'PS5D-825-WE-B-2M', 'PS5D-825-WE-A-2M'),
  (12, 'Sony Playstation', 'Sony PlayStation 5 Digital Edition 825GB Biały – 1 pad', '1 pad', 'Biały', '825 GB', 'PS5D-825-WE-C-1M', 'PS5D-825-WE-B-1M', 'PS5D-825-WE-A-1M'),
  (13, 'Sony Playstation', 'Sony PlayStation 5 (PS5) 825GB Biały – Bez padów', 'bez padów', 'Biały', '825 GB', 'PS5-825-WE-C-0M', 'PS5-825-WE-B-0M', 'PS5-825-WE-A-0M'),
  (14, 'Sony Playstation', 'Sony PlayStation 5 (PS5) 825GB Biały – 2 pady', '2 pady', 'Biały', '825 GB', 'PS5-825-WE-C-2M', 'PS5-825-WE-B-2M', 'PS5-825-WE-A-2M'),
  (15, 'Sony Playstation', 'Sony PlayStation 5 (PS5) 825GB Biały – 1 pad', '1 pad', 'Biały', '825 GB', 'PS5-825-WE-C-1M', 'PS5-825-WE-B-1M', 'PS5-825-WE-A-1M'),
  (16, 'Sony Playstation', 'Sony PlayStation 4 Slim (PS4 Slim) 500GB Czarny – Bez padów', 'bez padów', 'Czarny', '500 GB', 'PS4S-500-BK-C-0M', 'PS4S-500-BK-B-0M', 'PS4S-500-BK-A-0M'),
  (17, 'Sony Playstation', 'Sony PlayStation 4 Slim (PS4 Slim) 500GB Czarny – 2 pady', '2 pady', 'Czarny', '500 GB', 'PS4S-500-BK-C-2M', 'PS4S-500-BK-B-2M', 'PS4S-500-BK-A-2M'),
  (18, 'Sony Playstation', 'Sony PlayStation 4 Slim (PS4 Slim) 500GB Czarny – 1 pad', '1 pad', 'Czarny', '500 GB', 'PS4S-500-BK-C-1M', 'PS4S-500-BK-B-1M', 'PS4S-500-BK-A-1M'),
  (19, 'Sony Playstation', 'Sony PlayStation 4 Slim (PS4 Slim) 500GB Biały – Bez padów', 'bez padów', 'Biały', '500 GB', 'PS4S-500-WE-C-0M', 'PS4S-500-WE-B-0M', 'PS4S-500-WE-A-0M'),
  (20, 'Sony Playstation', 'Sony PlayStation 4 Slim (PS4 Slim) 500GB Biały – 2 pady', '2 pady', 'Biały', '500 GB', 'PS4S-500-WE-C-2M', 'PS4S-500-WE-B-2M', 'PS4S-500-WE-A-2M'),
  (21, 'Sony Playstation', 'Sony PlayStation 4 Slim (PS4 Slim) 500GB Biały – 1 pad', '1 pad', 'Biały', '500 GB', 'PS4S-500-WE-C-1M', 'PS4S-500-WE-B-1M', 'PS4S-500-WE-A-1M'),
  (22, 'Sony Playstation', 'Sony PlayStation 4 Slim (PS4 Slim) 1TB Czarny – Bez padów', 'bez padów', 'Czarny', '1 TB', 'PS4S-1TB-BK-C-0M', 'PS4S-1TB-BK-B-0M', 'PS4S-1TB-BK-A-0M'),
  (23, 'Sony Playstation', 'Sony PlayStation 4 Slim (PS4 Slim) 1TB Czarny – 2 pady', '2 pady', 'Czarny', '1 TB', 'PS4S-1TB-BK-C-2M', 'PS4S-1TB-BK-B-2M', 'PS4S-1TB-BK-A-2M'),
  (24, 'Sony Playstation', 'Sony PlayStation 4 Slim (PS4 Slim) 1TB Czarny – 1 pad', '1 pad', 'Czarny', '1 TB', 'PS4S-1TB-BK-C-1M', 'PS4S-1TB-BK-B-1M', 'PS4S-1TB-BK-A-1M'),
  (25, 'Sony Playstation', 'Sony PlayStation 4 Slim (PS4 Slim) 1TB Biały – Bez padów', 'bez padów', 'Biały', '1 TB', 'PS4S-1TB-WE-C-0M', 'PS4S-1TB-WE-B-0M', 'PS4S-1TB-WE-A-0M'),
  (26, 'Sony Playstation', 'Sony PlayStation 4 Slim (PS4 Slim) 1TB Biały – 2 pady', '2 pady', 'Biały', '1 TB', 'PS4S-1TB-WE-C-2M', 'PS4S-1TB-WE-B-2M', 'PS4S-1TB-WE-A-2M'),
  (27, 'Sony Playstation', 'Sony PlayStation 4 Slim (PS4 Slim) 1TB Biały – 1 pad', '1 pad', 'Biały', '1 TB', 'PS4S-1TB-WE-C-1M', 'PS4S-1TB-WE-B-1M', 'PS4S-1TB-WE-A-1M'),
  (28, 'Sony Playstation', 'Sony PlayStation 4 Pro (PS4 Pro) 1TB Czarny – Bez padów', 'bez padów', 'Czarny', '1 TB', 'PS4P-1TB-BK-C-0M', 'PS4P-1TB-BK-B-0M', 'PS4P-1TB-BK-A-0M'),
  (29, 'Sony Playstation', 'Sony PlayStation 4 Pro (PS4 Pro) 1TB Czarny – 2 pady', '2 pady', 'Czarny', '1 TB', 'PS4P-1TB-BK-C-2M', 'PS4P-1TB-BK-B-2M', 'PS4P-1TB-BK-A-2M'),
  (30, 'Sony Playstation', 'Sony PlayStation 4 Pro (PS4 Pro) 1TB Czarny – 1 pad', '1 pad', 'Czarny', '1 TB', 'PS4P-1TB-BK-C-1M', 'PS4P-1TB-BK-B-1M', 'PS4P-1TB-BK-A-1M'),
  (31, 'Sony Playstation', 'Sony PlayStation 4 Pro (PS4 Pro) 1TB Biały – Bez padów', 'bez padów', 'Biały', '1 TB', 'PS4P-1TB-WE-C-0M', 'PS4P-1TB-WE-B-0M', 'PS4P-1TB-WE-A-0M'),
  (32, 'Sony Playstation', 'Sony PlayStation 4 Pro (PS4 Pro) 1TB Biały – 2 pady', '2 pady', 'Biały', '1 TB', 'PS4P-1TB-WE-C-2M', 'PS4P-1TB-WE-B-2M', 'PS4P-1TB-WE-A-2M'),
  (33, 'Sony Playstation', 'Sony PlayStation 4 Pro (PS4 Pro) 1TB Biały – 1 pad', '1 pad', 'Biały', '1 TB', 'PS4P-1TB-WE-C-1M', 'PS4P-1TB-WE-B-1M', 'PS4P-1TB-WE-A-1M'),
  (34, 'Sony Playstation', 'Sony PlayStation 4 (PS4) 500GB Czarny – Bez padów', 'bez padów', 'Czarny', '500 GB', 'PS4-500-BK-C-0M', 'PS4-500-BK-B-0M', 'PS4-500-BK-A-0M'),
  (35, 'Sony Playstation', 'Sony PlayStation 4 (PS4) 500GB Czarny – 2 pady', '2 pady', 'Czarny', '500 GB', 'PS4-500-BK-C-2M', 'PS4-500-BK-B-2M', 'PS4-500-BK-A-2M'),
  (36, 'Sony Playstation', 'Sony PlayStation 4 (PS4) 500GB Czarny – 1 pad', '1 pad', 'Czarny', '500 GB', 'PS4-500-BK-C-1M', 'PS4-500-BK-B-1M', 'PS4-500-BK-A-1M'),
  (37, 'Sony Playstation', 'Sony PlayStation 4 (PS4) 500GB Biały – Bez padów', 'bez padów', 'Biały', '500 GB', 'PS4-500-WE-C-0M', 'PS4-500-WE-B-0M', 'PS4-500-WE-A-0M'),
  (38, 'Sony Playstation', 'Sony PlayStation 4 (PS4) 500GB Biały – 2 pady', '2 pady', 'Biały', '500 GB', 'PS4-500-WE-C-2M', 'PS4-500-WE-B-2M', 'PS4-500-WE-A-2M'),
  (39, 'Sony Playstation', 'Sony PlayStation 4 (PS4) 500GB Biały – 1 pad', '1 pad', 'Biały', '500 GB', 'PS4-500-WE-C-1M', 'PS4-500-WE-B-1M', 'PS4-500-WE-A-1M'),
  (40, 'Sony Playstation', 'Sony PlayStation 4 (PS4) 1TB Czarny – Bez padów', 'bez padów', 'Czarny', '1 TB', 'PS4-1TB-BK-C-0M', 'PS4-1TB-BK-B-0M', 'PS4-1TB-BK-A-0M'),
  (41, 'Sony Playstation', 'Sony PlayStation 4 (PS4) 1TB Czarny – 2 pady', '2 pady', 'Czarny', '1 TB', 'PS4-1TB-BK-C-2M', 'PS4-1TB-BK-B-2M', 'PS4-1TB-BK-A-2M'),
  (42, 'Sony Playstation', 'Sony PlayStation 4 (PS4) 1TB Czarny – 1 pad', '1 pad', 'Czarny', '1 TB', 'PS4-1TB-BK-C-1M', 'PS4-1TB-BK-B-1M', 'PS4-1TB-BK-A-1M'),
  (43, 'Sony Playstation', 'Sony PlayStation 4 (PS4) 1TB Biały – Bez padów', 'bez padów', 'Biały', '1 TB', 'PS4-1TB-WE-C-0M', 'PS4-1TB-WE-B-0M', 'PS4-1TB-WE-A-0M'),
  (44, 'Sony Playstation', 'Sony PlayStation 4 (PS4) 1TB Biały – 2 pady', '2 pady', 'Biały', '1 TB', 'PS4-1TB-WE-C-2M', 'PS4-1TB-WE-B-2M', 'PS4-1TB-WE-A-2M'),
  (45, 'Sony Playstation', 'Sony PlayStation 4 (PS4) 1TB Biały – 1 pad', '1 pad', 'Biały', '1 TB', 'PS4-1TB-WE-C-1M', 'PS4-1TB-WE-B-1M', 'PS4-1TB-WE-A-1M'),
  (46, 'Microsoft', 'Microsoft Xbox Series X 1TB Czarny – 2 pady', '2 pady', 'Czarny', '1 TB', 'XSX-1TB-BK-C-2M', 'XSX-1TB-BK-B-2M', 'XSX-1TB-BK-A-2M'),
  (47, 'Microsoft', 'Microsoft Xbox Series X 1TB Czarny – 1 pad', '1 pad', 'Czarny', '1 TB', 'XSX-1TB-BK-C-1M', 'XSX-1TB-BK-B-1M', 'XSX-1TB-BK-A-1M'),
  (48, 'Microsoft', 'Microsoft Xbox Series X 1TB Czarny – Bez padów', 'bez padów', 'Czarny', '1 TB', 'XSX-1TB-BK-C-0M', 'XSX-1TB-BK-B-0M', 'XSX-1TB-BK-A-0M'),
  (49, 'Microsoft', 'Microsoft Xbox Series S 512GB Biały – Bez padów', 'bez padów', 'Biały', '512 GB', 'XSS-512-WE-C-0M', 'XSS-512-WE-B-0M', 'XSS-512-WE-A-0M'),
  (50, 'Microsoft', 'Microsoft Xbox Series S 512GB Biały – 2 pady', '2 pady', 'Biały', '512 GB', 'XSS-512-WE-C-2M', 'XSS-512-WE-B-2M', 'XSS-512-WE-A-2M'),
  (51, 'Microsoft', 'Microsoft Xbox Series S 512GB Biały – 1 pad', '1 pad', 'Biały', '512 GB', 'XSS-512-WE-C-1M', 'XSS-512-WE-B-1M', 'XSS-512-WE-A-1M'),
  (52, 'Microsoft', 'Microsoft Xbox Series S 1TB Czarny – Bez padów', 'bez padów', 'Czarny', '1 TB', 'XSS-1TB-BK-C-0M', 'XSS-1TB-BK-B-0M', 'XSS-1TB-BK-A-0M'),
  (53, 'Microsoft', 'Microsoft Xbox Series S 1TB Czarny – 2 pady', '2 pady', 'Czarny', '1 TB', 'XSS-1TB-BK-C-2M', 'XSS-1TB-BK-B-2M', 'XSS-1TB-BK-A-2M'),
  (54, 'Microsoft', 'Microsoft Xbox Series S 1TB Czarny – 1 pad', '1 pad', 'Czarny', '1 TB', 'XSS-1TB-BK-C-1M', 'XSS-1TB-BK-B-1M', 'XSS-1TB-BK-A-1M'),
  (55, 'Microsoft', 'Microsoft Xbox Series S 1TB Biały – Bez padów', 'bez padów', 'Biały', '1 TB', 'XSS-1TB-WE-C-0M', 'XSS-1TB-WE-B-0M', 'XSS-1TB-WE-A-0M'),
  (56, 'Microsoft', 'Microsoft Xbox Series S 1TB Biały – 2 pady', '2 pady', 'Biały', '1 TB', 'XSS-1TB-WE-C-2M', 'XSS-1TB-WE-B-2M', 'XSS-1TB-WE-A-2M'),
  (57, 'Microsoft', 'Microsoft Xbox Series S 1TB Biały – 1 pad', '1 pad', 'Biały', '1 TB', 'XSS-1TB-WE-C-1M', 'XSS-1TB-WE-B-1M', 'XSS-1TB-WE-A-1M'),
  (58, 'Microsoft', 'Microsoft Xbox One X 1TB Czarny – Bez padów', 'bez padów', 'Czarny', '1 TB', 'XOX-1TB-BK-C-0M', 'XOX-1TB-BK-B-0M', 'XOX-1TB-BK-A-0M'),
  (59, 'Microsoft', 'Microsoft Xbox One X 1TB Czarny – 2 pady', '2 pady', 'Czarny', '1 TB', 'XOX-1TB-BK-C-2M', 'XOX-1TB-BK-B-2M', 'XOX-1TB-BK-A-2M'),
  (60, 'Microsoft', 'Microsoft Xbox One X 1TB Czarny – 1 pad', '1 pad', 'Czarny', '1 TB', 'XOX-1TB-BK-C-1M', 'XOX-1TB-BK-B-1M', 'XOX-1TB-BK-A-1M'),
  (61, 'Microsoft', 'Microsoft Xbox One S 500GB Biały – Bez padów', 'bez padów', 'Biały', '500 GB', 'XOS-500-WE-C-0M', 'XOS-500-WE-B-0M', 'XOS-500-WE-A-0M'),
  (62, 'Microsoft', 'Microsoft Xbox One S 500GB Biały – 2 pady', '2 pady', 'Biały', '500 GB', 'XOS-500-WE-C-2M', 'XOS-500-WE-B-2M', 'XOS-500-WE-A-2M'),
  (63, 'Microsoft', 'Microsoft Xbox One S 500GB Biały – 1 pad', '1 pad', 'Biały', '500 GB', 'XOS-500-WE-C-1M', 'XOS-500-WE-B-1M', 'XOS-500-WE-A-1M'),
  (64, 'Microsoft', 'Microsoft Xbox One S 2TB Biały – Bez padów', 'bez padów', 'Biały', '2 TB', 'XOS-2TB-WE-C-0M', 'XOS-2TB-WE-B-0M', 'XOS-2TB-WE-A-0M'),
  (65, 'Microsoft', 'Microsoft Xbox One S 2TB Biały – 2 pady', '2 pady', 'Biały', '2 TB', 'XOS-2TB-WE-C-2M', 'XOS-2TB-WE-B-2M', 'XOS-2TB-WE-A-2M'),
  (66, 'Microsoft', 'Microsoft Xbox One S 2TB Biały – 1 pad', '1 pad', 'Biały', '2 TB', 'XOS-2TB-WE-C-1M', 'XOS-2TB-WE-B-1M', 'XOS-2TB-WE-A-1M'),
  (67, 'Microsoft', 'Microsoft Xbox One S 1TB Biały – Bez padów', 'bez padów', 'Biały', '1 TB', 'XOS-1TB-WE-C-0M', 'XOS-1TB-WE-B-0M', 'XOS-1TB-WE-A-0M'),
  (68, 'Microsoft', 'Microsoft Xbox One S 1TB Biały – 2 pady', '2 pady', 'Biały', '1 TB', 'XOS-1TB-WE-C-2M', 'XOS-1TB-WE-B-2M', 'XOS-1TB-WE-A-2M'),
  (69, 'Microsoft', 'Microsoft Xbox One S 1TB Biały – 1 pad', '1 pad', 'Biały', '1 TB', 'XOS-1TB-WE-C-1M', 'XOS-1TB-WE-B-1M', 'XOS-1TB-WE-A-1M'),
  (70, 'Microsoft', 'Microsoft Xbox One 500GB Czarny – Bez padów', 'bez padów', 'Czarny', '500 GB', 'XO-500-BK-C-0M', 'XO-500-BK-B-0M', 'XO-500-BK-A-0M'),
  (71, 'Microsoft', 'Microsoft Xbox One 500GB Czarny – 2 pady', '2 pady', 'Czarny', '500 GB', 'XO-500-BK-C-2M', 'XO-500-BK-B-2M', 'XO-500-BK-A-2M'),
  (72, 'Microsoft', 'Microsoft Xbox One 500GB Czarny – 1 pad', '1 pad', 'Czarny', '500 GB', 'XO-500-BK-C-1M', 'XO-500-BK-B-1M', 'XO-500-BK-A-1M'),
  (73, 'Microsoft', 'Microsoft Xbox One 1TB Czarny – Bez padów', 'bez padów', 'Czarny', '1 TB', 'XO-1TB-BK-C-0M', 'XO-1TB-BK-B-0M', 'XO-1TB-BK-A-0M'),
  (74, 'Microsoft', 'Microsoft Xbox One 1TB Czarny – 2 pady', '2 pady', 'Czarny', '1 TB', 'XO-1TB-BK-C-2M', 'XO-1TB-BK-B-2M', 'XO-1TB-BK-A-2M'),
  (75, 'Microsoft', 'Microsoft Xbox One 1TB Czarny – 1 pad', '1 pad', 'Czarny', '1 TB', 'XO-1TB-BK-C-1M', 'XO-1TB-BK-B-1M', 'XO-1TB-BK-A-1M')
) as v(position, manufacturer, name, accessories, color, storage, sku_satisfactory, sku_good, sku_very_good)
where not exists (select 1 from console_catalog);
