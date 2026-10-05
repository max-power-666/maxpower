-- Magazyn ERP — moduł Testy (rejestr testów urządzeń wg Regulaminu premiowania z 12.10.2026, §2)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów.
--
-- Jeden wiersz = jeden test urządzenia, z cyklem życia w statusie. started_at ustawia się
-- przy rejestracji, finished_at przy przejściu na status końcowy. "Czas" jest tylko
-- informacyjny (regulamin liczy wydajność jako punkty / godziny przepracowane, §4).
-- Punkty do podsumowania liczą się tylko dla status='przetestowane' (§2 ust. 4).

create table if not exists test_log (
  id bigint generated always as identity primary key,
  employee_user_id uuid references auth.users(id) on delete set null,
  employee_email text,
  serial_number text not null,
  status text not null default 'w_trakcie',  -- w_trakcie | przetestowane | przerwany
  notes text,                                -- uwagi, edytowane w wierszu listy
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- Migawka punktów za urządzenie. Gdyby stawka się zmieniła, zmieniamy default; stare wiersze
  -- zachowują swoją wartość.
  points numeric not null default (200.0 / 13.0)
);

alter table test_log add column if not exists notes text;
-- Regulamin zaktualizowany 01.10.2026: "Tester - urządzenie" to teraz 15 pkt flat (tabela §2 ust.
-- 6), nie ułamek 100/6,5 = 200/13 (≈15,38) jak w poprzedniej wersji regulaminu. Zmieniamy tylko
-- default dla NOWYCH wpisów — stare testy zachowują swoją migawkę 200/13, zgodnie z zasadą, że
-- migawka punktów nie zmienia się wstecz.
alter table test_log alter column points set default 15;
-- Rodzaj testu (01.10.2026) — skąd/czemu urządzenie trafiło do testu (po dostawie, po serwisie,
-- ponowny test z magazynu, OLX, Allegro, Vinted); zwykły tekst jak role/typy w innych modułach —
-- dodanie kolejnej wartości nie wymaga SQL, tylko TEST_KINDS w lib/workLog.ts. Default zapewnia,
-- że stare wiersze dostają sensowną wartość bez ręcznego backfillu.
alter table test_log add column if not exists test_kind text not null default 'po_dostawie';
-- Wynik testu (01.10.2026) — stan urządzenia ustalony podczas testu (sprawny/serwis/rma/do
-- poprawy/outlet); NIEZALEŻNY od statusu cyklu życia testu (w_trakcie/przetestowane/przerwany,
-- kolumna `status` wyżej) i od punktów — ustalany dopiero w trakcie/po teście, więc nullable,
-- bez default (stare wiersze zostają bez wyniku, pokazane jako "—").
alter table test_log add column if not exists result text;
-- SKU (02.10.2026) — wpisywany ręcznie przez pracownika w wierszu listy testów, nullable, zwykły tekst
-- (jak SKU w Trade-in); nie jest wymagany do żadnego statusu.
alter table test_log add column if not exists sku text;
-- ON DELETE SET NULL (30.09.2026) — patrz wyjaśnienie w schema.sql (members.user_id) i service.sql; employee_email
-- jest już zapisany osobno, więc "kto to zrobił" zostaje widoczne mimo zerwania linku do konta.
alter table test_log alter column employee_user_id drop not null;
alter table test_log drop constraint if exists test_log_employee_user_id_fkey;
alter table test_log add constraint test_log_employee_user_id_fkey foreign key (employee_user_id) references auth.users(id) on delete set null;

