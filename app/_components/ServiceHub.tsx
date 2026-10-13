"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import ServiceView from "./ServiceView";
import PartsView from "./PartsView";
import ServiceRequestsView from "./ServiceRequestsView";
import { SERVICE_STAFF_ROLES } from "@/lib/serviceRequests";
import type { MemberLite } from "@/lib/displayName";

// Zakładka Serwis: domyślnie rejestr napraw (ServiceView), plus podstrona "Części" (04.10.2026) — rejestr części z ceną i przypisanym urządzeniem,
// oraz "Zapotrzebowanie" (13.10.2026) — ten sam widok co w zakładce Zamówienia (serwisanci wchodzą tu, dział sprzedaży z Zamówień; to jedna tabela service_requests).
const pill = (active: boolean) => `px-3 py-1.5 rounded-full text-sm font-semibold border ${active ? "bg-ink text-paper border-ink" : "bg-white border-line"}`;

export default function ServiceHub({ session, members, role, isAdmin, isAdminOrManager, isServiceLead }: { session: Session; members: MemberLite[]; role: string; isAdmin: boolean; isAdminOrManager: boolean; isServiceLead: boolean }) {
  const [sub, setSub] = useState<"repairs" | "parts" | "requests">(() => {
    // baner "Nowe zapotrzebowania dla serwisu" (ReminderBanners) otwiera Serwis od razu na Zapotrzebowaniu
    try {
      if (sessionStorage.getItem("service-sub") === "requests") {
        sessionStorage.removeItem("service-sub");
        return "requests";
      }
    } catch {
      /* brak sessionStorage */
    }
    return "repairs";
  });
  // Baner kliknięty, gdy Serwis jest już otwarty: komponent nie montuje się od nowa, więc słuchamy zdarzenia.
  useEffect(() => {
    const onNav = () => {
      try {
        if (sessionStorage.getItem("service-sub") === "requests") {
          sessionStorage.removeItem("service-sub");
          setSub("requests");
        }
      } catch {
        /* brak sessionStorage */
      }
    };
    window.addEventListener("nav-sub-changed", onNav);
    return () => window.removeEventListener("nav-sub-changed", onNav);
  }, []);
  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setSub("repairs")} className={pill(sub === "repairs")}>Naprawy</button>
        <button onClick={() => setSub("parts")} className={pill(sub === "parts")}>Części</button>
        <button onClick={() => setSub("requests")} className={pill(sub === "requests")}>Zapotrzebowanie</button>
      </div>
      {sub === "repairs" && <ServiceView session={session} members={members} isAdmin={isAdmin} isAdminOrManager={isAdminOrManager} isServiceLead={isServiceLead} />}
      {sub === "parts" && <PartsView members={members} session={session} />}
      {sub === "requests" && <ServiceRequestsView session={session} members={members} role={role} canHandle={SERVICE_STAFF_ROLES.includes(role)} />}
    </div>
  );
}
