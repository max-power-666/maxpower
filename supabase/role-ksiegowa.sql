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

-- service_requests_guard: pełna definicja (z rolą Księgowa i usuwaniem) jest TYLKO w service-requests.sql — uruchom ten plik, żeby ją zaktualizować.

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

