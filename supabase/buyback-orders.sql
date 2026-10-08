-- Magazyn ERP — moduł Trade-in (zamówienia BuyBack z Back Market)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów (wszystko jest "if not exists" / "or replace").
--
-- Osobne od buyback_* w tradein.sql (to jest bidder cen) — tu trzymamy same zamówienia
-- BuyBack pobierane z GET /ws/buyback/v1/orders (patrz app/api/tradein/orders-sync/route.ts).

create table if not exists buyback_orders (
  order_public_id text primary key,          -- np. "US-24527-ABCDE"
  status text not null,                      -- NEW | PENDING | TO_SEND | SENT | RECEIVED |
                                              -- COUNTER_PROPOSAL | VALIDATED | PAID | MONEY_TRANSFERED | SUSPENDED
  market text,
  creation_date timestamptz not null,
  modification_date timestamptz not null,
  shipping_date timestamptz,
  suspension_date timestamptz,
  receival_date timestamptz,
  payment_date timestamptz,
  counter_proposal_date timestamptz,
  sku text,
  product_id bigint,
  product_title text,
  grade text,                                -- DIAMOND | PLATINUM | GOLD | SILVER | BRONZE | STALLONE
  customer_first_name text,
  customer_last_name text,
  customer_phone text,
  return_address jsonb,
  original_price numeric,
  original_price_currency text,
  counter_offer_price numeric,
  counter_offer_price_currency text,
  tracking_number text,
  shipper text,
  transfer_certificate_link text,
  suspend_reasons jsonb,
  counter_offer_reasons jsonb,
  raw jsonb not null,                        -- pełna odpowiedź API — bufor na pola, których jeszcze nie wyciągnęliśmy do kolumn
  synced_at timestamptz not null default now()
);
create index if not exists buyback_orders_status_idx on buyback_orders (status);
create index if not exists buyback_orders_modification_idx on buyback_orders (modification_date desc);
create index if not exists buyback_orders_creation_idx on buyback_orders (creation_date desc);

-- Jeden wiersz: od kiedy liczyć kolejną synchronizację przyrostową (parametr modificationDate API)
-- full_scan_done = false: następne wywołanie robi pełny skan od 1 stycznia (w porcjach, z kursorem
-- scan_page); dopiero po jego ukończeniu przechodzimy na przyrostowe (last_synced_at). scan_started_at
-- to data startu trwającego skanu — od niej liczymy pierwszą synchronizację przyrostową.
-- Dla istniejącej bazy kolumna full_scan_done dostaje false, więc pierwszy przebieg po wdrożeniu
-- uzupełni zamówienia, które wcześniej urwał limit 200 stron (patrz lib/scanOrders.ts).
create table if not exists buyback_orders_sync_meta (
  id int primary key default 1,
  last_synced_at timestamptz,
  full_scan_done boolean not null default false,
  scan_page int not null default 1,
  scan_started_at timestamptz,
  constraint buyback_orders_sync_meta_singleton check (id = 1)
);
alter table buyback_orders_sync_meta add column if not exists full_scan_done boolean not null default false;
alter table buyback_orders_sync_meta add column if not exists scan_page int not null default 1;
alter table buyback_orders_sync_meta add column if not exists scan_started_at timestamptz;
insert into buyback_orders_sync_meta (id) values (1) on conflict (id) do nothing;

alter table buyback_orders enable row level security;
alter table buyback_orders_sync_meta enable row level security;

-- Tylko odczyt dla zespołu — zapisuje wyłącznie serwer (service_role, poza RLS),
-- tak samo jak fakturownia_stock_cache.
drop policy if exists "authenticated read buyback_orders" on buyback_orders;
create policy "authenticated read buyback_orders" on buyback_orders
  for select using (auth.role() = 'authenticated');

drop policy if exists "authenticated read buyback_orders_sync_meta" on buyback_orders_sync_meta;
create policy "authenticated read buyback_orders_sync_meta" on buyback_orders_sync_meta
  for select using (auth.role() = 'authenticated');

