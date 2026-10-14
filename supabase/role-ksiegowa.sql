-- Nowa rola "Księgowa" (14.10.2026, na prośbę właściciela): na razie ma TAKIE SAME uprawnienia jak Manager.
-- Lekka paczka: tylko funkcje sprawdzające rolę w bazie (te same definicje są też w rcp.sql, shipping.sql, sales-orders.sql,
-- service-requests.sql, shop.sql i goods.sql). Idempotentna, same `create or replace function` — bezpieczna do ponownego uruchomienia.
-- Rolę nadaje Admin w zakładce Zespół (dokładna nazwa: Księgowa).
set lock_timeout = '5s';

-- rcp_is_manager (rcp.sql)
create or replace function rcp_is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Księgowa'));
$$;

-- is_admin_or_manager (shipping.sql)
create or replace function is_admin_or_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Księgowa', 'Zamówienia'));
$$;

-- shipping_rules_editor (shipping.sql)
create or replace function shipping_rules_editor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Księgowa'));
$$;

-- sales_can_edit (sales-orders.sql)
create or replace function sales_can_edit() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.role() = 'service_role'
      or exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Księgowa', 'Zamówienia'));
$$;

-- is_service_staff (service-requests.sql)
create or replace function is_service_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Księgowa', 'Serwis', 'Kierownik serwisu'));
$$;

-- service_requests_guard (service-requests.sql)
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

-- can_edit_shop (shop.sql)
create or replace function can_edit_shop() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Księgowa', 'Sklep'));
$$;

-- goods_can_read (goods-access.sql)
create or replace function goods_can_read() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members
    where user_id = auth.uid()
      and (role = 'Admin'
        or (view_access is null and role in ('Manager', 'Księgowa'))
        or (view_access is not null and 'goods' = any (view_access)))
  );
$$;

