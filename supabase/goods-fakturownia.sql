-- Towar -> Fakturownia (15.10.2026): znacznik, że pozycja została wysłana do magazynu Fakturowni z aplikacji (przycisk "Do Fakturowni" w zakładce Towar).
-- Uruchom w Supabase: SQL Editor -> wklej CAŁY plik -> Run. Idempotentny. Po nim uruchom ponownie supabase/goods-available.sql (widok musi objąć nowe kolumny).
alter table goods_register add column if not exists fakturownia_product_id bigint;
alter table goods_register add column if not exists fakturownia_sent_at timestamptz;
alter table goods_register add column if not exists fakturownia_sent_by text;
alter table goods_register add column if not exists fakturownia_pz_id bigint; -- dokument PZ (przyjęcie na stan) wystawiony w Fakturowni dla tej pozycji (15.10.2026)
create index if not exists goods_register_fakturownia_idx on goods_register (fakturownia_product_id) where fakturownia_product_id is not null;
