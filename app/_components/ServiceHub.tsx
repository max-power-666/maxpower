"use client";

import { useState } from "react";
import type { Session } from "@supabase/supabase-js";
import ServiceView from "./ServiceView";
import PartsView from "./PartsView";
import ServiceRequestsView from "./ServiceRequestsView";
import { SERVICE_STAFF_ROLES } from "@/lib/serviceRequests";
import type { MemberLite } from "@/lib/displayName";

// Zakładka Serwis: domyślnie rejestr napraw (ServiceView), plus podstrona "Części" (04.10.2026) — rejestr części z ceną i przypisanym urządzeniem.
const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

export default function ServiceHub({ session, members, isAdmin, isAdminOrManager, isServiceLead, role }: { session: Session; members: MemberLite[]; isAdmin: boolean; isAdminOrManager: boolean; isServiceLead: boolean; role: string }) {
  const [sub, setSub] = useState<"repairs" | "parts" | "requests">("repairs");
  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setSub("repairs")} className={pill(sub === "repairs")}>Naprawy</button>
        <button onClick={() => setSub("parts")} className={pill(sub === "parts")}>Części</button>
        <button onClick={() => setSub("requests")} className={pill(sub === "requests")}>Zapotrzebowanie</button>
      </div>
      {sub === "repairs" && <ServiceView session={session} members={members} isAdmin={isAdmin} isAdminOrManager={isAdminOrManager} isServiceLead={isServiceLead} />}
      {sub === "parts" && <PartsView members={members} session={session} />}
      {sub === "requests" && <ServiceRequestsView session={session} members={members} canHandle={SERVICE_STAFF_ROLES.includes(role)} />}
    </div>
  );
}
