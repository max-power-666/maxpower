-- Magazyn ERP — Serwis -> Części: edycja rekordów przez Kierownika serwisu (16.10.2026). LEKKA PACZKA (ta sama treść jest w service-parts.sql).
-- Uruchom w Supabase: SQL Editor -> wklej CAŁY plik -> Run. Można uruchomić ponownie. Wymaga wcześniej service-parts.sql i schema.sql (is_admin, members).
-- Kierownik serwisu (i Admin) edytuje WSZYSTKIE dane części (16.10.2026, na prośbę właściciela — "kierownik serwisu może edytować rekordy"): nazwa, kod, dostawca, faktura, ceny, kurs,
-- status, numer seryjny urządzenia, uwagi. Pozostali zalogowani dalej zmieniają tylko status i uwagi o użyciu. Każda taka edycja trafia do `history` (kto, kiedy, pole: było -> jest) —
-- ceny części zasilają koszt serwisu w Marży, więc zmiany muszą być widoczne. Log (16.10.2026: "zmiany zapisujemy w logu") obejmuje też status i uwagi zwykłych serwisantów. Niezmienne dla wszystkich zalogowanych: źródło, autor importu, data utworzenia i sama historia.
alter table service_parts add column if not exists history jsonb not null default '[]'::jsonb;

-- is_service_lead() zdefiniowane też w service.sql i service-requests.sql — tu powtórzone (create or replace, ta sama treść), żeby plik działał samodzielnie.
create or replace function is_service_lead() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role = 'Kierownik serwisu');
$$;

create or replace function service_parts_can_edit_all() returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or is_service_lead();
$$;

create or replace function service_parts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  c text;
  changes jsonb := '[]'::jsonb;
  tracked text[] := array['received_at', 'invoice_no', 'invoice_date', 'supplier', 'status', 'notes', 'name', 'part_code', 'batch_qty', 'price_net', 'currency', 'nbp_rate', 'price_pln', 'device_ref', 'usage_notes'];
begin
  if auth.role() = 'authenticated' then
    new.history := old.history; -- historię dopisuje tylko ten trigger
    if (new.source, new.created_by_email, new.created_at) is distinct from (old.source, old.created_by_email, old.created_at) then
      raise exception 'Źródła, autora importu i daty utworzenia części nie można zmienić.' using errcode = '42501';
    end if;
    if not service_parts_can_edit_all() then
      if (new.received_at, new.invoice_no, new.invoice_date, new.supplier, new.notes, new.name, new.part_code, new.batch_qty,
          new.price_net, new.currency, new.nbp_rate, new.price_pln)
         is distinct from
         (old.received_at, old.invoice_no, old.invoice_date, old.supplier, old.notes, old.name, old.part_code, old.batch_qty,
          old.price_net, old.currency, old.nbp_rate, old.price_pln) then
        raise exception 'Dane zakupowe części może zmienić tylko Kierownik serwisu (albo Admin) — tu zmienia się status i uwagi.' using errcode = '42501';
      end if;
      -- Numer seryjny urządzenia przypisuje serwisant w Serwis -> Naprawy (kolumna "Części"), a trigger service_parts_sync_from_repair
      -- przenosi go tutaj — ręcznie (z listy Części) zwykły serwisant go nie edytuje (06.10.2026).
      if new.device_ref is distinct from old.device_ref and coalesce(current_setting('parts.repair_sync', true), '') <> '1' then
        raise exception 'Numer seryjny urządzenia przypisuje się w Serwis -> Naprawy (kolumna Części), nie tutaj.' using errcode = '42501';
      end if;
    end if;
    new.device_ref := nullif(upper(btrim(new.device_ref)), '');
    -- Log obejmuje KAŻDĄ zmianę zalogowanego (status i uwagi serwisanta, edycje kierownika, przypisanie z napraw — to ostatnie z oznaczeniem via = 'naprawa').
    foreach c in array tracked loop
      if (to_jsonb(new) -> c) is distinct from (to_jsonb(old) -> c) then
        changes := changes || jsonb_build_array(jsonb_build_object('field', c, 'from', to_jsonb(old) -> c, 'to', to_jsonb(new) -> c));
      end if;
    end loop;
    if jsonb_array_length(changes) > 0 then
      new.history := coalesce(old.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'action', 'edited', 'by_email', coalesce(auth.jwt() ->> 'email', ''), 'at', now(), 'changes', changes,
        'via', case when coalesce(current_setting('parts.repair_sync', true), '') = '1' then 'naprawa' else 'lista' end));
    end if;
    new.updated_at := now();
    new.updated_by_email := coalesce(auth.jwt() ->> 'email', old.updated_by_email);
  end if;
  return new;
end $$;

drop trigger if exists service_parts_guard_trg on service_parts;
create trigger service_parts_guard_trg before update on service_parts
  for each row execute function service_parts_guard();
