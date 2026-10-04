// Generates assets/branding/journal-app-icon-macos.png from the original app icon:
//   npx electron scripts/make-mac-icon.cjs
// macOS 26 and later put icons that do not fill the whole square on a grey
// platter. This version is full-bleed: the artwork's dark background (a slight
// vertical gradient) covers the 1024 px canvas and the glyph keeps its size and
// position; macOS applies its own rounded mask. The original PNG is unchanged.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { deflateSync } = require('node:zlib');

// A minimal RGB (colour type 2) PNG encoder: the icon must carry no alpha channel.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
function rgbPng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 3 + 1)] = 0; for (let x = 0; x < size; x++) { const i = (y * size + x) * 4; const o = y * (size * 3 + 1) + 1 + x * 3; raw[o] = rgba[i]; raw[o + 1] = rgba[i + 1]; raw[o + 2] = rgba[i + 2]; } }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const source = resolve(__dirname, '../assets/branding/journal-app-icon.png');
const target = resolve(__dirname, '../assets/branding/journal-app-icon-macos.png');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await window.loadURL('about:blank');
  const src = `data:image/png;base64,${readFileSync(source).toString('base64')}`;
  const png = await window.webContents.executeJavaScript(`new Promise((done, fail) => { const image = new Image();
    image.onerror = fail; image.onload = () => {
      const size = 1024; const canvas = document.createElement('canvas'); canvas.width = canvas.height = size; const g = canvas.getContext('2d', { alpha: false }); // opaque: no alpha channel at all
      // The source's background: #0d0d10 at the top fading to #030303.
      const fill = g.createLinearGradient(0, 0, 0, size); fill.addColorStop(0, '#0d0d10'); fill.addColorStop(0.45, '#050506'); fill.addColorStop(1, '#030303');
      g.fillStyle = fill; g.fillRect(0, 0, size, size);
      // The artwork's rounded square spans x 110-1143 of 1254 px (scale 1024/1034). Only the
      // glyph area (240-1014, dark margin included) is drawn, with "lighten", so the white
      // glyph keeps its exact size and position and no rounded border edge comes along.
      const scale = size / 1034; g.globalCompositeOperation = 'lighten';
      g.drawImage(image, 240, 240, 774, 774, (240 - 110) * scale, (240 - 110) * scale, 774 * scale, 774 * scale);
      done(Array.from(g.getImageData(0, 0, size, size).data)); }; image.src = ${JSON.stringify(src)}; })`);
  writeFileSync(target, rgbPng(Uint8Array.from(png), 1024));
  console.log(`Wrote ${target}`);
  app.quit();
});
