// Browser smoke test: loads index.html from file://, exercises every family,
// runs a size sweep, and mints the PDF through the real download path.
// Playwright is not a project dependency; resolve it from wherever it is installed.
// Override with PLAYWRIGHT_PATH=<...>/node_modules/playwright/index.mjs if needed.
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, rmSync, mkdirSync } from 'fs';

// Playwright is not a project dependency. Use an installed copy if resolvable, else
// point at one with PLAYWRIGHT_PATH=<...>/node_modules/playwright/index.mjs
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  if (!process.env.PLAYWRIGHT_PATH) {
    console.error('playwright not found — `npm i -D playwright` or set PLAYWRIGHT_PATH');
    process.exit(2);
  }
  ({ chromium } = await import('file:///' + process.env.PLAYWRIGHT_PATH.replace(/\\/g, '/')));
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'tools', 'ui_out');
if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto('file://' + path.join(root, 'index.html').replace(/\\/g, '/'));
await page.waitForTimeout(300);

const families = ['aruco', 'april', 'april3', 'runetag', 'charuco', 'gridboard', 'qrtag'];
for (const fam of families) {
  await page.selectOption('#family', fam);
  await page.waitForTimeout(120);
  const meta = await page.textContent('#previewMeta');
  const svgCount = await page.locator('#preview svg').count();
  const err = await page.locator('#preview .err').count();
  console.log(`${fam.padEnd(10)} svg=${svgCount} err=${err} | ${meta}`);
  if (!svgCount || err) errors.push(`family ${fam} failed to preview`);
  await page.screenshot({ path: path.join(outDir, `${fam}.png`) });
}

// QR concealment: the live decode badge must say the symbol still reads, and adding a
// RuneTag layer must build the nested stack without error.
await page.selectOption('#family', 'qrtag');
await page.waitForTimeout(250);
const badge = await page.textContent('#scanBadge');
console.log('scan badge:', badge);
if (!/decodes ✓/.test(badge)) errors.push(`default QR config does not decode: ${badge}`);

await page.click('text=+ RuneTag layer');
await page.waitForTimeout(400);
const nestedMeta = await page.textContent('#previewMeta');
console.log('nested:', nestedMeta.slice(0, 110));
if (!/RUNE-129/.test(nestedMeta)) errors.push('RuneTag layer did not appear in nested stack');
if (await page.locator('#preview .err').count()) errors.push('nested stack failed to render');
await page.screenshot({ path: path.join(outDir, 'nested.png') });

await page.click('#matrixBtn');
await page.waitForTimeout(400);
const matrixCount = Number(await page.textContent('#cartCount'));
console.log('cart after robustness matrix:', matrixCount);
if (matrixCount !== 20) errors.push(`matrix added ${matrixCount} items, expected 20`);
await page.click('#clearBtn');

// Size sweep on AprilTag 36h11
await page.selectOption('#family', 'april');
await page.waitForTimeout(100);
await page.click('#sweepBtn');
await page.waitForTimeout(150);
let count = await page.textContent('#cartCount');
console.log('cart after sweep:', count);
if (Number(count) !== 7) errors.push(`sweep added ${count} items, expected 7`);

// Add a RuneTag and a ChArUco board too
for (const fam of ['runetag', 'charuco']) {
  await page.selectOption('#family', fam);
  await page.waitForTimeout(120);
  await page.click('#addBtn');
}
count = await page.textContent('#cartCount');
console.log('cart total:', count);

// Mint the PDF via the real download path
const dl = page.waitForEvent('download', { timeout: 15000 });
await page.click('#mintBtn');
const download = await dl;
const pdfPath = path.join(outDir, 'ui-sheet.pdf');
await download.saveAs(pdfPath);
console.log('downloaded:', download.suggestedFilename());

// SVG + PNG export paths
await page.selectOption('#family', 'aruco');
await page.waitForTimeout(120);
for (const [btn, name] of [['#svgBtn', 'svg'], ['#pngBtn', 'png']]) {
  const d = page.waitForEvent('download', { timeout: 20000 });
  await page.click(btn);
  const f = await d;
  await f.saveAs(path.join(outDir, f.suggestedFilename()));
  console.log(`${name} export:`, f.suggestedFilename());
}

await page.screenshot({ path: path.join(outDir, 'full.png'), fullPage: true });
await browser.close();

if (errors.length) {
  console.log('\nERRORS:');
  errors.forEach(e => console.log('  ' + e));
  process.exit(1);
}
console.log('\nUI smoke test passed');
