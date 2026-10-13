-- Magazyn ERP — RCP: Kierownik serwisu widzi wnioski urlopowe serwisantów (13.10.2026). LEKKA paczka (tylko funkcja i dwie polityki odczytu), ta sama treść co w rcp.sql —
-- do uruchomienia zamiast całego rcp.sql, żeby nie dotykać tabeli odcinków czasu pracy, na której cały czas ktoś zapisuje. Można uruchomić wielokrotnie.
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Wymaga wcześniejszego rcp.sql (tabele rcp_absences, rcp_leave_balances, funkcja rcp_is_manager).
set lock_timeout = '5s';

create or replace function rcp_service_lead_sees(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role = 'Kierownik serwisu')
     and exists (select 1 from members where user_id = target and role = 'Serwis');
$$;

alter policy "own or manager read rcp_absences" on rcp_absences using (user_id = auth.uid() or rcp_is_manager() or rcp_service_lead_sees(user_id));
alter policy "own or manager read rcp_leave_balances" on rcp_leave_balances using (user_id = auth.uid() or rcp_is_manager() or rcp_service_lead_sees(user_id));
