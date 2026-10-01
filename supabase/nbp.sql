-- Magazyn ERP — kursy walut NBP (zakładka NBP, 01.10.2026)
-- Uruchom w Supabase: Dashboard -> SQL Editor -> New query -> wklej CAŁY plik -> Run.
-- Można uruchomić ponownie bez błędów.
--
-- Kursy średnie NBP (tabela A, https://api.nbp.pl) — na razie EUR i DKK (jedyne obce waluty
-- występujące w zamówieniach, patrz lib/salesOrders.ts), żeby przeliczać wartości zamówień
-- z różnych kanałów na PLN na Przeglądzie. Przydadzą się też gdzie indziej (stąd osobna
-- zakładka, nie tylko funkcja wewnętrzna Przeglądu).
--
-- ZASADA: do przeliczenia dnia D używamy kursu z OSTATNIEGO dnia roboczego PRZED D (polska
-- zasada księgowa: kurs z dnia poprzedzającego dzień transakcji), NIE kursu z samego dnia D —
-- patrz rateForDate w lib/nbp.ts (szuka najpóźniejszej daty ŚCIŚLE mniejszej niż D).

create table if not exists nbp_rates (
  currency text not null,     -- "EUR", "DKK", ...
  rate_date date not null,    -- effectiveDate z NBP (dzień, w którym kurs obowiązywał)
  mid numeric not null,       -- kurs średni (1 jednostka waluty obcej = tyle PLN)
  synced_at timestamptz not null default now(),
  primary key (currency, rate_date)
);
create index if not exists nbp_rates_currency_date_idx on nbp_rates (currency, rate_date desc);

alter table nbp_rates enable row level security;

drop policy if exists "authenticated read nbp_rates" on nbp_rates;
create policy "authenticated read nbp_rates" on nbp_rates
  for select using (auth.role() = 'authenticated');
-- Zapis tylko przez serwer (service_role) — synchronizacja z NBP (cron + przycisk "Odśwież"
-- w zakładce NBP), zespół nie wpisuje kursów ręcznie.

do $$
begin
  begin alter publication supabase_realtime add table nbp_rates; exception when duplicate_object then null; end;
end $$;
