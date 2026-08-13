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

// Visual search: sketch mode needs no index, concept mode lazy-loads it.
await page.selectOption('#family', 'april');
await page.waitForTimeout(150);
await page.click('.findbtn');
await page.waitForTimeout(400);
if (!(await page.locator('#searchModal').isVisible())) errors.push('search modal did not open');

await page.click('.tab[data-tab="sketch"]');
await page.waitForTimeout(150);
const cells = page.locator('#sketchGrid div');
for (const i of [0, 1, 6, 7]) await cells.nth(i).click();
await page.click('#sketchGo');
await page.waitForTimeout(400);
let hits = await page.locator('.hit').count();
console.log('sketch search hits:', hits, '|', await page.textContent('#searchStatus'));
if (!hits) errors.push('sketch search returned nothing');

// Letter search: routes to glyph matching and must search across dictionaries.
await page.click('.tab[data-tab="concept"]');
await page.selectOption('#searchDict', '*');
await page.fill('#conceptQuery', 'letter L');
await page.click('#conceptGo');
await page.waitForTimeout(2500);
const letterStatus = await page.textContent('#searchStatus');
console.log('letter search:', await page.locator('.hit').count(), '|', letterStatus.slice(0, 90));
if (!/letter "L"/.test(letterStatus)) errors.push(`letter query did not route to glyph: ${letterStatus}`);
await page.screenshot({ path: path.join(outDir, 'search_letter.png') });

await page.fill('#conceptQuery', 'checkerboard');
await page.click('#conceptGo');
await page.waitForTimeout(2500);           // first query pulls in the index
hits = await page.locator('.hit').count();
const status = await page.textContent('#searchStatus');
console.log('concept search hits:', hits, '|', status);
if (!hits) errors.push(`concept search returned nothing: ${status}`);
await page.screenshot({ path: path.join(outDir, 'search.png') });

// Picking a result must load it into the controls and close the modal.
if (hits) {
  await page.locator('.hit').first().click();
  await page.waitForTimeout(300);
  if (await page.locator('#searchModal').isVisible()) errors.push('modal stayed open after picking');
  console.log('after pick:', (await page.textContent('#previewMeta')).slice(0, 70));
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

// ID range: one entry per id, at the current print size.
await page.selectOption('#family', 'aruco');
await page.waitForTimeout(200);
await page.fill('input[placeholder="0-9, 12, 20-24"]', '3-7, 20');
await page.click('text=Add range to sheet');
await page.waitForTimeout(500);
const rangeCount = Number(await page.textContent('#cartCount'));
console.log('cart after id range 3-7,20:', rangeCount, '|', await page.textContent('#rangeNote'));
if (rangeCount !== 6) errors.push(`id range added ${rangeCount} items, expected 6`);
const rangeLabels = await page.locator('#cartList li span').allTextContents();
if (!rangeLabels.some(t => /#3\b/.test(t)) || !rangeLabels.some(t => /#20\b/.test(t)))
  errors.push('id range did not queue the expected ids');
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
