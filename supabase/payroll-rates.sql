-- Magazyn ERP — Zespół: stawki godzinowe i premie wg płac (20.10.2026, na prośbę właściciela).
-- Tabela payroll_rates: jeden wiersz = osoba x okres rozliczeniowy (na razie umowy zlecenie, płace za wrzesień 2026, wypłata 10.10.2026).
-- Dostęp (odczyt) tylko Admin, Manager i Księgowa — RLS; zapis wyłącznie przez SQL Editor / serwer (brak polityk zapisu).
-- Koszt godziny dla firmy (używa go Marża -> Koszty pracy) = (kwota z umowy + składki pracodawcy) / godziny.
-- Stawka godzinowa = (kwota z umowy − premia) / godziny; premia na godzinę = premia / godziny; razem na godzinę = kwota z umowy / godziny (liczy aplikacja).
-- Dane (wypłaty i premie z imienia i nazwiska) są w osobnym pliku payroll-rates-data.sql — poza repozytorium (dane osobowe).
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Można uruchomić ponownie (dane z tego pliku są nadpisywane).
set lock_timeout = '5s';

create or replace function payroll_can_read() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Księgowa'));
$$;

create table if not exists payroll_rates (
  id bigint generated always as identity primary key,
  period text not null,                 -- 'YYYY-MM' — miesiąc, za który są płace
  person_name text not null,            -- jak w Zespół (members.name)
  contract text not null default 'UZ',  -- UZ = umowa zlecenie, UO = umowa o pracę
  hours numeric(8,2) not null check (hours > 0),
  payout numeric(12,2) not null,        -- kwota z umowy (brutto, "Kwota na umowie" z rachunku); do 26. r.ż. bez składek = wypłata
  bonus numeric(12,2) not null default 0,
  employer_costs numeric(12,2) not null default 0,  -- składki pracodawcy (ZUS, FP, FGŚP); 0 przy zleceniu do 26. r.ż.
  note text,
  unique (period, person_name)
);

alter table payroll_rates add column if not exists employer_costs numeric(12,2) not null default 0;
alter table payroll_rates enable row level security;
drop policy if exists "payroll read" on payroll_rates;
create policy "payroll read" on payroll_rates for select using (payroll_can_read());
