import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildInvoiceBuyerPrefill } from "@/lib/invoices";
import { guessReturnProduct, type ReturnLookup } from "@/lib/returns";
import { serialVariants } from "@/lib/globalSearch";

// Zwroty: dane podpowiadane po numerze seryjnym (22.10.2026). Szuka najnowszej sprzedaży sztuki (pozycje zamówień po numerze seryjnym) i zwraca platformę,
// numer zamówienia, SKU, nazwę produktu i imię i nazwisko kupującego; gdy sztuka nie była u nas sprzedana — SKU z Towaru, Trade-in albo Testów.
// Imię i nazwisko czytamy po stronie serwera z surowych danych kanału (tabele surowe nie są dla wszystkich ról), dlatego route, a nie zapytanie z przeglądarki.
export const maxDuration = 30;

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const normSerial = (s: string | null | undefined) => (s || "").trim().toUpperCase().replace(/^0+/, "");

async function buyerName(db: ReturnType<typeof admin>, marketplace: string, externalId: string): Promise<string> {
  let raw: any = null;
  let customerEmail: string | null = null;
  if (marketplace === "backmarket") raw = (await db.from("bm_orders").select("*").eq("order_id", Number(externalId)).maybeSingle()).data;
  else if (marketplace === "refurbed") {
    const { data } = await db.from("refurbed_orders").select("raw, customer_email").eq("id", externalId).maybeSingle();
    raw = data?.raw ?? null;
    customerEmail = data?.customer_email ?? null;
  } else if (marketplace === "octopia") raw = (await db.from("octopia_orders").select("raw").eq("id", externalId).maybeSingle()).data?.raw ?? null;
  else if (marketplace === "allegro") raw = (await db.from("allegro_orders").select("raw").eq("id", externalId).maybeSingle()).data?.raw ?? null;
  else if (marketplace === "erli") raw = (await db.from("erli_orders").select("raw").eq("id", externalId).maybeSingle()).data?.raw ?? null;
  else if (marketplace === "swopify") {
    raw = (await db.from("sales_orders").select("manual_details").eq("marketplace", marketplace).eq("external_id", externalId).maybeSingle()).data?.manual_details ?? null;
    customerEmail = raw?.customer?.email ?? null;
  }
  if (!raw) return "";
  const b = buildInvoiceBuyerPrefill(marketplace, raw, customerEmail);
  return b.name || b.company || "";
}

export async function GET(request: Request) {
  const db = admin();
  // zalogowana osoba z przypisaną rolą (zakładka Zwroty jest dla wszystkich ról)
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const uid = (await anon.auth.getUser(token)).data?.user?.id;
  if (!uid) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const { data: member } = await db.from("members").select("role").eq("user_id", uid).maybeSingle();
  if (!member?.role) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

  const sp = new URL(request.url).searchParams;
  const serial = (sp.get("q") || sp.get("serial") || "").trim();
  if (serial.length < 3) return NextResponse.json({ found: false } satisfies ReturnLookup);
  const variants = serialVariants(serial);
  const orFilter = (col: string) => variants.map((v) => `${col}.ilike.${quote(v.replace(/[%_\\]/g, "\\$&"))}`).join(",");

  // 0) numer zamówienia sprzedaży (22.10.2026: zwrot można wprowadzić też po numerze zamówienia) — dokładny numer, bez rozróżniania wielkości liter
  const { data: ords } = await db.from("sales_orders").select("marketplace, external_id, order_date").ilike("external_id", serial.replace(/[%_\\]/g, "\\$&")).order("order_date", { ascending: false }).limit(3);
  if (ords?.length) {
    const o = ords[0] as any;
    const { data: its } = await db.from("sales_order_items").select("sku, name, serial_number").eq("marketplace", o.marketplace).eq("external_id", o.external_id).order("position", { ascending: true });
    const items = (its || []).map((i: any) => ({ serial: (i.serial_number || "").trim(), sku: i.sku || "", name: i.name || "", product: guessReturnProduct(i.name, i.sku) }));
    const name = await buyerName(db, o.marketplace, o.external_id).catch(() => "");
    const first = items[0];
    const res: ReturnLookup = {
      found: true,
      source: "zamowienie",
      byOrder: true,
      platform: o.marketplace,
      orderId: o.external_id,
      customerName: name,
      items,
      ...(items.length === 1 ? { serial: first.serial, sku: first.sku, productName: first.name, product: first.product } : {}),
      note: items.length > 1 ? "W zamówieniu jest kilka pozycji — wybierz, której dotyczy zwrot." : undefined,
    };
    return NextResponse.json(res);
  }

  // 1) sprzedaż: pozycje zamówień z tym numerem seryjnym; bierzemy najnowsze zamówienie (sztuka mogła być sprzedana kilka razy)
  const { data: items } = await db.from("sales_order_items").select("marketplace, external_id, sku, name, serial_number").or(orFilter("serial_number")).limit(20);
  const want = normSerial(serial);
  const matches = (items || []).filter((i: any) => normSerial(i.serial_number) === want);
  if (matches.length) {
    const orders = await Promise.all(
      matches.map(async (i: any) => {
        const { data } = await db.from("sales_orders").select("order_date, status").eq("marketplace", i.marketplace).eq("external_id", i.external_id).maybeSingle();
        return { i, date: data?.order_date ? Date.parse(data.order_date) : 0 };
      }),
    );
    orders.sort((a, b) => b.date - a.date);
    const best = orders[0].i;
    const name = await buyerName(db, best.marketplace, best.external_id).catch(() => "");
    const res: ReturnLookup = {
      found: true,
      source: "zamowienie",
      platform: best.marketplace,
      orderId: best.external_id,
      customerName: name,
      sku: best.sku || "",
      productName: best.name || "",
      product: guessReturnProduct(best.name, best.sku),
      note: orders.length > 1 ? `Sztuka sprzedana ${orders.length} razy — wybrano najnowsze zamówienie.` : undefined,
    };
    return NextResponse.json(res);
  }

  // 2) sztuka spoza sprzedaży: SKU z Towaru, Trade-in albo Testów (bez zamówienia i kupującego)
  const [goods, intake, tests] = await Promise.all([
    db.from("goods_register").select("name, serial").or(orFilter("serial")).order("purchased_on", { ascending: false }).limit(1),
    db.from("buyback_order_intake").select("sku").or(orFilter("serial_number")).not("sku", "is", null).order("entered_at", { ascending: false }).limit(1),
    db.from("test_log").select("sku").or(orFilter("serial_number")).not("sku", "is", null).order("started_at", { ascending: false }).limit(1),
  ]);
  const gName = (goods.data?.[0] as any)?.name as string | undefined;
  const iSku = (intake.data?.[0] as any)?.sku as string | undefined;
  const tSku = (tests.data?.[0] as any)?.sku as string | undefined;
  const sku = iSku || tSku || (gName && /^\S+-\S+$/.test(gName) ? gName : "");
  if (sku || gName) {
    const res: ReturnLookup = {
      found: true,
      source: iSku ? "trade-in" : tSku ? "testy" : "towar",
      sku: sku || "",
      productName: gName && gName !== sku ? gName : "",
      product: guessReturnProduct(gName, sku),
      note: "Nie znaleziono zamówienia sprzedaży z tym numerem seryjnym — uzupełnij platformę i numer zamówienia ręcznie.",
    };
    return NextResponse.json(res);
  }
  return NextResponse.json({ found: false } satisfies ReturnLookup);
}
