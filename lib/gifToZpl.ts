// Etykieta UPS jako obraz GIF -> ZPL (05.10.2026). UPS dla niektórych przesyłek (u nas: z POBRANIEM, "EDI-COD") zwraca etykietę wyłącznie jako GIF, mimo prośby o ZPL
// (odpowiedź niesie LabelImageFormat "zpl", a w GraphicImage jest GIF — sprawdzone na produkcji, także przez Label Recovery w formatach ZPL/EPL/SPL/GIF). Podgląd (Labelary) i druk
// na Zebrę (QZ Tray, surowy ZPL) potrzebują ZPL, więc GIF zamieniamy tu na grafikę ZPL (^GFA): dekodowanie GIF (LZW) -> czerń/biel -> obrót o 90° (UPS daje etykietę leżącą)
// -> przycięcie do zawartości -> ZPL z kompresją. Czysta logika, bez zależności (w projekcie nie ma biblioteki do obrazów), testowana osobno.

export type Mono = { width: number; height: number; black: Uint8Array }; // black[y * width + x] = 1 dla czarnego piksela

export function isGif(buf: Uint8Array): boolean {
  return buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38; // "GIF8"
}

// Dekoder pierwszej klatki GIF (87a/89a): paleta globalna/lokalna, LZW, przeplot, przezroczystość = biel.
export function decodeGifToMono(buf: Uint8Array, threshold = 128): Mono {
  if (!isGif(buf)) throw new Error("To nie jest obraz GIF.");
  let p = 6;
  const sw = buf[p] | (buf[p + 1] << 8);
  const sh = buf[p + 2] | (buf[p + 3] << 8);
  const flags = buf[p + 4];
  p += 7;
  let palette: Uint8Array | null = null;
  if (flags & 0x80) {
    const n = 3 * (1 << ((flags & 7) + 1));
    palette = buf.subarray(p, p + n);
    p += n;
  }
  let transparent = -1;
  while (p < buf.length) {
    const block = buf[p++];
    if (block === 0x21) {
      const label = buf[p++];
      if (label === 0xf9 && buf[p] >= 4) {
        if (buf[p + 1] & 1) transparent = buf[p + 4];
      }
      while (buf[p] !== 0 && p < buf.length) p += buf[p] + 1; // bloki rozszerzeń
      p++;
    } else if (block === 0x2c) {
      const left = buf[p] | (buf[p + 1] << 8);
      const top = buf[p + 2] | (buf[p + 3] << 8);
      const w = buf[p + 4] | (buf[p + 5] << 8);
      const h = buf[p + 6] | (buf[p + 7] << 8);
      const lf = buf[p + 8];
      p += 9;
      if (lf & 0x80) {
        const n = 3 * (1 << ((lf & 7) + 1));
        palette = buf.subarray(p, p + n);
        p += n;
      }
      const interlaced = (lf & 0x40) !== 0;
      const minCode = buf[p++];
      const chunks: number[] = [];
      while (p < buf.length && buf[p] !== 0) {
        const len = buf[p++];
        for (let i = 0; i < len; i++) chunks.push(buf[p + i]);
        p += len;
      }
      const indices = lzwDecode(Uint8Array.from(chunks), minCode, w * h);
      if (!palette) throw new Error("GIF bez palety kolorów.");
      const black = new Uint8Array(sw * sh); // tło poza klatką = biel
      const rowOrder = interlaced ? interlacedRows(h) : null;
      for (let row = 0; row < h; row++) {
        const y = top + (rowOrder ? rowOrder[row] : row);
        if (y >= sh) continue;
        for (let col = 0; col < w; col++) {
          const x = left + col;
          if (x >= sw) continue;
          const idx = indices[row * w + col];
          if (idx === transparent) continue;
          const r = palette[idx * 3], g = palette[idx * 3 + 1], b = palette[idx * 3 + 2];
          if (0.299 * r + 0.587 * g + 0.114 * b < threshold) black[y * sw + x] = 1;
        }
      }
      return { width: sw, height: sh, black };
    } else if (block === 0x3b) break;
    else break;
  }
  throw new Error("W pliku GIF nie znaleziono obrazu.");
}

function interlacedRows(h: number): number[] {
  const order: number[] = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < h; y += step) order.push(y);
  return order; // order[k] = numer wiersza docelowego dla k-tego wiersza w strumieniu
}

