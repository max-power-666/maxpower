-- Magazyn ERP — RCP (rejestracja czasu pracy), etap 1 (06.10.2026).
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Można uruchomić ponownie. Wymaga schema.sql (members, is_admin, audit_delete).
--
-- Model: czas pracy to ODCINKI (rcp_segments): praca / przerwa / wyjście prywatne / wyjście służbowe, każdy z początkiem i końcem. Pracownik ma najwyżej JEDEN
-- otwarty odcinek (ended_at is null) — indeks częściowy. Praca i wyjście służbowe liczą się do czasu pracy, przerwa i wyjście prywatne nie. Odcinek "praca" niesie obszar
-- (Serwis / Testy / Trade-in / Magazyn / Zamówienia / Inne), co pozwoli później liczyć punkty na godzinę pracy w danym obszarze.
-- Zapisuje WYŁĄCZNIE serwer (service_role): rejestracja przez funkcję rcp_act (atomowo, z blokadą na pracownika) po sprawdzeniu adresu IP komputera, korekty przez route
-- rcp/edit (Admin/Manager, z uzasadnieniem w history). Odczyt: pracownik widzi tylko swoje odcinki, Admin i Manager wszystkie.

-- Admin albo Manager (NIE rola Zamówienia — is_admin_or_manager() z shipping.sql ma historycznie szerszy zakres).
create or replace function rcp_is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager'));
$$;

-- Ustawienia (jeden wiersz): adresy IP komputerów w firmie, z których wolno rejestrować czas. Pusta lista = bez ograniczenia (żeby nikt nie został zablokowany,
-- zanim Admin ustawi adresy). Zmienia tylko Admin (przez route rcp/settings).
create table if not exists rcp_settings (
  id int primary key default 1 check (id = 1),
  allowed_ips text[] not null default '{}',
  updated_at timestamptz,
  updated_by_email text
);
insert into rcp_settings (id) values (1) on conflict (id) do nothing;

