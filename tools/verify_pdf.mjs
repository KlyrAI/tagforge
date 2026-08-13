// Mints a PDF sheet headlessly using the same pdf.js/render.js the browser uses,
// so the print geometry is tested rather than re-implemented.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';
import { createRequire } from 'module';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { jsPDF } = require(path.join(root, 'vendor', 'jspdf.umd.min.js'));

const ctx = { window: { jspdf: { jsPDF } }, console, Math, Blob: class {} };
vm.createContext(ctx);
for (const f of ['vendor/qrcode-generator.min.js', 'data/aruco_dicts.js', 'data/apriltag3.js',
                 'js/runetag.js', 'js/render.js', 'js/qrapril.js', 'js/nest.js', 'js/svg.js', 'js/pdf.js']) {
  vm.runInContext(readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}
const Render = vm.runInContext('Render', ctx);
const SvgOut = vm.runInContext('SvgOut', ctx);
const PdfOut = vm.runInContext('PdfOut', ctx);

// A size sweep of 36h11 #23 plus one ArUco and one RuneTag — the real use case.
const items = [];
const sweep = [15, 20, 30, 40, 60, 80, 100];
for (const mm of sweep) {
  const tile = Render.gridTag('april_36h11', 23, 1);
  items.push({ tile, phys: SvgOut.physMm(tile, mm), label: `36h11 #23 ${mm}mm`, sizeMm: mm });
}
for (const mm of [40, 60]) {
  const tile = Render.gridTag('6x6_1000', 7, 1);
  items.push({ tile, phys: SvgOut.physMm(tile, mm), label: `6x6 #7 ${mm}mm`, sizeMm: mm });
}
{
  const id = vm.runInContext('RuneTag', ctx).canonicalAt(1);
  const tile = Render.runeTag(id, 0.05);
  items.push({ tile, phys: SvgOut.physMm(tile, 80), label: `RUNE-129 #${id} 80mm`, sizeMm: 80 });
}
// deliberately tiny tags with long labels — the case where text used to run under
// the neighbouring marker
for (const mm of [10, 12, 15]) {
  const tile = Render.gridTag('7x7_1000', 123, 1);
  items.push({ tile, phys: SvgOut.physMm(tile, mm), label: `ArUco 7x7 (1000) #123 — ${mm}mm`, sizeMm: mm });
}

// Concealed / nested markers, at the sizes they'd actually be printed. This is the
// real test of the idea: does the QR still scan after going through the PDF pipeline?
const Nest = vm.runInContext('Nest', ctx);
const PAYLOAD = 'https://klyrai.github.io/tagforge/';
const qrL = (r, ecc = 'H') => ({ type: 'qr', payload: PAYLOAD, version: 0, ecc, ratioPct: r, quiet: 4 });
const leafSpec = { kind: 'grid', dict: 'april_36h11', id: 23 };
for (const mm of [40, 60, 80]) {
  const tile = Nest.compose([qrL(35)], leafSpec);
  items.push({ tile, phys: SvgOut.physMm(tile, mm), label: `QR-H + 36h11 #23 ${mm}mm`, sizeMm: mm, qrItem: true });
}
{
  const tile = Nest.compose([{ type: 'runetag', ordinal: 1, quietPct: 5 }, qrL(35)], leafSpec);
  items.push({ tile, phys: SvgOut.physMm(tile, 100), label: 'RuneTag+QR+36h11 #23 100mm', sizeMm: 100, qrItem: true });
}

const doc = PdfOut.mint(items, 'letter');

// ---- layout assertions: nothing may overlap, labels included ----
const placed = items.filter(i => i.placed);
let overlaps = 0;
for (let a = 0; a < placed.length; a++) {
  for (let b = a + 1; b < placed.length; b++) {
    const A = placed[a].placed, B = placed[b].placed;
    if (A.page !== B.page) continue;
    const ax2 = A.cellX + A.cellW, ay2 = A.y + A.h + 7;
    const bx2 = B.cellX + B.cellW, by2 = B.y + B.h + 7;
    if (A.cellX < bx2 && B.cellX < ax2 && A.y < by2 && B.y < ay2) {
      overlaps++;
      console.log(`  OVERLAP: "${placed[a].label}" vs "${placed[b].label}" on page ${A.page}`);
    }
  }
}
console.log(overlaps === 0 ? 'PASS no cell overlaps' : `FAIL ${overlaps} overlapping cells`);
if (overlaps) process.exitCode = 1;
writeFileSync(path.join(root, 'tools', 'verify_sheet.pdf'), Buffer.from(doc.output('arraybuffer')));
writeFileSync(path.join(root, 'tools', 'verify_sheet.json'),
  JSON.stringify({ expected: items.map(i => ({ label: i.label, w: i.phys.w, h: i.phys.h, skipped: !!i.skipped, qrItem: !!i.qrItem })) }));
console.log('wrote tools/verify_sheet.pdf —', items.length, 'items, skipped:', items.filter(i => i.skipped).length);