-- Obsługa paczek Trade-in przez pracowników (Regulamin premiowania z 12.10.2026, §2).
-- Pracownik podaje numer zamówienia LUB numer przesyłki — aplikacja znajduje zamówienie
-- w buyback_orders (stąd klucz obcy) i zakłada rekord ze statusem "w_trakcie".
--
-- Jeden wiersz = jedna paczka = jedna karta (unique na order_public_id). To zarazem
-- pilnuje Regulaminu §2 ust. 3 i §9 ust. 2: ta sama paczka nie może być zaliczona dwa razy.
-- entered_at = początek obsługi; finished_at ustawia się przy przejściu na status końcowy.
-- "Czas" (finished_at - entered_at) jest tylko informacyjny. Punkty do podsumowania liczą się
-- dla status w ('obsluzona', 'kontroferta', 'ok_dok', 'problem') — pierwotnie (§2 ust. 4: po prawidłowym
-- zakończeniu procesu) tylko 'obsluzona'; rozszerzenie to świadoma decyzja właściciela (30.09.2026),
-- nie literalny zapis regulaminu.
create table if not exists buyback_order_intake (
  id bigint generated always as identity primary key,
  order_public_id text not null references buyback_orders(order_public_id),
  serial_number text,                        -- wymagane do statusu "obsluzona"/"kontroferta"/"ok_dok" (trigger poniżej)
  sku text,                                  -- wymagane do statusu "obsluzona"/"kontroferta"/"ok_dok" (trigger poniżej)
  pads int check (pads is null or pads >= 0), -- liczba padów w zestawie (konsole); wymagane do "obsluzona"/"kontroferta"/"ok_dok", 0 jest dozwolone
  pad_serials text[],                        -- numery seryjne padów: element i = pad i+1 (osobne pole na każdy pad, skanery)
  docs boolean not null default false,       -- kolumna "dok." (checkbox)
  notes text default '',
  entered_by_user_id uuid references auth.users(id) on delete set null,
  entered_by_email text,
  entered_at timestamptz not null default now(),
  history jsonb not null default '[]'::jsonb,  -- [{action: "created"|"edited", by_email, at, changes?}, ...]
  status text not null default 'w_trakcie',    -- w_trakcie | obsluzona | kontroferta | ok_dok | problem | zwrocona
  finished_at timestamptz,
  -- Migawka punktów za paczkę: 100/6 (Regulamin §2 tabela). Celowo bez zaokrąglania (§2 ust. 7,
  -- §4 ust. 8) — zaokrąglamy dopiero przy wyświetlaniu. Gdyby stawka się zmieniła, zmieniamy
  -- default; stare wiersze zachowują swoją wartość.
  points numeric not null default (100.0 / 6.0)
);

-- Migracja z poprzedniej wersji (serial_number/sku wymagane, brak statusu) — bezpieczna do
-- wielokrotnego uruchomienia.
alter table buyback_order_intake alter column serial_number drop not null;
alter table buyback_order_intake alter column sku drop not null;
alter table buyback_order_intake add column if not exists status text not null default 'w_trakcie';
alter table buyback_order_intake add column if not exists finished_at timestamptz;
alter table buyback_order_intake add column if not exists points numeric not null default (100.0 / 6.0);
alter table buyback_order_intake add column if not exists pads int;
-- Regulamin zaktualizowany 01.10.2026: "Trade-In - paczka" to teraz 17 pkt flat (tabela §2 ust. 6),
-- nie ułamek 100/6 (≈16,67) jak w poprzedniej wersji regulaminu. Zmieniamy tylko default dla
-- NOWYCH wpisów — stare paczki zachowują swoją migawkę 100/6, migawka nie zmienia się wstecz.
alter table buyback_order_intake alter column points set default 17;
-- ON DELETE SET NULL (30.09.2026) — patrz wyjaśnienie w schema.sql (members.user_id); entered_by_email jest już
-- zapisany osobno, więc "kto to zrobił" zostaje widoczne mimo zerwania linku do konta.
alter table buyback_order_intake drop constraint if exists buyback_order_intake_entered_by_user_id_fkey;
alter table buyback_order_intake add constraint buyback_order_intake_entered_by_user_id_fkey foreign key (entered_by_user_id) references auth.users(id) on delete set null;
alter table buyback_order_intake add column if not exists pad_serials text[];
alter table buyback_order_intake add column if not exists docs boolean not null default false;
-- Usterki paczki (06.10.2026): lista wpisywana w Trade-in (np. "hdmi", "dysk") — Enter dodaje kolejną; nie wymagana do żadnego statusu.
alter table buyback_order_intake add column if not exists defects text[];
-- Wcześniejsza wersja trzymała numery padów w jednym polu tekstowym (po przecinku) — zamień na tablicę.
do $$
begin
  if (select data_type from information_schema.columns
      where table_name = 'buyback_order_intake' and column_name = 'pad_serials') = 'text' then
    alter table buyback_order_intake alter column pad_serials type text[]
      using case when nullif(btrim(pad_serials), '') is null then null
                 else regexp_split_to_array(btrim(pad_serials), '\s*,\s*') end;
  end if;
end $$;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'buyback_order_intake_pads_check') then
    alter table buyback_order_intake add constraint buyback_order_intake_pads_check check (pads is null or pads >= 0);
  end if;
end $$;

create index if not exists buyback_order_intake_order_idx on buyback_order_intake (order_public_id);
create index if not exists buyback_order_intake_entered_idx on buyback_order_intake (entered_at desc);
create index if not exists buyback_order_intake_finished_idx on buyback_order_intake (finished_at desc);
create index if not exists buyback_orders_tracking_idx on buyback_orders (tracking_number);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'buyback_order_intake_order_unique') then
    alter table buyback_order_intake add constraint buyback_order_intake_order_unique unique (order_public_id);
  end if;
