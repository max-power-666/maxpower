"use client";

import { useState } from "react";
import type { Session } from "@supabase/supabase-js";
import ServiceView from "./ServiceView";
import PartsView from "./PartsView";
import type { MemberLite } from "@/lib/displayName";

// Zakładka Serwis: domyślnie rejestr napraw (ServiceView), plus podstrona "Części" (04.10.2026) — rejestr części z ceną i przypisanym urządzeniem.
const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

export default function ServiceHub({ session, members, isAdmin, isAdminOrManager }: { session: Session; members: MemberLite[]; isAdmin: boolean; isAdminOrManager: boolean }) {
  const [sub, setSub] = useState<"repairs" | "parts">("repairs");
  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setSub("repairs")} className={pill(sub === "repairs")}>Naprawy</button>
        <button onClick={() => setSub("parts")} className={pill(sub === "parts")}>Części</button>
      </div>
      {sub === "repairs" && <ServiceView session={session} members={members} isAdmin={isAdmin} isAdminOrManager={isAdminOrManager} />}
      {sub === "parts" && <PartsView members={members} />}
    </div>
  );
}
