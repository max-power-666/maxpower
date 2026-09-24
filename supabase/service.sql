-- Magazyn ERP — moduł Serwis (rejestracja pracy wg Regulaminu premiowania z 12.10.2026, §2)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów.
--
-- Uwaga: to rejestruje CZYNNOŚCI i PUNKTY (Regulamin §2), nie liczy wysokości premii w zł
-- (Regulamin §4-§7) — to wymagałoby danych o czasie pracy/urlopach, których apka nie ma.

create table if not exists service_log (
  id bigint generated always as identity primary key,
  employee_user_id uuid not null references auth.users(id),
  employee_email text,
  task_type text not null,                   -- joycon_pair | ps4_controller | xbox_controller | ps5_controller | console_cleaning
  points numeric not null,                   -- migawka punktów z chwili rejestracji (gdyby regulamin się zmienił, stare wpisy zostają poprawne)
  device_ref text,                           -- numer seryjny / identyfikator urządzenia — Regulamin §2 ust. 5 wymaga wskazania urządzenia w ewidencji
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists service_log_employee_idx on service_log (employee_user_id, created_at desc);
create index if not exists service_log_created_idx on service_log (created_at desc);

alter table service_log enable row level security;

drop policy if exists "authenticated read service_log" on service_log;
create policy "authenticated read service_log" on service_log
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated insert service_log" on service_log;
create policy "authenticated insert service_log" on service_log
  for insert with check (auth.role() = 'authenticated');
-- Celowo bez update/delete z poziomu UI — Regulamin §9 zabrania manipulowania wynikami,
-- więc log punktowy jest tylko do dopisywania. Korekta błędu to osobna, świadoma decyzja
-- (na razie poza zakresem — dodamy, jeśli będzie potrzebna).

do $$
begin
  begin alter publication supabase_realtime add table service_log; exception when duplicate_object then null; end;
end $$;
