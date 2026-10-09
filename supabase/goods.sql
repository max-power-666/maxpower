-- Magazyn ERP — zakładka "Towar" (10.10.2026): rejestr zakupionego towaru z arkusza właściciela (Towar.numbers), dwa arkusze = dwie pigułki:
--   "VM/V23"   (kind = 'vm_v23')  — zakupy od firm i z Allegro: dostawca, faktura, VAT-marża albo V23, waluta i kurs NBP, koszty,
--   "Trade-in" (kind = 'trade_in') — zakupy ze skupu Back Market (BuyBack): numer zamówienia BM, DW, PCC, kraj, prowizja + PCC.
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Można uruchomić ponownie (nic nie kasuje).
--
-- Dane z arkusza wgrywa się osobnym plikiem jednorazowym (poza repozytorium — to dane, nie schemat), który ładuje wiersze tylko do PUSTEGO rodzaju.
-- Kolumny finansowe ("cena PLN + koszty", "Cena PLN", "prowizja + PCC") są wartościami Z ARKUSZA — nie przeliczamy ich w aplikacji.
-- Odczyt: tylko Admin i Manager (ceny zakupu, dostawcy). Zapis: tylko przez serwer/SQL Editor (service_role) — brak polityk insert/update/delete.

create or replace function goods_can_read() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager'));
$$;

create table if not exists goods_register (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('vm_v23', 'trade_in')),
  row_no int,                         -- kolejność wiersza w arkuszu (1 = pierwszy)
  serial text,                        -- SN (numer seryjny / IMEI)
  name text,                          -- nazwa towaru (np. SKU albo opis)
  supplier text,                      -- dostawca (PCS, AAR, LW, BB, "z Allegro"...)
  purchased_on date,                  -- data zakupu
  delivered_on date,                  -- data dostawy
  order_no text,                      -- numer zamówienia (dla Trade-in: numer zamówienia Back Market)
  invoice_no text,                    -- numer faktury / DW
  category text,                      -- kategoria z arkusza (Konsola, Watch, Aparat1, iPad...)
  price numeric(12,2),                -- cena zakupu w walucie zakupu
  vat text,                           -- VM / V23
  currency text,                      -- EUR / PLN / GBP
  nbp_rate numeric(10,4),             -- kurs NBP użyty w arkuszu
  costs numeric(12,2),                -- koszty (z arkusza)
  total_pln numeric(12,2),            -- "cena PLN + koszty"
  price_pln numeric(12,2),            -- "Cena PLN"
  pcc numeric(12,2),                  -- tylko Trade-in
  country text,                       -- tylko Trade-in: kod kraju (FR/DE/ES/IT) — puste dla starych zamówień z samymi cyframi
  commission_pcc numeric(12,2),       -- tylko Trade-in: "prowizja + pcc"
  created_at timestamptz not null default now()
);
create index if not exists goods_register_kind_date_idx on goods_register (kind, purchased_on desc nulls last, id desc);
create index if not exists goods_register_serial_idx on goods_register (lower(btrim(serial)));

alter table goods_register enable row level security;
drop policy if exists "admin manager read goods_register" on goods_register;
create policy "admin manager read goods_register" on goods_register for select using (goods_can_read());

-- ===== Formularz "Dodaj towar" (10.10.2026) =====
-- Dodawać może każdy, kto czyta towar (Admin i Manager); usuwać (np. pomyłkę we wpisie) tylko Admin — usunięcie zapisuje audit_delete() w deleted_records.
-- Edycja: patrz niżej (tylko Admin). row_no i autora (created_by_email) uzupełnia trigger, więc nie da się ich podrobić z przeglądarki.
alter table goods_register add column if not exists created_by_email text;     -- puste = wiersz z arkusza; wypełnione = dodany w aplikacji

create or replace function goods_register_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.row_no := coalesce((select max(row_no) from goods_register where kind = new.kind), 0) + 1;
  new.created_by_email := coalesce(auth.jwt() ->> 'email', new.created_by_email);
  return new;
end;
$$;
drop trigger if exists goods_register_before_insert on goods_register;
create trigger goods_register_before_insert before insert on goods_register
  for each row execute function goods_register_before_insert();

drop policy if exists "admin manager insert goods_register" on goods_register;
create policy "admin manager insert goods_register" on goods_register for insert with check (goods_can_read());
drop policy if exists "admin delete goods_register" on goods_register;
create policy "admin delete goods_register" on goods_register for delete using (is_admin());

drop trigger if exists goods_register_audit_delete on goods_register;
create trigger goods_register_audit_delete before delete on goods_register
  for each row execute function audit_delete();

-- ===== Edycja wierszy przez Admina (10.10.2026) =====
-- Edytować może tylko Admin (RLS update). Każda realna zmiana trafia do `history` (kto, kiedy, pole: było -> jest) — trigger, więc nie da się jej ominąć
-- z przeglądarki; id, row_no, autor i data dodania są niezmienne. Zapis bez zmiany wartości niczego nie loguje.
alter table goods_register add column if not exists updated_at timestamptz;
alter table goods_register add column if not exists updated_by_email text;
alter table goods_register add column if not exists history jsonb not null default '[]'::jsonb;

create or replace function goods_register_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb;
  n jsonb;
  k text;
  ch jsonb := '[]'::jsonb;
  who text;
begin
  -- pola niezmienne
  new.id := old.id;
  new.row_no := old.row_no;
  new.created_at := old.created_at;
  new.created_by_email := old.created_by_email;
  new.history := old.history;
  new.updated_at := old.updated_at;
  new.updated_by_email := old.updated_by_email;
  o := to_jsonb(old);
  n := to_jsonb(new);
  for k in select jsonb_object_keys(n) loop
    if (o -> k) is distinct from (n -> k) then
      ch := ch || jsonb_build_array(jsonb_build_object('field', k, 'from', o -> k, 'to', n -> k));
    end if;
  end loop;
  if jsonb_array_length(ch) = 0 then
    return new;
  end if;
  who := coalesce(auth.jwt() ->> 'email', old.updated_by_email);
  new.updated_at := now();
  new.updated_by_email := who;
  new.history := coalesce(old.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'by', who, 'changes', ch));
  return new;
end;
$$;
drop trigger if exists goods_register_before_update on goods_register;
create trigger goods_register_before_update before update on goods_register
  for each row execute function goods_register_before_update();

drop policy if exists "admin update goods_register" on goods_register;
create policy "admin update goods_register" on goods_register for update using (is_admin()) with check (is_admin());
