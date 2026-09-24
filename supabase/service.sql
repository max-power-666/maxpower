-- Magazyn ERP — moduł Serwis (rejestracja pracy wg Regulaminu premiowania z 12.10.2026, §2)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów.
--
-- Uwaga: to rejestruje CZYNNOŚCI i PUNKTY (Regulamin §2), nie liczy wysokości premii w zł
-- (Regulamin §4-§7) — to wymagałoby danych o czasie pracy/urlopach, których apka nie ma.
--
-- Model: jeden wiersz na naprawę, z cyklem życia w statusie (nie dwa osobne wpisy start/koniec).
-- started_at ustawia się przy rejestracji, finished_at przy przejściu na status końcowy.
-- "Czas" (finished_at - started_at) jest tylko informacyjny — regulamin liczy wydajność
-- jako punkty / godziny PRZEPRACOWANE (ewidencja czasu pracy), nie sumę czasów napraw.
-- Punkty do podsumowania liczą się tylko dla status='naprawiony' (Regulamin §2 ust. 4:
-- punkty nalicza się dopiero po prawidłowym zakończeniu procesu).

create table if not exists service_log (
  id bigint generated always as identity primary key,
  employee_user_id uuid not null references auth.users(id),
  employee_email text,
  task_type text not null,                   -- joycon_pair | ps4_controller | xbox_controller | ps5_controller | console_cleaning
  points numeric not null,                   -- migawka punktów wg typu czynności (gdyby regulamin się zmienił, stare wpisy zostają poprawne)
  device_ref text,                           -- numer seryjny / identyfikator urządzenia — Regulamin §2 ust. 5 wymaga wskazania urządzenia w ewidencji
  status text not null default 'w_naprawie', -- w_naprawie | naprawiony | uszkodzony
  started_at timestamptz not null default now(),
  finished_at timestamptz                    -- ustawiane przy przejściu na status naprawiony/uszkodzony
);

-- Migracja z poprzedniej wersji (created_at/notes) — bezpieczna do wielokrotnego uruchomienia.
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'service_log' and column_name = 'created_at') then
    alter table service_log rename column created_at to started_at;
  end if;
end $$;
alter table service_log add column if not exists status text not null default 'w_naprawie';
alter table service_log add column if not exists finished_at timestamptz;
alter table service_log drop column if exists notes;

create index if not exists service_log_employee_idx on service_log (employee_user_id, started_at desc);
create index if not exists service_log_started_idx on service_log (started_at desc);
create index if not exists service_log_finished_idx on service_log (finished_at desc);

alter table service_log enable row level security;

drop policy if exists "authenticated read service_log" on service_log;
create policy "authenticated read service_log" on service_log
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated insert service_log" on service_log;
create policy "authenticated insert service_log" on service_log
  for insert with check (auth.role() = 'authenticated');
-- Update dozwolony tylko po to, żeby dało się zmieniać status/finished_at (postęp naprawy) —
-- sama liczba punktów za dany typ czynności jest stała i nie do zmiany przez UI, więc to nie
-- otwiera furtki do ręcznego dopisywania sobie punktów (Regulamin §9).
drop policy if exists "authenticated update service_log" on service_log;
create policy "authenticated update service_log" on service_log
  for update using (auth.role() = 'authenticated');

do $$
begin
  begin alter publication supabase_realtime add table service_log; exception when duplicate_object then null; end;
end $$;
