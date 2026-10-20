-- Recoo Sklep <- Back Market (21.10.2026, na prośbę właściciela). Uruchamiać PO supabase/shop.sql. Idempotentny.
-- Produkty sklepu powstają z aktywnych ofert BM (Listingi -> Sklep) przyciskiem "Odśwież oferty" w ERP -> Recoo Sklep -> Magazyn,
-- a stan wariantu = suma ilości jego ofert BM (przycisk "Odśwież ilości" albo automatycznie co 5 min, gdy synchronizacja włączona).
-- Logika: lib/shopBm.ts, lib/shopBmServer.ts, app/api/shop/bm-sync.

-- Powiązanie wariantu sklepu z ofertą marketplace'u (jedna oferta -> jeden wariant; wariant może mieć kilka ofert, ilości się sumują).
create table if not exists shop_variant_sources (
  id bigserial primary key,
  variant_id uuid not null references shop_variants (id) on delete cascade,
  marketplace text not null default 'backmarket',
  external_id text not null,                     -- id oferty (listing) na marketplace'ie
  external_sku text,                             -- SKU oferty (oryginalne, do podglądu)
  title text,                                    -- tytuł oferty w chwili powiązania
  last_seen_at timestamptz,                      -- ostatnio widziana jako aktywna
  created_at timestamptz not null default now(),
  unique (marketplace, external_id)
);
create index if not exists shop_variant_sources_variant_idx on shop_variant_sources (variant_id);
alter table shop_variant_sources enable row level security;
drop policy if exists "shop read variant sources" on shop_variant_sources;
create policy "shop read variant sources" on shop_variant_sources for select using (can_edit_shop());
-- brak polityk zapisu: powiązania tworzy tylko serwer (service_role)

-- Ustawienia synchronizacji (jeden wiersz). Zapis tylko serwer — przyciski w ERP idą przez app/api/shop/bm-sync.
create table if not exists shop_sync_settings (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,        -- automatyczne odświeżanie ilości co 5 min
  updated_by_email text,
  updated_at timestamptz,
  last_qty_at timestamptz,
  last_qty_result jsonb,
  last_offers_at timestamptz,
  last_offers_result jsonb
);
insert into shop_sync_settings (id) values (1) on conflict (id) do nothing;
alter table shop_sync_settings enable row level security;
drop policy if exists "shop read sync settings" on shop_sync_settings;
create policy "shop read sync settings" on shop_sync_settings for select using (can_edit_shop());

-- Ustawienie stanu wariantu przez synchronizację: jak shop_stock_change (blokada wiersza, zapis ruchu "korekta"), ale bez sprawdzania
-- roli — wołać może WYŁĄCZNIE serwer (service_role).
create or replace function shop_bm_set_stock(p_variant_id uuid, p_qty int, p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  v shop_variants;
  mname text;
begin
  if p_qty is null or p_qty < 0 then
    raise exception 'Niepoprawna ilość.';
  end if;
  select * into v from shop_variants where id = p_variant_id for update;
  if not found then
    raise exception 'Nie ma takiego wariantu.';
  end if;
  if v.stock = p_qty then
    return p_qty;
  end if;
  select name into mname from shop_models where id = v.model_id;
  perform set_config('shop.stock_rpc', '1', true);
  update shop_variants set stock = p_qty where id = v.id;
  perform set_config('shop.stock_rpc', '', true);
  insert into shop_stock_moves (variant_id, sku, model_name, kind, delta, stock_before, stock_after, note, by_email)
  values (v.id, v.sku, mname, 'korekta', p_qty - v.stock, v.stock, p_qty, nullif(trim(p_note), ''), 'Synchronizacja (Back Market)');
  return p_qty;
end $$;
revoke all on function shop_bm_set_stock(uuid, int, text) from public, anon, authenticated;
grant execute on function shop_bm_set_stock(uuid, int, text) to service_role;

-- JEDNORAZOWO, tylko przed pierwszym importem ofert (gdy nie ma jeszcze żadnego powiązania): wyczyszczenie dotychczasowego magazynu sklepu.
-- Produkty NIE są usuwane: modele -> szkice, warianty -> nieaktywne, stan -> 0 (ruch "korekta"); zdjęcia i opisy zostają.
-- Kategorie: Smartwatche odkryte, Kontrolery / Akcesoria / Gry ukryte (bez produktów byłyby puste).
do $$
declare v record;
begin
  if exists (select 1 from shop_variant_sources) then
    return;
  end if;
  update shop_models set published = false where published;
  update shop_variants set active = false where active;
  perform set_config('shop.stock_rpc', '1', true);
  for v in
    select sv.id, sv.sku, sv.stock, m.name as mname
    from shop_variants sv join shop_models m on m.id = sv.model_id
    where sv.stock > 0
  loop
    update shop_variants set stock = 0 where id = v.id;
    insert into shop_stock_moves (variant_id, sku, model_name, kind, delta, stock_before, stock_after, note, by_email)
    values (v.id, v.sku, v.mname, 'korekta', -v.stock, v.stock, 0, 'Wyczyszczenie magazynu przed importem ofert Back Market (21.10.2026)', 'Import (SQL)');
  end loop;
  perform set_config('shop.stock_rpc', '', true);
  update shop_categories set hidden = false, tagline = 'Samsung Galaxy Watch' where slug = 'smartwatche';
  update shop_categories set tagline = 'Canon, Nikon, Sony, Panasonic' where slug = 'aparaty';
  update shop_categories set tagline = 'PlayStation, Xbox, Nintendo Switch' where slug = 'konsole';
  update shop_categories set hidden = true where slug in ('kontrolery', 'akcesoria', 'gry');
end $$;