function lzwDecode(data: Uint8Array, minCode: number, expected: number): Uint8Array {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  const out = new Uint8Array(expected);
  let outPos = 0;
  let codeSize = minCode + 1;
  let next = eoi + 1;
  // słownik: dla kodu c — prefiks i ostatni znak
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const lengths = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) {
    suffix[i] = i;
    lengths[i] = 1;
    prefix[i] = -1;
  }
  let bitBuf = 0, bitCnt = 0, pos = 0;
  let prev = -1;
  const stack = new Uint8Array(4097);
  while (outPos < expected) {
    while (bitCnt < codeSize && pos < data.length) {
      bitBuf |= data[pos++] << bitCnt;
      bitCnt += 8;
    }
    if (bitCnt < codeSize) break;
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>= codeSize;
    bitCnt -= codeSize;
    if (code === clear) {
      codeSize = minCode + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    let cur = code;
    let sp = 0;
    if (code >= next) {
      // KwKwK: kod jeszcze nie w słowniku = poprzedni ciąg + jego pierwszy znak
      if (prev < 0) throw new Error("Uszkodzony GIF (LZW).");
      stack[sp++] = 0; // zostanie uzupełnione pierwszym znakiem poprzedniego ciągu
      cur = prev;
    }
    while (cur >= clear) {
      stack[sp++] = suffix[cur];
      cur = prefix[cur];
    }
    stack[sp++] = suffix[cur];
    const first = stack[sp - 1];
    if (code >= next) stack[0] = first;
    while (sp > 0 && outPos < expected) out[outPos++] = stack[--sp];
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      lengths[next] = lengths[prev] + 1;
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return out;
}

// Obrót o 90° w prawo (zgodnie z ruchem wskazówek zegara): UPS daje etykietę 4x6 "leżącą" (tekst czyta się od dołu do góry) — po obrocie jest pionowa i czytelna.
export function rotateCw(m: Mono): Mono {
  const { width: w, height: h } = m;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m.black[y * w + x]) out[x * h + (h - 1 - y)] = 1;
  return { width: h, height: w, black: out };
}

// Przycięcie do prostokąta zawierającego wszystkie czarne piksele (obraz UPS ma biały margines po prawej stronie).
export function cropToContent(m: Mono): Mono {
  let minX = m.width, minY = m.height, maxX = -1, maxY = -1;
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (m.black[y * m.width + x]) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return m;
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = m.black[(minY + y) * m.width + (minX + x)];
  return { width: w, height: h, black: out };
}

const RUN_HI = "ghijklmnopqrstuvwxyz"; // 20, 40, ..., 400
const RUN_LO = "GHIJKLMNOPQRSTUVWXY"; // 1..19
function runCode(ch: string, n: number): string {
  if (n === 1) return ch;
  let out = "";
  while (n > 400) {
    out += "z" + ch;
    n -= 400;
  }
  const hi = Math.floor(n / 20), lo = n % 20;
  if (hi > 0) out += RUN_HI[hi - 1];
  if (lo > 0) out += RUN_LO[lo - 1];
  return out + ch;
}

// Wiersz bitmapy -> hex (pole ^GFA) z kompresją ZPL: powtórzenia znaków (G–Y, g–z), "," = reszta wiersza zer, "!" = reszta jedynek, ":" = ten sam wiersz co poprzedni.
export function monoToGfa(m: Mono): { total: number; rowBytes: number; data: string } {
  const rowBytes = Math.ceil(m.width / 8);
  let prevHex = "";
  const lines: string[] = [];
  for (let y = 0; y < m.height; y++) {
    let hex = "";
    for (let b = 0; b < rowBytes; b++) {
      let v = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = b * 8 + bit;
        if (x < m.width && m.black[y * m.width + x]) v |= 0x80 >> bit;
      }
      hex += v.toString(16).toUpperCase().padStart(2, "0");
    }
    if (hex === prevHex) {
      lines.push(":");
      continue;
    }
    prevHex = hex;
    // uciąć końcówkę z samych zer ("," = reszta wiersza zerami) albo z samych F ("!" = reszta jedynkami)
    let end = hex.length;
    let tail = "";
    const zeros = /0+$/.exec(hex);
    const effs = /F+$/.exec(hex);
    if (zeros) {
      end = zeros.index;
      tail = ",";
    } else if (effs) {
      end = effs.index;
      tail = "!";
    }
    let out = "";
    let i = 0;
    while (i < end) {
      let j = i + 1;
      while (j < end && hex[j] === hex[i]) j++;
      out += runCode(hex[i], j - i);
      i = j;
    }
    lines.push(out + tail);
  }
  return { total: rowBytes * m.height, rowBytes, data: lines.join("") };
}

// Etykieta UPS z GIF -> ZPL 4x6 cala (203 dpi, 812 x 1218 punktów); obraz wyśrodkowany w poziomie.
export function gifLabelToZpl(gif: Uint8Array): string {
  const mono = rotateCw(cropToContent(decodeGifToMono(gif)));
  const { total, rowBytes, data } = monoToGfa(mono);
  const ox = Math.max(0, Math.floor((812 - mono.width) / 2));
  return `^XA\n^PW812\n^LL1218\n^LH0,0\n^FO${ox},0^GFA,${total},${total},${rowBytes},${data}^FS\n^XZ\n`;
}
