-- Magazyn ERP — Zamówienia -> Zapotrzebowanie (08.10.2026; początkowo w Serwisie): zlecenia dla serwisu — dowolna treść (np. "pad ps4 red" albo numer zamówienia) i priorytet.
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Można uruchomić ponownie. Wymaga wcześniejszego schema.sql (members, is_admin, audit_delete); funkcję is_service_lead() zakłada sam.
--
-- Dowolny zalogowany dodaje zlecenie (treść + automatycznie autor i data, status "nowe"); status zlecenia zmieniają WYŁĄCZNIE serwisanci (Admin, Manager, Serwis, Kierownik serwisu) — pilnuje tego
-- trigger w bazie (działa też przy bezpośrednim wywołaniu API). Autor, data i historia są niezmienne dla zalogowanych; kto i kiedy PRZYJĄŁ zlecenie, ustawia trigger (zegar serwera).
-- Edycja (13.10.2026): TREŚĆ i PRIORYTET zmienia Admin albo Manager (zawsze) oraz autor zlecenia, dopóki zlecenie jest aktywne (nowe / przyjęte / w realizacji) — z WYJĄTKIEM serwisantów:
-- role Serwis i Kierownik serwisu (strona realizująca zlecenia) nie edytują treści ani priorytetu, nawet własnych zleceń; dalej przyjmują zlecenia i zmieniają status.
-- Każda zmiana treści/priorytetu trafia do historii (action 'edited', changes: [{field, from, to}]) razem ze zmianami statusu — log na karcie zlecenia.
-- Usuwanie (15.10.2026): "miękkie" — zlecenie dostaje deleted_at / deleted_by_email i znika z list, ale zostaje w widoku "Usunięte" (można je przywrócić). Usuwają i przywracają: Admin,
-- Kierownik serwisu i rola Zamówienia (can_delete_service_requests()); kto i kiedy — ustawia trigger (zegar serwera), wpis trafia też do historii (action deleted / restored).
-- Trwałe usunięcie wiersza (DELETE) zostaje tylko dla Admina i Kierownika serwisu, z zapisem w deleted_records — z aplikacji nie jest już używane.
-- Numer zlecenia to id (w UI "ZAP-123").

create table if not exists service_requests (
  id bigint generated always as identity primary key,
  message text not null check (length(btrim(message)) > 0 and length(message) <= 2000),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now(),
  status text not null default 'nowe' check (status in ('nowe', 'przyjete', 'w_realizacji', 'zrobione', 'odrzucone')),
  accepted_by_email text,                       -- kto pierwszy przyjął zlecenie (status przyjete / w_realizacji / zrobione)
  accepted_at timestamptz,
  status_changed_by_email text,                 -- ostatnia zmiana statusu
  status_changed_at timestamptz,
  history jsonb not null default '[]'::jsonb    -- [{at, by_email, action: created|status, from, to}]
);
-- Priorytet (08.10.2026): wysoki / sredni / niski — wybierany przy dodawaniu zlecenia. Dodany osobno, żeby plik działał też na tabeli założonej wcześniej bez tej kolumny.
alter table service_requests add column if not exists priority text not null default 'sredni' check (priority in ('wysoki', 'sredni', 'niski'));
alter table service_requests add column if not exists deleted_at timestamptz;
alter table service_requests add column if not exists deleted_by_email text;
create index if not exists service_requests_status_idx on service_requests (status, created_at desc);

-- is_service_lead() zdefiniowane też w service.sql — tu powtórzone (create or replace, ta sama treść), żeby ten plik działał nawet bez ponownego uruchomienia service.sql.
create or replace function is_service_lead() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role = 'Kierownik serwisu');
$$;

-- Czy zalogowany jest serwisantem (może przyjmować zlecenia i zmieniać ich status). SECURITY DEFINER jak is_admin() — czyta members bez uprawnień do niej.
create or replace function is_service_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Księgowa', 'Serwis', 'Kierownik serwisu'));
$$;

-- Kto może usuwać (i przywracać) zlecenia — "miękkie" usunięcie z widoku "Usunięte". SECURITY DEFINER jak is_admin().
create or replace function can_delete_service_requests() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Kierownik serwisu', 'Zamówienia'));
$$;

create or replace function service_requests_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who text := coalesce(auth.jwt() ->> 'email', (select email from members where user_id = auth.uid()));
  client boolean := auth.uid() is not null;   -- service_role / SQL Editor (bez auth.uid()) nie podlega ograniczeniom, ale też dostaje wpisy do historii
  changes jsonb := '[]'::jsonb;
  my_role text := (select role from members where user_id = auth.uid());
