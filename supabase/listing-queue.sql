-- Magazyn ERP — Magazyn -> "Do wystawienia" (16.10.2026): lista urządzeń gotowych do wystawienia na sprzedaż, wprowadzana skanerem (numer seryjny + SKU).
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Można uruchomić ponownie. Wymaga schema.sql (is_admin, audit_delete).
-- Ceny zakupu i sugerowane ceny sprzedaży NIE są tu przechowywane — liczy je aplikacja na żywo z Towaru (goods_register) i reguł prowizji.

create table if not exists listing_queue (
  id bigint generated always as identity primary key,
  serial_number text not null,
  sku text not null,
  notes text,
  created_by_email text,
  created_at timestamptz not null default now(),
  listed_at timestamptz,          -- chwila oznaczenia "wystawione" (puste = nadal do wystawienia)
  listed_by_email text
);

-- To samo urządzenie nie może być "do wystawienia" dwa razy (wystawione i wrócone na listę — nowy wpis jest dozwolony).
create unique index if not exists listing_queue_active_serial_idx on listing_queue (upper(btrim(serial_number))) where listed_at is null;
create index if not exists listing_queue_created_idx on listing_queue (created_at desc);

-- Autor i znaczniki czasu ustawia baza z konta zalogowanego (nie z żądania).
create or replace function listing_queue_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.serial_number := upper(btrim(new.serial_number));
    new.sku := upper(btrim(new.sku));
    new.created_by_email := coalesce(auth.jwt() ->> 'email', new.created_by_email);
    new.created_at := now();
    new.listed_at := null;
    new.listed_by_email := null;
  else
    new.serial_number := old.serial_number;
    new.created_by_email := old.created_by_email;
    new.created_at := old.created_at;
    new.sku := upper(btrim(new.sku));
    if new.listed_at is not null and old.listed_at is null then
      new.listed_at := now();
      new.listed_by_email := coalesce(auth.jwt() ->> 'email', new.listed_by_email);
    elsif new.listed_at is null then
      new.listed_by_email := null;
    else
      new.listed_at := old.listed_at;
      new.listed_by_email := old.listed_by_email;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists listing_queue_guard_trg on listing_queue;
create trigger listing_queue_guard_trg before insert or update on listing_queue
  for each row execute function listing_queue_guard();

alter table listing_queue enable row level security;
drop policy if exists "authenticated read listing_queue" on listing_queue;
create policy "authenticated read listing_queue" on listing_queue for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated insert listing_queue" on listing_queue;
create policy "authenticated insert listing_queue" on listing_queue for insert with check (auth.role() = 'authenticated');
drop policy if exists "authenticated update listing_queue" on listing_queue;
create policy "authenticated update listing_queue" on listing_queue for update using (auth.role() = 'authenticated');
-- Usuwa Admin albo autor wpisu (pomyłka przy skanowaniu); zapis w deleted_records.
drop policy if exists "admin or author delete listing_queue" on listing_queue;
create policy "admin or author delete listing_queue" on listing_queue for delete using (is_admin() or created_by_email = (auth.jwt() ->> 'email'));
drop trigger if exists listing_queue_audit_delete on listing_queue;
create trigger listing_queue_audit_delete before delete on listing_queue
  for each row execute function audit_delete();
