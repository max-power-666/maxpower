import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createSign } from "crypto";
import { requireRole } from "@/lib/serverAuth";

// Podpisuje żądania do lokalnego agenta drukowania (QZ Tray) kluczem prywatnym — bez tego QZ Tray traktuje
// połączenie jako niezaufane i pokazuje okno z prośbą o zgodę PRZY KAŻDYM druku (checkbox "zapamiętaj" nie
// działa trwale bez podpisu — zgłoszone przez właściciela 30.09.2026, potwierdzone w dokumentacji QZ Tray:
// "trust" bez podpisu jest tymczasowy, dopiero podpisane żądania dają "Allow" + "Remember this decision" na
// stałe). `lib/printAgent.ts` woła ten route przez `qz.security.setSignaturePromise`, z gotowym `toSign`
// (hex SHA-256 z {call, params, timestamp}, liczony przez samo qz-tray.js po stronie przeglądarki) — my tylko
// podpisujemy ten string kluczem prywatnym, algorytmem SHA1 (domyślny `signAlgorithm` w qz-tray.js; nie
// zmienialiśmy go po stronie klienta, więc musi się zgadzać). Klucz prywatny (`QZ_TRAY_PRIVATE_KEY`) tylko tu,
// nigdy w przeglądarce — para wygenerowana raz (openssl, self-signed, 10 lat), publiczny certyfikat
// (`QZ_CERT` w `lib/printAgent.ts`) nie jest sekretem, więc jest wprost w kodzie klienta.

const ROLES = ["Admin", "Manager", "Zamówienia"];
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function POST(request: Request) {
  if (!(await requireRole(request, admin(), ROLES))) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
  const privateKey = (process.env.QZ_TRAY_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!privateKey) return NextResponse.json({ error: "Brak konfiguracji (QZ_TRAY_PRIVATE_KEY)." }, { status: 500 });

  const b = await request.json().catch(() => null);
  const toSign = typeof b?.toSign === "string" ? b.toSign : "";
  if (!toSign) return NextResponse.json({ error: "Brak danych do podpisania." }, { status: 400 });

  try {
    const signature = createSign("SHA1").update(toSign, "utf8").sign(privateKey, "base64");
    return NextResponse.json({ signature });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "Nie udało się podpisać żądania." }, { status: 500 });
  }
}
