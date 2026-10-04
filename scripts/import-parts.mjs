// Jednorazowy import części z arkusza parts.numbers do service_parts (Serwis -> Części).
//
//   node scripts/import-parts.mjs /ścieżka/do/parts.json [--replace]
//
// Plik JSON to wiersze arkusza po oczyszczeniu (pola jak kolumny service_parts: received_at, invoice_no, invoice_date, supplier, status,
// notes, name, part_code, batch_qty, price_net, currency, nbp_rate, price_pln, device_ref, usage_notes). Skrypt NIE nadpisuje danych:
// jeśli tabela ma już wiersze z importu, kończy się błędem, chyba że podasz --replace (wtedy kasuje wiersze source='import', a razem z nimi
// ręczne przypisania urządzeń zrobione w aplikacji!). Wymaga NEXT_PUBLIC_SUPABASE_URL i SUPABASE_SERVICE_ROLE_KEY w .env.local.

import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
for (const line of fs.readFileSync(path.join(root, ".env.local"), "utf-8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const file = process.argv[2];
if (!file) throw new Error("Podaj ścieżkę do parts.json.");
const replace = process.argv.includes("--replace");
const rows = JSON.parse(fs.readFileSync(file, "utf-8"));
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { count, error } = await db.from("service_parts").select("id", { count: "exact", head: true }).eq("source", "import");
if (error) throw new Error(`Tabela service_parts niedostępna (uruchom supabase/service-parts.sql): ${error.message}`);
if (count > 0) {
  if (!replace) throw new Error(`Tabela ma już ${count} wierszy z importu — użyj --replace, żeby je zastąpić (kasuje też ręczne przypisania).`);
  const { error: delErr } = await db.from("service_parts").delete().eq("source", "import");
  if (delErr) throw new Error(delErr.message);
}
let done = 0;
for (let i = 0; i < rows.length; i += 1000) {
  const chunk = rows.slice(i, i + 1000).map((r) => ({ ...r, source: "import" }));
  const { error: insErr } = await db.from("service_parts").insert(chunk);
  if (insErr) throw new Error(`Wiersze ${i}-${i + chunk.length}: ${insErr.message}`);
  done += chunk.length;
  console.log(`${done}/${rows.length}`);
}
console.log("Gotowe.");
