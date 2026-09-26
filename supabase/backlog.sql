-- Magazyn ERP — zakładka Backlog (zadania i pomysły zespołu)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów. Wymaga wcześniej uruchomionego schema.sql (is_admin(), audit_delete()).
--
-- Jedno zadanie = jeden wiersz: tytuł, typ, priorytet, status, obszar (moduł), opis, kryteria akceptacji, osoba,
-- kto i kiedy dodał, log zmian (history). Dodawać i edytować może każdy zalogowany (zespół pracuje razem);
-- usuwać tylko Admin, a usunięcie ląduje w deleted_records (tak jak w Serwisie, Testach i Trade-in).

create table if not exists backlog_items (
  id bigint generated always as identity primary key,
  title text not null check (length(btrim(title)) > 0),
  type text not null default 'task' check (type in ('feature', 'improvement', 'bug', 'task')),
  priority text not null default 'p2' check (priority in ('p1', 'p2', 'p3')),          -- p1 najpilniejszy
  status text not null default 'backlog' check (status in ('backlog', 'todo', 'in_progress', 'review', 'done')),
  area text,                                   -- moduł, którego dotyczy (lista w lib/backlog.ts, bez ograniczenia w bazie)
  description text not null default '',
  acceptance text not null default '',         -- kryteria akceptacji: po czym poznamy, że zrobione
  assignee_email text,                         -- kto ma to zrobić (opcjonalnie)
  created_by_user_id uuid references auth.users(id),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz,                         -- ustawiane automatycznie przy przejściu na "done"
  history jsonb not null default '[]'::jsonb   -- [{action: "created"|"edited", by_email, at, changes?: [{field, from, to}]}]
);
create index if not exists backlog_items_status_idx on backlog_items (status, priority);
create index if not exists backlog_items_created_idx on backlog_items (created_at desc);

alter table backlog_items enable row level security;

drop policy if exists "authenticated read backlog_items" on backlog_items;
create policy "authenticated read backlog_items" on backlog_items
  for select using (auth.role() = 'authenticated');
-- Wpisać można tylko siebie jako autora (nie da się dodać zadania "w imieniu" kogoś innego).
drop policy if exists "authenticated insert backlog_items" on backlog_items;
create policy "authenticated insert backlog_items" on backlog_items
  for insert with check (auth.role() = 'authenticated' and created_by_user_id = auth.uid());
drop policy if exists "authenticated update backlog_items" on backlog_items;
create policy "authenticated update backlog_items" on backlog_items
  for update using (auth.role() = 'authenticated');
drop policy if exists "admin delete backlog_items" on backlog_items;
create policy "admin delete backlog_items" on backlog_items
  for delete using (is_admin());
drop trigger if exists backlog_items_audit_delete on backlog_items;
create trigger backlog_items_audit_delete before delete on backlog_items
  for each row execute function audit_delete();

-- Autora i datę dodania zmienić się nie da; updated_at i done_at ustawia baza (nie przeglądarka).
create or replace function backlog_items_touch() returns trigger
language plpgsql as $$
begin
  if new.created_by_user_id is distinct from old.created_by_user_id
     or new.created_by_email is distinct from old.created_by_email
     or new.created_at is distinct from old.created_at then
    raise exception 'Autora i daty dodania zadania nie można zmienić.' using errcode = '42501';
  end if;
  new.updated_at := now();
  if new.status = 'done' and old.status <> 'done' then
    new.done_at := now();
  elsif new.status <> 'done' then
    new.done_at := null;
  end if;
  return new;
end $$;
drop trigger if exists backlog_items_touch on backlog_items;
create trigger backlog_items_touch before update on backlog_items
  for each row execute function backlog_items_touch();

