-- Trade-in: cena zakupu i numer faktury dla kanałów innych niż Buyback (22.10.2026, na prośbę właściciela).
-- Uruchom w Supabase: SQL Editor -> wklej CAŁY plik -> Run. Można uruchomić ponownie. (Ta sama treść jest na końcu buyback-orders.sql.)
-- Pola NIE są obowiązkowe (nie blokują żadnego statusu), ale aplikacja pokazuje wyraźne ostrzeżenie, dopóki cena i numer faktury nie zostaną uzupełnione.
-- Dla Buyback cena pochodzi z zamówienia Back Market, więc te kolumny tam zostają puste.
alter table buyback_order_intake add column if not exists purchase_price numeric(12,2); -- cena zakupu, PLN
alter table buyback_order_intake add column if not exists invoice_no text;               -- numer faktury / dokumentu zakupu
