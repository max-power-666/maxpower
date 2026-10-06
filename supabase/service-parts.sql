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

-- Zespół zmienia TYLKO uwagi o użyciu (przypisanie urządzenia idzie z napraw — patrz service_parts_sync_from_repair niżej); dane zakupowe (nazwa, cena, faktura) z arkusza
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
    -- Numer seryjny urządzenia przypisuje serwisant w Serwis -> Naprawy (kolumna "Części"), a trigger service_parts_sync_from_repair
    -- przenosi go tutaj — ręcznie (z listy Części) nie edytujemy go (06.10.2026).
    if new.device_ref is distinct from old.device_ref and coalesce(current_setting('parts.repair_sync', true), '') <> '1' then
      raise exception 'Numer seryjny urządzenia przypisuje się w Serwis -> Naprawy (kolumna Części), nie tutaj.' using errcode = '42501';
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

-- ---- Przypisanie części do urządzenia z napraw (06.10.2026, na prośbę właściciela) ----
-- Serwisant wpisuje w naprawie (service_log.part_serials, kolumna "Części") kody użytych części; część w tej tabeli o tym samym
-- kodzie (part_code, bez rozróżniania wielkości liter i spacji) dostaje numer seryjny/IMEI naprawianego urządzenia (service_log.device_ref).
-- Dotyczy tylko kodów JEDNOZNACZNYCH (dokładnie jeden wiersz z takim kodem) — kody partii (np. 6741 na 139 sztukach) są pomijane,
-- bo nie wiadomo, którą sztukę wbudowano. Ostatnia edycja naprawy wygrywa (też nad przypisaniem z arkusza). Usunięcie kodu z naprawy,
-- zmiana urządzenia albo usunięcie naprawy zwalnia część (tylko jeśli wciąż jest przypisana do TEGO urządzenia).
create index if not exists service_parts_code_norm_idx on service_parts (upper(btrim(part_code)));

create or replace function service_parts_sync_from_repair() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  old_codes text[] := '{}';
  new_codes text[] := '{}';
  old_dev text;
  new_dev text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    old_codes := coalesce((select array_agg(distinct upper(btrim(x))) from unnest(old.part_serials) x where btrim(x) <> ''), '{}');
    old_dev := nullif(upper(btrim(old.device_ref)), '');
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    new_codes := coalesce((select array_agg(distinct upper(btrim(x))) from unnest(new.part_serials) x where btrim(x) <> ''), '{}');
    new_dev := nullif(upper(btrim(new.device_ref)), '');
  end if;
  if old_dev is null and new_dev is null then
    return coalesce(new, old);
  end if;
  perform set_config('parts.repair_sync', '1', true);
  if old_dev is not null and cardinality(old_codes) > 0 then
    update service_parts p set device_ref = null
     where upper(btrim(p.device_ref)) = old_dev
       and upper(btrim(p.part_code)) = any (old_codes)
       and (tg_op = 'DELETE' or new_dev is distinct from old_dev or not (upper(btrim(p.part_code)) = any (new_codes)))
       and (select count(*) from service_parts q where upper(btrim(q.part_code)) = upper(btrim(p.part_code))) = 1;
  end if;
  if new_dev is not null and cardinality(new_codes) > 0 then
    update service_parts p set device_ref = new_dev
     where upper(btrim(p.part_code)) = any (new_codes)
       and upper(btrim(coalesce(p.device_ref, ''))) is distinct from new_dev
       and (select count(*) from service_parts q where upper(btrim(q.part_code)) = upper(btrim(p.part_code))) = 1;
  end if;
  perform set_config('parts.repair_sync', '0', true);
  return coalesce(new, old);
end $$;

-- Trigger na service_log (tabela z service.sql) — zakładany tylko gdy tabela już istnieje (przy pierwszym uruchomieniu przed service.sql
-- uruchom ten plik jeszcze raz).
do $$
begin
  if to_regclass('public.service_log') is not null then
    drop trigger if exists service_log_sync_parts on service_log;
    create trigger service_log_sync_parts after insert or delete or update of part_serials, device_ref on service_log
      for each row execute function service_parts_sync_from_repair();
  end if;
end $$;

-- Jednorazowe uzupełnienie z istniejących napraw (od najstarszej, więc najnowsza wygrywa) — tylko kody jednoznaczne.
do $$
declare r record;
begin
  if to_regclass('public.service_log') is not null then
    perform set_config('parts.repair_sync', '1', true);
    for r in select device_ref, part_serials from service_log where nullif(btrim(device_ref), '') is not null and part_serials is not null order by started_at, id loop
      update service_parts p set device_ref = nullif(upper(btrim(r.device_ref)), '')
       where upper(btrim(p.part_code)) = any (select upper(btrim(x)) from unnest(r.part_serials) x where btrim(x) <> '')
         and upper(btrim(coalesce(p.device_ref, ''))) is distinct from upper(btrim(r.device_ref))
         and (select count(*) from service_parts q where upper(btrim(q.part_code)) = upper(btrim(p.part_code))) = 1;
    end loop;
    perform set_config('parts.repair_sync', '0', true);
  end if;
end $$;
