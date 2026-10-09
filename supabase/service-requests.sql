-- Magazyn ERP — Serwis -> Zapotrzebowanie (08.10.2026): zlecenia dodatkowych zadań dla serwisu.
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Można uruchomić ponownie. Wymaga wcześniejszego schema.sql (members, is_admin, audit_delete) i service.sql (is_service_lead).
--
-- Dowolny zalogowany dodaje zlecenie (treść + automatycznie autor i data, status "nowe"); status zlecenia zmieniają WYŁĄCZNIE serwisanci (Admin, Manager, Serwis, Kierownik serwisu) — pilnuje tego
-- trigger w bazie (działa też przy bezpośrednim wywołaniu API). Treść, autor i data są niezmienne dla zalogowanych; kto i kiedy PRZYJĄŁ zlecenie, ustawia trigger (zegar serwera).
-- Usuwanie: Admin i Kierownik serwisu (z zapisem w deleted_records). Numer zlecenia to id (w UI "ZAP-123").

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
create index if not exists service_requests_status_idx on service_requests (status, created_at desc);

-- Czy zalogowany jest serwisantem (może przyjmować zlecenia i zmieniać ich status). SECURITY DEFINER jak is_admin() — czyta members bez uprawnień do niej.
create or replace function is_service_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Serwis', 'Kierownik serwisu'));
$$;

create or replace function service_requests_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who text := coalesce(auth.jwt() ->> 'email', (select email from members where user_id = auth.uid()));
  client boolean := auth.uid() is not null;   -- service_role / SQL Editor (bez auth.uid()) nie podlega ograniczeniom, ale też dostaje wpisy do historii
begin
  if tg_op = 'INSERT' then
    if client then
      new.created_by_user_id := auth.uid();
      new.created_by_email := who;
      new.created_at := now();
      new.status := 'nowe';
      new.accepted_by_email := null; new.accepted_at := null; new.status_changed_by_email := null; new.status_changed_at := null;
    end if;
    new.history := jsonb_build_array(jsonb_build_object('at', now(), 'by_email', coalesce(new.created_by_email, who), 'action', 'created'));
    return new;
  end if;

  if client and (
       new.message is distinct from old.message
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_by_email is distinct from old.created_by_email
    or new.created_at is distinct from old.created_at
    or new.accepted_by_email is distinct from old.accepted_by_email
    or new.accepted_at is distinct from old.accepted_at
    or new.status_changed_by_email is distinct from old.status_changed_by_email
    or new.status_changed_at is distinct from old.status_changed_at
    or new.history is distinct from old.history) then
    raise exception 'Treść, autora i datę zlecenia oraz historię zmienia tylko system.' using errcode = 'P0001';
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
    new.history := coalesce(old.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'by_email', who, 'action', 'status', 'from', old.status, 'to', new.status));
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
create policy "service staff update service_requests" on service_requests for update using (is_service_staff()) with check (is_service_staff());
drop policy if exists "admin or service lead delete service_requests" on service_requests;
create policy "admin or service lead delete service_requests" on service_requests for delete using (is_admin() or is_service_lead());
drop trigger if exists service_requests_audit_delete on service_requests;
create trigger service_requests_audit_delete before delete on service_requests
  for each row execute function audit_delete();

do $$
begin
  begin alter publication supabase_realtime add table service_requests; exception when duplicate_object then null; end;
end $$;
