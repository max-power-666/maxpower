// Jednorazowy import danych ze starego programu "Buyback Bidder" do tabel Trade-in w Supabase.
//
//   node scripts/import-buyback.mjs ["/ścieżka/do/Buyback Bidder 2"]
//
// Czyta data.json, max-prices.json, ignored-skus.json i bidder-state.json i robi upsert
// do buyback_skus. Można uruchomić ponownie — nadpisze cenę max / ignorowanie / ostatnie
// ceny wartościami z plików. history.json (ponad 500 MB) NIE jest importowany.
// Wymaga NEXT_PUBLIC_SUPABASE_URL i SUPABASE_SERVICE_ROLE_KEY w .env.local.

import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
for (const line of fs.readFileSync(path.join(root, ".env.local"), "utf-8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const src = process.argv[2] || path.join(process.env.HOME, "Documents", "Buyback Bidder 2");
const read = (f, fallback) => {
  const p = path.join(src, f);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : fallback;
};

const catalog = read("data.json", []);
const maxPrices = read("max-prices.json", {});
const ignored = new Set(read("ignored-skus.json", []));
const state = read("bidder-state.json", {});

const rows = catalog
  .filter((item) => item.sku && item.listing_id)
  .map((item) => {
    const max = Number(maxPrices[item.sku]);
    const st = state[item.sku];
    const lastSet = st?.last_set
      ? Object.fromEntries(Object.entries(st.last_set).map(([m, v]) => [m, Number(v)]).filter(([, v]) => Number.isFinite(v)))
      : null;
    return {
      sku: item.sku,
      listing_id: item.listing_id,
      product_id: item.product_id ?? null,
      max_price: Number.isFinite(max) && max > 0 ? max : null,
      ignored: ignored.has(item.sku),
      last_set: lastSet && Object.keys(lastSet).length ? lastSet : null,
      last_run_at: st?.last_run ?? null,
      updated_at: new Date().toISOString(),
    };
  });

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { error } = await db.from("buyback_skus").upsert(rows);
if (error) {
  console.error("Błąd importu:", error.message);
  process.exit(1);
}
console.log(`Zaimportowano ${rows.length} SKU z "${src}"`);
console.log(`  z ceną max: ${rows.filter((r) => r.max_price).length}, ignorowane: ${rows.filter((r) => r.ignored).length}, z ostatnimi cenami: ${rows.filter((r) => r.last_set).length}`);