-- Zmiana wybranych pól zadania razem z wpisem do logu w JEDNEJ transakcji; wpis dopisuje baza, więc równoczesne
-- edycje dwóch osób nie nadpisują sobie nawzajem logu. p_patch zawiera tylko zmieniane pola (obecność klucza = zmiana,
-- także na null/pusty, np. odebranie osoby). Działa z uprawnieniami wywołującego (obowiązują polityki i triggery).
create or replace function backlog_apply(p_id bigint, p_patch jsonb, p_entry jsonb) returns void
language plpgsql as $$
begin
  update backlog_items set
    title          = case when p_patch ? 'title'          then p_patch->>'title'          else title end,
    type           = case when p_patch ? 'type'           then p_patch->>'type'           else type end,
    priority       = case when p_patch ? 'priority'       then p_patch->>'priority'       else priority end,
    status         = case when p_patch ? 'status'         then p_patch->>'status'         else status end,
    area           = case when p_patch ? 'area'           then nullif(p_patch->>'area', '')           else area end,
    description    = case when p_patch ? 'description'    then coalesce(p_patch->>'description', '')  else description end,
    acceptance     = case when p_patch ? 'acceptance'     then coalesce(p_patch->>'acceptance', '')   else acceptance end,
    assignee_email = case when p_patch ? 'assignee_email' then nullif(p_patch->>'assignee_email', '') else assignee_email end,
    history        = history || jsonb_build_array(p_entry)
  where id = p_id;
  if not found then
    raise exception 'Nie ma takiego zadania.';
  end if;
end $$;

-- Załączniki (zrzuty ekranu, PDF-y itp.). Pliki leżą w PRYWATNYM bucketcie Supabase Storage (bez publicznych linków —
-- aplikacja pokazuje je przez krótkotrwałe, podpisane adresy), a metadane w tabeli backlog_attachments.
-- Limity pilnuje też sam bucket: do 10 MB na plik i tylko wymienione typy (obrazy, PDF, tekst, CSV, dokumenty Office).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'backlog-attachments', 'backlog-attachments', false, 10485760,
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create table if not exists backlog_attachments (
  id bigint generated always as identity primary key,
  item_id bigint not null references backlog_items(id) on delete cascade,
  path text not null unique,                   -- ścieżka pliku w bucketcie: <id zadania>/<uuid>-<nazwa>
  filename text not null,                      -- oryginalna nazwa do wyświetlenia
  mime_type text,
  size_bytes bigint,
  uploaded_by_user_id uuid references auth.users(id),
  uploaded_by_email text,
  created_at timestamptz not null default now()
);
create index if not exists backlog_attachments_item_idx on backlog_attachments (item_id);
alter table backlog_attachments enable row level security;

drop policy if exists "authenticated read backlog_attachments" on backlog_attachments;
create policy "authenticated read backlog_attachments" on backlog_attachments
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated insert backlog_attachments" on backlog_attachments;
create policy "authenticated insert backlog_attachments" on backlog_attachments
  for insert with check (auth.role() = 'authenticated' and uploaded_by_user_id = auth.uid());
-- Załącznik usuwa jego autor albo Admin. Nie ma UPDATE — plik zastępuje się nowym.
drop policy if exists "uploader or admin delete backlog_attachments" on backlog_attachments;
create policy "uploader or admin delete backlog_attachments" on backlog_attachments
  for delete using (uploaded_by_user_id = auth.uid() or is_admin());

-- Dostęp do samych plików w Storage: czytać i wgrywać może każdy zalogowany; usunąć plik może Admin albo ten, kto go wgrał
-- (sprawdzamy to po wierszu w backlog_attachments, dlatego aplikacja usuwa NAJPIERW plik, a potem wiersz).
drop policy if exists "backlog attachments read" on storage.objects;
create policy "backlog attachments read" on storage.objects
  for select to authenticated using (bucket_id = 'backlog-attachments');
drop policy if exists "backlog attachments upload" on storage.objects;
create policy "backlog attachments upload" on storage.objects
  for insert to authenticated with check (bucket_id = 'backlog-attachments');
drop policy if exists "backlog attachments delete" on storage.objects;
create policy "backlog attachments delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'backlog-attachments'
    and (is_admin() or exists (
      select 1 from backlog_attachments a where a.path = storage.objects.name and a.uploaded_by_user_id = auth.uid()
    ))
  );

do $$
begin
  begin alter publication supabase_realtime add table backlog_items; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table backlog_attachments; exception when duplicate_object then null; end;
end $$;
