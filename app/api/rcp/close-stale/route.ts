import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/buyback";
import { rcpAdmin } from "@/lib/rcpServer";

// Cron (vercel.json, raz dziennie): zamyka odcinki RCP trwające od poprzednich dni (nikt nie kliknął "Zakończ") i oznacza je do sprawdzenia przez Managera.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) return NextResponse.json({ error: "Brak autoryzacji." }, { status: 401 });
  const { data, error } = await rcpAdmin().rpc("rcp_close_stale", { p_user: null });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, closed: data });
}
