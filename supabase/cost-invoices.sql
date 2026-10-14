-- Finanse -> Faktury kosztowe (14.10.2026, na prośbę właściciela): faktury kosztowe (wydatki) pobierane z Fakturowni (GET /invoices.json?income=no),
-- w tym te, które Fakturownia sama ściąga z KSeF. Zapis TYLKO przez serwer (app/api/costs/sync, service_role); odczyt: Admin, Manager i Księgowa
-- (dane finansowe) albo osoba, której Admin zaznaczył zakładkę "Faktury kosztowe" w Zespół -> Edytuj. Idempotentny.
create or replace function cost_invoices_can_read() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members
    where user_id = auth.uid()
      and (role = 'Admin'
        or (view_access is null and role in ('Manager', 'Księgowa'))
        or (view_access is not null and 'costs' = any (view_access)))
  );
$$;

create table if not exists cost_invoices (
  fakturownia_id bigint primary key,            -- id dokumentu w Fakturowni
  number text,
  kind text,                                    -- rodzaj dokumentu (vat, ...)
  issue_date date,
  sell_date date,
  payment_to date,                              -- termin płatności
  paid_date date,
  paid boolean not null default false,
  status text,                                  -- issued / sent / paid / partial / rejected (jak w Fakturowni)
  supplier_name text,                           -- sprzedawca na dokumencie (kontrahent)
  supplier_tax_no text,
  price_net numeric(14,2),
  price_tax numeric(14,2),
  price_gross numeric(14,2),
  currency text,
  accounting_kind text,                         -- rodzaj wydatku (purchases, expenses, media, salary, fixed_assets, no_vat_deduction)
  ksef_number text,                             -- numer KSeF, gdy faktura przyszła z KSeF (pole gov_id z Fakturowni)
  from_ksef boolean not null default false,
  description text,
  url text,                                     -- link do dokumentu w panelu Fakturowni
  raw jsonb,                                    -- cała odpowiedź Fakturowni (do podglądu i późniejszego mapowania pól)
  synced_at timestamptz not null default now()
);
create index if not exists cost_invoices_issue_idx on cost_invoices (issue_date desc, fakturownia_id desc);
create index if not exists cost_invoices_supplier_idx on cost_invoices (lower(supplier_name));

alter table cost_invoices enable row level security;
drop policy if exists "finance read cost_invoices" on cost_invoices;
create policy "finance read cost_invoices" on cost_invoices for select using (cost_invoices_can_read());
-- brak polityk insert/update/delete: zapisuje wyłącznie serwer (service_role poza RLS)

create table if not exists cost_invoices_sync_meta (
  id int primary key default 1 check (id = 1),
  last_synced_at timestamptz,
  last_count int,
  last_error text
);
alter table cost_invoices_sync_meta enable row level security;
drop policy if exists "finance read cost_invoices_sync_meta" on cost_invoices_sync_meta;
create policy "finance read cost_invoices_sync_meta" on cost_invoices_sync_meta for select using (cost_invoices_can_read());
