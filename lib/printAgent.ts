"use client";

// Cienki wrapper wokół QZ Tray (qz.io) — lokalny agent drukowania instalowany RĘCZNIE przez Admina na komputerze,
// który ma drukować (patrz CLAUDE.md, sekcja Wysyłka — instrukcja instalacji na Windows). Jeden agent obsługuje
// oba przypadki: surowy ZPL prosto na etykieciarkę Zebra i zwykły PDF na dowolną drukarkę A4 — bez okna
// drukowania przeglądarki, bez wyboru sterownika za każdym razem.
//
// Świadomie BEZ podpisywania żądań (qz.security.setCertificatePromise/setSignaturePromise) — to dla wewnętrznego,
// zaufanego zespołu nadmiarowa infrastruktura (własny certyfikat, serwer podpisujący). QZ Tray i tak pozwala się
// połączyć bez podpisu: pokazuje jednorazowe okno z prośbą o zgodę (z checkboxem "zapamiętaj", więc pyta raz na
// komputer, nie przy każdym wydruku). Jeśli to się okaże uciążliwe, podpisywanie da się dodać później bez zmiany
// wywołań w ShippingView.tsx — cała logika QZ Tray jest tylko tutaj.

import qz from "qz-tray";

export class PrintAgentError extends Error {}

let connecting: Promise<void> | null = null;

async function ensureConnected(): Promise<void> {
  if (qz.websocket.isActive()) return;
  if (!connecting) {
    connecting = qz.websocket.connect().catch((e: any) => {
      connecting = null;
      throw e;
    });
  }
  try {
    await connecting;
  } catch (e: any) {
    throw new PrintAgentError(
      `Nie udało się połączyć z QZ Tray na tym komputerze — sprawdź, czy aplikacja jest zainstalowana i uruchomiona (ikona w zasobniku systemowym). Szczegóły: ${e?.message || e}`
    );
  }
}

// Surowy ZPL prosto na etykieciarkę Zebra — bez konwersji, bez okna drukowania.
export async function printRawToZebra(zpl: string, printerName: string): Promise<void> {
  await ensureConnected();
  try {
    const config = qz.configs.create(printerName);
    await qz.print(config, [zpl]);
  } catch (e: any) {
    throw new PrintAgentError(`Nie udało się wydrukować etykiety na "${printerName}": ${e?.message || e}`);
  }
}

// PDF (base64) na dowolną drukarkę (A4 dla delivery note; dla etykiety bez ZPL — np. Erli — fallback na Zebrę
// przez jej sterownik Windows) — bez okna drukowania.
export async function printPdf(pdfBase64: string, printerName: string): Promise<void> {
  await ensureConnected();
  try {
    const config = qz.configs.create(printerName);
    await qz.print(config, [{ type: "pixel", format: "pdf", flavor: "base64", data: pdfBase64 }]);
  } catch (e: any) {
    throw new PrintAgentError(`Nie udało się wydrukować dokumentu na "${printerName}": ${e?.message || e}`);
  }
}

// Lista drukarek widocznych dla QZ Tray na tym komputerze — do wyboru dokładnej nazwy w ustawieniach (Admin).
export async function listPrinters(): Promise<string[]> {
  await ensureConnected();
  try {
    const found = await qz.printers.find();
    return Array.isArray(found) ? found : [String(found)];
  } catch (e: any) {
    throw new PrintAgentError(`Nie udało się pobrać listy drukarek: ${e?.message || e}`);
  }
}
