-- Magazyn ERP — Towar: dostęp, dodawanie i EDYCJA towaru ma każdy, kto ma zakładkę Towar (13.10.2026); usuwa nadal tylko Admin. LEKKA paczka: funkcja goods_can_read() + polityka edycji
-- (ta sama treść co w goods.sql). Polityki odczytu i dodawania już używają funkcji, więc po jej podmianie od razu działają. Można uruchomić wielokrotnie.
set lock_timeout = '5s';
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Wymaga wcześniejszego goods.sql (tabela goods_register i polityki).
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

-- Edycja wierszy: wcześniej tylko Admin (is_admin()), teraz jak odczyt i dodawanie. Historię zmian (kto, kiedy, co) dopisuje trigger goods_register_before_update.
drop policy if exists "admin update goods_register" on goods_register;
drop policy if exists "goods access update goods_register" on goods_register;
create policy "goods access update goods_register" on goods_register for update using (goods_can_read()) with check (goods_can_read());

-- Pełny log zmian (13.10.2026): dodanie wiersza z aplikacji zapisuje się jako pierwszy wpis historii, a zmiana spoza aplikacji (SQL/serwer) dostaje autora "poza aplikacją".
-- Funkcje triggerów — ta sama treść co w goods.sql; same triggery już istnieją, więc wystarczy podmienić funkcje.
create or replace function goods_register_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.row_no := coalesce((select max(row_no) from goods_register where kind = new.kind), 0) + 1;
  new.created_by_email := coalesce(auth.jwt() ->> 'email', new.created_by_email);
  -- Dodanie z aplikacji to pierwszy wpis w historii (kto i kiedy); wiersze z importu/SQL (bez e-maila z sesji) zostają z pustą historią.
  if auth.jwt() ->> 'email' is not null then
    new.history := jsonb_build_array(jsonb_build_object('at', now(), 'by', auth.jwt() ->> 'email', 'action', 'created', 'changes', '[]'::jsonb));
  end if;
  return new;
end;
$$;

create or replace function goods_register_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb;
  n jsonb;
  k text;
  ch jsonb := '[]'::jsonb;
  who text;
begin
  new.id := old.id;
  new.row_no := old.row_no;
  new.created_at := old.created_at;
  new.created_by_email := old.created_by_email;
  new.history := old.history;
  new.updated_at := old.updated_at;
  new.updated_by_email := old.updated_by_email;
  o := to_jsonb(old);
  n := to_jsonb(new);
  for k in select jsonb_object_keys(n) loop
    if (o -> k) is distinct from (n -> k) then
      ch := ch || jsonb_build_array(jsonb_build_object('field', k, 'from', o -> k, 'to', n -> k));
    end if;
  end loop;
  if jsonb_array_length(ch) = 0 then
    return new;
  end if;
  who := coalesce(auth.jwt() ->> 'email', 'poza aplikacją');  -- zmiana z SQL Editora/serwera nie ma e-maila z sesji — nie przypisujemy jej poprzedniemu edytorowi
  new.updated_at := now();
  new.updated_by_email := who;
  new.history := coalesce(old.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'by', who, 'changes', ch));
  return new;
end;
$$;