end $$;

-- Kanały skupu (06.10.2026, na prośbę właściciela): oprócz Buyback (Back Market) paczki z Allegro, Vinted, OLX i Umowy. Dla kanałów innych
-- niż Buyback pracownik wpisuje numer PRZESYŁKI, który jest kluczem wpisu (order_public_id, nadal unikalny — ta sama paczka nie zaliczy się dwa razy),
-- bo nie ma dla nich zamówienia w buyback_orders. Dlatego klucz obcy do buyback_orders znika, a jego rolę dla kanału 'buyback' przejmuje trigger
-- (wpis Buyback wymaga istniejącego zamówienia BM). Lista kanałów jest w aplikacji (lib/workLog.ts, INTAKE_CHANNELS) — kolumna to zwykły tekst jak role.
alter table buyback_order_intake add column if not exists channel text not null default 'buyback';
alter table buyback_order_intake drop constraint if exists buyback_order_intake_order_public_id_fkey;
create index if not exists buyback_order_intake_channel_idx on buyback_order_intake (channel);

create or replace function buyback_order_intake_check_order() returns trigger
language plpgsql as $$
begin
  if coalesce(new.channel, 'buyback') = 'buyback'
     and not exists (select 1 from buyback_orders o where o.order_public_id = new.order_public_id) then
    raise exception 'Nie ma zamówienia Back Market o numerze %.', new.order_public_id using errcode = '23503';
  end if;
  return new;
end $$;
drop trigger if exists buyback_order_intake_check_order on buyback_order_intake;
create trigger buyback_order_intake_check_order before insert or update of order_public_id, channel on buyback_order_intake
  for each row execute function buyback_order_intake_check_order();

-- Warunek kompletności: statusy "obsluzona", "kontroferta" i "ok_dok" (30.09.2026 — wszystkie trzy dotyczą
-- konkretnego, już zidentyfikowanego urządzenia, więc wymagają tego samego kompletu; "problem" zostaje bez
-- wymagań, bo paczka mogła nie dojść do etapu identyfikacji) wymagają numeru seryjnego, SKU i liczby padów.
-- To twarde zabezpieczenie w bazie (działa też przy bezpośrednim wywołaniu API); UI pokazuje ten sam komunikat.
-- Sprawdzamy przy przejściu NA jeden z tych statusów oraz gdy w już zakończonej paczce ktoś czyści któreś z pól.
-- Dzięki temu stare wiersze bez tych danych można dalej edytować (np. uzupełniać po jednym polu).
create or replace function buyback_order_intake_require_complete() returns trigger
language plpgsql as $$
declare
  requires_complete boolean := new.status in ('obsluzona', 'kontroferta', 'ok_dok');
  entering boolean := tg_op = 'INSERT' or old.status not in ('obsluzona', 'kontroferta', 'ok_dok');
  missing text[] := '{}';
  status_label text := case new.status when 'obsluzona' then 'Obsłużona' when 'kontroferta' then 'Kontroferta' else 'Ok. Dok.' end;
begin
  if not requires_complete then
    return new;
  end if;
  if coalesce(btrim(new.serial_number), '') = '' and (entering or coalesce(btrim(old.serial_number), '') <> '') then
    missing := array_append(missing, 'numer seryjny');
  end if;
  if coalesce(btrim(new.sku), '') = '' and (entering or coalesce(btrim(old.sku), '') <> '') then
    missing := array_append(missing, 'SKU');
  end if;
  if new.pads is null and (entering or old.pads is not null) then
    missing := array_append(missing, 'pady');
  end if;
  if array_length(missing, 1) > 0 then
    raise exception 'Status „%” wymaga uzupełnienia: %.', status_label, array_to_string(missing, ', ')
      using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists buyback_order_intake_require_complete on buyback_order_intake;
create trigger buyback_order_intake_require_complete before insert or update on buyback_order_intake
  for each row execute function buyback_order_intake_require_complete();

