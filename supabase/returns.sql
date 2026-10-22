-- Magazyn ERP — zakładka Zwroty (22.10.2026): rejestr przyjętych zwrotów, kolumny jak w dotychczasowym arkuszu.
-- Uruchom w Supabase: SQL Editor -> wklej CAŁY plik -> Run (po schema.sql). Można uruchomić ponownie.
-- Jeden wiersz = jeden zwrot. Autor i data dodania ustawiane po stronie bazy; historia zmian pól w `history` (jak w innych modułach).

create table if not exists returns_log (
  id bigint generated always as identity primary key,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now(),
  received_at date not null default ((now() at time zone 'Europe/Warsaw')::date), -- DATA PRZYJĘCIA
  return_kind text,            -- RODZAJ ZWROTU (zwrot / reklamacja / gwarancja — lista w lib/returns.ts, zwykły tekst)
  customer_name text,          -- IMIĘ I NAZWISKO
  platform text,               -- PLATFORMA (klucz marketplace'u: backmarket, refurbed, erli, allegro, octopia, amazon, swopify, inna)
  order_id text,               -- ID ZAMÓWIENIA
  product text,                -- PRODUKT (grupa: PlayStation, iPhone…)
  sku text,                    -- SKU
  serial_number text,          -- NUMER SERYJNY / IMEI
  client_comment text,         -- KOMENTARZ KLIENTA
  can_do boolean not null default false, -- CZY MOŻNA WYKONAĆ
  final_status text,           -- STATUS KOŃCOWY (zwrot_srodkow / naprawione_odeslane)
  correction_number text,      -- NUMER KOREKTY
  replaced_imei text,          -- IMEI WYMIENIONEGO
  check_notes text,            -- UWAGI PRZY SPRAWDZANIU
  commission numeric,          -- (nieużywane od 22.10.2026 — PROWIZJA to lista, patrz commission_status)
  history jsonb not null default '[]'::jsonb
);

-- PROWIZJA jako lista (22.10.2026): prowizja / odzyskana / odrzucona / bez_prowizji / do_zgloszenia / zgloszona — zwykły tekst, lista w lib/returns.ts
alter table returns_log add column if not exists commission_status text;

create index if not exists returns_log_created_idx on returns_log (created_at desc);
create index if not exists returns_log_serial_idx on returns_log (upper(btrim(serial_number)));
create index if not exists returns_log_order_idx on returns_log (order_id);

-- Autor i znacznik dodania z konta (przeglądarka ich nie podrobi); każda zmiana pola trafia do history (kto, kiedy, było -> jest)
create or replace function returns_log_guard() returns trigger
language plpgsql as $$
declare
  changes jsonb := '[]'::jsonb;
  who text := coalesce(auth.jwt() ->> 'email', 'poza aplikacją');
  f text;
  o jsonb;
  n jsonb;
begin
  if tg_op = 'INSERT' then
    new.created_by_user_id := auth.uid();
    new.created_by_email := auth.jwt() ->> 'email';
    new.created_at := now();
    new.history := jsonb_build_array(jsonb_build_object('action', 'created', 'by_email', who, 'at', now()));
    return new;
  end if;
  if auth.role() = 'authenticated' then
    new.created_by_user_id := old.created_by_user_id;
    new.created_by_email := old.created_by_email;
    new.created_at := old.created_at;
  end if;
  o := to_jsonb(old);
  n := to_jsonb(new);
  foreach f in array array['received_at','return_kind','customer_name','platform','order_id','product','sku','serial_number','client_comment','can_do','final_status','correction_number','replaced_imei','check_notes','commission_status'] loop
    if o -> f is distinct from n -> f then
      changes := changes || jsonb_build_array(jsonb_build_object('field', f, 'from', o -> f, 'to', n -> f));
    end if;
  end loop;
  new.history := old.history;
  if jsonb_array_length(changes) > 0 then
    new.history := old.history || jsonb_build_array(jsonb_build_object('action', 'edited', 'by_email', who, 'at', now(), 'changes', changes));
  end if;
  return new;
end $$;
drop trigger if exists returns_log_guard on returns_log;
create trigger returns_log_guard before insert or update on returns_log
  for each row execute function returns_log_guard();

alter table returns_log enable row level security;
drop policy if exists "authenticated read returns_log" on returns_log;
create policy "authenticated read returns_log" on returns_log for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated insert returns_log" on returns_log;
create policy "authenticated insert returns_log" on returns_log for insert with check (auth.role() = 'authenticated');
drop policy if exists "authenticated update returns_log" on returns_log;
create policy "authenticated update returns_log" on returns_log for update using (auth.role() = 'authenticated');
-- Usuwanie: tylko Admin, ślad w deleted_records (audit_delete z schema.sql)
drop policy if exists "admin delete returns_log" on returns_log;
create policy "admin delete returns_log" on returns_log for delete using (is_admin());
drop trigger if exists returns_log_audit_delete on returns_log;
create trigger returns_log_audit_delete before delete on returns_log
  for each row execute function audit_delete();

do $$
begin
  begin alter publication supabase_realtime add table returns_log; exception when duplicate_object then null; end;
end $$;
