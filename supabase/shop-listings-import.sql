-- Sklep: wyczyszczenie magazynu i import produktów z ERP -> Listingi -> Sklep (21.10.2026, na prośbę właściciela). Jednorazowy.
-- 1) Dotychczasowe produkty sklepu: UKRYTE (szkice), warianty NIEAKTYWNE, stan wyzerowany ruchem "korekta" — nic nie jest usuwane
--    (zdjęcia, opisy i warianty zostają; produkt da się przywrócić w ERP -> Recoo Sklep -> Produkty).
-- 2) 194 aktywnych ofert Back Market (online, ilość > 0) z kategorii: konsole, aparaty, smartwatche Samsung —
--    KAŻDA oferta = osobny produkt z jednym wariantem (decyzja właściciela). Nazwy przetłumaczone z francuskiego tytułu oferty.
--    Stan wizualny z oceny Back Market: EXCELLENT/VERY_GOOD -> bardzo dobry (A), GOOD -> dobry (B), FAIR/STALLONE -> zadowalający (C).
--    SKU = SKU oferty Back Market zapisane wielkimi literami bez znaków spoza A-Z 0-9 + - (dwa kolidujące z istniejącymi dostały końcówkę -BM).
--    Cena = cena Back Market (EUR) x kurs NBP 4,3716 z 20.10.2026, zaokrąglona w górę do pełnych ...9 zł.
--    Stan = ilość z oferty Back Market (ruch "przyjęcie"). UWAGA: to ten sam towar co na Back Markecie — stany sklepu NIE synchronizują się same.
-- 3) Kategorie: Smartwatche odkryte, Kontrolery / Akcesoria / Gry ukryte (bez produktów byłyby puste w menu sklepu).
-- Bezpieczne do ponownego uruchomienia: istniejących produktów/wariantów nie dubluje, nowych nie zeruje.
begin;

