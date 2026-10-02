// Dane do TESTOWEGO wydruku (zakładka Wysyłka -> "Test druku", tymczasowe, 02.10.2026): próbna etykieta ZPL na Zebrę
// i próbny delivery note (PDF) na drukarkę A4 — żeby sprawdzić drukowanie bezpośrednie (QZ Tray) bez nadawania prawdziwej
// przesyłki w DHL i bez zgłaszania czegokolwiek do marketplace'u. Same ASCII (bez polskich znaków) — ZPL bez ^CI28
// i ręcznie składany PDF z czcionką Helvetica nie obsłużyłyby ogonków.

// Etykieta 100 x 150 mm przy 203 dpi (Zebra GK420d): ramka, napis, kod kreskowy.
export function testLabelZpl(): string {
  const stamp = new Date().toLocaleString("pl-PL").replace(/[^\x20-\x7E]/g, "");
  return [
    "^XA",
    "^PW812",
    "^LL1218",
    "^FO20,20^GB772,1178,4^FS",
    "^FO60,70^A0N,90,90^FDTEST DRUKU^FS",
    "^FO60,190^A0N,40,40^FDRecoo ERP - etykieta testowa^FS",
    `^FO60,250^A0N,34,34^FD${stamp}^FS`,
    "^FO60,340^A0N,34,34^FDZamowienie TEST-0001^FS",
    "^FO60,420^BY3^BCN,180,Y,N,N^FDTEST0001234567^FS",
    "^FO60,700^A0N,34,34^FDTo NIE jest prawdziwa przesylka.^FS",
    "^FO60,750^A0N,34,34^FDNiczego nie wyslano do DHL ani do marketplace.^FS",
    "^XZ",
  ].join("\n");
}

// Jednostronicowy PDF A4 składany ręcznie (bez biblioteki): kilka linii tekstu, poprawna tablica xref.
export function testDeliveryNotePdfBase64(): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stamp = new Date().toLocaleString("pl-PL").replace(/[^\x20-\x7E]/g, "");
  const lines: { size: number; y: number; text: string }[] = [
    { size: 26, y: 780, text: "DELIVERY NOTE - TEST" },
    { size: 13, y: 745, text: "Recoo ERP - testowy wydruk na drukarke A4" },
    { size: 12, y: 715, text: `Data: ${stamp}` },
    { size: 12, y: 690, text: "Zamowienie: TEST-0001" },
    { size: 12, y: 650, text: "1 x Testowy produkt (SN: TEST0001234567)" },
    { size: 11, y: 600, text: "To nie jest prawdziwy dokument. Nic nie zostalo wyslane do marketplace." },
  ];
  const content = lines.map((l) => `BT /F1 ${l.size} Tf 50 ${l.y} Td (${esc(l.text)}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return btoa(pdf);
}
