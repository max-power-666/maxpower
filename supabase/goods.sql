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
