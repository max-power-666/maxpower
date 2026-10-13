-- Magazyn ERP — Magazyn -> Listingi (13.10.2026): oferty (listingi) wystawione na Back Market i refurbed — SKU, ilość, cena, stan oferty, klasa, gwarancja itd.
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Można uruchomić ponownie (nic nie kasuje). Niezależny od innych plików.
--
-- Dane pobiera serwer (app/api/listings/sync, cron co 30 min + przycisk "Odśwież" w zakładce) i zapisuje KOMPLETNĄ MIGAWKĘ ofert danego marketplace'u:
--  - Back Market: GET /ws/listings (zwraca wszystkie listingi sprzedawcy, także offline), refurbed: OfferService/ListOffers;
--  - migawka może zająć kilka przebiegów (kursor w listings_sync_meta); dopiero po ukończeniu usuwane są oferty, których marketplace już nie zwraca (snapshot_at starszy niż migawka).
-- Zapis TYLKO serwer (service_role — brak polityk insert/update/delete); odczyt dla zalogowanych (tak jak zamówienia sprzedaży).

create table if not exists marketplace_listings (
  marketplace text not null,                         -- 'backmarket' | 'refurbed' (zwykły tekst — kolejny kanał to nowa wartość, bez SQL)
  external_id text not null,                         -- Back Market: listing id (UUID); refurbed: id oferty
  sku text,                                          -- SKU sprzedawcy (u refurbed bywa puste)
  title text,                                        -- nazwa produktu (BM: title, refurbed: instance_name)
  quantity int,                                      -- ilość / stan oferty (BM: quantity, refurbed: stock); 0 = oferta offline
  price numeric(12, 2),                              -- cena (BM: price w walucie rynku z BACKMARKET_LANG, domyślnie fr-fr; refurbed: reference_price brutto)
  currency text,
  min_price numeric(12, 2),                          -- minimalna cena automatycznego repricingu
  max_price numeric(12, 2),                          -- BM: maksymalna dozwolona cena
  state text,                                        -- BM: publication_state (0..4, etykiety w lib/listings.ts); refurbed: OK/UNVERIFIED/SUBMITTED/PENDING_REVIEW/REJECTED
  grade text,                                        -- BM: PREMIUM/EXCELLENT/VERY_GOOD/GOOD/FAIR/STALLONE; refurbed: AA/A/B/C
  warranty_months int,
  product_id text,                                   -- BM: product_id (UUID produktu); refurbed: instance_id (wariant produktu)
  listing_ref text,                                  -- BM: stary numeryjny listing_id (deprecated, ale widoczny w panelu)
  details jsonb not null default '{}'::jsonb,        -- reszta: komentarz, wysyłka, ceny na rynkach i BuyBox (refurbed)...
  listed_at timestamptz,                             -- kiedy oferta powstała (tylko refurbed)
  snapshot_at timestamptz not null default now(),    -- migawka, w której oferta ostatnio się pojawiła
  primary key (marketplace, external_id)
);
create index if not exists marketplace_listings_sku_idx on marketplace_listings (marketplace, lower(sku));
create index if not exists marketplace_listings_qty_idx on marketplace_listings (marketplace, quantity);

create table if not exists listings_sync_meta (
  marketplace text primary key,
  last_synced_at timestamptz,                        -- koniec ostatniej KOMPLETNEJ migawki
  last_count int,                                    -- ile ofert miała ta migawka
  scan_cursor text,                                  -- niedokończona migawka: BM numer następnej strony, refurbed id ostatniej oferty
  scan_started_at timestamptz,                       -- początek niedokończonej migawki (== snapshot_at jej wierszy)
  last_attempt_at timestamptz,
  last_error text
);

alter table marketplace_listings enable row level security;
alter table listings_sync_meta enable row level security;
drop policy if exists "authenticated read marketplace_listings" on marketplace_listings;
create policy "authenticated read marketplace_listings" on marketplace_listings for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated read listings_sync_meta" on listings_sync_meta;
create policy "authenticated read listings_sync_meta" on listings_sync_meta for select using (auth.role() = 'authenticated');
