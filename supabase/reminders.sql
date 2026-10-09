-- Magazyn ERP — zakładka "Przypomnienia" (09.10.2026): ważne komunikaty i zadania cykliczne widoczne na górze strony, dopóki nie zostaną oznaczone jako zrobione.
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Można uruchomić ponownie. Wymaga schema.sql (is_admin, audit_delete).
--
-- Na razie TYLKO Admin (RLS: is_admin() na wszystko — odczyt i zapis). Przypomnienie jest "aktywne" (baner na górze), gdy done_at jest puste i due_date <= dziś (czas polski).
-- Jednorazowe: "Zrobione" ustawia done_at. Cykliczne (codziennie / co tydzień / co miesiąc / co rok): "Zrobione" przesuwa due_date na NASTĘPNE wystąpienie po dziś
-- (liczy aplikacja, lib/reminders.ts), więc baner wraca dopiero wtedy.

create table if not exists reminders (
  id bigint generated always as identity primary key,
  message text not null check (length(btrim(message)) > 0 and length(message) <= 1000),
  due_date date not null default ((now() at time zone 'Europe/Warsaw')::date),    -- od kiedy baner jest widoczny (i, dla cyklicznych, kolejny termin)
  recurrence text not null default 'none' check (recurrence in ('none', 'daily', 'weekly', 'monthly', 'yearly')),
  anchor_day int,                                -- dzień miesiąca terminu pierwotnego (dla "co miesiąc/rok" — żeby 31-go nie "zjeżdżał" po miesiącach z mniejszą liczbą dni)
  done_at timestamptz,                           -- tylko jednorazowe: kiedy oznaczono jako zrobione
  last_done_at timestamptz,                      -- cykliczne i jednorazowe: ostatnie "Zrobione"
  last_done_by_email text,
  done_count int not null default 0,
  created_by_email text,
  created_at timestamptz not null default now()
);
create index if not exists reminders_active_idx on reminders (done_at, due_date);

alter table reminders enable row level security;
drop policy if exists "admin all reminders" on reminders;
create policy "admin all reminders" on reminders for all using (is_admin()) with check (is_admin());
drop trigger if exists reminders_audit_delete on reminders;
create trigger reminders_audit_delete before delete on reminders
  for each row execute function audit_delete();

do $$
begin
  begin alter publication supabase_realtime add table reminders; exception when duplicate_object then null; end;
end $$;
