"use client";

// Cienki wrapper wokół QZ Tray (qz.io) — lokalny agent drukowania instalowany RĘCZNIE przez Admina na komputerze,
// który ma drukować (patrz CLAUDE.md, sekcja Wysyłka — instrukcja instalacji na Windows). Jeden agent obsługuje
// oba przypadki: surowy ZPL prosto na etykieciarkę Zebra i zwykły PDF na dowolną drukarkę A4 — bez okna
// drukowania przeglądarki, bez wyboru sterownika za każdym razem.
//
// Żądania są PODPISYWANE (qz.security.setCertificatePromise/setSignaturePromise) — bez tego QZ Tray traktuje
// każde połączenie jako niezaufane i pyta o zgodę PRZY KAŻDYM druku (checkbox "zapamiętaj" nie działa trwale bez
// podpisu — zgłoszone przez właściciela 30.09.2026, potwierdzone w dokumentacji QZ Tray: dopiero podpisane
// żądania dają "Allow" + "Remember this decision" na stałe). Certyfikat (`QZ_CERT` niżej) to publiczna część pary
// wygenerowanej raz (openssl, self-signed, 10 lat) — nie jest sekretem, stąd wprost w kodzie klienta. Podpisywanie
// samych żądań dzieje się na serwerze (`app/api/shipping/qz-sign`, klucz prywatny tylko tam) — `signaturePromise`
// niżej dogrywa aktualny token sesji z supabase-js przy każdym podpisie (nie łapiemy go raz przy starcie, żeby nie
// podpisywać przeterminowanym tokenem po dłuższej bezczynności).

import qz from "qz-tray";
import { supabase } from "@/lib/supabaseClient";

const QZ_CERT = `-----BEGIN CERTIFICATE-----
MIIC7jCCAdYCCQCZsV8RLYVX9DANBgkqhkiG9w0BAQsFADA5MQswCQYDVQQGEwJQ
TDEOMAwGA1UECgwFUmVjb28xGjAYBgNVBAMMEVJlY29vIEVSUCBRWiBUcmF5MB4X
DTI2MDkzMDEyMDYzMVoXDTM2MDkyNzEyMDYzMVowOTELMAkGA1UEBhMCUEwxDjAM
BgNVBAoMBVJlY29vMRowGAYDVQQDDBFSZWNvbyBFUlAgUVogVHJheTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAKY7bgN4TYKDryebvzNAIFhv7iLUX2fx
cKQQTq2CljmXFIw42iOWOEEWHZTW+M12DXMgc2Vljn5WPPluFToVprou1aVYpOWX
Gg2eT1L6vaj3+zI5o9wVjCCOeJZFSHSzBRsiq3xpWMBsoThy9ovX2iv6ZboI1Ffx
3EILIVYofgRKQ/Tw8XykZaIu/RaGUpwnVuXqyCbS4o49XHaAavUq039g8seK6+Tb
uN/q4D5R8HQiYx/Lpqk4Jpm05+o1BUEEo+VrgpmcimyJCQZ+4WaBGqxpQTOT+uWL
9cM/n/UFsQPJo99A1dJDZNn47tE0//YfW5sHoGZ4It1FjYIHVBBKyrECAwEAATAN
BgkqhkiG9w0BAQsFAAOCAQEAVIdwGXgI7h/yUSPvang9nmzK9aok2vdPC5x8pYXP
T9UnXB7EmP7Boa0mhsRYM3cJawnEc+XD1cZJ+Vtgl63KQUzrOv3fBTLNuA+/eMPK
yEm6DnQGcgOTfPteNRd6jAfhnJYXLZv6XUQyS3bvVHafaW/OT8RJVGdNBl68eab4
cKLlaATBovulaaLZACDLQVUO2JieT4KVxMXYzylJAfHbPhavNPHFdWax6uZ19mQX
0UFwCaOo7w0IX9saUVbYsML+wtB4cLj8rFmDz8ztmku7r3gvdVdKwcUMG6A0BrF6
G39qiXn8cZCmypeG02JjND3o7UsNVMk2fHh322dj9o1pNg==
-----END CERTIFICATE-----`;

export class PrintAgentError extends Error {}

let securityConfigured = false;
function configureSecurity() {
  if (securityConfigured) return;
  securityConfigured = true;
  qz.security.setCertificatePromise((resolve: (v: string) => void) => resolve(QZ_CERT));
  qz.security.setSignaturePromise((toSign: string) => async (resolve: (v: string) => void, reject: (e: any) => void) => {
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetch("/api/shipping/qz-sign", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}) },
        body: JSON.stringify({ toSign }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return reject(new Error(j?.error || "Nie udało się podpisać żądania."));
      resolve(j.signature);
    } catch (e) {
      reject(e);
    }
  });
}

let connecting: Promise<void> | null = null;

async function ensureConnected(): Promise<void> {
  if (qz.websocket.isActive()) return;
  configureSecurity();
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

// Czy etykieta ZPL na tej drukarce ma iść jako OBRAZ (06.10.2026). Prawdziwe Zebry (sterownik "ZDesigner ...", "Zebra ...") drukują ZPL wprost, a drukarki
// z "emulacją ZPL" innych marek (np. HPRT HD100) nie rozumieją fontów ZPL DHL (^A0N,,24 itp.) — tekst wychodzi nieczytelny, choć kody kreskowe są dobre.
// Dla nich etykieta jest renderowana (Labelary) do obrazu i drukowana jako sama grafika ^GFA, którą obsługuje każda drukarka ZPL.
export const printerNeedsImageLabel = (printerName: string | null | undefined) => !!printerName && !/zdesigner|zebra/i.test(printerName);
