-- Magazyn ERP — powiadomienia o nowych zamówieniach na webhook (Make) (20.10.2026): dziennik wysłanych zamówień, żeby każde poszło dokładnie raz.
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run. Można uruchomić ponownie.
-- Dalej: w Vercel dodaj zmienną MAKE_ORDER_WEBHOOK_URL (adres webhooka — sekret, nie w repozytorium) i zrób nowy deploy.
-- Pierwszy przebieg crona oznacza zamówienia z ostatnich 14 dni jako "baseline" (NIE są wysyłane) — wysyłane są dopiero zamówienia, które pojawią się albo staną się opłacone później.
-- Tabele tylko dla serwera (RLS bez polityk) — nikt z przeglądarki ich nie czyta.
set lock_timeout = '5s';

create table if not exists order_webhook_sent (
  marketplace text not null,
  external_id text not null,
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed', 'abandoned', 'baseline')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (marketplace, external_id)
);
create index if not exists order_webhook_sent_created_idx on order_webhook_sent (created_at desc);

create table if not exists order_webhook_state (
  id int primary key default 1 check (id = 1),
  baseline_done boolean not null default false,
  baseline_at timestamptz
);
insert into order_webhook_state (id) values (1) on conflict do nothing;

alter table order_webhook_sent enable row level security;
alter table order_webhook_state enable row level security;
