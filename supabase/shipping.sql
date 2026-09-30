-- Magazyn ERP — zakładka Wysyłka (nadawanie przesyłek DHL Express)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów. Wymaga wcześniej uruchomionego schema.sql (tabela members, is_admin()).
--
--  * shipping_settings  — dane nadawcy widoczne na etykiecie (jeden wiersz), zmienia je Admin,
--  * shipping_templates — szablony paczek (nazwa, waga, wymiary, opis zawartości), np. "ps4",
--  * shipments          — nadane przesyłki (DHL Express i DHL Parcel) wraz z etykietą (PDF w base64) i opłatami. Zapisuje wyłącznie serwer (service_role);
--                         czytać mogą tylko Admin, Manager i Zamówienia (są tam adresy odbiorców).

-- Admin, Manager albo Zamówienia: SECURITY DEFINER, żeby polityki mogły sprawdzić rolę w members bez uprawnień do niej.
-- Nazwa funkcji zostaje historyczna (Admin/Manager) mimo że dziś obejmuje też rolę Zamówienia — używana wyłącznie
-- przez tabele Wysyłki, więc zmiana nazwy niczego by nie ułatwiła.
create or replace function is_admin_or_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Zamówienia'));
$$;

create table if not exists shipping_settings (
  id int primary key default 1,
  shipper_company text not null,
  shipper_name text not null,
  street text not null,
  postal_code text not null,
  city text not null,
  country_code text not null default 'PL',
  phone text not null,
  email text,
  default_description text not null default 'Used electronics',   -- opis zawartości, gdy szablon nie ma własnego
  zebra_printer_name text,          -- nazwa drukarki (dokładnie jak w Windows/QZ Tray) do druku etykiet ZPL
  a4_printer_name text,             -- nazwa drukarki A4 do druku delivery note/packing slipu
  constraint shipping_settings_singleton check (id = 1)
);
alter table shipping_settings add column if not exists zebra_printer_name text;
alter table shipping_settings add column if not exists a4_printer_name text;
-- Dane nadawcy Recoo (widnieją na etykiecie). Wstawiane tylko gdy wiersza jeszcze nie ma — późniejsze zmiany Admina zostają.
insert into shipping_settings (id, shipper_company, shipper_name, street, postal_code, city, country_code, phone, email)
values (1, 'M13 Maksymilian Jonkisz', 'Maksymilian Jonkisz', 'ul. Karola Olszewskiego 20', '25-663', 'Kielce', 'PL', '579510490', 'hello@recoo.io')
on conflict (id) do nothing;

create table if not exists shipping_templates (
  id bigint generated always as identity primary key,
  name text not null unique check (length(btrim(name)) > 0),
  weight_kg numeric not null check (weight_kg > 0 and weight_kg <= 70),
  length_cm numeric not null check (length_cm > 0 and length_cm <= 300),
  width_cm numeric not null check (width_cm > 0 and width_cm <= 300),
  height_cm numeric not null check (height_cm > 0 and height_cm <= 300),
  description text,                                   -- opis zawartości do przesyłki (np. "Used game console"); puste = domyślny z ustawień
  created_by_email text,
  created_at timestamptz not null default now()
);
-- Szablon startowy z przykładu: ps4 — 3 kg, 40x30x20 cm.
insert into shipping_templates (name, weight_kg, length_cm, width_cm, height_cm, description)
values ('ps4', 3, 40, 30, 20, 'Used game console')
on conflict (name) do nothing;

create table if not exists shipments (
  id bigint generated always as identity primary key,
  client_request_id uuid not null unique,             -- klucz z formularza: to samo kliknięcie nie nada dwóch przesyłek
  carrier text not null default 'dhl_express',
  created_at timestamptz not null default now(),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_email text,
  environment text not null,                          -- test | production (przesyłki testowe nie są prawdziwe)
  marketplace text,                                   -- z którego zamówienia (opcjonalnie)
  order_external_id text,
  product_code text not null,
  product_name text,
  tracking_number text not null,
  tracking_url text,
  planned_shipping_date date,
  receiver jsonb not null,                            -- odbiorca (imię, firma, adres, telefon, e-mail)
  package jsonb not null,                             -- waga, wymiary, opis, szablon
  charges jsonb,                                      -- opłaty zwrócone przez DHL (shipmentCharges)
  label_format text,                                  -- pdf
  label_data text,                                    -- etykieta w base64 (pobierana osobno, nie na liście)
  cancelled_at timestamptz,                           -- anulowano przez API (tylko DHL Parcel); wiersz zostaje jako zapis księgowy
  marketplace_synced_at timestamptz,                  -- kiedy numer przesyłki zgłoszono z powrotem do marketplace'u (null = nie dotyczy albo jeszcze się nie udało)
  marketplace_sync_error text                         -- ostatni błąd zgłoszenia (null = zgłoszono albo nie dotyczy); UI pokazuje ostrzeżenie i "Zgłoś ponownie"
);
alter table shipments add column if not exists cancelled_at timestamptz;
alter table shipments add column if not exists marketplace_synced_at timestamptz;
alter table shipments add column if not exists marketplace_sync_error text;
create index if not exists shipments_created_idx on shipments (created_at desc);
create index if not exists shipments_order_idx on shipments (marketplace, order_external_id);
-- ON DELETE SET NULL (30.09.2026) — patrz wyjaśnienie w schema.sql (members.user_id); created_by_email jest już
-- zapisany osobno, więc "kto nadał" zostaje widoczne mimo zerwania linku do konta.
alter table shipments drop constraint if exists shipments_created_by_user_id_fkey;
alter table shipments add constraint shipments_created_by_user_id_fkey foreign key (created_by_user_id) references auth.users(id) on delete set null;

alter table shipping_settings enable row level security;
alter table shipping_templates enable row level security;
alter table shipments enable row level security;

drop policy if exists "admin manager read shipping_settings" on shipping_settings;
create policy "admin manager read shipping_settings" on shipping_settings for select using (is_admin_or_manager());
drop policy if exists "admin update shipping_settings" on shipping_settings;
create policy "admin update shipping_settings" on shipping_settings for update using (is_admin());

drop policy if exists "admin manager read shipping_templates" on shipping_templates;
create policy "admin manager read shipping_templates" on shipping_templates for select using (is_admin_or_manager());
drop policy if exists "admin manager insert shipping_templates" on shipping_templates;
create policy "admin manager insert shipping_templates" on shipping_templates for insert with check (is_admin_or_manager());
drop policy if exists "admin manager update shipping_templates" on shipping_templates;
create policy "admin manager update shipping_templates" on shipping_templates for update using (is_admin_or_manager());
drop policy if exists "admin delete shipping_templates" on shipping_templates;
create policy "admin delete shipping_templates" on shipping_templates for delete using (is_admin());

-- Przesyłki: odczyt Admin/Manager/Zamówienia; brak polityk zapisu, więc tworzy je tylko serwer (service_role poza RLS).
-- Nie ma UPDATE/DELETE: nadana przesyłka jest zapisem księgowym i zostaje.
drop policy if exists "admin manager read shipments" on shipments;
create policy "admin manager read shipments" on shipments for select using (is_admin_or_manager());

do $$
begin
  begin alter publication supabase_realtime add table shipments; exception when duplicate_object then null; end;
end $$;
