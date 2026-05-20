/* Velouria 1200 — generate amber square PNG icons with serif "V" glyph.
 * Run: node scripts/make-icons.js
 * Outputs: icons/icon-192.png and icons/icon-512.png
 *
 * Uses only node:zlib + node:fs (no native deps).
 */
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

/* CRC32 table (PNG chunk CRC) */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([tBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, tBuf, data, crc]);
}

/* Tiny 5x7 bitmap font for the letter "V" only. 1 = pixel on. */
const V_5x7 = [
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
  [1,0,0,0,1],
  [0,1,0,1,0],
  [0,0,1,0,0],
];

/* Renders a size x size RGBA image with a rounded amber square and a
 * centered "V" glyph in dark wood color. Returns raw RGBA bytes. */
function renderIcon(size) {
  const px = (r, g, b, a = 255) => [r, g, b, a];
  // Amber palette
  const AMBER     = [255, 174,  61, 255];
  const AMBER_HI  = [255, 208, 132, 255];
  const WOOD_INK  = [ 42,  24,  16, 255];
  const TRANSPARENT = [0, 0, 0, 0];

  const data = Buffer.alloc(size * size * 4);
  // Background gradient (radial from highlight to amber)
  const cx = size / 2, cy = size / 2;
  const radius = size * 0.5;
  const corner = size * 0.16; // rounded-square corner radius
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rounded square mask
      const dx = Math.max(0, Math.abs(x - cx) - (size / 2 - corner));
      const dy = Math.max(0, Math.abs(y - cy) - (size / 2 - corner));
      const d = Math.sqrt(dx * dx + dy * dy);
      const inside = d <= corner;
      const i = (y * size + x) * 4;
      if (!inside) {
        // For "any maskable" we still fill outside with amber so the safe
        // area covers the whole square — masking happens at the OS level.
        const t = Math.min(1, Math.hypot(x - cx, y - cy) / radius);
        const r = Math.round(AMBER_HI[0] * (1 - t) + AMBER[0] * t);
        const g = Math.round(AMBER_HI[1] * (1 - t) + AMBER[1] * t);
        const b = Math.round(AMBER_HI[2] * (1 - t) + AMBER[2] * t);
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      } else {
        const t = Math.min(1, Math.hypot(x - cx, y - cy) / radius);
        const r = Math.round(AMBER_HI[0] * (1 - t) + AMBER[0] * t);
        const g = Math.round(AMBER_HI[1] * (1 - t) + AMBER[1] * t);
        const b = Math.round(AMBER_HI[2] * (1 - t) + AMBER[2] * t);
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
    }
  }

  // Subtle outer ring (darker amber border)
  const borderW = Math.max(2, Math.round(size * 0.012));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distFromEdge = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (distFromEdge < borderW) {
        const i = (y * size + x) * 4;
        data[i]     = Math.round(data[i]     * 0.55);
        data[i + 1] = Math.round(data[i + 1] * 0.50);
        data[i + 2] = Math.round(data[i + 2] * 0.40);
      }
    }
  }

  // Draw "V" glyph centered using the bitmap
  const glyphCols = V_5x7[0].length;
  const glyphRows = V_5x7.length;
  const cell = Math.floor(size * 0.085);
  const glyphW = glyphCols * cell;
  const glyphH = glyphRows * cell;
  const ox = Math.floor((size - glyphW) / 2);
  const oy = Math.floor((size - glyphH) / 2);

  for (let gy = 0; gy < glyphRows; gy++) {
    for (let gx = 0; gx < glyphCols; gx++) {
      if (!V_5x7[gy][gx]) continue;
      for (let py = 0; py < cell; py++) {
        for (let px2 = 0; px2 < cell; px2++) {
          const x = ox + gx * cell + px2;
          const y = oy + gy * cell + py;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const i = (y * size + x) * 4;
          data[i] = WOOD_INK[0];
          data[i + 1] = WOOD_INK[1];
          data[i + 2] = WOOD_INK[2];
          data[i + 3] = 255;
        }
      }
    }
  }

  return data;
}

function writePng(filePath, size) {
  const rgba = renderIcon(size);
  // Add filter byte (0) at the start of each row.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = zlib.deflateSync(raw);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);  // bit depth
  ihdr.writeUInt8(6, 9);  // color type RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  const png = Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, png);
  console.log("wrote", filePath, png.length, "bytes");
}

writePng(path.resolve(__dirname, "..", "icons", "icon-192.png"), 192);
writePng(path.resolve(__dirname, "..", "icons", "icon-512.png"), 512);
