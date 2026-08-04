// Generates src-tauri/icon-src.png: a 1024x1024 RGBA PNG app icon, zero deps
// (raw pixel buffer -> zlib deflate -> hand-rolled PNG chunks -- no canvas,
// no image library). Deliberately NOT a flat placeholder color: it draws a
// simple ascending four-bar "market data" glyph (dark slate background,
// teal-green bars with candlestick wicks) so the built app has a real,
// reproducible mark instead of the stock Tauri logo.
//
// Re-run any time to regenerate icon-src.png, then re-run
// `pnpm tauri icon src-tauri/icon-src.png` to refresh src-tauri/icons/*.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 1024;
const H = 1024;

const BG = [0x12, 0x16, 0x1d, 0xff]; // dark slate background
const BAR = [0x22, 0xc9, 0x9b, 0xff]; // teal-green bars
const WICK = [0x8f, 0xe9, 0xd2, 0xff]; // lighter wick accent

// Raw scanlines: each row is [filter byte 0] + W * RGBA.
const stride = 1 + W * 4;
const raw = Buffer.alloc(stride * H);
for (let y = 0; y < H; y++) {
  const rowStart = y * stride;
  raw[rowStart] = 0; // filter: None
  for (let x = 0; x < W; x++) {
    const o = rowStart + 1 + x * 4;
    raw[o] = BG[0];
    raw[o + 1] = BG[1];
    raw[o + 2] = BG[2];
    raw[o + 3] = BG[3];
  }
}

function fillRect(x0, y0, x1, y1, rgba) {
  const xs = Math.max(0, Math.round(x0));
  const xe = Math.min(W, Math.round(x1));
  const ys = Math.max(0, Math.round(y0));
  const ye = Math.min(H, Math.round(y1));
  for (let y = ys; y < ye; y++) {
    const rowStart = y * stride;
    for (let x = xs; x < xe; x++) {
      const o = rowStart + 1 + x * 4;
      raw[o] = rgba[0];
      raw[o + 1] = rgba[1];
      raw[o + 2] = rgba[2];
      raw[o + 3] = rgba[3];
    }
  }
}

// Four ascending candlestick-style bars, centered in the canvas.
const baseline = 760;
const barWidth = 100;
const gap = 60;
const heights = [280, 400, 520, 640];
const totalWidth = heights.length * barWidth + (heights.length - 1) * gap;
const startX = (W - totalWidth) / 2;
const wickWidth = 16;
const wickOverhang = 44;

heights.forEach((height, i) => {
  const x0 = startX + i * (barWidth + gap);
  const x1 = x0 + barWidth;
  const top = baseline - height;

  // Wick: thin center line extending above/below the body.
  const wx0 = x0 + barWidth / 2 - wickWidth / 2;
  const wx1 = wx0 + wickWidth;
  fillRect(wx0, top - wickOverhang, wx1, baseline + wickOverhang, WICK);

  // Body.
  fillRect(x0, top, x1, baseline, BAR);
});

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync("src-tauri/icon-src.png", png);
console.log("wrote src-tauri/icon-src.png");
