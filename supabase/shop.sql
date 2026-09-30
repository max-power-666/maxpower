-- Sklep Recoo (recoo-sklep.vercel.app): katalog produktów edytowany w ERP → przełącznik "Recoo Sklep".
-- Wymaga schema.sql (members, is_admin()). Idempotentny — można uruchamiać wielokrotnie.
--
-- Model danych (jak w sklepie, lib/catalog.ts):
--   shop_categories  — kategorie (ukryta = nie ma jej w sklepie, dane zostają)
--   shop_models      — model, który ogląda klient (np. "PlayStation 5 Slim"); published = widoczny w sklepie
--   shop_variants    — wariant = opcja (pamięć/wersja/kolor…) × stan wizualny; cena i RĘCZNY stan (stock)
--   shop_images      — zdjęcia modelu (url: względny "/produkty/..." = plik w repo sklepu, albo pełny adres Storage)
--   shop_log         — dziennik zmian (kto, kiedy, co) — zapisują go triggery, nie aplikacja
--
-- Dostęp: sklep czyta kluczem anon TYLKO opublikowane modele, aktywne warianty i widoczne kategorie.
-- Edytuje zespół z rolą Admin / Manager / Sklep (can_edit_shop()); usuwa model tylko Admin.

create or replace function can_edit_shop() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Sklep'));
$$;

create table if not exists shop_categories (
  slug text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  tagline text not null default '',
  hidden boolean not null default false,
  sort int not null default 0
);

