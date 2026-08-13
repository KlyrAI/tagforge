// Compose a matrix of QR-concealed tags and dump them as pixel grids for OpenCV to
// decode. Sweeps ECC level x overlay ratio x QR version.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ctx = { window: {}, console, Math };
vm.createContext(ctx);
for (const f of ['vendor/qrcode-generator.min.js', 'data/aruco_dicts.js', 'data/apriltag3.js',
                 'js/runetag.js', 'js/render.js', 'js/qrapril.js', 'js/nest.js']) {
  vm.runInContext(readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}
const Render = vm.runInContext('Render', ctx);
const QrApril = vm.runInContext('QrApril', ctx);

const PAYLOAD = 'https://klyrai.github.io/tagforge/';
const TAG_DICT = 'april_36h11', TAG_ID = 23;
const PX = 8;   // pixels per QR module in the dump

function raster(tile, pxPerUnit) {
  const size = Math.round(tile.wu * pxPerUnit);
  const img = Array.from({ length: size }, () => new Array(size).fill(255));
  for (const s of tile.shapes) {
    const v = s.black ? 0 : 255;
    if (s.t === 'rect') {
      const x0 = Math.round(s.x * pxPerUnit), y0 = Math.round(s.y * pxPerUnit);
      const x1 = Math.round((s.x + s.w) * pxPerUnit), y1 = Math.round((s.y + s.h) * pxPerUnit);
      for (let y = Math.max(0, y0); y < Math.min(size, y1); y++)
        for (let x = Math.max(0, x0); x < Math.min(size, x1); x++) img[y][x] = v;
    } else {
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const dx = x + 0.5 - s.cx * pxPerUnit, dy = y + 0.5 - s.cy * pxPerUnit;
          if (dx * dx + dy * dy <= (s.r * pxPerUnit) ** 2) img[y][x] = v;
        }
    }
  }
  return img;
}

const cases = [];
const inner = Render.gridTag(TAG_DICT, TAG_ID, 1);
for (const version of [0, 3, 5, 8]) {
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    for (const ratioPct of [20, 25, 30, 35, 40, 45, 50]) {
      let tile;
      try {
        tile = QrApril.compose({ payload: PAYLOAD, version, ecc, innerTile: inner,
                                 innerLabel: `${TAG_DICT} #${TAG_ID}`, ratioPct, quiet: 4 });
      } catch (e) {
        // qrcode-generator throws bare strings ("code length overflow") for
        // payloads that exceed the chosen version's capacity.
        cases.push({ requestedVersion: version, ecc, ratioPct, error: String(e && e.message || e) });
        continue;
      }
      cases.push({
        version: tile.qr.version, requestedVersion: version, ecc, ratioPct,
        n: tile.qr.n, overlayModules: tile.qr.overlayModules,
        areaPct: +tile.qr.areaPct.toFixed(1), budgetPct: tile.qr.budgetPct,
        img: raster(tile, PX),
      });
    }
  }
}

// ---- nested stacks: each layer carries the next in its middle ----
const Nest = vm.runInContext('Nest', ctx);
const qrL = (r, ecc = 'H') => ({ type: 'qr', payload: PAYLOAD, version: 0, ecc, ratioPct: r, quiet: 4 });
const runeL = () => ({ type: 'runetag', ordinal: 1, quietPct: 5 });
const leaf = { kind: 'grid', dict: TAG_DICT, id: TAG_ID };

// Nested tiles differ hugely in abstract width, so rasterize each to a fixed pixel size
// — otherwise a RuneTag outer layer lands at a fraction of the resolution of a QR outer.
const NEST_PX = 900;
const stacks = {
  'qr(30) > tag':      [qrL(30)],
  'qr(40) > tag':      [qrL(40)],
  'qr > tag':          [qrL(35)],
  'runetag > tag':     [runeL()],
  'runetag > qr > tag': [runeL(), qrL(35)],
  'runetag > qr(45) > tag': [runeL(), qrL(45)],
  'qr(50) > runetag > tag': [qrL(50), runeL()],
  'qr(40) > runetag > tag': [qrL(40), runeL()],
};
const nested = [];
for (const [name, stack] of Object.entries(stacks)) {
  try {
    const tile = Nest.compose(stack, leaf);
    nested.push({ name, label: tile.stack.label, notes: tile.stack.notes, depth: tile.stack.depth,
                  hasQr: stack.some(l => l.type === 'qr'),
                  img: raster(tile, NEST_PX / tile.wu) });
  } catch (e) {
    nested.push({ name, error: String(e && e.message || e) });
  }
}

writeFileSync(path.join(root, 'tools', 'verify_qr_dump.json'),
  JSON.stringify({ payload: PAYLOAD, tagDict: TAG_DICT, tagId: TAG_ID, px: PX, cases, nested }));
console.log(`dumped ${cases.length} matrix configurations, ${nested.length} nested stacks`);
