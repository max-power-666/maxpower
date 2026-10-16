-- Magazyn ERP — RCP: Kierownik serwisu widzi w "Teraz w pracy" serwisantów (16.10.2026). LEKKA paczka (funkcja + zmiana polityki odczytu), ta sama treść co na końcu rcp.sql.
-- Tylko odcinki otwarte albo z ostatnich 2 dni — nie pełna ewidencja. Można uruchomić wielokrotnie.
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Wymaga wcześniejszego rcp-service-lead.sql (funkcja rcp_service_lead_sees) albo pełnego rcp.sql.
set lock_timeout = '5s';

create or replace function rcp_service_lead_sees_segment(target uuid, started timestamptz, ended timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select rcp_service_lead_sees(target) and (ended is null or started >= now() - interval '2 days');
$$;

alter policy "own or manager read rcp_segments" on rcp_segments using (user_id = auth.uid() or rcp_is_manager() or rcp_service_lead_sees_segment(user_id, started_at, ended_at));