create table if not exists shop_models (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (length(trim(name)) > 0),
  brand text not null default '',
  category_slug text not null references shop_categories (slug) on update cascade,
  description text not null default '',
  highlights text[] not null default '{}',
  option_label text,                                   -- nazwa opcji wariantu: "Dysk", "Kolor", "Platforma"…; null = "Pamięć"
  color text not null default '#E1F0FE' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  keywords text not null default '',                   -- dodatkowe frazy dla wyszukiwarki sklepu ("ps5 pad")
  is_new boolean not null default false,
  featured boolean not null default false,
  published boolean not null default false,            -- nowy model startuje jako szkic
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shop_models_category_idx on shop_models (category_slug, sort);

create table if not exists shop_variants (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references shop_models (id) on delete cascade,
  sku text not null unique check (sku ~ '^[A-Z0-9+-]+$'),
  option_value text,                                   -- "1 TB", "PS5", "Body"…; null = model bez opcji
  grade text not null check (grade in ('jak-nowy', 'bardzo-dobry', 'dobry')),
  price numeric(10, 2) not null check (price >= 0),    -- PLN brutto
  old_price numeric(10, 2) check (old_price is null or old_price >= 0), -- cena nowego (przekreślona)
  stock int not null default 0 check (stock >= 0),     -- RĘCZNY stan (decyzja właściciela), edycja w zakładce Magazyn
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shop_variants_model_idx on shop_variants (model_id, sort);
-- Jeden wariant na parę (opcja, stan) w modelu; brak opcji traktujemy jak pusty tekst.
create unique index if not exists shop_variants_model_option_grade on shop_variants (model_id, coalesce(option_value, ''), grade);

create table if not exists shop_images (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references shop_models (id) on delete cascade,
  url text not null,
  storage_path text,                                   -- ścieżka w buckecie shop-images (null = plik w repo sklepu)
  alt text not null default '',
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists shop_images_model_idx on shop_images (model_id, position);

create table if not exists shop_log (
  id bigserial primary key,
  model_id uuid references shop_models (id) on delete cascade,
  model_slug text,
  entity text not null,                                -- model / wariant / zdjęcie
  action text not null,                                -- created / edited / deleted
  label text,                                          -- czytelny identyfikator (np. SKU wariantu)
  changes jsonb,                                       -- [{field, from, to}]
  by_email text,
  at timestamptz not null default now()
);
create index if not exists shop_log_model_idx on shop_log (model_id, at desc);

-- updated_at ustawiane przez bazę
create or replace function shop_touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists shop_models_touch on shop_models;
create trigger shop_models_touch before update on shop_models for each row execute function shop_touch_updated_at();
drop trigger if exists shop_variants_touch on shop_variants;
create trigger shop_variants_touch before update on shop_variants for each row execute function shop_touch_updated_at();

-- Dziennik zmian: zapisuje trigger (security definer), więc log nie zależy od tego, czy aplikacja o nim pamiętała.
-- Zmiana = lista pól, które się różnią (bez created_at/updated_at). Autor = e-mail z tokenu (SQL Editor → null).
create or replace function shop_log_changes() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  n jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  rec jsonb := coalesce(n, o);
  diff jsonb := '[]'::jsonb;
  k text;
  mid uuid;
  mslug text;
  ent text;
  lbl text;
begin
  if tg_table_name = 'shop_models' then
    ent := 'model'; mid := (rec ->> 'id')::uuid; lbl := rec ->> 'name';
  elsif tg_table_name = 'shop_variants' then
    ent := 'wariant'; mid := (rec ->> 'model_id')::uuid; lbl := rec ->> 'sku';
  else
    ent := 'zdjęcie'; mid := (rec ->> 'model_id')::uuid; lbl := rec ->> 'url';
  end if;

  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(n) loop
      if k not in ('created_at', 'updated_at') and (o -> k) is distinct from (n -> k) then
        diff := diff || jsonb_build_array(jsonb_build_object('field', k, 'from', o -> k, 'to', n -> k));
      end if;
    end loop;
    if jsonb_array_length(diff) = 0 then return new; end if;
  end if;

  -- Przy kasowaniu całego modelu kaskada usuwa jego log — model_id zostawiamy null, żeby wpis "usunięto" przetrwał.
  if tg_op = 'DELETE' and ent = 'model' then mid := null; end if;
  -- Warianty/zdjęcia kasowane KASKADOWO razem z modelem: wystarczy jeden wpis "usunięto model", bez szumu.
  if tg_op = 'DELETE' and ent <> 'model' and not exists (select 1 from shop_models where id = mid) then
    return old;
  end if;
  select slug into mslug from shop_models where id = coalesce(mid, (rec ->> 'id')::uuid);
  if mslug is null and ent = 'model' then mslug := rec ->> 'slug'; end if;

  insert into shop_log (model_id, model_slug, entity, action, label, changes, by_email)
  values (
    mid, mslug, ent,
    case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'edited' else 'deleted' end,
    lbl,
    case when tg_op = 'UPDATE' then diff else null end,
    auth.jwt() ->> 'email'
  );
  return coalesce(new, old);
end $$;

drop trigger if exists shop_models_log on shop_models;
create trigger shop_models_log after insert or update or delete on shop_models for each row execute function shop_log_changes();
drop trigger if exists shop_variants_log on shop_variants;
create trigger shop_variants_log after insert or update or delete on shop_variants for each row execute function shop_log_changes();
drop trigger if exists shop_images_log on shop_images;
create trigger shop_images_log after insert or delete on shop_images for each row execute function shop_log_changes();

-- ——— RLS ———
alter table shop_categories enable row level security;
alter table shop_models enable row level security;
alter table shop_variants enable row level security;
alter table shop_images enable row level security;
alter table shop_log enable row level security;

-- Odczyt: sklep (anon) widzi tylko to, co opublikowane; zespół sklepu widzi wszystko (także szkice).
drop policy if exists "shop read categories" on shop_categories;
create policy "shop read categories" on shop_categories for select using (true);
drop policy if exists "shop read models" on shop_models;
create policy "shop read models" on shop_models for select using (published or can_edit_shop());
drop policy if exists "shop read variants" on shop_variants;
create policy "shop read variants" on shop_variants for select using (
  can_edit_shop() or (active and exists (select 1 from shop_models m where m.id = model_id and m.published))
);
drop policy if exists "shop read images" on shop_images;
create policy "shop read images" on shop_images for select using (
  can_edit_shop() or exists (select 1 from shop_models m where m.id = model_id and m.published)
);
drop policy if exists "shop read log" on shop_log;
create policy "shop read log" on shop_log for select using (can_edit_shop());

-- Zapis: zespół sklepu. Usuwanie modelu i kategorii tylko Admin (warianty i zdjęcia — cały zespół sklepu).
do $$
declare t text;
begin
  foreach t in array array['shop_categories', 'shop_models', 'shop_variants', 'shop_images'] loop
    execute format('drop policy if exists "shop insert" on %I', t);
    execute format('create policy "shop insert" on %I for insert with check (can_edit_shop())', t);
    execute format('drop policy if exists "shop update" on %I', t);
    execute format('create policy "shop update" on %I for update using (can_edit_shop()) with check (can_edit_shop())', t);
  end loop;
end $$;
drop policy if exists "shop delete" on shop_categories;
create policy "shop delete" on shop_categories for delete using (is_admin());
drop policy if exists "shop delete" on shop_models;
create policy "shop delete" on shop_models for delete using (is_admin());
drop policy if exists "shop delete" on shop_variants;
create policy "shop delete" on shop_variants for delete using (can_edit_shop());
drop policy if exists "shop delete" on shop_images;
create policy "shop delete" on shop_images for delete using (can_edit_shop());

-- ——— Zdjęcia: publiczny bucket (sklep pokazuje je każdemu), zapis tylko zespół sklepu ———
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop-images', 'shop-images', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "shop images upload" on storage.objects;
create policy "shop images upload" on storage.objects
  for insert to authenticated with check (bucket_id = 'shop-images' and can_edit_shop());
drop policy if exists "shop images update" on storage.objects;
create policy "shop images update" on storage.objects
  for update to authenticated using (bucket_id = 'shop-images' and can_edit_shop());
drop policy if exists "shop images delete" on storage.objects;
create policy "shop images delete" on storage.objects
  for delete to authenticated using (bucket_id = 'shop-images' and can_edit_shop());

do $$
begin
  begin alter publication supabase_realtime add table shop_models; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table shop_variants; exception when duplicate_object then null; end;
end $$;

-- ——— Magazyn sklepu (zakładka Magazyn w Recoo Sklep) ———
-- Stan wariantu (shop_variants.stock) to RĘCZNY licznik (decyzja właściciela). Każda zmiana = ruch w shop_stock_moves
-- (rodzaj, ilość, stan przed/po, notatka, kto, kiedy). Zmieniać stan wolno WYŁĄCZNIE funkcją shop_stock_change():
-- blokuje wiersz (dwie osoby naraz nie nadpiszą sobie wyniku), pilnuje zera i zapisuje ruch w tej samej transakcji.
-- Bezpośredni UPDATE stock (z aplikacji czy SQL) odrzuca trigger — historia ruchów jest przez to zawsze kompletna.

create table if not exists shop_stock_moves (
  id bigserial primary key,
  variant_id uuid references shop_variants (id) on delete set null,
  sku text not null,                                   -- zapisane osobno: ruch zostaje czytelny po usunięciu wariantu
  model_name text,
  kind text not null check (kind in ('przyjecie', 'wydanie', 'korekta')),
  delta int not null,                                  -- o ile zmienił się stan (+/-)
  stock_before int not null,
  stock_after int not null check (stock_after >= 0),
  note text,
  by_email text,
  at timestamptz not null default now()
);
create index if not exists shop_stock_moves_at_idx on shop_stock_moves (at desc);
create index if not exists shop_stock_moves_variant_idx on shop_stock_moves (variant_id, at desc);

create or replace function shop_stock_guard() returns trigger language plpgsql as $$
begin
  if new.stock is distinct from old.stock and coalesce(current_setting('shop.stock_rpc', true), '') <> '1' then
    raise exception 'Stan magazynowy zmieniaj w zakładce Magazyn (funkcja shop_stock_change) — każda zmiana musi mieć zapis ruchu.';
  end if;
  return new;
end $$;
drop trigger if exists shop_variants_stock_guard on shop_variants;
create trigger shop_variants_stock_guard before update on shop_variants for each row execute function shop_stock_guard();

-- p_kind: 'przyjecie' (+p_qty), 'wydanie' (-p_qty), 'korekta' (ustaw stan = p_qty, np. po inwentaryzacji). Zwraca nowy stan.
create or replace function shop_stock_change(p_variant_id uuid, p_kind text, p_qty int, p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  v shop_variants;
  mname text;
  after int;
begin
  if not can_edit_shop() then
    raise exception 'Brak uprawnień do magazynu sklepu.';
  end if;
  if p_qty is null or p_qty < 0 or (p_kind in ('przyjecie', 'wydanie') and p_qty = 0) then
    raise exception 'Niepoprawna ilość.';
  end if;
  select * into v from shop_variants where id = p_variant_id for update;
  if not found then
    raise exception 'Nie ma takiego wariantu.';
  end if;
  after := case p_kind
    when 'przyjecie' then v.stock + p_qty
    when 'wydanie' then v.stock - p_qty
    when 'korekta' then p_qty
    else null end;
  if after is null then
    raise exception 'Nieznany rodzaj ruchu: %', p_kind;
  end if;
  if after < 0 then
    raise exception 'Na stanie jest tylko % szt. — nie można wydać %.', v.stock, p_qty;
  end if;
  if after = v.stock then
    return after; -- korekta do tej samej liczby: nic nie zapisujemy
  end if;
  select name into mname from shop_models where id = v.model_id;
  perform set_config('shop.stock_rpc', '1', true);
  update shop_variants set stock = after where id = v.id;
  perform set_config('shop.stock_rpc', '', true);
  insert into shop_stock_moves (variant_id, sku, model_name, kind, delta, stock_before, stock_after, note, by_email)
  values (v.id, v.sku, mname, p_kind, after - v.stock, v.stock, after, nullif(trim(p_note), ''), auth.jwt() ->> 'email');
  return after;
end $$;
revoke all on function shop_stock_change(uuid, text, int, text) from public;
grant execute on function shop_stock_change(uuid, text, int, text) to authenticated;

alter table shop_stock_moves enable row level security;
drop policy if exists "shop read stock moves" on shop_stock_moves;
create policy "shop read stock moves" on shop_stock_moves for select using (can_edit_shop());
-- brak polityk insert/update/delete: ruchy zapisuje tylko shop_stock_change (security definer); historia jest nieedytowalna

do $$
begin
  begin alter publication supabase_realtime add table shop_stock_moves; exception when duplicate_object then null; end;
end $$;

-- Dane startowe: katalog przeniesiony 1:1 z lib/catalog.ts sklepu (te same slugi i SKU — koszyki klientów zostają ważne).
-- on conflict do nothing: ponowne uruchomienie pliku NIE nadpisuje zmian zrobionych w backoffice.
insert into shop_categories (slug, name, tagline, hidden, sort) values
  ('konsole', 'Konsole', 'PlayStation, Xbox, Nintendo', false, 0),
  ('kontrolery', 'Kontrolery', 'DualSense, Xbox, Joy-Con', false, 1),
  ('akcesoria', 'Akcesoria', 'Słuchawki, ładowarki, stacje', false, 2),
  ('gry', 'Gry', 'PS5, PS4, Xbox, Switch', false, 3),
  ('aparaty', 'Aparaty fotograficzne', 'Canon, Sony, Fujifilm', false, 4),
  ('smartfony', 'Smartfony', 'iPhone, Samsung, Pixel', true, 5),
  ('tablety', 'Tablety', 'iPad i Galaxy Tab', true, 6),
  ('laptopy', 'Laptopy', 'MacBook i ultrabooki', true, 7),
  ('smartwatche', 'Smartwatche', 'Apple Watch, Galaxy Watch', true, 8)
on conflict (slug) do nothing;

insert into shop_models (slug, name, brand, category_slug, description, highlights, option_label, color, keywords, is_new, featured, published, sort) values
  ('iphone-13', 'iPhone 13', 'Apple', 'smartfony', 'Sprawdzony iPhone w świetnej cenie. Każdy egzemplarz przechodzi test ponad 40 punktów: ekran, aparaty, Face ID, głośniki, łączność i kondycję baterii.', array['Ekran 6,1" Super Retina XDR', 'Procesor A15 Bionic', 'Podwójny aparat 12 Mpx', 'Bateria min. 85%']::text[], null, '#E1F0FE', '', false, true, true, 0),
  ('iphone-14-pro', 'iPhone 14 Pro', 'Apple', 'smartfony', 'Flagowiec Apple z ekranem ProMotion 120 Hz i aparatem 48 Mpx. Przetestowany, wyczyszczony i gotowy do pracy od pierwszego uruchomienia.', array['Dynamic Island', 'Aparat 48 Mpx', 'Always-On Display', 'Bateria min. 85%']::text[], null, '#E7EBFA', '', true, false, true, 1),
  ('galaxy-s23', 'Galaxy S23', 'Samsung', 'smartfony', 'Kompaktowy flagowiec Samsunga z wydajnym procesorem i świetnym aparatem.', array['Snapdragon 8 Gen 2', 'Ekran 6,1" 120 Hz', 'Aparat 50 Mpx', 'IP68']::text[], null, '#E3FCEE', '', true, false, true, 2),
  ('playstation-5-slim', 'PlayStation 5 Slim', 'Sony', 'konsole', 'Konsola po pełnym teście: gry z płyty i dysku, porty, Wi-Fi, chłodzenie. Czyszczona wewnątrz, z padem DualSense i okablowaniem.', array['Dysk 1 TB SSD', 'Napęd Blu-ray', 'Pad DualSense w zestawie', 'Gry 4K do 120 fps']::text[], 'Dysk', '#E1F0FE', 'ps5 playstation 5', true, true, true, 3),
  ('playstation-5', 'PlayStation 5', 'Sony', 'konsole', 'Pierwsza generacja PS5 z napędem płyt. Po pełnym teście: gry z płyty i dysku, porty, Wi-Fi, chłodzenie. Czyszczona wewnątrz, z nową pastą termiczną, padem DualSense i okablowaniem.', array['Dysk 825 GB SSD', 'Napęd Blu-ray', 'Pad DualSense w zestawie', 'Gry 4K do 120 fps']::text[], 'Dysk', '#E1F0FE', 'ps5 playstation 5 fat pierwsza generacja', false, false, true, 4),
  ('xbox-series-x', 'Xbox Series X', 'Microsoft', 'konsole', 'Najmocniejszy Xbox z pełną wsteczną kompatybilnością. Przetestowany i wyczyszczony.', array['Dysk 1 TB SSD', '4K 120 fps', 'Quick Resume', 'Pad w zestawie']::text[], 'Dysk', '#D9F8EF', 'xsx', false, false, true, 5),
  ('nintendo-switch-oled', 'Nintendo Switch OLED', 'Nintendo', 'konsole', 'Switch z ekranem OLED — do gry w domu i w podróży. Joy-Cony sprawdzone pod kątem driftu.', array['Ekran OLED 7"', '64 GB pamięci', 'Stacja z portem LAN', 'Joy-Con w zestawie']::text[], 'Pamięć', '#FDECF0', 'switch', false, false, true, 6),
  ('ipad-air-5', 'iPad Air 5', 'Apple', 'tablety', 'Lekki i wydajny tablet z chipem M1 — do nauki, pracy i rozrywki.', array['Chip M1', 'Ekran 10,9" Liquid Retina', 'USB-C', 'Obsługa Apple Pencil 2']::text[], null, '#E1F0FE', '', false, false, true, 7),
  ('macbook-air-m2', 'MacBook Air M2', 'Apple', 'laptopy', 'Cienki, cichy i szybki. Bateria sprawdzona, klawiatura i gładzik przetestowane, system zainstalowany na czysto.', array['Chip Apple M2', 'Ekran 13,6" Liquid Retina', '8 GB RAM', 'Bateria do 18 h']::text[], null, '#F1F2F3', '', false, true, true, 8),
  ('apple-watch-series-8', 'Apple Watch Series 8', 'Apple', 'smartwatche', 'Zegarek z zaawansowanymi funkcjami zdrowotnymi. Bateria i czujniki przetestowane.', array['Czujnik temperatury', 'EKG i tlen we krwi', 'Wykrywanie wypadków', '45 mm, GPS']::text[], null, '#FDECF0', '', false, false, true, 9),
  ('dualsense', 'Pad DualSense', 'Sony', 'kontrolery', 'Oryginalny pad do PlayStation 5, po serwisie i teście gałek.', array['Haptyka i adaptacyjne triggery', 'USB-C', 'Wbudowany mikrofon', 'Sprawdzony pod kątem driftu']::text[], null, '#E7EBFA', 'ps5 pad kontroler', true, true, true, 10),
  ('airpods-pro-2', 'AirPods Pro 2', 'Apple', 'akcesoria', 'Słuchawki z ANC. Każda para dostaje nowe, zapakowane wkładki dokanałowe.', array['Aktywna redukcja szumów', 'Etui MagSafe USB-C', 'Dźwięk przestrzenny', 'Nowe wkładki']::text[], null, '#E3FCEE', '', false, false, true, 11),
  ('steam-deck-oled', 'Steam Deck OLED', 'Valve', 'konsole', 'Przenośny PC do gier z ekranem OLED. Przetestowany na kilkunastu tytułach.', array['Ekran OLED HDR 7,4"', '512 GB NVMe', 'Bateria do 12 h', 'Biblioteka Steam']::text[], 'Dysk', '#E7EBFA', 'pc handheld', true, false, true, 12),
  ('xbox-series-s', 'Xbox Series S', 'Microsoft', 'konsole', 'Kompaktowy Xbox nowej generacji w wersji cyfrowej. Przetestowany, wyczyszczony, z padem i okablowaniem.', array['Gry do 1440p 120 fps', 'Quick Resume', 'Game Pass', 'Pad w zestawie']::text[], 'Dysk', '#D9F8EF', 'xss', true, false, true, 13),
  ('playstation-4-pro', 'PlayStation 4 Pro', 'Sony', 'konsole', 'Sprawdzona konsola z tysiącami tytułów w niskich cenach. Po czyszczeniu i wymianie pasty termicznej — cicha jak nowa.', array['Dysk 1 TB', 'Obsługa 4K i HDR', 'Ogromna biblioteka gier', 'Pad DualShock 4 w zestawie']::text[], 'Dysk', '#E1F0FE', 'ps4 playstation 4', false, false, true, 14),
  ('dualshock-4', 'Pad DualShock 4', 'Sony', 'kontrolery', 'Oryginalny pad do PlayStation 4, po serwisie: czyszczenie, test gałek i przycisków, sprawdzona bateria.', array['Do PS4 (działa też z PS5 w grach z PS4)', 'Touchpad i czujnik ruchu', 'Gałki po teście driftu', 'Kabel w zestawie']::text[], 'Kolor', '#E1F0FE', 'ps4 pad kontroler', false, false, true, 15),
  ('xbox-wireless-controller', 'Kontroler Xbox Wireless', 'Microsoft', 'kontrolery', 'Oryginalny kontroler Xbox nowej generacji. Działa z konsolami Xbox i komputerem.', array['Xbox Series X|S, Xbox One, PC', 'Bluetooth', 'Przycisk Share', 'Gałki po teście driftu']::text[], 'Kolor', '#D9F8EF', 'pad', false, false, true, 16),
  ('joy-con-para', 'Joy-Con (para)', 'Nintendo', 'kontrolery', 'Para Joy-Conów po serwisie — wymieniamy gałki podatne na drift, więc sterowanie jest precyzyjne jak w nowych.', array['Lewy i prawy Joy-Con', 'Naprawiony drift gałek', 'Paski w zestawie', 'Nintendo Switch / OLED']::text[], 'Kolor', '#FDECF0', 'switch pad', false, false, true, 17),
  ('switch-pro-controller', 'Nintendo Switch Pro Controller', 'Nintendo', 'kontrolery', 'Pełnowymiarowy kontroler do Switcha dla tych, którzy grają długo.', array['Do 40 h na baterii', 'HD Rumble', 'amiibo NFC', 'Kabel USB-C w zestawie']::text[], null, '#E7EBFA', 'pad', false, false, true, 18),
  ('pulse-3d', 'Słuchawki Pulse 3D', 'Sony', 'akcesoria', 'Oficjalne słuchawki PlayStation 5. Każda para dostaje nowe, zapakowane nauszniki.', array['Dźwięk 3D w PS5', 'Dwa mikrofony z redukcją szumów', 'Bezprzewodowe + jack 3,5 mm', 'Nowe nauszniki']::text[], null, '#E7EBFA', 'ps5 słuchawki', false, false, true, 19),
  ('stacja-ladujaca-dualsense', 'Stacja ładująca DualSense', 'Sony', 'akcesoria', 'Oficjalna stacja Sony — pady zawsze naładowane i gotowe do gry.', array['Ładuje dwa pady naraz', 'Bez podłączania kabli', 'Zasilacz w zestawie']::text[], null, '#E1F0FE', 'ps5 ładowarka', false, false, true, 20),
  ('ea-sports-fc-25', 'EA Sports FC 25', 'EA Sports', 'gry', 'Piłka nożna od EA — płyta bez rys wpływających na odczyt, sprawdzona na konsoli.', array['Polska wersja językowa', 'Płyta sprawdzona i wyczyszczona', 'Oryginalne pudełko']::text[], 'Platforma', '#D9F8EF', '', true, false, true, 21),
  ('gta-v', 'Grand Theft Auto V', 'Rockstar Games', 'gry', 'Klasyk Rockstar Games. Płyty testujemy na konsoli przed wysyłką.', array['Polskie napisy', 'Tryb GTA Online', 'Płyta sprawdzona na konsoli']::text[], 'Platforma', '#FDECF0', '', false, false, true, 22),
  ('marvels-spider-man-2', 'Marvel''s Spider-Man 2', 'PlayStation Studios', 'gry', 'Przygoda Petera Parkera i Milesa Moralesa w otwartym Nowym Jorku.', array['Polska wersja językowa (dubbing)', 'Wyłącznie na PS5', 'Oryginalne pudełko']::text[], 'Platforma', '#FDECF0', '', true, false, true, 23),
  ('zelda-tears-of-the-kingdom', 'The Legend of Zelda: Tears of the Kingdom', 'Nintendo', 'gry', 'Kontynuacja Breath of the Wild — kartridż przetestowany na Switchu.', array['Kartridż sprawdzony na konsoli', 'Oryginalne pudełko', 'Polska okładka']::text[], 'Platforma', '#E3FCEE', '', false, false, true, 24),
  ('mario-kart-8-deluxe', 'Mario Kart 8 Deluxe', 'Nintendo', 'gry', 'Najlepsza imprezowa gra na Switcha.', array['Do 4 graczy na jednym ekranie', 'Kartridż sprawdzony na konsoli', 'Oryginalne pudełko']::text[], 'Platforma', '#E1F0FE', '', false, false, true, 25),
  ('canon-eos-250d', 'Canon EOS 250D', 'Canon', 'aparaty', 'Lekka lustrzanka na start. Podajemy przebieg migawki, sprawdzamy matrycę (martwe piksele, kurz), autofokus i wszystkie przyciski.', array['Matryca APS-C 24,1 Mpx', 'Film 4K', 'Odchylany ekran dotykowy', 'Sprawdzony przebieg migawki']::text[], 'Zestaw', '#FDECF0', 'lustrzanka', false, true, true, 26),
  ('sony-alpha-a6400', 'Sony Alpha a6400', 'Sony', 'aparaty', 'Szybki autofokus i kompaktowe body — świetny do zdjęć i vlogów. Matryca i AF przetestowane.', array['Bezlusterkowiec APS-C 24,2 Mpx', 'Real-time Eye AF', 'Film 4K', 'Ekran do selfie/vlogów']::text[], 'Zestaw', '#E7EBFA', 'bezlusterkowiec', true, false, true, 27),
  ('fujifilm-x-t30-ii', 'Fujifilm X-T30 II', 'Fujifilm', 'aparaty', 'Kompaktowy bezlusterkowiec z legendarnymi kolorami Fujifilm.', array['Matryca X-Trans 26,1 Mpx', 'Symulacje filmów Fujifilm', 'Klasyczne pokrętła', 'Film 4K']::text[], 'Zestaw', '#E3FCEE', 'bezlusterkowiec fuji', false, false, true, 28),
  ('canon-powershot-g7x-iii', 'Canon PowerShot G7 X Mark III', 'Canon', 'aparaty', 'Kultowy kompakt vlogerów. Obiektyw i matryca sprawdzone, bateria w zestawie.', array['Matryca 1" 20,1 Mpx', 'Jasny obiektyw f/1.8–2.8', 'Film 4K, transmisje na żywo', 'Mieści się w kieszeni']::text[], null, '#E1F0FE', 'kompakt vlog', false, false, true, 29)
on conflict (slug) do nothing;

insert into shop_variants (model_id, sku, option_value, grade, price, old_price, stock, active, sort)
select m.id, v.sku, v.option_value, v.grade, v.price, v.old_price, v.stock, true, v.sort from (values
  ('iphone-13', 'IP13-128GB-A+', '128 GB', 'jak-nowy', 1799, 3199::numeric, 3, 0),
  ('iphone-13', 'IP13-128GB-A', '128 GB', 'bardzo-dobry', 1659, 3199::numeric, 7, 1),
  ('iphone-13', 'IP13-128GB-B', '128 GB', 'dobry', 1509, 3199::numeric, 2, 2),
  ('iphone-13', 'IP13-256GB-A+', '256 GB', 'jak-nowy', 2099, 3699::numeric, 7, 3),
  ('iphone-13', 'IP13-256GB-A', '256 GB', 'bardzo-dobry', 1929, 3699::numeric, 2, 4),
  ('iphone-13', 'IP13-256GB-B', '256 GB', 'dobry', 1759, 3699::numeric, 3, 5),
  ('iphone-14-pro', 'IP14P-128GB-A+', '128 GB', 'jak-nowy', 3299, 5199::numeric, 2, 0),
  ('iphone-14-pro', 'IP14P-128GB-A', '128 GB', 'bardzo-dobry', 3039, 5199::numeric, 4, 1),
  ('iphone-14-pro', 'IP14P-128GB-B', '128 GB', 'dobry', 2769, 5199::numeric, 1, 2),
  ('iphone-14-pro', 'IP14P-256GB-A+', '256 GB', 'jak-nowy', 3699, 5799::numeric, 4, 3),
  ('iphone-14-pro', 'IP14P-256GB-A', '256 GB', 'bardzo-dobry', 3399, 5799::numeric, 1, 4),
  ('iphone-14-pro', 'IP14P-256GB-B', '256 GB', 'dobry', 3109, 5799::numeric, 2, 5),
  ('galaxy-s23', 'S23-128GB-A+', '128 GB', 'jak-nowy', 1999, 3999::numeric, 3, 0),
  ('galaxy-s23', 'S23-128GB-A', '128 GB', 'bardzo-dobry', 1839, 3999::numeric, 7, 1),
  ('galaxy-s23', 'S23-128GB-B', '128 GB', 'dobry', 1679, 3999::numeric, 2, 2),
  ('galaxy-s23', 'S23-256GB-A+', '256 GB', 'jak-nowy', 2199, 4299::numeric, 7, 3),
  ('galaxy-s23', 'S23-256GB-A', '256 GB', 'bardzo-dobry', 2019, 4299::numeric, 2, 4),
  ('galaxy-s23', 'S23-256GB-B', '256 GB', 'dobry', 1849, 4299::numeric, 3, 5),
  ('playstation-5-slim', 'PS5S-1TB-A+', '1 TB', 'jak-nowy', 1899, 2599::numeric, 4, 0),
  ('playstation-5-slim', 'PS5S-1TB-A', '1 TB', 'bardzo-dobry', 1749, 2599::numeric, 9, 1),
  ('playstation-5-slim', 'PS5S-1TB-B', '1 TB', 'dobry', 1599, 2599::numeric, 3, 2),
  ('playstation-5', 'PS5-825GB-A+', '825 GB', 'jak-nowy', 1699, null::numeric, 3, 0),
  ('playstation-5', 'PS5-825GB-A', '825 GB', 'bardzo-dobry', 1559, null::numeric, 6, 1),
  ('playstation-5', 'PS5-825GB-B', '825 GB', 'dobry', 1429, null::numeric, 2, 2),
  ('xbox-series-x', 'XSX-1TB-A+', '1 TB', 'jak-nowy', 1699, 2349::numeric, 2, 0),
  ('xbox-series-x', 'XSX-1TB-A', '1 TB', 'bardzo-dobry', 1559, 2349::numeric, 5, 1),
  ('xbox-series-x', 'XSX-1TB-B', '1 TB', 'dobry', 1429, 2349::numeric, 1, 2),
  ('nintendo-switch-oled', 'NSWO-64GB-A+', '64 GB', 'jak-nowy', 1149, 1549::numeric, 3, 0),
  ('nintendo-switch-oled', 'NSWO-64GB-A', '64 GB', 'bardzo-dobry', 1059, 1549::numeric, 7, 1),
  ('nintendo-switch-oled', 'NSWO-64GB-B', '64 GB', 'dobry', 969, 1549::numeric, 2, 2),
  ('ipad-air-5', 'IPA5-64GB-A+', '64 GB', 'jak-nowy', 1899, 2999::numeric, 3, 0),
  ('ipad-air-5', 'IPA5-64GB-A', '64 GB', 'bardzo-dobry', 1749, 2999::numeric, 7, 1),
  ('ipad-air-5', 'IPA5-64GB-B', '64 GB', 'dobry', 1599, 2999::numeric, 2, 2),
  ('ipad-air-5', 'IPA5-256GB-A+', '256 GB', 'jak-nowy', 2399, 3699::numeric, 7, 3),
  ('ipad-air-5', 'IPA5-256GB-A', '256 GB', 'bardzo-dobry', 2209, 3699::numeric, 2, 4),
  ('ipad-air-5', 'IPA5-256GB-B', '256 GB', 'dobry', 2019, 3699::numeric, 3, 5),
  ('macbook-air-m2', 'MBAM2-256GB-A+', '256 GB', 'jak-nowy', 3799, 5999::numeric, 2, 0),
  ('macbook-air-m2', 'MBAM2-256GB-A', '256 GB', 'bardzo-dobry', 3499, 5999::numeric, 3, 1),
  ('macbook-air-m2', 'MBAM2-256GB-B', '256 GB', 'dobry', 3189, 5999::numeric, 1, 2),
  ('macbook-air-m2', 'MBAM2-512GB-A+', '512 GB', 'jak-nowy', 4499, 6999::numeric, 3, 3),
  ('macbook-air-m2', 'MBAM2-512GB-A', '512 GB', 'bardzo-dobry', 4139, 6999::numeric, 1, 4),
  ('macbook-air-m2', 'MBAM2-512GB-B', '512 GB', 'dobry', 3779, 6999::numeric, 2, 5),
  ('apple-watch-series-8', 'AW8---A+', null, 'jak-nowy', 1299, 2199::numeric, 3, 0),
  ('apple-watch-series-8', 'AW8---A', null, 'bardzo-dobry', 1199, 2199::numeric, 7, 1),
  ('apple-watch-series-8', 'AW8---B', null, 'dobry', 1089, 2199::numeric, 2, 2),
  ('dualsense', 'DS5---A+', null, 'jak-nowy', 219, 339::numeric, 8, 0),
  ('dualsense', 'DS5---A', null, 'bardzo-dobry', 199, 339::numeric, 12, 1),
  ('dualsense', 'DS5---B', null, 'dobry', 179, 339::numeric, 5, 2),
  ('airpods-pro-2', 'APP2---A+', null, 'jak-nowy', 699, 1149::numeric, 5, 0),
  ('airpods-pro-2', 'APP2---A', null, 'bardzo-dobry', 639, 1149::numeric, 3, 1),
  ('airpods-pro-2', 'APP2---B', null, 'dobry', 589, 1149::numeric, 2, 2),
  ('steam-deck-oled', 'SDO-512GB-A+', '512 GB', 'jak-nowy', 2299, 2799::numeric, 1, 0),
  ('steam-deck-oled', 'SDO-512GB-A', '512 GB', 'bardzo-dobry', 2119, 2799::numeric, 2, 1),
  ('steam-deck-oled', 'SDO-512GB-B', '512 GB', 'dobry', 1929, 2799::numeric, 0, 2),
  ('xbox-series-s', 'XSS-512GB-A+', '512 GB', 'jak-nowy', 899, 1299::numeric, 3, 0),
  ('xbox-series-s', 'XSS-512GB-A', '512 GB', 'bardzo-dobry', 829, 1299::numeric, 7, 1),
  ('xbox-series-s', 'XSS-512GB-B', '512 GB', 'dobry', 759, 1299::numeric, 2, 2),
  ('xbox-series-s', 'XSS-1TB-A+', '1 TB', 'jak-nowy', 1099, 1549::numeric, 7, 3),
  ('xbox-series-s', 'XSS-1TB-A', '1 TB', 'bardzo-dobry', 1009, 1549::numeric, 2, 4),
  ('xbox-series-s', 'XSS-1TB-B', '1 TB', 'dobry', 919, 1549::numeric, 3, 5),
  ('playstation-4-pro', 'PS4P-1TB-A+', '1 TB', 'jak-nowy', 899, null::numeric, 3, 0),
  ('playstation-4-pro', 'PS4P-1TB-A', '1 TB', 'bardzo-dobry', 829, null::numeric, 5, 1),
  ('playstation-4-pro', 'PS4P-1TB-B', '1 TB', 'dobry', 759, null::numeric, 2, 2),
  ('dualshock-4', 'DS4-CZARNY-A+', 'Czarny', 'jak-nowy', 129, 249::numeric, 6, 0),
  ('dualshock-4', 'DS4-CZARNY-A', 'Czarny', 'bardzo-dobry', 119, 249::numeric, 4, 1),
  ('dualshock-4', 'DS4-CZARNY-B', 'Czarny', 'dobry', 109, 249::numeric, 2, 2),
  ('dualshock-4', 'DS4-BIALY-A+', 'Biały', 'jak-nowy', 139, 259::numeric, 4, 3),
  ('dualshock-4', 'DS4-BIALY-A', 'Biały', 'bardzo-dobry', 129, 259::numeric, 2, 4),
  ('dualshock-4', 'DS4-BIALY-B', 'Biały', 'dobry', 119, 259::numeric, 6, 5),
  ('xbox-wireless-controller', 'XBC-CARBONBLACK-A+', 'Carbon Black', 'jak-nowy', 179, 269::numeric, 3, 0),
  ('xbox-wireless-controller', 'XBC-CARBONBLACK-A', 'Carbon Black', 'bardzo-dobry', 159, 269::numeric, 7, 1),
  ('xbox-wireless-controller', 'XBC-CARBONBLACK-B', 'Carbon Black', 'dobry', 149, 269::numeric, 2, 2),
  ('xbox-wireless-controller', 'XBC-ROBOTWHITE-A+', 'Robot White', 'jak-nowy', 179, 269::numeric, 7, 3),
  ('xbox-wireless-controller', 'XBC-ROBOTWHITE-A', 'Robot White', 'bardzo-dobry', 159, 269::numeric, 2, 4),
  ('xbox-wireless-controller', 'XBC-ROBOTWHITE-B', 'Robot White', 'dobry', 149, 269::numeric, 3, 5),
  ('joy-con-para', 'JCP-NEONCZERWONYNIEBIESKI-A+', 'Neon czerwony/niebieski', 'jak-nowy', 249, 399::numeric, 3, 0),
  ('joy-con-para', 'JCP-NEONCZERWONYNIEBIESKI-A', 'Neon czerwony/niebieski', 'bardzo-dobry', 229, 399::numeric, 7, 1),
  ('joy-con-para', 'JCP-NEONCZERWONYNIEBIESKI-B', 'Neon czerwony/niebieski', 'dobry', 209, 399::numeric, 2, 2),
  ('joy-con-para', 'JCP-SZARY-A+', 'Szary', 'jak-nowy', 239, 389::numeric, 7, 3),
  ('joy-con-para', 'JCP-SZARY-A', 'Szary', 'bardzo-dobry', 219, 389::numeric, 2, 4),
  ('joy-con-para', 'JCP-SZARY-B', 'Szary', 'dobry', 199, 389::numeric, 3, 5),
  ('switch-pro-controller', 'NSPRO---A+', null, 'jak-nowy', 229, 339::numeric, 3, 0),
  ('switch-pro-controller', 'NSPRO---A', null, 'bardzo-dobry', 209, 339::numeric, 7, 1),
  ('switch-pro-controller', 'NSPRO---B', null, 'dobry', 189, 339::numeric, 2, 2),
  ('pulse-3d', 'PULSE3D---A+', null, 'jak-nowy', 279, 449::numeric, 3, 0),
  ('pulse-3d', 'PULSE3D---A', null, 'bardzo-dobry', 259, 449::numeric, 7, 1),
  ('pulse-3d', 'PULSE3D---B', null, 'dobry', 229, 449::numeric, 2, 2),
  ('stacja-ladujaca-dualsense', 'DSCHG---A+', null, 'jak-nowy', 89, 149::numeric, 5, 0),
  ('stacja-ladujaca-dualsense', 'DSCHG---A', null, 'bardzo-dobry', 79, 149::numeric, 3, 1),
  ('stacja-ladujaca-dualsense', 'DSCHG---B', null, 'dobry', 69, 149::numeric, 2, 2),
  ('ea-sports-fc-25', 'FC25-PS5-A+', 'PS5', 'jak-nowy', 129, 299::numeric, 8, 0),
  ('ea-sports-fc-25', 'FC25-PS5-A', 'PS5', 'bardzo-dobry', 119, 299::numeric, 5, 1),
  ('ea-sports-fc-25', 'FC25-PS5-B', 'PS5', 'dobry', 109, 299::numeric, 3, 2),
  ('ea-sports-fc-25', 'FC25-PS4-A+', 'PS4', 'jak-nowy', 99, 249::numeric, 5, 3),
  ('ea-sports-fc-25', 'FC25-PS4-A', 'PS4', 'bardzo-dobry', 89, 249::numeric, 3, 4),
  ('ea-sports-fc-25', 'FC25-PS4-B', 'PS4', 'dobry', 79, 249::numeric, 8, 5),
  ('gta-v', 'GTAV-PS5-A+', 'PS5', 'jak-nowy', 69, 129::numeric, 6, 0),
  ('gta-v', 'GTAV-PS5-A', 'PS5', 'bardzo-dobry', 59, 129::numeric, 9, 1),
  ('gta-v', 'GTAV-PS5-B', 'PS5', 'dobry', 59, 129::numeric, 4, 2),
  ('gta-v', 'GTAV-PS4-A+', 'PS4', 'jak-nowy', 49, 99::numeric, 9, 3),
  ('gta-v', 'GTAV-PS4-A', 'PS4', 'bardzo-dobry', 49, 99::numeric, 4, 4),
  ('gta-v', 'GTAV-PS4-B', 'PS4', 'dobry', 39, 99::numeric, 6, 5),
  ('marvels-spider-man-2', 'SM2-PS5-A+', 'PS5', 'jak-nowy', 129, 349::numeric, 3, 0),
  ('marvels-spider-man-2', 'SM2-PS5-A', 'PS5', 'bardzo-dobry', 119, 349::numeric, 7, 1),
  ('marvels-spider-man-2', 'SM2-PS5-B', 'PS5', 'dobry', 109, 349::numeric, 2, 2),
  ('zelda-tears-of-the-kingdom', 'ZTOTK-SWITCH-A+', 'Switch', 'jak-nowy', 189, 299::numeric, 3, 0),
  ('zelda-tears-of-the-kingdom', 'ZTOTK-SWITCH-A', 'Switch', 'bardzo-dobry', 169, 299::numeric, 7, 1),
  ('zelda-tears-of-the-kingdom', 'ZTOTK-SWITCH-B', 'Switch', 'dobry', 159, 299::numeric, 2, 2),
  ('mario-kart-8-deluxe', 'MK8D-SWITCH-A+', 'Switch', 'jak-nowy', 159, 249::numeric, 5, 0),
  ('mario-kart-8-deluxe', 'MK8D-SWITCH-A', 'Switch', 'bardzo-dobry', 149, 249::numeric, 7, 1),
  ('mario-kart-8-deluxe', 'MK8D-SWITCH-B', 'Switch', 'dobry', 129, 249::numeric, 3, 2),
  ('canon-eos-250d', 'EOS250D-BODY-A+', 'Body', 'jak-nowy', 1699, 2599::numeric, 2, 0),
  ('canon-eos-250d', 'EOS250D-BODY-A', 'Body', 'bardzo-dobry', 1559, 2599::numeric, 3, 1),
  ('canon-eos-250d', 'EOS250D-BODY-B', 'Body', 'dobry', 1429, 2599::numeric, 1, 2),
  ('canon-eos-250d', 'EOS250D-ZOBIEKTYWEM18-55-A+', 'Z obiektywem 18-55', 'jak-nowy', 1999, 3099::numeric, 3, 3),
  ('canon-eos-250d', 'EOS250D-ZOBIEKTYWEM18-55-A', 'Z obiektywem 18-55', 'bardzo-dobry', 1839, 3099::numeric, 1, 4),
  ('canon-eos-250d', 'EOS250D-ZOBIEKTYWEM18-55-B', 'Z obiektywem 18-55', 'dobry', 1679, 3099::numeric, 2, 5),
  ('sony-alpha-a6400', 'A6400-BODY-A+', 'Body', 'jak-nowy', 2799, 4299::numeric, 1, 0),
  ('sony-alpha-a6400', 'A6400-BODY-A', 'Body', 'bardzo-dobry', 2579, 4299::numeric, 2, 1),
  ('sony-alpha-a6400', 'A6400-BODY-B', 'Body', 'dobry', 2349, 4299::numeric, 1, 2),
  ('sony-alpha-a6400', 'A6400-ZOBIEKTYWEM16-50-A+', 'Z obiektywem 16-50', 'jak-nowy', 3199, 4899::numeric, 2, 3),
  ('sony-alpha-a6400', 'A6400-ZOBIEKTYWEM16-50-A', 'Z obiektywem 16-50', 'bardzo-dobry', 2939, 4899::numeric, 1, 4),
  ('sony-alpha-a6400', 'A6400-ZOBIEKTYWEM16-50-B', 'Z obiektywem 16-50', 'dobry', 2689, 4899::numeric, 1, 5),
  ('fujifilm-x-t30-ii', 'XT30II-BODY-A+', 'Body', 'jak-nowy', 2899, 4199::numeric, 1, 0),
  ('fujifilm-x-t30-ii', 'XT30II-BODY-A', 'Body', 'bardzo-dobry', 2669, 4199::numeric, 2, 1),
  ('fujifilm-x-t30-ii', 'XT30II-BODY-B', 'Body', 'dobry', 2439, 4199::numeric, 0, 2),
  ('canon-powershot-g7x-iii', 'G7X3---A+', null, 'jak-nowy', 2299, 3499::numeric, 2, 0),
  ('canon-powershot-g7x-iii', 'G7X3---A', null, 'bardzo-dobry', 2119, 3499::numeric, 1, 1),
  ('canon-powershot-g7x-iii', 'G7X3---B', null, 'dobry', 1929, 3499::numeric, 1, 2)
) as v(model_slug, sku, option_value, grade, price, old_price, stock, sort)
join shop_models m on m.slug = v.model_slug
on conflict (sku) do nothing;

-- Zdjęcia startowe: pliki leżą w repo sklepu (public/produkty/...), więc url jest względny wobec domeny sklepu.
-- Nowe zdjęcia z backoffice trafiają do Supabase Storage (bucket shop-images) z pełnym adresem.
insert into shop_images (model_id, url, alt, position)
select m.id, v.url, v.alt, v.position from (values
  ('xbox-series-x', '/produkty/xbox-series-x/przod-bok.png', 'Xbox Series X z kontrolerem — widok z przodu pod kątem', 0),
  ('xbox-series-x', '/produkty/xbox-series-x/przod.png', 'Xbox Series X z kontrolerem — widok z przodu', 1),
  ('xbox-series-x', '/produkty/xbox-series-x/tyl.png', 'Xbox Series X — tył obudowy ze złączami', 2),
  ('xbox-series-s', '/produkty/xbox-series-s/przod-bok.png', 'Xbox Series S z kontrolerem — widok z przodu pod kątem', 0),
  ('xbox-series-s', '/produkty/xbox-series-s/przod.png', 'Xbox Series S z kontrolerem — widok z przodu', 1),
  ('xbox-series-s', '/produkty/xbox-series-s/bok.png', 'Xbox Series S z kontrolerem — widok z boku', 2),
  ('playstation-5', '/produkty/playstation-5/z-napedem-pad.png', 'PlayStation 5 (pierwsza generacja) z napędem i padem DualSense', 0)
) as v(model_slug, url, alt, position)
join shop_models m on m.slug = v.model_slug
where not exists (select 1 from shop_images i where i.model_id = m.id and i.url = v.url);
