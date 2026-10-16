-- Magazyn ERP — dziennik zmian cen ofert na marketplace'ach (16.10.2026, Magazyn -> Do wystawienia -> "Ustaw cenę").
-- Uruchom w Supabase: SQL Editor -> wklej CAŁY plik -> Run. Można uruchomić ponownie. Wymaga schema.sql (members).
-- Zapisuje wyłącznie serwer (app/api/listings/update-price, service_role) — każda próba zmiany ceny, także nieudana. Odczyt: Admin, Manager, Księgowa.
create table if not exists listing_price_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  by_email text,
  marketplace text not null,
  external_id text not null,          -- ID oferty (Back Market: listing UUID, refurbed: Offer.id)
  sku text,
  old_price numeric,
  new_price numeric not null,
  currency text,
  reason text,                        -- uzasadnienie wg strategii (np. "cena wyższa niż cena do wygrania BuyBox")
  ok boolean not null default true,
  error text
);
create index if not exists listing_price_log_offer_idx on listing_price_log (marketplace, external_id, created_at desc);

alter table listing_price_log enable row level security;
drop policy if exists "managers read listing_price_log" on listing_price_log;
create policy "managers read listing_price_log" on listing_price_log for select
  using (exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Księgowa')));
-- brak polityk insert/update/delete: zapis tylko service_role