begin
  if tg_op = 'INSERT' then
    if client then
      new.created_by_user_id := auth.uid();
      new.created_by_email := who;
      new.created_at := now();
      new.status := 'nowe';
      new.accepted_by_email := null; new.accepted_at := null; new.status_changed_by_email := null; new.status_changed_at := null;
      new.deleted_at := null; new.deleted_by_email := null;
    end if;
    new.history := jsonb_build_array(jsonb_build_object('at', now(), 'by_email', coalesce(new.created_by_email, who), 'action', 'created'));
    return new;
  end if;

  if client and (
       new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_by_email is distinct from old.created_by_email
    or new.created_at is distinct from old.created_at
    or new.accepted_by_email is distinct from old.accepted_by_email
    or new.accepted_at is distinct from old.accepted_at
    or new.status_changed_by_email is distinct from old.status_changed_by_email
    or new.status_changed_at is distinct from old.status_changed_at
    or new.history is distinct from old.history) then
    raise exception 'Autora i datę zlecenia oraz historię zmienia tylko system.' using errcode = 'P0001';
  end if;

  -- Edycja treści / priorytetu: Admin i Manager zawsze; autor tylko własnego zlecenia i tylko dopóki jest aktywne; serwisanci (Serwis, Kierownik serwisu) nigdy.
  if new.message is distinct from old.message then new.message := btrim(new.message); end if;
  if new.message is distinct from old.message or new.priority is distinct from old.priority then
    if client and not (
         my_role in ('Admin', 'Manager', 'Księgowa')
      or (old.created_by_user_id = auth.uid() and old.status in ('nowe', 'przyjete', 'w_realizacji') and coalesce(my_role, '') not in ('Serwis', 'Kierownik serwisu'))) then
      raise exception 'Treść i priorytet zlecenia zmienia jego autor (dopóki jest aktywne), Admin albo Manager — serwisanci nie edytują zleceń.' using errcode = 'P0001';
    end if;
    if new.message is distinct from old.message then
      changes := changes || jsonb_build_array(jsonb_build_object('field', 'message', 'from', old.message, 'to', new.message));
    end if;
    if new.priority is distinct from old.priority then
      changes := changes || jsonb_build_array(jsonb_build_object('field', 'priority', 'from', old.priority, 'to', new.priority));
    end if;
    new.history := coalesce(new.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'by_email', who, 'action', 'edited', 'changes', changes));
  end if;

  -- Usunięcie / przywrócenie: tylko can_delete_service_requests(); autora i czas ustawia serwer, nie żądanie.
  if new.deleted_at is distinct from old.deleted_at then
    if client and not can_delete_service_requests() then
      raise exception 'Zlecenia usuwają i przywracają tylko Admin, Kierownik serwisu i Zamówienia.' using errcode = 'P0001';
    end if;
    if new.deleted_at is not null then
      new.deleted_at := now();
      new.deleted_by_email := who;
      new.history := coalesce(new.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'by_email', who, 'action', 'deleted'));
    else
      new.deleted_by_email := null;
      new.history := coalesce(new.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'by_email', who, 'action', 'restored'));
    end if;
  elsif client then
    new.deleted_by_email := old.deleted_by_email;
  end if;

  if new.status is distinct from old.status then
    if client and not is_service_staff() then
      raise exception 'Status zlecenia zmieniają tylko serwisanci.' using errcode = 'P0001';
    end if;
    new.status_changed_by_email := who;
    new.status_changed_at := now();
    if new.accepted_at is null and new.status in ('przyjete', 'w_realizacji', 'zrobione') then
      new.accepted_by_email := who;
      new.accepted_at := now();
    end if;
    new.history := coalesce(new.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'by_email', who, 'action', 'status', 'from', old.status, 'to', new.status));
  end if;
  return new;
end $$;
drop trigger if exists service_requests_guard on service_requests;
create trigger service_requests_guard before insert or update on service_requests
  for each row execute function service_requests_guard();

alter table service_requests enable row level security;
drop policy if exists "authenticated read service_requests" on service_requests;
create policy "authenticated read service_requests" on service_requests for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated insert service_requests" on service_requests;
create policy "authenticated insert service_requests" on service_requests for insert with check (auth.role() = 'authenticated');
drop policy if exists "service staff update service_requests" on service_requests;
drop policy if exists "staff or author update service_requests" on service_requests;
create policy "staff or author update service_requests" on service_requests for update
  using (is_service_staff() or can_delete_service_requests() or (created_by_user_id = auth.uid() and status in ('nowe', 'przyjete', 'w_realizacji')))
  with check (is_service_staff() or can_delete_service_requests() or (created_by_user_id = auth.uid() and status in ('nowe', 'przyjete', 'w_realizacji')));
drop policy if exists "admin or service lead delete service_requests" on service_requests;
create policy "admin or service lead delete service_requests" on service_requests for delete using (is_admin() or is_service_lead());
drop trigger if exists service_requests_audit_delete on service_requests;
create trigger service_requests_audit_delete before delete on service_requests
  for each row execute function audit_delete();

do $$
begin
  begin alter publication supabase_realtime add table service_requests; exception when duplicate_object then null; end;
end $$;