-- To samo urządzenie nie może mieć DWÓCH TRWAJĄCYCH testów naraz (duplikat przez pomyłkę/skan
-- dwóch osób na raz) — ale PO zakończeniu testu ("przetestowane") urządzenie MOŻE trafić na
-- kolejny test ponownie: zgłoszone przez właściciela 01.10.2026 (ten sam dzień co "Rodzaj testu"
-- wyżej) jako realny scenariusz biznesowy wprost nazwany w TEST_KINDS — po serwisie, ponowny test
-- z magazynu, przed wystawieniem na OLX/Allegro/Vinted, to wszystko testy urządzenia, które już
-- wcześniej miało status "przetestowane". Pierwotna wersja (do 01.10.2026) blokowała też ponowny
-- test po "przetestowane" — błędne założenie z Regulaminu §2 ust. 3/§9 ust. 2 ("wielokrotne
-- rejestrowanie to manipulowanie wynikiem"), które miało sens dla ZDUBLOWANEGO zaliczenia TEGO
-- SAMEGO przebiegu testu, nie dla kolejnego, osobnego testu w innym momencie — każdy taki test to
-- osobna, prawdziwie wykonana praca i osobne punkty. Test "przerwany" nigdy nie blokował ponownego
-- podejścia, to się nie zmienia.
drop index if exists test_log_serial_active_uq;
create unique index if not exists test_log_serial_active_uq
  on test_log (serial_number) where status = 'w_trakcie';

create index if not exists test_log_employee_idx on test_log (employee_user_id, started_at desc);
create index if not exists test_log_started_idx on test_log (started_at desc);
create index if not exists test_log_finished_idx on test_log (finished_at desc);


-- Punktacja naliczana TYLKO RAZ (05.10.2026, tak jak w Trade-in — patrz buyback-orders.sql): `points_awarded_at` = chwila PIERWSZEGO wejścia w status
-- "przetestowane", ustawiana wyłącznie triggerem (zegar serwera). Zmiana statusu tam i z powrotem (np. przetestowane -> inny -> przetestowane) nie przesuwa
-- punktów do nowego dnia/miesiąca; podsumowanie Dziś/7/30 dni liczy po tej dacie, nie po finished_at (które UI ustawia przy każdej zmianie statusu).
-- Zalogowani nie zmieniają tej daty (SQL Editor/serwer mogą — np. backfill poniżej).
alter table test_log add column if not exists points_awarded_at timestamptz;
update test_log set points_awarded_at = finished_at where points_awarded_at is null and finished_at is not null and status = 'przetestowane';
create index if not exists test_log_awarded_idx on test_log (points_awarded_at desc);

create or replace function test_log_points_once() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.points_awarded_at := case when new.status = 'przetestowane' then now() else null end;
  else
    if auth.role() = 'authenticated' then
      new.points_awarded_at := old.points_awarded_at;
    end if;
    if new.points_awarded_at is null and new.status = 'przetestowane' then
      new.points_awarded_at := now();
    end if;
  end if;
  return new;
end $$;
drop trigger if exists test_log_points_once on test_log;
create trigger test_log_points_once before insert or update on test_log
  for each row execute function test_log_points_once();

alter table test_log enable row level security;

drop policy if exists "authenticated read test_log" on test_log;
create policy "authenticated read test_log" on test_log
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated insert test_log" on test_log;
create policy "authenticated insert test_log" on test_log
  for insert with check (auth.role() = 'authenticated');
-- Update dozwolony tylko po to, żeby dało się zmieniać status/finished_at (postęp testu) —
-- liczba punktów za urządzenie jest stała i nie do zmiany przez UI (Regulamin §9).
drop policy if exists "authenticated update test_log" on test_log;
create policy "authenticated update test_log" on test_log
  for update using (auth.role() = 'authenticated');

-- Usuwanie wpisów Testów: tylko Admin (is_admin() z schema.sql — uruchom ten plik najpierw), a każde
-- usunięcie ląduje w deleted_records (kto, kiedy, cały wiersz). Polityka to twarde zabezpieczenie:
-- działa też przy bezpośrednim wywołaniu API, nie tylko gdy przycisk jest ukryty w UI.
drop policy if exists "admin delete test_log" on test_log;
create policy "admin delete test_log" on test_log
  for delete using (is_admin());
drop trigger if exists test_log_audit_delete on test_log;
create trigger test_log_audit_delete before delete on test_log
  for each row execute function audit_delete();

do $$
begin
  begin alter publication supabase_realtime add table test_log; exception when duplicate_object then null; end;
end $$;
