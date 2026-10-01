-- Magazyn ERP — zakładka Faktury (01.10.2026)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów. Wymaga wcześniej uruchomionego schema.sql (members, is_admin()),
-- shipping.sql (is_admin_or_manager() — obejmuje też rolę Zamówienia, mimo historycznej nazwy) i
-- sales-orders.sql (sales_orders, sales_order_items).
--
-- Zamówienie kwalifikuje się do faktury, gdy ma numer przesyłki (sales_orders.tracking_number) ORAZ każda jego
-- pozycja ma numer seryjny/IMEI (sales_order_items.serial_number) — widok invoices_ready_orders (niżej) liczy to
-- raz, po stronie bazy, zamiast w przeglądarce (te same tabele mogą mieć tysiące wierszy). Wystawienie faktury
-- jest RĘCZNE (jawny przycisk "Wystaw fakturę" na liście, świadoma decyzja właściciela — to prawdziwy dokument
-- księgowo-podatkowy, nie generujemy go automatycznie bez przeglądu człowieka).

create table if not exists invoices (
  id bigint generated always as identity primary key,
  marketplace text not null,
  external_id text not null,
  fakturownia_id bigint,
  number text,                       -- numer dokumentu z Fakturowni, np. "AO/24/10/2026"
  issue_date date,
  sell_date date,
  buyer_name text,
  buyer_tax_no text,                 -- NIP, gdy nabywca to firma; puste dla osoby prywatnej
  buyer_country text,
  total_gross numeric,
  currency text,
  status text not null default 'wystawiono',  -- wystawiono | zaplacone (status płatności dziś nie jest
                                               -- synchronizowany z Fakturowni — do zrobienia, patrz CLAUDE.md)
  raw jsonb,                         -- pełna odpowiedź Fakturowni, do debugowania/audytu
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (marketplace, external_id)  -- jedna faktura na zamówienie (pozycje = wszystkie sztuki tego zamówienia)
);
create index if not exists invoices_order_idx on invoices (marketplace, external_id);
create index if not exists invoices_created_idx on invoices (created_at desc);

alter table invoices enable row level security;

-- Tak samo jak shipments: odczyt dla Admin/Manager/Zamówienia, ZAPIS tylko przez serwer (service_role) —
-- faktura to zapis księgowy, żadna rola nie edytuje ani nie usuwa jej z poziomu aplikacji.
drop policy if exists "admin manager read invoices" on invoices;
create policy "admin manager read invoices" on invoices for select using (is_admin_or_manager());

-- Widok musi powstać PO tabeli invoices (odwołuje się do niej w not exists) — kolejność w pliku ma znaczenie.
create or replace view invoices_ready_orders as
select s.marketplace, s.external_id, s.order_date, s.tracking_number, s.country_code, s.sku
from sales_orders s
where s.tracking_number is not null
  and exists (select 1 from sales_order_items i where i.marketplace = s.marketplace and i.external_id = s.external_id)
  and not exists (
    select 1 from sales_order_items i
     where i.marketplace = s.marketplace and i.external_id = s.external_id
       and coalesce(btrim(i.serial_number), '') = ''
  )
  and not exists (
    select 1 from invoices inv where inv.marketplace = s.marketplace and inv.external_id = s.external_id
  );
-- Widoki nie mają własnych RLS/grantów niezależnych od tabel źródłowych w tym projekcie (sales_orders ma dziś
-- szerokie select dla authenticated — patrz sekcja Uprawnienia w CLAUDE.md), więc invoices_ready_orders dziedziczy
-- to samo; grant jawny na wszelki wypadek (PostgREST eksponuje widoki tak jak tabele).
grant select on invoices_ready_orders to authenticated;

do $$
begin
  begin alter publication supabase_realtime add table invoices; exception when duplicate_object then null; end;
end $$;
