// Reguły wysyłki (12.10.2026, na prośbę właściciela): domyślny szablon paczki, przewoźnik i produkt wybierane automatycznie na podstawie SKU, kraju odbiorcy
// i metody przesyłki. Czysta logika (bez dostępu do bazy) — używa jej formularz Wysyłki przy otwarciu z karty zamówienia oraz podgląd w zakładce Reguły.

export type ShippingCarrier = "parcel" | "express" | "ups";
export type SkuOp = "starts_with" | "contains" | "equals";

export type ShippingRule = {
  id: number;
  position: number;
  name: string | null;
  active: boolean;
  sku_op: SkuOp | null;
  sku_value: string | null;
  country_code: string | null;
  shipping_method: "Express" | "Standard" | null;
  template_id: number | null;
  carrier: ShippingCarrier | null;
  product_code: string | null;
  signature: boolean; // dodatkowa usługa UPS "podpis przy doręczeniu" (12.10.2026)
};

export const SKU_OP_LABEL: Record<SkuOp, string> = { starts_with: "zaczyna się od", contains: "zawiera", equals: "jest równe" };
export const CARRIER_NAME: Record<ShippingCarrier, string> = { parcel: "DHL Parcel", express: "DHL Express", ups: "UPS" };

// Produkty do wyboru w regule. Kody takie jak zwraca wycena danego przewoźnika (DHL Parcel: EK/PI/CP; UPS: kody usług). DHL Express ma wiele produktów zależnych od trasy,
// więc oferujemy tylko "Economy Select" (kod pomocniczy ECONOMY — formularz wybiera produkt rozpoznany jako Economy Select); pusty produkt = domyślny wybór przewoźnika.
export const CARRIER_PRODUCTS: Record<ShippingCarrier, { code: string; name: string }[]> = {
  parcel: [
    { code: "EK", name: "Connect" },
    { code: "PI", name: "International" },
    { code: "CP", name: "Connect Plus" },
  ],
  express: [{ code: "ECONOMY", name: "Economy Select" }],
  ups: [
    { code: "11", name: "Standard" },
    { code: "65", name: "Express Saver" },
    { code: "07", name: "Express" },
    { code: "54", name: "Express Plus" },
  ],
};
export const productName = (carrier: ShippingCarrier | null, code: string | null): string | null =>
  carrier && code ? CARRIER_PRODUCTS[carrier].find((p) => p.code === code)?.name ?? code : null;

export type RuleContext = {
  skus: string[]; // SKU wszystkich pozycji zamówienia
  countryCode: string; // kraj odbiorcy (ISO, wielkie litery)
  shippingMethod: string | null; // "Express" | "Standard" | null (inne kanały nie podają)
};

const norm = (s: string) => s.trim().toUpperCase();

export function ruleMatches(rule: ShippingRule, ctx: RuleContext): boolean {
  if (!rule.active) return false;
  if (rule.sku_op && rule.sku_value) {
    const v = norm(rule.sku_value);
    const ok = ctx.skus.some((sku) => {
      const s = norm(sku);
      return rule.sku_op === "starts_with" ? s.startsWith(v) : rule.sku_op === "contains" ? s.includes(v) : s === v;
    });
    if (!ok) return false;
  }
  if (rule.country_code && norm(rule.country_code) !== norm(ctx.countryCode || "")) return false;
  if (rule.shipping_method && rule.shipping_method !== ctx.shippingMethod) return false;
  return true;
}

export type RuleResult = {
  templateId: number | null;
  templateRule: ShippingRule | null;
  carrier: ShippingCarrier | null;
  productCode: string | null;
  carrierRule: ShippingRule | null;
  signature: boolean; // true, gdy KTÓRAKOLWIEK pasująca reguła włącza podpis przy doręczeniu (UPS)
  signatureRule: ShippingRule | null;
  matched: ShippingRule[];
};

// Reguły po kolei (position, id): szablon bierze się z pierwszej pasującej reguły, która go ustawia; przewoźnik razem z produktem — z pierwszej pasującej reguły z przewoźnikiem;
// podpis przy doręczeniu jest włączony, gdy włącza go choć jedna pasująca reguła (usługa dodatkowa — nie "wyłączamy" jej kolejną regułą).
export function evaluateRules(rules: ShippingRule[], ctx: RuleContext): RuleResult {
  const sorted = [...rules].sort((a, b) => a.position - b.position || a.id - b.id);
  const out: RuleResult = { templateId: null, templateRule: null, carrier: null, productCode: null, carrierRule: null, signature: false, signatureRule: null, matched: [] };
  for (const r of sorted) {
    if (!ruleMatches(r, ctx)) continue;
    out.matched.push(r);
    if (out.templateId === null && r.template_id !== null) {
      out.templateId = r.template_id;
      out.templateRule = r;
    }
    if (!out.signature && r.signature) {
      out.signature = true;
      out.signatureRule = r;
    }
    if (out.carrier === null && r.carrier) {
      out.carrier = r.carrier;
      out.productCode = r.product_code;
      out.carrierRule = r;
    }
  }
  return out;
}

// Opis reguły zdaniem: "Jeśli SKU zaczyna się od „PS4” i kraj odbiorcy to Niemcy → szablon PS4; DHL Parcel · Connect".
export function describeRule(r: ShippingRule, templateName: (id: number) => string | null, countryName: (code: string) => string): string {
  const cond: string[] = [];
  if (r.sku_op && r.sku_value) cond.push(`SKU ${SKU_OP_LABEL[r.sku_op]} „${r.sku_value}”`);
  if (r.country_code) cond.push(`kraj odbiorcy to ${countryName(r.country_code)}`);
  if (r.shipping_method) cond.push(`metoda przesyłki to ${r.shipping_method}`);
  const act: string[] = [];
  if (r.template_id !== null) act.push(`szablon ${templateName(r.template_id) ?? "(usunięty)"}`);
  if (r.carrier) act.push([CARRIER_NAME[r.carrier], productName(r.carrier, r.product_code)].filter(Boolean).join(" · "));
  if (r.signature) act.push("podpis przy doręczeniu (UPS)");
  return `${cond.length ? `Jeśli ${cond.join(" i ")}` : "Zawsze"} → ${act.length ? act.join("; ") : "(nic nie ustawia — usunięto jej szablon; edytuj albo usuń regułę)"}`;
}
