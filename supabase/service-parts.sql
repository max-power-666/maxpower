-- Magazyn ERP — Serwis -> Części (04.10.2026): rejestr części do napraw z ceną zakupu i przypisanym urządzeniem.
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Można uruchomić ponownie.
-- Wymaga schema.sql (is_admin, audit_delete). Dane z arkusza parts.numbers są ładowane osobno (skrypt przez REST, nie przez ten plik).
--
-- Jeden wiersz = jedna część (sztuka). W starszych zakupach jeden wiersz bywa partią (batch_qty = ilość z arkusza,
-- dalsze wiersze partii nie mają ilości) — to informacja, nie licznik. Cena netto w walucie zakupu + przeliczenie na PLN
-- (price_pln = cena JEDNOSTKOWA w PLN, z arkusza; brak kursu -> null). device_ref = numer seryjny/IMEI urządzenia, w które
-- część wbudowano (puste = część nieprzypisana).

create table if not exists service_parts (
  id bigint generated always as identity primary key,
  received_at date,                 -- data przyjęcia
  invoice_no text,                  -- numer faktury/zamówienia dostawcy
  invoice_date date,
  supplier text,
  status text,                      -- Dotarło | Demontaż | Reklamacja | Zareklamowane | Uszkodzony | puste
  notes text,                       -- uwagi o dostawie/sklepie
  name text,                        -- nazwa towaru
  part_code text,                   -- SKU / kod produktu części
  batch_qty integer,                -- ilość partii z arkusza (tylko pierwszy wiersz partii)
  price_net numeric,                -- cena netto jednostkowa w walucie zakupu
  currency text,                    -- PLN | EUR | USD
  nbp_rate numeric,                 -- kurs użyty w arkuszu
  price_pln numeric,                -- cena netto jednostkowa w PLN
  device_ref text,                  -- numer seryjny / IMEI urządzenia (wiele po przecinku, gdy w arkuszu było kilka)
  usage_notes text,                 -- uwagi o użyciu (np. "pękło przy montażu", "reklamacja")
  source text not null default 'import',
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  updated_by_email text
);

-- Kto zaimportował pozycję (06.10.2026, import z faktury w aplikacji); wiersze z arkusza mają null.
alter table service_parts add column if not exists created_by_email text;

create index if not exists service_parts_received_idx on service_parts (received_at desc nulls last, id desc);
create index if not exists service_parts_device_idx on service_parts (upper(device_ref));
create index if not exists service_parts_code_idx on service_parts (part_code);

-- Zespół zmienia TYLKO przypisanie urządzenia, status i uwagi o użyciu; dane zakupowe (nazwa, cena, faktura) z arkusza
-- są niezmienne dla zalogowanych (poprawka z SQL Editora / service_role przechodzi). Ślad: kto i kiedy ostatnio zmienił.
create or replace function service_parts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'authenticated' then
    if (new.received_at, new.invoice_no, new.invoice_date, new.supplier, new.notes, new.name, new.part_code, new.batch_qty,
        new.price_net, new.currency, new.nbp_rate, new.price_pln, new.source, new.created_by_email)
       is distinct from
       (old.received_at, old.invoice_no, old.invoice_date, old.supplier, old.notes, old.name, old.part_code, old.batch_qty,
        old.price_net, old.currency, old.nbp_rate, old.price_pln, old.source, old.created_by_email) then
      raise exception 'Dane zakupowe części są tylko do odczytu — zmienić można przypisanie urządzenia, status i uwagi.' using errcode = '42501';
    end if;
    new.device_ref := nullif(upper(btrim(new.device_ref)), '');
    new.updated_at := now();
    new.updated_by_email := coalesce(auth.jwt() ->> 'email', old.updated_by_email);
  end if;
  return new;
end $$;

drop trigger if exists service_parts_guard_trg on service_parts;
create trigger service_parts_guard_trg before update on service_parts
  for each row execute function service_parts_guard();

alter table service_parts enable row level security;

drop policy if exists "authenticated read service_parts" on service_parts;
create policy "authenticated read service_parts" on service_parts
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated update service_parts" on service_parts;
create policy "authenticated update service_parts" on service_parts
  for update using (auth.role() = 'authenticated');
-- Brak polityki insert: części dopisuje serwer (service_role) — arkusz (scripts/import-parts.mjs) i import z faktury (app/api/parts/import); usuwanie tylko Admin, z zapisem w deleted_records.
drop policy if exists "admin delete service_parts" on service_parts;
create policy "admin delete service_parts" on service_parts
  for delete using (is_admin());
drop trigger if exists service_parts_audit_delete on service_parts;
create trigger service_parts_audit_delete before delete on service_parts
  for each row execute function audit_delete();
