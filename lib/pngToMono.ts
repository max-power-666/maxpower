// Minimalny dekoder PNG -> czerń/biel (06.10.2026), bez zależności (w projekcie nie ma biblioteki do obrazów). Służy do zamiany etykiety wyrenderowanej przez
// Labelary (PNG) na grafikę ZPL ^GFA dla drukarek, które nie rozumieją fontów ZPL po zebrowemu (np. HPRT w trybie emulacji ZPL). Obsługuje PNG bez przeplotu:
// typy kolorów 0/2/3/4/6, głębia 1–8 bitów. Czysta logika (zlib z Node), testowana osobno.

import { inflateSync } from "zlib";
import type { Mono } from "./gifToZpl";

export function pngToMono(png: Uint8Array, threshold = 128): Mono {
  const buf = Buffer.from(png);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 33 || sig.some((b, i) => buf[i] !== b)) throw new Error("To nie jest obraz PNG.");
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!width || !height) throw new Error("Uszkodzony PNG (brak nagłówka).");
  if (interlace) throw new Error("PNG z przeplotem nie jest obsługiwany.");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels || ![1, 2, 4, 8].includes(depth)) throw new Error(`Nieobsługiwany format PNG (typ ${colorType}, ${depth} bit).`);
  const bpp = Math.max(1, (channels * depth) >> 3); // bajtów na piksel do filtrów (min. 1)
  const stride = Math.ceil((width * channels * depth) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("Uszkodzony PNG (za mało danych).");

  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error("Uszkodzony PNG (nieznany filtr).");
      px[dst + x] = v & 255;
    }
  }

  const black = new Uint8Array(width * height);
  const sample = (y: number, i: number) => {
    // i-ta próbka (kanał) w wierszu y, przeliczona na 0..255
    if (depth === 8) return px[y * stride + i];
    const bitPos = i * depth;
    const byte = px[y * stride + (bitPos >> 3)];
    const v = (byte >> (8 - depth - (bitPos & 7))) & ((1 << depth) - 1);
    return colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lum: number;
      let alpha = 255;
      if (colorType === 3) {
        const idx = sample(y, x);
        if (!palette) throw new Error("Uszkodzony PNG (brak palety).");
        lum = (palette[idx * 3] * 299 + palette[idx * 3 + 1] * 587 + palette[idx * 3 + 2] * 114) / 1000;
        if (trns && idx < trns.length) alpha = trns[idx];
      } else if (colorType === 0) lum = sample(y, x);
      else if (colorType === 4) {
        lum = sample(y, x * 2);
        alpha = sample(y, x * 2 + 1);
      } else {
        const r = sample(y, x * channels), g = sample(y, x * channels + 1), bl = sample(y, x * channels + 2);
        lum = (r * 299 + g * 587 + bl * 114) / 1000;
        if (colorType === 6) alpha = sample(y, x * 4 + 3);
      }
      if (alpha < 128) lum = 255; // przezroczystość = papier
      black[y * width + x] = lum < threshold ? 1 : 0;
    }
  }
  return { width, height, black };
}