create temp table _imp (slug text, name text, brand text, category_slug text, color text, bm_sku text, sku text, grade text, price numeric, qty int, sort int) on commit drop;
insert into _imp values
  ('sony-playstation-4-1-tb-niebieski-edycja-limitowana-uncharted-4-unchar-a', 'PlayStation 4 1 TB - Niebieski - Edycja limitowana Uncharted 4 + Uncharted 4', 'Sony', 'konsole', '#E1F0FE', 'PS4 UNCHARTED', 'PS4-UNCHARTED', 'bardzo-dobry', 1089, 1, 0),
  ('sony-playstation-4-1-tb-czarny-far-cry-primal-b', 'PlayStation 4 1 TB - Czarny + Far Cry Primal', 'Sony', 'konsole', '#E1F0FE', 'PS4-1T-BK-B+FCP', 'PS4-1T-BK-B+FCP', 'dobry', 799, 7, 1),
  ('sony-playstation-4-1-tb-czarny-lego-star-wars-b', 'PlayStation 4 1 TB - Czarny + Lego Star Wars', 'Sony', 'konsole', '#E1F0FE', 'PS4-1T-BK-B+LSW', 'PS4-1T-BK-B+LSW', 'dobry', 979, 3, 2),
  ('sony-playstation-4-1-tb-czarny-no-man-s-sky-b', 'PlayStation 4 1 TB - Czarny + No Man''s Sky', 'Sony', 'konsole', '#E1F0FE', 'PS4-1T-BK-BNMS', 'PS4-1T-BK-BNMS', 'dobry', 1069, 1, 3),
  ('sony-playstation-4-1-tb-czarny-uncharted-4-b', 'PlayStation 4 1 TB - Czarny + Uncharted 4', 'Sony', 'konsole', '#E1F0FE', 'PS4-1T-BK-B+U4', 'PS4-1T-BK-B+U4', 'dobry', 879, 16, 4),
  ('sony-playstation-4-500-gb-czarny-assassin-s-creed-valhalla-b', 'PlayStation 4 500 GB - Czarny + Assassin''s Creed Valhalla', 'Sony', 'konsole', '#E1F0FE', 'PS4-500-BK-B+ACV', 'PS4-500-BK-B+ACV', 'dobry', 959, 5, 5),
  ('sony-playstation-4-500-gb-czarny-destiny-b', 'PlayStation 4 500 GB - Czarny + Destiny', 'Sony', 'konsole', '#E1F0FE', 'PS4-500-BK-B+Destiny', 'PS4-500-BK-B+DESTINY', 'dobry', 749, 8, 6),
  ('sony-playstation-4-500-gb-czarny-drive-club-b', 'PlayStation 4 500 GB - Czarny + Drive Club', 'Sony', 'konsole', '#E1F0FE', 'PS4-500-BK-B+DC', 'PS4-500-BK-B+DC', 'dobry', 789, 5, 7),
  ('sony-playstation-4-500-gb-czarny-driveclub-the-last-of-us-remastered-b', 'PlayStation 4 500 GB - Czarny + DriveClub + The Last Of Us (Remastered)', 'Sony', 'konsole', '#E1F0FE', 'PS4-500-BK-B+DC+TLOU', 'PS4-500-BK-B+DC+TLOU', 'dobry', 969, 4, 8),
  ('sony-playstation-4-500-gb-czarny-fifa-22-b', 'PlayStation 4 500 GB - Czarny + FIFA 22', 'Sony', 'konsole', '#E1F0FE', 'PS4-500-BK-B+F22', 'PS4-500-BK-B+F22', 'dobry', 789, 2, 9),
  ('sony-playstation-4-500-gb-czarny-god-of-war-iii-remastered-b', 'PlayStation 4 500 GB - Czarny + God of War III Remastered', 'Sony', 'konsole', '#E1F0FE', 'PS4-500-BK-B+GOW3R', 'PS4-500-BK-B+GOW3R', 'dobry', 899, 1, 10),
  ('sony-playstation-4-500-gb-czarny-grand-theft-auto-v-a', 'PlayStation 4 500 GB - Czarny + Grand Theft Auto V', 'Sony', 'konsole', '#E1F0FE', 'PS4-500-BK-A-GTA5', 'PS4-500-BK-A-GTA5', 'bardzo-dobry', 939, 7, 11),
  ('sony-playstation-4-500-gb-czarny-the-last-of-us-remastered-b', 'PlayStation 4 500 GB - Czarny + The Last of Us Remastered', 'Sony', 'konsole', '#E1F0FE', 'PS4-500-BK-B-1M+TLOU', 'PS4-500-BK-B-1M+TLOU', 'dobry', 789, 6, 12),
  ('sony-playstation-4-500-gb-bialy-c', 'PlayStation 4 500 GB - Biały', 'Sony', 'konsole', '#E1F0FE', 'PS4-500-WE-C', 'PS4-500-WE-C', 'zadowalajacy', 809, 1, 13),
  ('sony-playstation-4-pro-1-tb-czarny-call-of-duty-black-ops-4-a', 'PlayStation 4 Pro 1 TB - Czarny + Call of Duty: Black Ops 4', 'Sony', 'konsole', '#E1F0FE', 'PS4P-1T-BK-A + CODBO4', 'PS4P-1T-BK-A+CODBO4', 'bardzo-dobry', 1079, 13, 14),
  ('sony-playstation-4-pro-1-tb-czarny-call-of-duty-black-ops-4-b', 'PlayStation 4 Pro 1 TB - Czarny + Call of Duty: Black Ops 4', 'Sony', 'konsole', '#E1F0FE', 'PS4P-1T-BK-B+CODBO4', 'PS4P-1T-BK-B+CODBO4', 'dobry', 1059, 5, 15),
  ('sony-playstation-4-pro-1-tb-czarny-call-of-duty-modern-warfare-c', 'PlayStation 4 Pro 1 TB - Czarny + Call of Duty: Modern Warfare', 'Sony', 'konsole', '#E1F0FE', 'PS4P-1T-BK-B+CODMW', 'PS4P-1T-BK-B+CODMW', 'zadowalajacy', 1029, 16, 16),
  ('sony-playstation-4-pro-1-tb-czarny-fifa-22-b', 'PlayStation 4 Pro 1 TB - Czarny + FIFA 22', 'Sony', 'konsole', '#E1F0FE', 'PS4P-1T-BK-B +FC22', 'PS4P-1T-BK-B+FC22', 'dobry', 1049, 3, 17),
  ('sony-playstation-4-pro-1-tb-czarny-ghost-of-tsushima-b', 'PlayStation 4 Pro 1 TB - Czarny + Ghost of Tsushima', 'Sony', 'konsole', '#E1F0FE', 'PS4P-1T-BK-B+GHOT', 'PS4P-1T-BK-B+GHOT', 'dobry', 1109, 7, 18),
  ('sony-playstation-4-pro-1-tb-czarny-grand-turismo-sport-b', 'PlayStation 4 Pro 1 TB - Czarny + Grand Turismo Sport', 'Sony', 'konsole', '#E1F0FE', 'PS4P+GTS', 'PS4P+GTS', 'dobry', 1159, 30, 19),
  ('sony-playstation-4-pro-1-tb-czarny-horizon-zero-dawn-b', 'PlayStation 4 Pro 1 TB - Czarny + Horizon Zero Dawn', 'Sony', 'konsole', '#E1F0FE', 'PS4P-1T-BK-B -HZD', 'PS4P-1T-BK-B-HZD', 'dobry', 1119, 7, 20),
  ('sony-playstation-4-pro-1-tb-czarny-red-dead-redemption-ii-b', 'PlayStation 4 Pro 1 TB - Czarny + Red Dead Redemption II', 'Sony', 'konsole', '#E1F0FE', 'PS4P-1TB-BK-B-1M+RDR2', 'PS4P-1TB-BK-B-1M+RDR2', 'dobry', 1039, 17, 21),
  ('sony-playstation-4-pro-1-tb-czarny-red-dead-redemption-ii-a', 'PlayStation 4 Pro 1 TB - Czarny + Red Dead Redemption II', 'Sony', 'konsole', '#E1F0FE', 'PS4PRO-1TB-BLA-A2 + RDR2', 'PS4PRO-1TB-BLA-A2+RDR2', 'bardzo-dobry', 1079, 2, 22),
  ('sony-playstation-4-pro-1-tb-czarny-edycja-limitowana-god-of-war-god-of-b', 'PlayStation 4 Pro 1 TB - Czarny - Edycja limitowana God of War + God of War', 'Sony', 'konsole', '#E1F0FE', 'PS4P-1T-BK-B - GOW', 'PS4P-1T-BK-B-GOW', 'dobry', 1159, 1, 23),
  ('sony-playstation-4-slim-1-tb-szary-edycja-limitowana-days-of-play-a', 'PlayStation 4 Slim 1 TB - Szary - Edycja limitowana Days of Play', 'Sony', 'konsole', '#E1F0FE', 'PS4S-1TB-DOP-A', 'PS4S-1TB-DOP-A', 'bardzo-dobry', 1529, 1, 24),
  ('sony-playstation-4-slim-1-tb-czarny-destiny-2-the-taken-king-a', 'PlayStation 4 Slim 1 TB - Czarny + Destiny 2: The Taken King', 'Sony', 'konsole', '#E1F0FE', 'PS4S-1TB-BK-A+D2', 'PS4S-1TB-BK-A+D2', 'bardzo-dobry', 969, 10, 25),
  ('sony-playstation-4-slim-1-tb-czarny-fifa-22-a', 'PlayStation 4 Slim 1 TB - Czarny + FIFA 22', 'Sony', 'konsole', '#E1F0FE', 'PS4S-1TB-BK-A+F22', 'PS4S-1TB-BK-A+F22', 'bardzo-dobry', 949, 5, 26),
  ('sony-playstation-4-slim-1-tb-czarny-far-cry-5-a', 'PlayStation 4 Slim 1 TB - Czarny + Far Cry 5', 'Sony', 'konsole', '#E1F0FE', 'PS4S-1TB-BK-B+FC5', 'PS4S-1TB-BK-B+FC5', 'bardzo-dobry', 1019, 15, 27),
  ('sony-playstation-4-slim-1-tb-czarny-final-fantasy-xv-a', 'PlayStation 4 Slim 1 TB - Czarny + Final Fantasy XV', 'Sony', 'konsole', '#E1F0FE', 'PS4S-1TB-BK-A+FFXV', 'PS4S-1TB-BK-A+FFXV', 'bardzo-dobry', 1049, 9, 28),
  ('sony-playstation-4-slim-1-tb-czarny-final-fantasy-xv-b', 'PlayStation 4 Slim 1 TB - Czarny + Final Fantasy XV', 'Sony', 'konsole', '#E1F0FE', 'PS4S-1TB-BK-B+FFXV', 'PS4S-1TB-BK-B+FFXV', 'dobry', 1009, 3, 29),
  ('sony-playstation-4-slim-1-tb-czarny-marvel-s-spider-man-b', 'PlayStation 4 Slim 1 TB - Czarny + Marvel''s Spider-Man', 'Sony', 'konsole', '#E1F0FE', 'ps4 slim 1tb a3 + spiderman', 'PS4-SLIM-1TB-A3+SPIDERMAN', 'dobry', 929, 41, 30),
  ('sony-playstation-4-slim-1-tb-czarny-star-wars-battlefront-ii-b', 'PlayStation 4 Slim 1 TB - Czarny + Star Wars: Battlefront II', 'Sony', 'konsole', '#E1F0FE', 'PS4S-1T-BK-B+SWB2', 'PS4S-1T-BK-B+SWB2', 'dobry', 1009, 20, 31),
  ('sony-playstation-4-slim-500-gb-czarny-call-of-duty-black-ops-4-a', 'PlayStation 4 Slim 500 GB - Czarny + Call of Duty: Black Ops 4', 'Sony', 'konsole', '#E1F0FE', 'PS4S-1TB-BK-A+CODBO4', 'PS4S-1TB-BK-A+CODBO4', 'bardzo-dobry', 919, 5, 32),
  ('sony-playstation-4-slim-500-gb-czarny-elden-ring-a', 'PlayStation 4 Slim 500 GB - Czarny + Elden Ring', 'Sony', 'konsole', '#E1F0FE', 'PS4S-500-BK-A+ELDEN RING', 'PS4S-500-BK-A+ELDEN-RING', 'bardzo-dobry', 1009, 10, 33),
  ('sony-playstation-4-slim-500-gb-czarny-fifa-19-a', 'PlayStation 4 Slim 500 GB - Czarny + FIFA 19', 'Sony', 'konsole', '#E1F0FE', 'ps4 slim 500gb bk a2 + fifa19', 'PS4-SLIM-500GB-BK-A2+FIFA19', 'bardzo-dobry', 969, 1, 34),
  ('sony-playstation-4-slim-500-gb-czarny-fifa-20-b', 'PlayStation 4 Slim 500 GB - Czarny + FIFA 20', 'Sony', 'konsole', '#E1F0FE', 'ps4slim 500gb a3 + fifa20', 'PS4SLIM-500GB-A3+FIFA20', 'dobry', 869, 20, 35),
  ('sony-playstation-4-slim-500-gb-czarny-far-cry-5-a', 'PlayStation 4 Slim 500 GB - Czarny + Far Cry 5', 'Sony', 'konsole', '#E1F0FE', 'PS4S-500-BK-A+FC5', 'PS4S-500-BK-A+FC5', 'bardzo-dobry', 999, 3, 36),
  ('sony-playstation-4-slim-500-gb-czarny-minecraft-b', 'PlayStation 4 Slim 500 GB - Czarny + Minecraft', 'Sony', 'konsole', '#E1F0FE', 'PS4S-500-BK-B+MINECRAFT', 'PS4S-500-BK-B+MINECRAFT', 'dobry', 1029, 17, 37),
  ('sony-playstation-4-slim-500-gb-czarny-star-wars-battlefront-ii-b', 'PlayStation 4 Slim 500 GB - Czarny + Star Wars: Battlefront II', 'Sony', 'konsole', '#E1F0FE', 'PS4S-500-BK-B-SW2', 'PS4S-500-BK-B-SW2', 'dobry', 839, 14, 38),
  ('sony-playstation-4-slim-500-gb-czarny-the-last-of-us-remastered-ratche-b', 'PlayStation 4 Slim 500 GB - Czarny + The Last of Us Remastered + Ratchet & Clank + Uncharted 4 A Thief''s End', 'Sony', 'konsole', '#E1F0FE', 'PS4S-500-BK-B-1M+TLOU+R&C+U4', 'PS4S-500-BK-B-1M+TLOU+R-C+U4', 'dobry', 1019, 3, 39),
  ('sony-playstation-4-slim-500-gb-czarny-edycja-limitowana-the-last-of-us-a', 'PlayStation 4 Slim 500 GB - Czarny - Edycja limitowana The Last of Us Remastered + The Last of Us Remastered', 'Sony', 'konsole', '#E1F0FE', 'PS4S-500-BK-A+TLOU', 'PS4S-500-BK-A+TLOU', 'bardzo-dobry', 1049, 10, 40),
  ('sony-playstation-4-slim-500-gb-czarny-edycja-limitowana-uncharted-4-a-a', 'PlayStation 4 Slim 500 GB - Czarny - Edycja limitowana Uncharted 4: A Thief´s End + God Of War + The Last of Us: Remastered + Uncharted 4: A Thief´s End + God Of War + The Last of Us: Remastered', 'Sony', 'konsole', '#E1F0FE', 'PS4SLIM-05TB-BLA-A2 + mega pack', 'PS4SLIM-05TB-BLA-A2+MEGA-PACK', 'bardzo-dobry', 1349, 5, 41),
  ('sony-playstation-5-825-gb-bialy-gran-turismo-7-b', 'PlayStation 5 825 GB - Biały + Gran Turismo 7', 'Sony', 'konsole', '#E1F0FE', 'PS5-825-WE-B+GT7', 'PS5-825-WE-B+GT7', 'dobry', 3279, 3, 42),
  ('sony-playstation-5-digital-825-gb-bialy-b', 'PlayStation 5 Digital 825 GB - Biały', 'Sony', 'konsole', '#E1F0FE', 'PS5DE-W-825-B', 'PS5DE-W-825-B', 'dobry', 3279, 9, 43),
  ('sony-playstation-5-slim-digital-825-gb-bialy-b', 'PlayStation 5 Slim Digital 825 GB - Biały', 'Sony', 'konsole', '#E1F0FE', 'PS5DS-825-WH-B', 'PS5DS-825-WH-B', 'dobry', 3279, 3, 44),
  ('nintendo-switch-32-gb-niebieski-animal-crossing-new-horizons-a', 'Switch 32 GB - Niebieski + Animal Crossing: New Horizons', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Blue _Animal Crossing: New Horizons A', 'SWITCH-32GB-BLUE-ANIMAL-CROSSING-NEW-HORIZONS-A', 'bardzo-dobry', 1359, 6, 45),
  ('nintendo-switch-32-gb-niebieski-mario-odyssey-a', 'Switch 32 GB - Niebieski + Mario Odyssey', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Blue - Limited edition Standard + Mario Odyssey A', 'SWITCH-32GB-BLUE-LIMITED-EDITION-STANDARD+MARIO-ODYSSEY-A', 'bardzo-dobry', 1379, 20, 46),
  ('nintendo-switch-32-gb-niebieski-mario-odyssey-b', 'Switch 32 GB - Niebieski + Mario Odyssey', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Turquoise Standard Mario Odyssey', 'SWITCH-32GB-TURQUOISE-STANDARD-MARIO-ODYSSEY', 'dobry', 1399, 4, 47),
  ('nintendo-switch-32-gb-niebieski-minecraft-a', 'Switch 32 GB - Niebieski + Minecraft', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Blue + Minecraft A', 'SWITCH-32GB-BLUE+MINECRAFT-A', 'bardzo-dobry', 1359, 9, 48),
  ('nintendo-switch-32-gb-niebieski-minecraft-b', 'Switch 32 GB - Niebieski + Minecraft', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Turquoise Standard + Minecraft', 'SWITCH-32GB-TURQUOISE-STANDARD+MINECRAFT', 'dobry', 1399, 3, 49),
  ('nintendo-switch-32-gb-niebieski-szary-edycja-limitowana-blue-grey-b', 'Switch 32 GB - Niebieski/Szary - Edycja limitowana Blue Grey', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Blue/Grey - Limited edition Blue Grey B', 'SWITCH-32GB-BLUE-GREY-LIMITED-EDITION-BLUE-GREY-B', 'dobry', 1009, 7, 50),
  ('nintendo-switch-32-gb-niebieski-zolty-edycja-limitowana-blue-yellow-a', 'Switch 32 GB - Niebieski/Żółty - Edycja limitowana Blue Yellow', 'Nintendo', 'konsole', '#FDECF0', 'NS-BY-A', 'NS-BY-A', 'bardzo-dobry', 1129, 8, 51),
  ('nintendo-switch-32-gb-szary-animal-crossing-new-horizons-a', 'Switch 32 GB - Szary + Animal Crossing: New Horizons', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Grey + Animal Crossing: New Horizons A', 'SWITCH-32GB-GREY+ANIMAL-CROSSING-NEW-HORIZONS-A', 'bardzo-dobry', 1359, 10, 52),
  ('nintendo-switch-32-gb-szary-mario-kart-deluxe-a', 'Switch 32 GB - Szary + Mario Kart Deluxe', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-BRB-A+MKD', 'NS-V1V2-BRB-A+MKD', 'bardzo-dobry', 1399, 7, 53),
  ('nintendo-switch-32-gb-szary-mario-kart-deluxe-b', 'Switch 32 GB - Szary + Mario Kart Deluxe', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-BRB-B+MKD', 'NS-V1V2-BRB-B+MKD', 'dobry', 1269, 100, 54),
  ('nintendo-switch-32-gb-szary-mario-party-superstars-a', 'Switch 32 GB - Szary + Mario Party Superstars', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Grey + Mario Party Superstars A', 'SWITCH-32GB-GREY+MARIO-PARTY-SUPERSTARS-A', 'bardzo-dobry', 1389, 10, 55),
  ('nintendo-switch-32-gb-szary-mario-party-superstars-b', 'Switch 32 GB - Szary + Mario Party Superstars', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Grey + Mario Party Superstars', 'SWITCH-32GB-GREY+MARIO-PARTY-SUPERSTARS', 'dobry', 1369, 10, 56),
  ('nintendo-switch-32-gb-szary-minecraft-a', 'Switch 32 GB - Szary + Minecraft', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-GY-A+MINECRAFT', 'NS-V1V2-GY-A+MINECRAFT', 'bardzo-dobry', 1359, 9, 57),
  ('nintendo-switch-32-gb-szary-pokemon-brilliant-diamond-b', 'Switch 32 GB - Szary + Pokémon Brilliant Diamond', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Grey + Pokémon Brilliant Diamond', 'SWITCH-32GB-GREY+POKEMON-BRILLIANT-DIAMOND', 'dobry', 1339, 5, 58),
  ('nintendo-switch-32-gb-szary-super-mario-bros-u-deluxe-a', 'Switch 32 GB - Szary + Super Mario Bros U Deluxe', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Grey + Super Mario Bros U Deluxe A', 'SWITCH-32GB-GREY+SUPER-MARIO-BROS-U-DELUXE-A', 'bardzo-dobry', 1359, 10, 59),
  ('nintendo-switch-32-gb-szary-super-mario-bros-u-deluxe-b', 'Switch 32 GB - Szary + Super Mario Bros U Deluxe', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-BRB-A+SMBUD', 'NS-V1V2-BRB-A+SMBUD', 'dobry', 1399, 7, 60),
  ('nintendo-switch-32-gb-szary-zelda-breath-of-the-wild-a', 'Switch 32 GB - Szary + Zelda Breath Of The Wild', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Grey + Zelda Breath Of The Wild A', 'SWITCH-32GB-GREY+ZELDA-BREATH-OF-THE-WILD-A', 'bardzo-dobry', 1359, 9, 61),
  ('nintendo-switch-32-gb-szary-edycja-limitowana-fortnite-edition-a', 'Switch 32 GB - Szary - Edycja limitowana Fortnite Edition', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Grey - Limited edition Fortnite Edition', 'SWITCH-32GB-GREY-LIMITED-EDITION-FORTNITE-EDITION', 'bardzo-dobry', 1969, 1, 62),
  ('nintendo-switch-32-gb-szary-mario-odyssey-a', 'Switch 32 GB - Szary + Mario odyssey', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Grey - Limited edition Standard + Mario odyssey A', 'SWITCH-32GB-GREY-LIMITED-EDITION-STANDARD+MARIO-ODYSSEY-A', 'bardzo-dobry', 1309, 98, 63),
  ('nintendo-switch-32-gb-szary-zelda-breath-of-the-wild-a-2', 'Switch 32 GB - Szary + Zelda Breath Of The Wild', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Grey+ Zelda Breath Of The Wild', 'SWITCH-32GB-GREY+ZELDA-BREATH-OF-THE-WILD', 'bardzo-dobry', 1359, 10, 64),
  ('nintendo-switch-32-gb-szary-edycja-limitowana-super-smash-bros-ultimat-a', 'Switch 32 GB - Szary - Edycja limitowana Super Smash Bros Ultimate + Super Smash Bros Ultimate', 'Nintendo', 'konsole', '#FDECF0', 'NS-SSBU+SSBU', 'NS-SSBU+SSBU', 'bardzo-dobry', 1749, 1, 65),
  ('nintendo-switch-32-gb-fioletowy-pomaranczowy-edycja-limitowana-purple-b', 'Switch 32 GB - Fioletowy/Pomarańczowy - Edycja limitowana Purple Orange', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-PO-B', 'NS-V1V2-PO-B', 'dobry', 1009, 3, 66),
  ('nintendo-switch-32-gb-czarny-mario-rabbids-kingdom-battle-a', 'Switch 32 GB - Czarny + Mario + Rabbids Kingdom Battle', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + Mario + Rabbids Kingdom Battle A', 'SWITCH-32GB-BLACK+MARIO+RABBIDS-KINGDOM-BATTLE-A', 'bardzo-dobry', 1439, 9, 67),
  ('nintendo-switch-32-gb-czarny-mario-kart-8-deluxe-a', 'Switch 32 GB - Czarny + Mario Kart 8 Deluxe', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + Mario Kart 8 Deluxe A', 'SWITCH-32GB-BLACK+MARIO-KART-8-DELUXE-A', 'bardzo-dobry', 1369, 4, 68),
  ('nintendo-switch-32-gb-czarny-mario-kart-8-deluxe-b', 'Switch 32 GB - Czarny + Mario Kart 8 Deluxe', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + Mario Kart 8 Deluxe B', 'SWITCH-32GB-BLACK+MARIO-KART-8-DELUXE-B', 'dobry', 1329, 24, 69),
  ('nintendo-switch-32-gb-czarny-new-super-mario-bros-u-deluxe-a', 'Switch 32 GB - Czarny + New Super Mario Bros U Deluxe', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + New Super Mario Bros U Deluxe A', 'SWITCH-32GB-BLACK+NEW-SUPER-MARIO-BROS-U-DELUXE-A', 'bardzo-dobry', 1429, 7, 70),
  ('nintendo-switch-32-gb-czarny-new-super-mario-bros-u-deluxe-b', 'Switch 32 GB - Czarny + New Super Mario Bros U Deluxe', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + New Super Mario Bros U Deluxe', 'SWITCH-32GB-BLACK+NEW-SUPER-MARIO-BROS-U-DELUXE', 'dobry', 1389, 49, 71),
  ('nintendo-switch-32-gb-czarny-ring-fit-adventure-a', 'Switch 32 GB - Czarny + Ring Fit Adventure', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + Ring Fit Adventure A', 'SWITCH-32GB-BLACK+RING-FIT-ADVENTURE-A', 'bardzo-dobry', 1199, 10, 72),
  ('nintendo-switch-32-gb-czarny-ring-fit-adventure-b', 'Switch 32 GB - Czarny + Ring Fit Adventure', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-BRB-B+RFA', 'NS-V1V2-BRB-B+RFA', 'dobry', 1089, 5, 73),
  ('nintendo-switch-32-gb-czarny-splatoon-2-b', 'Switch 32 GB - Czarny + Splatoon 2', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + Splatoon 2', 'SWITCH-32GB-BLACK+SPLATOON-2', 'dobry', 1159, 19, 74),
  ('nintendo-switch-32-gb-czarny-splatoon-3-a', 'Switch 32 GB - Czarny + Splatoon 3', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + Splatoon 3 A', 'SWITCH-32GB-BLACK+SPLATOON-3-A', 'bardzo-dobry', 1309, 9, 75),
  ('nintendo-switch-32-gb-czarny-splatoon-3-b', 'Switch 32 GB - Czarny + Splatoon 3', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + Splatoon 3', 'SWITCH-32GB-BLACK+SPLATOON-3', 'dobry', 1399, 2, 76),
  ('nintendo-switch-32-gb-czarny-super-mario-party-a', 'Switch 32 GB - Czarny + Super Mario Party', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + Super Mario Party A', 'SWITCH-32GB-BLACK+SUPER-MARIO-PARTY-A', 'bardzo-dobry', 1329, 7, 77),
  ('nintendo-switch-32-gb-czarny-super-mario-party-b', 'Switch 32 GB - Czarny + Super Mario Party', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + Super Mario Party', 'SWITCH-32GB-BLACK+SUPER-MARIO-PARTY', 'dobry', 1319, 18, 78),
  ('nintendo-switch-32-gb-czarny-super-smash-bros-ultimate-a', 'Switch 32 GB - Czarny + Super Smash Bros Ultimate', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + Super Smash Bros Ultimate A', 'SWITCH-32GB-BLACK+SUPER-SMASH-BROS-ULTIMATE-A', 'bardzo-dobry', 1439, 10, 79),
  ('nintendo-switch-32-gb-czarny-super-smash-bros-ultimate-b', 'Switch 32 GB - Czarny + Super Smash Bros Ultimate', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + Super Smash Bros Ultimate', 'SWITCH-32GB-BLACK+SUPER-SMASH-BROS-ULTIMATE', 'dobry', 1269, 4, 80),
  ('nintendo-switch-32-gb-czarny-zleda-breath-of-the-wild-a', 'Switch 32 GB - Czarny + Zleda: Breath Of The Wild', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black + Zleda: Breath Of The Wild A', 'SWITCH-32GB-BLACK+ZLEDA-BREATH-OF-THE-WILD-A', 'bardzo-dobry', 1399, 10, 81),
  ('nintendo-switch-32-gb-czarny-mario-kart-8-deluxe-a-2', 'Switch 32 GB - Czarny + Mario Kart 8 Deluxe', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black- SzareJC + Mario Kart 8 Deluxe A', 'SWITCH-32GB-BLACK-SZAREJC+MARIO-KART-8-DELUXE-A', 'bardzo-dobry', 1359, 16, 82),
  ('nintendo-switch-32-gb-czarny-edycja-limitowana-pokemon-shield-pokemon-b', 'Switch 32 GB - Czarny - Edycja limitowana Pokémon Shield + Pokémon Shield', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black - Limited edition Pokémon Shield + Pokémon Shield B', 'SWITCH-32GB-BLACK-LIMITED-EDITION-POKEMON-SHIELD+POKEMON-SHIELD-B', 'dobry', 1309, 10, 83),
  ('nintendo-switch-32-gb-czarny-luigi-s-mansion-3-a', 'Switch 32 GB - Czarny + Luigi''s Mansion 3', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black - Limited edition Standard + Luigi''s Mansion 3 A', 'SWITCH-32GB-BLACK-LIMITED-EDITION-STANDARD+LUIGI-S-MANSION-3-A', 'bardzo-dobry', 1359, 9, 84),
  ('nintendo-switch-32-gb-czarny-luigi-s-mansion-3-b', 'Switch 32 GB - Czarny + Luigi''s Mansion 3', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black Standard + Luigi''s Mansion 3', 'SWITCH-32GB-BLACK-STANDARD+LUIGI-S-MANSION-3', 'dobry', 1399, 5, 85),
  ('nintendo-switch-32-gb-czarny-super-mario-party-jamboree-a', 'Switch 32 GB - Czarny + Super Mario Party Jamboree', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black - Limited edition Standard + Super Mario Party Jamboree A', 'SWITCH-32GB-BLACK-LIMITED-EDITION-STANDARD+SUPER-MARIO-PARTY-JAMBOREE-A', 'bardzo-dobry', 1399, 19, 86),
  ('nintendo-switch-32-gb-czarny-super-mario-party-jamboree-b', 'Switch 32 GB - Czarny + Super Mario Party Jamboree', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black Standard + Super Mario Party Jamboree', 'SWITCH-32GB-BLACK-STANDARD+SUPER-MARIO-PARTY-JAMBOREE', 'dobry', 1399, 7, 87),
  ('nintendo-switch-32-gb-czarny-zelda-tears-of-the-kingdom-b', 'Switch 32 GB - Czarny + Zelda Tears of the kingdom', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-BRB-B-ZT', 'NS-V1V2-BRB-B-ZT', 'dobry', 1499, 1, 88),
  ('nintendo-switch-32-gb-czarny-edycja-limitowana-super-mario-odyssey-sup-a', 'Switch 32 GB - Czarny - Edycja limitowana Super Mario Odyssey + Super Mario Odyssey', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Black - Limited edition Super Mario Odyssey + Super Mario Odyssey A', 'SWITCH-32GB-BLACK-LIMITED-EDITION-SUPER-MARIO-ODYSSEY+SUPER-MARIO-ODYSSEY-A', 'bardzo-dobry', 1439, 10, 89),
  ('nintendo-switch-32-gb-czerwony-edycja-limitowana-super-mario-odyssey-a', 'Switch 32 GB - Czerwony - Edycja limitowana Super Mario Odyssey', 'Nintendo', 'konsole', '#FDECF0', 'Switch 32GB - Red - Limited edition Super Mario Odyssey A', 'SWITCH-32GB-RED-LIMITED-EDITION-SUPER-MARIO-ODYSSEY-A', 'bardzo-dobry', 1399, 10, 90),
  ('nintendo-switch-32-gb-czerwony-edycja-limitowana-super-mario-odyssey-s-a', 'Switch 32 GB - Czerwony - Edycja limitowana Super Mario Odyssey + Super Mario Odyssey', 'Nintendo', 'konsole', '#FDECF0', 'NS-SMO-A+SMO', 'NS-SMO-A+SMO', 'bardzo-dobry', 1579, 2, 91),
  ('nintendo-switch-32-gb-zielony-rozowy-edycja-limitowana-green-pink-a', 'Switch 32 GB - Zielony/Różowy - Edycja limitowana Green Pink', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-GP-A', 'NS-V1V2-GP-A', 'bardzo-dobry', 1079, 35, 92),
  ('nintendo-switch-32-gb-zielony-rozowy-edycja-limitowana-green-pink-b', 'Switch 32 GB - Zielony/Różowy - Edycja limitowana Green Pink', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-GN-B', 'NS-V1V2-GN-B', 'dobry', 989, 36, 93),
  ('nintendo-switch-32-gb-szary-a', 'Switch 32 GB - Szary', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-GY-A', 'NS-V1V2-GY-A', 'bardzo-dobry', 1029, 15, 94),
  ('nintendo-switch-32-gb-szary-b', 'Switch 32 GB - Szary', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-GY-B', 'NS-V1V2-GY-B', 'dobry', 979, 14, 95),
  ('nintendo-switch-32-gb-czerwony-niebieski-a', 'Switch 32 GB - Czerwony/Niebieski', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-BRB-A', 'NS-V1V2-BRB-A', 'bardzo-dobry', 1049, 5, 96),
  ('nintendo-switch-32-gb-czerwony-niebieski-b', 'Switch 32 GB - Czerwony/Niebieski', 'Nintendo', 'konsole', '#FDECF0', 'NS-V1V2-BRB-B', 'NS-V1V2-BRB-B', 'dobry', 939, 4, 97),
  ('nintendo-switch-lite-32-gb-szary-edycja-limitowana-zacian-and-zamazent-a', 'Switch Lite 32 GB - Szary - Edycja limitowana Zacian and Zamazenta', 'Nintendo', 'konsole', '#FDECF0', 'NSL-LE-B', 'NSL-LE-B', 'bardzo-dobry', 919, 1, 98),
  ('nintendo-switch-lite-32-gb-zolty-c', 'Switch Lite 32 GB - Żółty', 'Nintendo', 'konsole', '#FDECF0', 'NSL-YW-C', 'NSL-YW-C', 'zadowalajacy', 759, 2, 99),
  ('nintendo-switch-lite-32-gb-zolty-b', 'Switch Lite 32 GB - Żółty', 'Nintendo', 'konsole', '#FDECF0', 'NSL-YW-B', 'NSL-YW-B', 'dobry', 799, 1, 100),
  ('nintendo-switch-lite-32-gb-zolty-a', 'Switch Lite 32 GB - Żółty', 'Nintendo', 'konsole', '#FDECF0', 'NSL-YW-A', 'NSL-YW-A', 'bardzo-dobry', 839, 1, 101),
  ('nintendo-switch-oled-64-gb-bialy-mario-kart-8-deluxe-a', 'Switch OLED 64 GB - Biały + Mario Kart 8 deluxe', 'Nintendo', 'konsole', '#FDECF0', 'NSO-WH-A+MKD', 'NSO-WH-A+MKD', 'bardzo-dobry', 1609, 10, 102),
  ('nintendo-switch-oled-64-gb-bialy-mario-kart-8-deluxe-b', 'Switch OLED 64 GB - Biały + Mario Kart 8 deluxe', 'Nintendo', 'konsole', '#FDECF0', 'Switch OLED 64GB - White Mario Kart 8 deluxe B', 'SWITCH-OLED-64GB-WHITE-MARIO-KART-8-DELUXE-B', 'dobry', 1419, 8, 103),
  ('nintendo-switch-oled-64-gb-szary-paper-mario-origami-king-b', 'Switch OLED 64 GB - Szary + Paper Mario Origami King', 'Nintendo', 'konsole', '#FDECF0', 'NSO-WH-B+PMOK', 'NSO-WH-B+PMOK', 'dobry', 1349, 1, 104),
  ('nintendo-switch-oled-64-gb-czerwony-edycja-limitowana-super-mario-red-a', 'Switch OLED 64 GB - Czerwony - Edycja limitowana Super Mario Red', 'Nintendo', 'konsole', '#FDECF0', 'NSO-RED-A', 'NSO-RED-A', 'bardzo-dobry', 1399, 2, 105),
  ('nintendo-switch-oled-64-gb-czerwony-edycja-limitowana-super-mario-red-b', 'Switch OLED 64 GB - Czerwony - Edycja limitowana Super Mario Red', 'Nintendo', 'konsole', '#FDECF0', 'NSO-RED-B', 'NSO-RED-B', 'dobry', 1299, 1, 106),
  ('nintendo-switch-oled-64-gb-bialy-b', 'Switch OLED 64 GB - Biały', 'Nintendo', 'konsole', '#FDECF0', 'NSO-WH-B', 'NSO-WH-B', 'dobry', 1169, 3, 107),
  ('nintendo-switch-oled-64-gb-czerwony-niebieski-b', 'Switch OLED 64 GB - Czerwony/Niebieski', 'Nintendo', 'konsole', '#FDECF0', 'NSO-BRB-B', 'NSO-BRB-B', 'dobry', 1129, 29, 108),
  ('microsoft-xbox-one-s-1-tb-bialy-battlefield-v-b', 'Xbox One S 1 TB - Biały + Battlefield V', 'Microsoft', 'konsole', '#D9F8EF', 'Xbox One S 1000GB - White + Battlefield V', 'XBOX-ONE-S-1000GB-WHITE+BATTLEFIELD-V', 'dobry', 1089, 3, 109),
  ('microsoft-xbox-one-s-1-tb-bialy-forza-horizon-3-a', 'Xbox One S 1 TB - Biały + Forza Horizon 3', 'Microsoft', 'konsole', '#D9F8EF', 'XOS-1T-A FH3', 'XOS-1T-A-FH3', 'bardzo-dobry', 1089, 2, 110),
  ('microsoft-xbox-one-s-1-tb-bialy-forza-horizon-3-b', 'Xbox One S 1 TB - Biały + Forza Horizon 3', 'Microsoft', 'konsole', '#D9F8EF', 'XOS-1T-B FH3', 'XOS-1T-B-FH3', 'dobry', 1309, 2, 111),
  ('microsoft-xbox-one-s-1-tb-bialy-forza-horizon-4-b', 'Xbox One S 1 TB - Biały + Forza Horizon 4', 'Microsoft', 'konsole', '#D9F8EF', 'Xbox One S 1000GB - White + Forza Horizon 4', 'XBOX-ONE-S-1000GB-WHITE+FORZA-HORIZON-4', 'dobry', 1229, 3, 112),
  ('microsoft-xbox-one-s-1-tb-bialy-middle-earth-shadow-of-war-b', 'Xbox One S 1 TB - Biały + Middle-earth: Shadow of War', 'Microsoft', 'konsole', '#D9F8EF', 'XOS-1TB-WE-B+SHOW', 'XOS-1TB-WE-B+SHOW', 'dobry', 1309, 1, 113),
  ('microsoft-xbox-one-s-1-tb-bialy-player-unknown-s-battlegrounds-b', 'Xbox One S 1 TB - Biały + Player Unknown''s Battlegrounds', 'Microsoft', 'konsole', '#D9F8EF', 'Xbox One S 1000GB - PUB - B', 'XBOX-ONE-S-1000GB-PUB-B', 'dobry', 1129, 3, 114),
  ('microsoft-xbox-one-s-1-tb-bialy-rocket-league-b', 'Xbox One S 1 TB - Biały + Rocket League', 'Microsoft', 'konsole', '#D9F8EF', 'Xbox One S 1000GB - White + Rocket League', 'XBOX-ONE-S-1000GB-WHITE+ROCKET-LEAGUE', 'dobry', 1089, 3, 115),
  ('microsoft-xbox-one-s-1-tb-bialy-sea-of-thieves-b', 'Xbox One S 1 TB - Biały + Sea of Thieves', 'Microsoft', 'konsole', '#D9F8EF', 'Xbox One S 1000GB - White + Sea of ​​Thieves', 'XBOX-ONE-S-1000GB-WHITE+SEA-OF-THIEVES', 'dobry', 1089, 3, 116),
  ('microsoft-xbox-one-s-1-tb-bialy-star-wars-jedi-fallen-order-b', 'Xbox One S 1 TB - Biały + Star Wars: Jedi Fallen Order', 'Microsoft', 'konsole', '#D9F8EF', 'Xbox One S 1000GB - White + Star Wars: Jedi Fallen Order', 'XBOX-ONE-S-1000GB-WHITE+STAR-WARS-JEDI-FALLEN-ORDER', 'dobry', 1089, 5, 117),
  ('microsoft-xbox-one-s-500-gb-bialy-assassin-s-creed-origins-b', 'Xbox One S 500 GB - Biały + Assassin''s Creed Origins', 'Microsoft', 'konsole', '#D9F8EF', 'Xbox One S 500GB - White + Assassin''s Creed Origins', 'XBOX-ONE-S-500GB-WHITE+ASSASSIN-S-CREED-ORIGINS', 'dobry', 989, 3, 118),
  ('microsoft-xbox-one-s-500-gb-bialy-battlefield-1-b', 'Xbox One S 500 GB - Biały + Battlefield 1', 'Microsoft', 'konsole', '#D9F8EF', 'XOS-500-B Battlefield 1', 'XOS-500-B-BATTLEFIELD-1', 'dobry', 1309, 3, 119),
  ('microsoft-xbox-one-s-500-gb-bialy-forza-horizon-3-b', 'Xbox One S 500 GB - Biały + Forza Horizon 3', 'Microsoft', 'konsole', '#D9F8EF', 'XOS-500-B FH3', 'XOS-500-B-FH3', 'dobry', 969, 3, 120),
  ('microsoft-xbox-one-s-500-gb-bialy-grand-theft-auto-v-b', 'Xbox One S 500 GB - Biały + Grand Theft Auto V', 'Microsoft', 'konsole', '#D9F8EF', 'Xbox One S 500GB - White + Grand Theft Auto 5', 'XBOX-ONE-S-500GB-WHITE+GRAND-THEFT-AUTO-5', 'dobry', 999, 1, 121),
  ('microsoft-xbox-one-s-500-gb-bialy-middle-earth-shadow-of-war-b', 'Xbox One S 500 GB - Biały + Middle-earth: Shadow of War', 'Microsoft', 'konsole', '#D9F8EF', 'Xbox One S 500GB - White + Middle-earth: Shadow of War', 'XBOX-ONE-S-500GB-WHITE+MIDDLE-EARTH-SHADOW-OF-WAR', 'dobry', 1009, 3, 122),
  ('microsoft-xbox-one-s-500-gb-bialy-minecraft-b', 'Xbox One S 500 GB - Biały + Minecraft', 'Microsoft', 'konsole', '#D9F8EF', 'Xbox One S 500GB - White + Minecraft', 'XBOX-ONE-S-500GB-WHITE+MINECRAFT', 'dobry', 1069, 2, 123),
  ('microsoft-xbox-one-x-1-tb-czarny-forza-horizon-4-forza-motorsport-7-b', 'Xbox One X 1 TB - Czarny + Forza Horizon 4 + Forza Motorsport 7', 'Microsoft', 'konsole', '#D9F8EF', 'XOX-1TB-BK-B+FH4/FM7', 'XOX-1TB-BK-B+FH4-FM7', 'dobry', 1579, 2, 124),
  ('microsoft-xbox-one-x-1-tb-czarny-shadow-of-the-tomb-raider-b', 'Xbox One X 1 TB - Czarny + Shadow of the Tomb Raider', 'Microsoft', 'konsole', '#D9F8EF', 'XOX-1TB-BK-B+SHTR', 'XOX-1TB-BK-B+SHTR', 'dobry', 1269, 4, 125),
  ('microsoft-xbox-series-s-digital-500-gb-bialy-b', 'Xbox Series S Digital 500 GB - Biały', 'Microsoft', 'konsole', '#D9F8EF', 'XSS-512-WE-B-1M', 'XSS-512-WE-B-1M-BM', 'dobry', 1749, 1, 126),
  ('microsoft-xbox-series-x-1-tb-czarny-b', 'Xbox Series X 1 TB - Czarny', 'Microsoft', 'konsole', '#D9F8EF', 'XSX-1TB-BK-B', 'XSX-1TB-BK-B', 'dobry', 3499, 3, 127),
  ('microsoft-xbox-series-x-1-tb-czarny-a', 'Xbox Series X 1 TB - Czarny', 'Microsoft', 'konsole', '#D9F8EF', 'XSX-1TB-BK-A-1M', 'XSX-1TB-BK-A-1M-BM', 'bardzo-dobry', 3499, 2, 128),
  ('sony-a6000-czarny-obiektyw-e-16-50-mm-f-3-5-5-6-pz-oss-b', 'Sony A6000 - Czarny + obiektyw E 16-50 mm f/3.5-5.6 PZ OSS', 'Sony', 'aparaty', '#E7EBFA', '473506 (3/5)', '473506-3-5', 'dobry', 2579, 3, 129),
  ('sony-a6400-czarny-obiektyw-e-16-50mm-f-3-5-5-6-pz-oss-a', 'Sony A6400 - Czarny + obiektyw E 16-50mm f/3.5-5.6 PZ OSS', 'Sony', 'aparaty', '#E7EBFA', '261337 (5/5)', '261337-5-5', 'bardzo-dobry', 3849, 1, 130),
  ('sony-alpha-a5000-bialy-obiektyw-e-16-50mm-f-3-5-5-6-pz-oss-a', 'Sony Alpha A5000 - Biały + obiektyw E 16-50mm f/3.5-5.6 PZ OSS', 'Sony', 'aparaty', '#E7EBFA', '473435 (5/5)', '473435-5-5', 'bardzo-dobry', 1969, 2, 131),
  ('sony-alpha-a5000-bialy-obiektyw-e-16-50mm-f-3-5-5-6-pz-oss-b', 'Sony Alpha A5000 - Biały + obiektyw E 16-50mm f/3.5-5.6 PZ OSS', 'Sony', 'aparaty', '#E7EBFA', '473435 (3/5)', '473435-3-5', 'dobry', 1749, 1, 132),
  ('sony-alpha-7c-czarny-srebrny-obiektyw-fe-28-60mm-f-3-5-5-6-a', 'Sony Alpha 7C - Czarny/Srebrny + obiektyw FE 28-60mm f/3.5-5.6', 'Sony', 'aparaty', '#E7EBFA', '5676972 (5/5)', '5676972-5-5', 'bardzo-dobry', 5989, 1, 133),
  ('panasonic-lumix-dc-g90-czarny-obiektyw-g-vario-14-42mm-f-3-5-5-6-asph-a', 'Panasonic Lumix DC-G90 - Czarny + obiektyw G Vario 14-42mm f/3.5-5.6 ASPH Mega OIS', 'Panasonic', 'aparaty', '#E7EBFA', '4272763 (5/5)', '4272763-5-5', 'bardzo-dobry', 3719, 1, 134),
  ('sony-cyber-shot-dsc-rx10-czarny-obiektyw-carl-zeiss-vario-sonnar-t-24-b', 'Sony Cyber-shot DSC-RX10 - Czarny + obiektyw Carl Zeiss Vario-Sonnar T* 24-200mm f/2.8', 'Sony', 'aparaty', '#E7EBFA', '286413 (3/5)', '286413-3-5', 'dobry', 1929, 1, 135),
  ('panasonic-lumix-dmc-g7-czarny-body-a', 'Panasonic Lumix DMC-G7 - Czarny (body)', 'Panasonic', 'aparaty', '#E7EBFA', '905057 (5/5)', '905057-5-5', 'bardzo-dobry', 1749, 1, 136),
  ('panasonic-lumix-dmc-lx100e-k-czarny-obiektyw-leica-dc-vario-summilux-2-b', 'Panasonic Lumix DMC-LX100E-K - Czarny + obiektyw Leica DC Vario-Summilux 24-75mm f/1.7–2.8 ASPH', 'Panasonic', 'aparaty', '#E7EBFA', '13885 (3/5)', '13885-3-5', 'dobry', 2619, 2, 137),
  ('panasonic-lumix-dmc-tz70-czarny-srebrny-obiektyw-leica-dc-vario-elmar-b', 'Panasonic Lumix DMC-TZ70 - Czarny/Srebrny + obiektyw Leica DC Vario-Elmar 24–720mm f/3.3–6.4 ASPH', 'Panasonic', 'aparaty', '#E7EBFA', '304413 (3/5)', '304413-3-5', 'dobry', 1749, 1, 138),
  ('panasonic-lumix-dc-gx800-czarny-obiektyw-g-vario-12-32-mm-f-3-5-5-6-a', 'Panasonic Lumix DC-GX800 - Czarny + obiektyw G Vario 12-32 mm f/3.5-5.6', 'Panasonic', 'aparaty', '#E7EBFA', '124927 (5/5)', '124927-5-5', 'bardzo-dobry', 2189, 1, 139),
  ('canon-eos-m-czarny-obiektyw-ef-m-18-55mm-f-3-5-5-6-is-stm-b', 'Canon EOS M - Czarny + obiektyw EF-M 18-55mm f/3.5-5.6 IS STM', 'Canon', 'aparaty', '#E7EBFA', '155302 (3/5)', '155302-3-5', 'dobry', 1589, 1, 140),
  ('canon-eos-m10-bialy-obiektyw-ef-m-15-45-mm-f-3-5-6-3-is-stm-a', 'Canon EOS M10 - Biały + obiektyw EF-M 15-45 mm f/3.5-6.3 IS STM', 'Canon', 'aparaty', '#E7EBFA', '280819 (5/5)', '280819-5-5', 'bardzo-dobry', 1669, 1, 141),
  ('canon-eos-m10-czarny-obiektyw-ef-m-15-45mm-f-3-5-6-3-is-stm-a', 'Canon EOS M10 - Czarny + obiektyw EF-M 15-45mm f/3.5-6.3 IS STM', 'Canon', 'aparaty', '#E7EBFA', '3122434 (5/5)', '3122434-5-5', 'bardzo-dobry', 1799, 1, 142),
  ('canon-eos-m10-czarny-obiektyw-ef-m-15-45mm-f-3-5-6-3-is-stm-b', 'Canon EOS M10 - Czarny + obiektyw EF-M 15-45mm f/3.5-6.3 IS STM', 'Canon', 'aparaty', '#E7EBFA', '3122434 3/5', '3122434-3-5', 'dobry', 1789, 1, 143),
  ('canon-eos-m3-czarny-obiektyw-ef-m-15-45-mm-f-3-5-5-6-is-stm-b', 'Canon EOS M3 - Czarny + obiektyw EF-M 15-45 mm f/3.5-5.6 IS STM', 'Canon', 'aparaty', '#E7EBFA', '328753 (3/5)', '328753-3-5', 'dobry', 2189, 1, 144),
  ('canon-eos-m50-czarny-body-b', 'Canon EOS M50 - Czarny (body)', 'Canon', 'aparaty', '#E7EBFA', '351883 (3/5)', '351883-3-5', 'dobry', 1749, 1, 145),
  ('panasonic-lumix-dmc-g6k-czarny-obiektyw-g-vario-mega-o-i-s-f-3-5-5-6-b', 'Panasonic Lumix DMC-G6K - Czarny + obiektyw G Vario Mega O.I.S f/3.5-5.6', 'Panasonic', 'aparaty', '#E7EBFA', '448928 (3/5)', '448928-3-5', 'dobry', 1749, 1, 146),
  ('panasonic-lumix-dmc-g7-czarny-obiektyw-g-vario-12-60mm-f-3-5-5-6-asph-a', 'Panasonic Lumix DMC-G7 - Czarny + obiektyw G Vario 12-60mm f/3.5-5.6 ASPH Power O.I.S.', 'Panasonic', 'aparaty', '#E7EBFA', '412911 (5/5)', '412911-5-5', 'bardzo-dobry', 2409, 1, 147),
  ('panasonic-lumix-dmc-g7-czarny-obiektyw-g-vario-14-42mm-f-3-5-5-6-sph-a', 'Panasonic Lumix DMC-G7 - Czarny + obiektyw G Vario 14-42mm f/3.5-5.6 АSPH', 'Panasonic', 'aparaty', '#E7EBFA', '577776 (5/5)', '577776-5-5', 'bardzo-dobry', 2409, 1, 148),
  ('panasonic-lumix-dmc-g80-czarny-obiektyw-g-vario-12-60mm-f-3-5-5-6-asph-a', 'Panasonic Lumix DMC-G80 - Czarny + obiektyw G Vario 12-60mm f/3.5-5.6 ASPH. Power O.I.S.', 'Panasonic', 'aparaty', '#E7EBFA', '513674 (5/5)', '513674-5-5', 'bardzo-dobry', 2759, 1, 149),
  ('olympus-om-d-e-m10-czarny-body-b', 'Olympus OM-D E-M10 - Czarny (body)', 'Olympus', 'aparaty', '#E7EBFA', '118412 (3/5)', '118412-3-5', 'dobry', 1749, 1, 150),
  ('canon-eos-2000d-czarny-obiektyw-ef-s-18-55mm-f-3-5-5-6-is-ii-a', 'Canon EOS 2000D - Czarny + obiektyw EF-S 18-55mm f/3.5-5.6 IS II', 'Canon', 'aparaty', '#E7EBFA', '5630430 (5/5)', '5630430-5-5', 'bardzo-dobry', 1739, 2, 151),
  ('canon-eos-2000d-czarny-obiektyw-ef-s-18-55mm-f-3-5-5-6-is-ii-b', 'Canon EOS 2000D - Czarny + obiektyw EF-S 18-55mm f/3.5-5.6 IS II', 'Canon', 'aparaty', '#E7EBFA', '5630430 (3/5)', '5630430-3-5', 'dobry', 1689, 2, 152),
  ('canon-eos-60d-czarny-obiektyw-ef-s-18-135mm-f-3-5-5-6-is-b', 'Canon EOS 60D - Czarny + obiektyw EF-S 18-135mm f/3.5-5.6 IS', 'Canon', 'aparaty', '#E7EBFA', '5693408 (3/5)', '5693408-3-5', 'dobry', 1969, 1, 153),
  ('sony-alpha-a3000-czarny-obiektyw-e-18-55mm-f-3-5-5-6-oss-b', 'Sony Alpha a3000 - Czarny + obiektyw E 18-55mm f/3.5-5.6 OSS', 'Sony', 'aparaty', '#E7EBFA', '232739 (3/5)', '232739-3-5', 'dobry', 1159, 1, 154),
  ('nikon-d3200-czarny-obiektyw-af-s-dx-nikkor-18-55mm-f-3-5-5-6-vr-ii-b', 'Nikon D3200 - Czarny + obiektyw AF-S DX Nikkor 18-55mm f/3.5-5.6 VR II', 'Nikon', 'aparaty', '#E7EBFA', '824877 (3/5)', '824877-3-5', 'dobry', 1339, 1, 155),
  ('nikon-d3400-czarny-obiektyw-af-p-dx-nikkor-18-55-mm-f-3-5-5-6g-vr-b', 'Nikon D3400 - Czarny + obiektyw AF-P DX Nikkor 18-55 mm f/3.5-5.6G VR', 'Nikon', 'aparaty', '#E7EBFA', '199841 (3/5)', '199841-3-5', 'dobry', 1659, 1, 156),
  ('nikon-d3500-czarny-obiektyw-af-p-dx-nikkor-18-55mm-f-3-5-5-6g-vr-a', 'Nikon D3500 - Czarny + obiektyw AF-P DX Nikkor 18-55mm f/3.5-5.6G VR', 'Nikon', 'aparaty', '#E7EBFA', '3792260 (5/5)', '3792260-5-5', 'bardzo-dobry', 1929, 1, 157),
  ('nikon-d5100-czarny-obiektyw-af-s-dx-ed-vr-18-105mm-f-3-5-5-6-a', 'Nikon D5100 - Czarny + obiektyw AF-S DX ED VR 18-105mm f/3.5-5.6', 'Nikon', 'aparaty', '#E7EBFA', '635428 (5/5)', '635428-5-5', 'bardzo-dobry', 1659, 1, 158),
  ('nikon-d5100-czarny-obiektyw-af-s-dx-nikkor-18-55mm-f-3-5-5-6g-ii-ed-dx-b', 'Nikon D5100 - Czarny + obiektyw AF-S DX Nikkor 18-55mm f/3.5-5.6G II ED DX', 'Nikon', 'aparaty', '#E7EBFA', '622522 (3/5)', '622522-3-5', 'dobry', 1439, 1, 159),
  ('nikon-d5100-czarny-obiektyw-af-s-dx-nikkor-vr-f-3-5-5-6-b', 'Nikon D5100 - Czarny + obiektyw AF-S DX Nikkor VR f/3.5-5.6', 'Nikon', 'aparaty', '#E7EBFA', '451444 (3/5)', '451444-3-5', 'dobry', 1289, 1, 160),
  ('nikon-d5300-czarny-obiektyw-af-p-dx-nikkor-18-55mm-f-3-5-5-6g-vr-b', 'Nikon D5300 - Czarny + obiektyw AF-P DX Nikkor 18-55mm f/3.5-5.6G VR', 'Nikon', 'aparaty', '#E7EBFA', '719901 (3/5)', '719901-3-5', 'dobry', 1849, 1, 161),
  ('nikon-d5500-czarny-obiektyw-af-p-dx-nikkor-18-55mm-f-3-5-5-6-g-a', 'Nikon D5500 - Czarny + obiektyw AF-P DX Nikkor 18-55mm f/3.5-5.6 G', 'Nikon', 'aparaty', '#E7EBFA', '4172488 (5/5)', '4172488-5-5', 'bardzo-dobry', 2619, 1, 162),
  ('nikon-d7000-czarny-body-b', 'Nikon D7000 - Czarny (body)', 'Nikon', 'aparaty', '#E7EBFA', '3806 (3/5)', '3806-3-5', 'dobry', 1029, 1, 163),
  ('nikon-d7200-czarny-body-b', 'Nikon D7200 - Czarny (body)', 'Nikon', 'aparaty', '#E7EBFA', '14848 (3/5)', '14848-3-5', 'dobry', 2319, 1, 164),
  ('nikon-d7500-czarny-body-b', 'Nikon D7500 - Czarny (body)', 'Nikon', 'aparaty', '#E7EBFA', '625056 (3/5)', '625056-3-5', 'dobry', 3279, 1, 165),
  ('canon-eos-100d-czarny-obiektyw-18-55mm-f-3-5-5-6-iii-a', 'Canon EOS 100D - Czarny + obiektyw 18-55mm f/3.5-5.6 III', 'Canon', 'aparaty', '#E7EBFA', '628548 (5/5)', '628548-5-5', 'bardzo-dobry', 1529, 1, 166),
  ('canon-eos-1300d-czarny-obiektyw-ef-s-18-55mm-f-3-5-5-6-iii-a', 'Canon EOS 1300D - Czarny + obiektyw EF-S 18-55mm f/3.5-5.6 III', 'Canon', 'aparaty', '#E7EBFA', '582747 (5/5)', '582747-5-5', 'bardzo-dobry', 1399, 2, 167),
  ('canon-eos-2000d-czarny-obiektyw-ef-s-iii-f-3-5-5-6-b', 'Canon EOS 2000D - Czarny + obiektyw EF-S III f/3.5-5.6', 'Canon', 'aparaty', '#E7EBFA', '466579 (3/5)', '466579-3-5', 'dobry', 1659, 1, 168),
  ('canon-eos-4000d-czarny-obiektyw-ef-s-18-55-mm-f-3-5-5-6-iii-b', 'Canon EOS 4000D - Czarny + obiektyw EF-S 18-55 mm f/3.5-5.6 III', 'Canon', 'aparaty', '#E7EBFA', '464324 (3/5)', '464324-3-5', 'dobry', 1469, 3, 169),
  ('canon-eos-600d-czarny-obiektyw-ef-s-18-55mm-f-3-5-5-6-is-a', 'Canon EOS 600D - Czarny + obiektyw EF-S 18-55mm f/3.5-5.6 IS', 'Canon', 'aparaty', '#E7EBFA', '570520 (5/5)', '570520-5-5', 'bardzo-dobry', 1439, 1, 170),
  ('canon-eos-60d-czarny-obiektyw-ef-s-18-55mm-f-3-5-5-6-is-ii-b', 'Canon EOS 60D - Czarny + obiektyw EF-S 18-55mm f/3.5-5.6 IS II', 'Canon', 'aparaty', '#E7EBFA', '642981 (3/5)', '642981-3-5', 'dobry', 1559, 1, 171),
  ('canon-eos-700d-czarny-obiektyw-ef-s-18-55mm-f-3-5-5-6-iii-a', 'Canon EOS 700D - Czarny + obiektyw EF-S 18-55mm f/3.5-5.6 III', 'Canon', 'aparaty', '#E7EBFA', '569325 (5/5)', '569325-5-5', 'bardzo-dobry', 1539, 1, 172),
  ('canon-eos-70d-czarny-obiektyw-ef-s-18-55mm-f-3-5-5-6-is-stm-b', 'Canon EOS 70D - Czarny + obiektyw EF-S 18-55mm f/3.5-5.6 IS STM', 'Canon', 'aparaty', '#E7EBFA', '492642 (3/5)', '492642-3-5', 'dobry', 2009, 1, 173),
  ('canon-eos-750d-czarny-obiektyw-ef-s-18-55mm-f-3-5-5-6-is-stm-a', 'Canon EOS 750D - Czarny + obiektyw EF-S 18-55mm f/3.5-5.6 IS STM', 'Canon', 'aparaty', '#E7EBFA', '504541 (5/5)', '504541-5-5', 'bardzo-dobry', 2269, 1, 174),
  ('canon-eos-7d-czarny-body-b', 'Canon EOS 7D - Czarny (body)', 'Canon', 'aparaty', '#E7EBFA', '10334 (3/5)', '10334-3-5', 'dobry', 1359, 1, 175),
  ('canon-eos-7d-mark-ii-czarny-body-b', 'Canon EOS 7D Mark II - Czarny (body)', 'Canon', 'aparaty', '#E7EBFA', '7DM2-body-B', '7DM2-BODY-B', 'dobry', 3019, 2, 176),
  ('canon-eos-80d-czarny-body-a', 'Canon EOS 80D - Czarny (body)', 'Canon', 'aparaty', '#E7EBFA', '80D-body', '80D-BODY', 'bardzo-dobry', 2489, 1, 177),
  ('canon-eos-80d-czarny-body-b', 'Canon EOS 80D - Czarny (body)', 'Canon', 'aparaty', '#E7EBFA', '113948 (3/5)', '113948-3-5', 'dobry', 2319, 1, 178),
  ('canon-eos-850d-czarny-obiektyw-ef-s-18-55mm-f-4-5-6-is-stm-a', 'Canon EOS 850D - Czarny + obiektyw EF-S 18-55mm F/4-5.6 IS STM', 'Canon', 'aparaty', '#E7EBFA', '773631 (5/5)', '773631-5-5', 'bardzo-dobry', 3059, 1, 179),
  ('canon-eos-850d-czarny-obiektyw-ef-s-18-135mm-f-3-5-5-6-is-usm-a', 'Canon EOS 850D - Czarny + obiektyw EF-S 18-135mm f/3.5-5.6 IS USM', 'Canon', 'aparaty', '#E7EBFA', '591916 (5/5)', '591916-5-5', 'bardzo-dobry', 4389, 1, 180),
  ('panasonic-lumix-dmc-g80-czarny-obiektyw-g-vario-14-140mm-f-3-5-5-6-ii-a', 'Panasonic Lumix DMC-G80 - Czarny + obiektyw G Vario 14-140mm f/3.5-5.6 II ASPH Power OIS', 'Panasonic', 'aparaty', '#E7EBFA', 'G80-14140-A', 'G80-14140-A', 'bardzo-dobry', 3149, 1, 181),
  ('panasonic-lumix-dc-g90-czarny-obiektyw-g-vario-12-60mm-f-3-5-5-6-a', 'Panasonic Lumix Dc-G90 - Czarny + obiektyw G vario 12-60mm f/3,5-5,6', 'Panasonic', 'aparaty', '#E7EBFA', '403400 (5/5)', '403400-5-5', 'bardzo-dobry', 3939, 1, 182),
  ('samsung-galaxy-watch7-bluetooth-cellular-44-mm-srebrny-b', 'Galaxy Watch7 Bluetooth + Cellular 44 mm - Srebrny', 'Samsung', 'smartwatche', '#E3FCEE', 'SGW7C-44-SR-B', 'SGW7C-44-SR-B', 'dobry', 949, 1, 183),
  ('samsung-galaxy-watch7-bluetooth-44-mm-srebrny-a', 'Galaxy Watch7 Bluetooth 44 mm - Srebrny', 'Samsung', 'smartwatche', '#E3FCEE', 'SGW7-44-SR-A', 'SGW7-44-SR-A', 'bardzo-dobry', 1049, 1, 184),
  ('samsung-galaxy-watch7-bluetooth-44-mm-zielony-a', 'Galaxy Watch7 Bluetooth 44 mm - Zielony', 'Samsung', 'smartwatche', '#E3FCEE', 'SGW7-44-GN-A', 'SGW7-44-GN-A', 'bardzo-dobry', 1009, 2, 185),
  ('samsung-galaxy-watch8-bluetooth-cellular-40-mm-srebrny-a', 'Galaxy Watch8 Bluetooth + Cellular 40 mm - Srebrny', 'Samsung', 'smartwatche', '#E3FCEE', 'SGW8C-40-SR-A', 'SGW8C-40-SR-A', 'bardzo-dobry', 1159, 1, 186),
  ('samsung-galaxy-watch8-bluetooth-cellular-44-mm-szary-a', 'Galaxy Watch8 Bluetooth + Cellular 44 mm - Szary', 'Samsung', 'smartwatche', '#E3FCEE', 'SGW8C-44-GY-A', 'SGW8C-44-GY-A', 'bardzo-dobry', 1279, 1, 187),
  ('samsung-galaxy-watch8-bluetooth-cellular-44-mm-szary-c', 'Galaxy Watch8 Bluetooth + Cellular 44 mm - Szary', 'Samsung', 'smartwatche', '#E3FCEE', 'SGW8C-44-GY-C', 'SGW8C-44-GY-C', 'zadowalajacy', 1089, 1, 188),
  ('samsung-galaxy-watch8-bluetooth-44-mm-srebrny-b', 'Galaxy Watch8 Bluetooth 44 mm - Srebrny', 'Samsung', 'smartwatche', '#E3FCEE', 'SGW8-44-WE-B', 'SGW8-44-WE-B', 'dobry', 1019, 1, 189),
  ('samsung-galaxy-watch8-classic-bluetooth-cellular-46-mm-srebrny-a', 'Galaxy Watch8 Classic Bluetooth + Cellular 46 mm - Srebrny', 'Samsung', 'smartwatche', '#E3FCEE', 'SGW8CC-46-WE-A', 'SGW8CC-46-WE-A', 'bardzo-dobry', 1529, 3, 190),
  ('samsung-galaxy-watch8-classic-bluetooth-cellular-46-mm-srebrny-b', 'Galaxy Watch8 Classic Bluetooth + Cellular 46 mm - Srebrny', 'Samsung', 'smartwatche', '#E3FCEE', 'SGW8CC-46-WE-AB', 'SGW8CC-46-WE-AB', 'dobry', 1309, 2, 191),
  ('samsung-galaxy-watch8-classic-bluetooth-cellular-46-mm-czarny-b', 'Galaxy Watch8 Classic Bluetooth + Cellular 46 mm - Czarny', 'Samsung', 'smartwatche', '#E3FCEE', 'SGW8CC-46-BK-B', 'SGW8CC-46-BK-B', 'dobry', 1499, 1, 192),
  ('samsung-galaxy-watch9-bluetooth-40-mm-czarny-a', 'Galaxy Watch9 Bluetooth 40 mm - Czarny', 'Samsung', 'smartwatche', '#E3FCEE', 'SGW9-40-BK-A', 'SGW9-40-BK-A', 'bardzo-dobry', 1389, 1, 193);

-- 1) Ukrycie i wyzerowanie dotychczasowego magazynu
update shop_models set published = false where published and slug not in (select slug from _imp);
update shop_variants set active = false where active and sku not in (select sku from _imp);
do $$
declare v record;
begin
  perform set_config('shop.stock_rpc', '1', true);
  for v in
    select sv.id, sv.sku, sv.stock, m.name as mname
    from shop_variants sv join shop_models m on m.id = sv.model_id
    where sv.stock > 0 and sv.sku not in (select sku from _imp)
  loop
    update shop_variants set stock = 0 where id = v.id;
    insert into shop_stock_moves (variant_id, sku, model_name, kind, delta, stock_before, stock_after, note, by_email)
    values (v.id, v.sku, v.mname, 'korekta', -v.stock, v.stock, 0, 'Wyczyszczenie magazynu przed importem z Listingów Back Market (21.10.2026)', 'Import (SQL)');
  end loop;
  perform set_config('shop.stock_rpc', '', true);
end $$;

-- 3) Kategorie
update shop_categories set hidden = false, tagline = 'Samsung Galaxy Watch' where slug = 'smartwatche';
update shop_categories set tagline = 'Canon, Nikon, Sony, Panasonic' where slug = 'aparaty';
update shop_categories set tagline = 'PlayStation, Xbox, Nintendo Switch' where slug = 'konsole';
update shop_categories set hidden = true where slug in ('kontrolery', 'akcesoria', 'gry');

-- 2) Nowe produkty, warianty i ruchy "przyjęcie"
insert into shop_models (slug, name, brand, category_slug, keywords, color, published, sort)
select slug, name, brand, category_slug, bm_sku, color, true, 100 + sort from _imp
on conflict (slug) do nothing;

with ins as (
  insert into shop_variants (model_id, sku, option_value, grade, price, stock, active, sort)
  select m.id, i.sku, null, i.grade, i.price, i.qty, true, 0
  from _imp i join shop_models m on m.slug = i.slug
  on conflict do nothing
  returning id, sku, stock, model_id
)
insert into shop_stock_moves (variant_id, sku, model_name, kind, delta, stock_before, stock_after, note, by_email)
select ins.id, ins.sku, m.name, 'przyjecie', ins.stock, 0, ins.stock, 'Import z Listingów -> Sklep (oferty Back Market, 21.10.2026)', 'Import (SQL)'
from ins join shop_models m on m.id = ins.model_id
where ins.stock > 0;

commit;
