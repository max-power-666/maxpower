-- Magazyn ERP — Towar: dostęp i dodawanie towaru ma każdy, kto ma zakładkę Towar (13.10.2026). LEKKA paczka: tylko funkcja goods_can_read() (ta sama treść co w goods.sql);
-- polityki odczytu i dodawania już jej używają, więc po jej podmianie od razu działają. Można uruchomić wielokrotnie.
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Wymaga wcześniejszego goods.sql (tabela goods_register i polityki).
create or replace function goods_can_read() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members
    where user_id = auth.uid()
      and (role = 'Admin'
        or (view_access is null and role = 'Manager')
        or (view_access is not null and 'goods' = any (view_access)))
  );
$$;