create table if not exists rcp_segments (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  user_email text not null,
  kind text not null check (kind in ('praca', 'przerwa', 'wyjscie_prywatne', 'wyjscie_sluzbowe')),
  area text,                                   -- obszar pracy (dla przerwy/wyjścia: obszar, do którego pracownik wraca)
  started_at timestamptz not null default now(),
  ended_at timestamptz,                        -- null = trwa
  ip text,                                     -- adres, z którego zarejestrowano początek odcinka
  needs_review boolean not null default false, -- zamknięty automatycznie (nie kliknięto "Zakończ") albo wymaga sprawdzenia przez Managera
  source text not null default 'app' check (source in ('app', 'manual')),
  note text,
  history jsonb not null default '[]'::jsonb,  -- korekty: [{at, by_email, reason, changes:[{field, from, to}]}]
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create unique index if not exists rcp_segments_one_open on rcp_segments (user_id) where ended_at is null;
create index if not exists rcp_segments_user_started_idx on rcp_segments (user_id, started_at desc);
create index if not exists rcp_segments_started_idx on rcp_segments (started_at desc);

alter table rcp_settings enable row level security;
alter table rcp_segments enable row level security;

drop policy if exists "manager read rcp_settings" on rcp_settings;
create policy "manager read rcp_settings" on rcp_settings for select using (rcp_is_manager());

drop policy if exists "own or manager read rcp_segments" on rcp_segments;
create policy "own or manager read rcp_segments" on rcp_segments for select using (user_id = auth.uid() or rcp_is_manager());
-- Brak polityk insert/update: zapisuje serwer. Usuwanie wpisu tylko Admin, z zapisem w deleted_records.
drop policy if exists "admin delete rcp_segments" on rcp_segments;
create policy "admin delete rcp_segments" on rcp_segments for delete using (is_admin());
drop trigger if exists rcp_segments_audit_delete on rcp_segments;
create trigger rcp_segments_audit_delete before delete on rcp_segments
  for each row execute function audit_delete();

-- Zaległe odcinki (pracownik nie kliknął "Zakończ"): trwają od POPRZEDNIEGO dnia (wg czasu polskiego) ORAZ dłużej niż 10 godzin. Zamykamy je o 23:59:59 dnia rozpoczęcia i oznaczamy
-- do sprawdzenia przez Managera. Warunek wieku (06.10.2026) chroni pracę, która legalnie przechodzi przez północ (np. 23:20–01:30) — wcześniejsza wersja zamykała
-- każdy odcinek rozpoczęty "wczoraj" zaraz po północy, więc pracownik pracujący po 00:00 nie mógł zakończyć ani przerwać pracy ("Nie masz rozpoczętej pracy").
-- p_user = null: wszyscy (cron). Zwraca liczbę zamkniętych.
create or replace function rcp_close_stale(p_user uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update rcp_segments s
     set ended_at = least(now(), ((date_trunc('day', s.started_at at time zone 'Europe/Warsaw') + interval '1 day') at time zone 'Europe/Warsaw') - interval '1 second'),
         needs_review = true,
         history = s.history || jsonb_build_array(jsonb_build_object('at', now(), 'by_email', null, 'reason', 'Zamknięto automatycznie — nie zarejestrowano zakończenia pracy', 'changes', '[]'::jsonb))
   where s.ended_at is null
     and (p_user is null or s.user_id = p_user)
     and s.started_at < (date_trunc('day', now() at time zone 'Europe/Warsaw') at time zone 'Europe/Warsaw')
     and s.started_at < now() - interval '10 hours';
  get diagnostics n = row_count;
  return n;
end $$;

-- Rejestracja: start | break | resume | leave | change_area | end. Atomowo (blokada na pracownika), zegar serwera. Błędy biznesowe to wyjątki P0001 z polskim komunikatem.
create or replace function rcp_act(p_user uuid, p_email text, p_action text, p_area text, p_leave text, p_ip text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cur rcp_segments%rowtype;
  t timestamptz := now();
  area text := nullif(btrim(coalesce(p_area, '')), '');
  res rcp_segments%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('rcp:' || p_user::text));
  perform rcp_close_stale(p_user);
  select * into cur from rcp_segments where user_id = p_user and ended_at is null;

  if p_action = 'start' then
    if found then raise exception 'Praca jest już rozpoczęta.' using errcode = 'P0001'; end if;
    if area is null then raise exception 'Wybierz obszar pracy.' using errcode = 'P0001'; end if;
    insert into rcp_segments (user_id, user_email, kind, area, started_at, ip) values (p_user, p_email, 'praca', area, t, p_ip) returning * into res;
  elsif p_action = 'end' then
    if not found then raise exception 'Nie masz rozpoczętej pracy.' using errcode = 'P0001'; end if;
    update rcp_segments set ended_at = t where id = cur.id;
    return null;
  elsif not found then
    raise exception 'Najpierw rozpocznij pracę.' using errcode = 'P0001';
  elsif p_action = 'break' then
    if cur.kind <> 'praca' then raise exception 'Przerwę można zacząć tylko w trakcie pracy.' using errcode = 'P0001'; end if;
    update rcp_segments set ended_at = t where id = cur.id;
    insert into rcp_segments (user_id, user_email, kind, area, started_at, ip) values (p_user, p_email, 'przerwa', cur.area, t, p_ip) returning * into res;
  elsif p_action = 'leave' then
    if cur.kind <> 'praca' then raise exception 'Wyjście można zarejestrować tylko w trakcie pracy.' using errcode = 'P0001'; end if;
    if p_leave not in ('prywatne', 'sluzbowe') then raise exception 'Wybierz rodzaj wyjścia.' using errcode = 'P0001'; end if;
    update rcp_segments set ended_at = t where id = cur.id;
    insert into rcp_segments (user_id, user_email, kind, area, started_at, ip) values (p_user, p_email, 'wyjscie_' || p_leave, cur.area, t, p_ip) returning * into res;
  elsif p_action = 'resume' then
    if cur.kind = 'praca' then raise exception 'Już pracujesz.' using errcode = 'P0001'; end if;
    update rcp_segments set ended_at = t where id = cur.id;
    insert into rcp_segments (user_id, user_email, kind, area, started_at, ip) values (p_user, p_email, 'praca', cur.area, t, p_ip) returning * into res;
  elsif p_action = 'change_area' then
    if cur.kind <> 'praca' then raise exception 'Obszar można zmienić tylko w trakcie pracy.' using errcode = 'P0001'; end if;
    if area is null then raise exception 'Wybierz obszar pracy.' using errcode = 'P0001'; end if;
    if area = cur.area then raise exception 'To już jest Twój obecny obszar.' using errcode = 'P0001'; end if;
    update rcp_segments set ended_at = t where id = cur.id;
    insert into rcp_segments (user_id, user_email, kind, area, started_at, ip) values (p_user, p_email, 'praca', area, t, p_ip) returning * into res;
  else
    raise exception 'Nieznana akcja.' using errcode = 'P0001';
  end if;
  return to_jsonb(res);
end $$;

revoke all on function rcp_act(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function rcp_close_stale(uuid) from public, anon, authenticated;
grant execute on function rcp_act(uuid, text, text, text, text, text) to service_role;
grant execute on function rcp_close_stale(uuid) to service_role;

-- ---- Nieobecności i wnioski urlopowe (07.10.2026) ----
-- rcp_absences: wniosek/wpis nieobecności na dni kalendarzowe [date_from, date_to]; workdays = dni robocze (pn–pt poza świętami, liczone przez serwer, lib/holidays.ts).
-- Pracownik składa wniosek (status 'oczekuje'), Manager/Admin akceptuje lub odrzuca; Manager/Admin może też wpisać nieobecność za kogoś (od razu 'zaakceptowany', np. L4).
-- Zapisuje WYŁĄCZNIE serwer (route rcp/absence): tabela nie ma polityk zapisu. Odczyt: pracownik swoje, Admin i Manager wszystkie. Usuwanie tylko Admin (audit_delete).
create table if not exists rcp_absences (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  user_email text not null,
  kind text not null check (kind in ('urlop_wypoczynkowy', 'urlop_na_zadanie', 'urlop_okolicznosciowy', 'urlop_bezplatny', 'l4', 'inne')),
  date_from date not null,
  date_to date not null,
  workdays int not null check (workdays >= 1),
  note text,
  status text not null default 'oczekuje' check (status in ('oczekuje', 'zaakceptowany', 'odrzucony', 'wycofany', 'anulowany')),
  decided_by_email text,
  decided_at timestamptz,
  decision_note text,
  created_by_email text,
  created_at timestamptz not null default now(),
  history jsonb not null default '[]'::jsonb,
  check (date_to >= date_from)
);
create index if not exists rcp_absences_user_idx on rcp_absences (user_id, date_from desc);
create index if not exists rcp_absences_status_idx on rcp_absences (status, date_from);

-- Dwa aktywne (oczekujące/zaakceptowane) wnioski tej samej osoby nie mogą się nakładać — pilnuje też baza (serwer sprawdza wcześniej i daje czytelny komunikat).
create or replace function rcp_absences_no_overlap() returns trigger
language plpgsql as $$
begin
  if new.status in ('oczekuje', 'zaakceptowany') and exists (
    select 1 from rcp_absences o
     where o.user_id = new.user_id and o.id <> coalesce(new.id, -1) and o.status in ('oczekuje', 'zaakceptowany')
       and o.date_from <= new.date_to and new.date_from <= o.date_to
  ) then
    raise exception 'Ta osoba ma już nieobecność w tym terminie.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists rcp_absences_no_overlap on rcp_absences;
create trigger rcp_absences_no_overlap before insert or update of user_id, date_from, date_to, status on rcp_absences
  for each row execute function rcp_absences_no_overlap();

-- Roczny limit urlopowy per osoba (dni robocze) — ustawia Admin (tabela edytowalna wprost, polityki is_admin()); brak wiersza = limit nieustawiony (bez kontroli).
create table if not exists rcp_leave_balances (
  user_id uuid not null references auth.users(id) on delete cascade,
  year int not null,
  days_total numeric not null check (days_total >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, year)
);

alter table rcp_absences enable row level security;
alter table rcp_leave_balances enable row level security;

drop policy if exists "own or manager read rcp_absences" on rcp_absences;
create policy "own or manager read rcp_absences" on rcp_absences for select using (user_id = auth.uid() or rcp_is_manager());
drop policy if exists "admin delete rcp_absences" on rcp_absences;
create policy "admin delete rcp_absences" on rcp_absences for delete using (is_admin());
drop trigger if exists rcp_absences_audit_delete on rcp_absences;
create trigger rcp_absences_audit_delete before delete on rcp_absences
  for each row execute function audit_delete();

drop policy if exists "own or manager read rcp_leave_balances" on rcp_leave_balances;
create policy "own or manager read rcp_leave_balances" on rcp_leave_balances for select using (user_id = auth.uid() or rcp_is_manager());
drop policy if exists "admin write rcp_leave_balances" on rcp_leave_balances;
create policy "admin write rcp_leave_balances" on rcp_leave_balances for all using (is_admin()) with check (is_admin());
