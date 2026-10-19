-- Magazyn ERP — ceny minimalne/maksymalne ofert dla bidderów cen (19.10.2026, Magazyn -> Listingi -> Cdiscount; zadanie ZAD-7).
-- Uruchom w Supabase: SQL Editor -> wklej CAŁY plik -> Run. Można uruchomić ponownie. Wymaga schema.sql (members).
-- Reguła = cena minimalna (poniżej której bidder nigdy nie proponuje zejścia) i opcjonalnie maksymalna (do której może proponować podwyżkę) dla jednej oferty marketplace'u.
-- Zapisuje wyłącznie serwer (app/api/listings/price-rule, service_role); odczyt: Admin, Manager, Księgowa (to dolne granice opłacalności).
create table if not exists listing_price_rules (
  marketplace text not null,
  external_id text not null,             -- ID oferty (Cdiscount: offerId)
  min_price numeric check (min_price is null or min_price > 0),
  max_price numeric check (max_price is null or max_price > 0),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  history jsonb not null default '[]'::jsonb,   -- [{at, by_email, from: {min, max}, to: {min, max}}]
  primary key (marketplace, external_id),
  check (min_price is null or max_price is null or max_price >= min_price)
);

-- Automat cen (19.10.2026): tryb per oferta — off (tylko propozycje), raise (cron sam podnosi cenę), both (podnosi i obniża). Domyślnie off.
alter table listing_price_rules add column if not exists auto_mode text not null default 'off';
alter table listing_price_rules drop constraint if exists listing_price_rules_auto_mode_check;
alter table listing_price_rules add constraint listing_price_rules_auto_mode_check check (auto_mode in ('off', 'raise', 'both'));

alter table listing_price_rules enable row level security;
drop policy if exists "managers read listing_price_rules" on listing_price_rules;
create policy "managers read listing_price_rules" on listing_price_rules for select
  using (exists (select 1 from members where user_id = auth.uid() and role in ('Admin', 'Manager', 'Księgowa')));
-- brak polityk insert/update/delete: zapis tylko service_role