-- Punktacja naliczana TYLKO RAZ (05.10.2026, na prośbę właściciela): zmiana statusu między statusami punktowanymi
-- (np. "Ok. Dok." -> "Obsłużona") nie może liczyć paczki ponownie ani przesuwać jej punktów do nowego dnia/miesiąca.
-- Wiersz (paczka) jest jeden (unique na order_public_id), ale UI przy KAŻDEJ zmianie statusu nadpisywał finished_at
-- bieżącą chwilą, a podsumowanie Dziś/7/30 dni liczyło po finished_at — więc paczka zaliczona wczoraj pojawiała się
-- znów "dziś", a punkty za ubiegły miesiąc przeskakiwały do bieżącego. Teraz:
--   * points_awarded_at = chwila PIERWSZEGO wejścia w status punktowany (obsluzona/kontroferta/ok_dok/problem); ustawia je
--     wyłącznie trigger (zegar serwera), nikt nie zmienia go ręcznie i nie jest czyszczone przy cofnięciu do "w_trakcie"
--     (powrót do punktowanego statusu nie daje nowej daty — to ta sama paczka);
--   * finished_at zostaje na pierwszym zakończeniu, gdy paczka przechodzi między statusami zakończenia; czyści je tylko
--     powrót do "w_trakcie" (jak dotąd), a "Czas obsługi" liczy się do pierwszego zakończenia.
-- Podsumowanie punktów liczy po points_awarded_at.
alter table buyback_order_intake add column if not exists points_awarded_at timestamptz;
update buyback_order_intake set points_awarded_at = finished_at
  where points_awarded_at is null and finished_at is not null and status in ('obsluzona', 'kontroferta', 'ok_dok', 'problem');
create index if not exists buyback_order_intake_awarded_idx on buyback_order_intake (points_awarded_at desc);

create or replace function buyback_order_intake_points_once() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.points_awarded_at := case when new.status in ('obsluzona', 'kontroferta', 'ok_dok', 'problem') then now() else null end;
  else
    if auth.role() = 'authenticated' then
      new.points_awarded_at := old.points_awarded_at; -- zalogowani nie zmieniają daty zaliczenia (SQL Editor/serwer mogą, np. backfill poniżej)
    end if;
    if new.points_awarded_at is null and new.status in ('obsluzona', 'kontroferta', 'ok_dok', 'problem') then
      new.points_awarded_at := now();
    end if;
    -- pierwsze zakończenie zostaje; zmiana między statusami zakończenia nie przesuwa daty
    if old.finished_at is not null and new.status <> 'w_trakcie' then
      new.finished_at := old.finished_at;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists buyback_order_intake_points_once on buyback_order_intake;
create trigger buyback_order_intake_points_once before insert or update on buyback_order_intake
  for each row execute function buyback_order_intake_points_once();

-- Status produktu w Magazynie (05.10.2026): `status_changed_at` = chwila OSTATNIEJ zmiany statusu tego wpisu (ustawia trigger, zegar serwera). Widok magazynowy
-- (inventory.sql, product_status_for) bierze po numerze seryjnym najświeższy status spośród Serwisu, Testów i Trade-in. Wiersze sprzed zmiany: najlepsze
-- dostępne przybliżenie (coalesce(finished_at, entered_at)).
alter table buyback_order_intake add column if not exists status_changed_at timestamptz;
update buyback_order_intake set status_changed_at = coalesce(finished_at, entered_at) where status_changed_at is null;

create or replace function buyback_order_intake_status_changed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.status_changed_at := coalesce(new.status_changed_at, now());
  elsif new.status is distinct from old.status then
    new.status_changed_at := now();
  elsif old.status_changed_at is not null then
    new.status_changed_at := old.status_changed_at;
  end if;
  return new;
end $$;
drop trigger if exists buyback_order_intake_status_changed on buyback_order_intake;
create trigger buyback_order_intake_status_changed before insert or update on buyback_order_intake
  for each row execute function buyback_order_intake_status_changed();

alter table buyback_order_intake enable row level security;

drop policy if exists "authenticated read buyback_order_intake" on buyback_order_intake;
create policy "authenticated read buyback_order_intake" on buyback_order_intake
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated insert buyback_order_intake" on buyback_order_intake;
create policy "authenticated insert buyback_order_intake" on buyback_order_intake
  for insert with check (auth.role() = 'authenticated');
drop policy if exists "authenticated update buyback_order_intake" on buyback_order_intake;
create policy "authenticated update buyback_order_intake" on buyback_order_intake
  for update using (auth.role() = 'authenticated');

-- Usuwanie wpisów Trade-in: tylko Admin (is_admin() z schema.sql — uruchom ten plik najpierw), a każde
-- usunięcie ląduje w deleted_records (kto, kiedy, cały wiersz). Polityka to twarde zabezpieczenie:
-- działa też przy bezpośrednim wywołaniu API, nie tylko gdy przycisk jest ukryty w UI.
drop policy if exists "admin delete buyback_order_intake" on buyback_order_intake;
create policy "admin delete buyback_order_intake" on buyback_order_intake
  for delete using (is_admin());
drop trigger if exists buyback_order_intake_audit_delete on buyback_order_intake;
create trigger buyback_order_intake_audit_delete before delete on buyback_order_intake
  for each row execute function audit_delete();

do $$
begin
  begin alter publication supabase_realtime add table buyback_orders; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table buyback_order_intake; exception when duplicate_object then null; end;
end $$;
