// Node harness: loads the browser JS (window-shimmed) and dumps bit grids / dot patterns
// as JSON for cross-checking against OpenCV + reference data.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ctx = { window: {}, document: undefined, console };
vm.createContext(ctx);
for (const f of ['data/aruco_dicts.js', 'data/apriltag3.js', 'js/runetag.js', 'js/render.js']) {
  vm.runInContext(readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}
const Render = vm.runInContext('Render', ctx);
const RuneTag = vm.runInContext('RuneTag', ctx);
const W = ctx.window;

const out = {};

// ---- ArUco / AprilTag classic: full bit grids (data area only) ----
out.grids = {};
for (const [dict, ids] of Object.entries({
  '4x4_1000': [0, 1, 23, 999], '5x5_1000': [0, 42], '6x6_1000': [0, 23, 777],
  '7x7_1000': [0, 5], 'aruco': [0, 100], 'mip_36h12': [0, 10],
  'april_16h5': [0, 7, 29], 'april_25h9': [0, 34], 'april_36h10': [0, 2319], 'april_36h11': [0, 23, 586],
})) {
  const d = W.ARUCO_DICTS[dict];
  out.grids[dict] = {};
  for (const id of ids) out.grids[dict][id] = Render.decodeBits(d.markers[id], d.width, d.height);
}

// ---- AprilTag3: full rendered pixel image (total_width incl. border), 1 = white ----
out.at3 = {};
for (const fam of Object.keys(W.APRILTAG3)) {
  out.at3[fam] = {};
  for (const id of [0, 1, 42]) {
    const tile = Render.aprilTag3(fam, id, 0);
    const tw = W.APRILTAG3[fam].total_width;
    // rasterize shape list at 1 unit = 1 px
    const px = Array.from({ length: tw }, () => new Array(tw).fill(0));
    for (const s of tile.shapes) {
      if (s.t !== 'rect') continue;
      const v = s.black ? 0 : 1;
      for (let y = Math.round(s.y); y < Math.round(s.y + s.h); y++)
        for (let x = Math.round(s.x); x < Math.round(s.x + s.w); x++)
          if (y >= 0 && y < tw && x >= 0 && x < tw) px[y][x] = v;
    }
    // black background is implicit paper-white outside first rect; first shape covers all
    out.at3[fam][id] = px;
  }
}

// ---- RuneTag: 129 dot flags for a few ids + canonical index mapping ----
out.rune = {};
for (const id of [1, 6, 100, 12345]) {
  try {
    const { code, index } = RuneTag.generate(id);
    out.rune[id] = { index, code, bits: RuneTag.unpack(code).map(b => b ? 1 : 0) };
  } catch (e) {
    out.rune[id] = { error: e.message };
  }
}

// ---- Boards: rasterize at a known px/mm so OpenCV can compare pixel-for-pixel ----
function raster(tile, pxPerUnit) {
  const w = Math.round(tile.wu * pxPerUnit), h = Math.round(tile.hu * pxPerUnit);
  const img = Array.from({ length: h }, () => new Array(w).fill(1)); // 1 = white paper
  for (const s of tile.shapes) {
    const v = s.black ? 0 : 1;
    if (s.t === 'rect') {
      const x0 = Math.round(s.x * pxPerUnit), y0 = Math.round(s.y * pxPerUnit);
      const x1 = Math.round((s.x + s.w) * pxPerUnit), y1 = Math.round((s.y + s.h) * pxPerUnit);
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) img[y][x] = v;
    }
  }
  return img;
}

// ChArUco: 32mm squares / 24mm markers keeps modules on integer pixels at 32 px/square,
// so a mismatch means real geometry drift, not resampling noise.
out.charuco = {};
for (const [sx, sy, legacy] of [[4, 6, true], [4, 6, false], [5, 7, true], [5, 7, false], [6, 4, true], [3, 3, true]]) {
  const tile = Render.charucoBoard('6x6_1000', sx, sy, 32, 24, legacy, 0);
  out.charuco[`${sx}x${sy}_${legacy}`] = { img: raster(tile, 32), sx, sy, legacy };
}

// Grid board: units are mm, 32mm markers / 8mm gap, 1 px/mm
out.gridboard = { img: raster(Render.gridBoard('6x6_1000', 4, 5, 32, 8, 0, 0), 1), mx: 4, my: 5, markerMm: 32, sepMm: 8 };

// ---- glyph search: templates and routing, no index needed ----
vm.runInContext(readFileSync(path.join(root, 'js/search.js'), 'utf8'), ctx, { filename: 'search.js' });
const TagSearch = vm.runInContext('TagSearch', ctx);
const ALL_DICTS = ['april_36h11', 'april_36h10', '4x4_1000', '5x5_1000', '6x6_1000', '7x7_1000', 'aruco'];
let glyphFails = 0;
const gcheck = (name, ok, extra = '') => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
  if (!ok) glyphFails++;
};

// Every glyph is 15 bits of a 3x5 cell and must place inside the grid.
for (const [ch, rows] of Object.entries(TagSearch.FONT3x5)) {
  if (rows.length !== 15) gcheck(`font "${ch}" is 3x5`, false, `${rows.length} cells`);
}
gcheck('font covers A-Z and 0-9', Object.keys(TagSearch.FONT3x5).length === 36,
       `${Object.keys(TagSearch.FONT3x5).length} glyphs`);
gcheck('glyph needs at least 5 modules', TagSearch.glyphTemplate('A', 4) === null);
gcheck('"letter A", "A" and "the letter a" all route to the same glyph',
       TagSearch.asGlyph('letter A') === 'A' && TagSearch.asGlyph('A') === 'A' &&
       TagSearch.asGlyph('the letter a') === 'A');
gcheck('a multi-word concept is not treated as a glyph', TagSearch.asGlyph('a smiling face') === null);

// Known best matches. These are fixed by the dictionaries, so they pin the scoring.
for (const [ch, dict, id, score] of [['L', 'aruco', 64, 0.88], ['U', '5x5_1000', 809, 0.92],
                                     ['N', 'aruco', 1023, 0.92]]) {
  const r = TagSearch.glyph(ch, ALL_DICTS, 1);
  const top = r.results[0];
  gcheck(`best "${ch}" is ${dict} #${id}`,
         top && top.dict === dict && top.id === id && Math.abs(top.score - score) < 0.005,
         top ? `${top.dict} #${top.id} at ${top.score.toFixed(2)}` : 'no result');
}
if (glyphFails) process.exitCode = 1;

writeFileSync(path.join(root, 'tools', 'verify_dump.json'), JSON.stringify(out));
console.log('dumped tools/verify_dump.json');

// quick internal sanity for runetag: aligned code must re-align to itself
const { code, index } = RuneTag.generate(1);
const again = RuneTag.generate(index);
console.log('rune generate(1) -> canonical', index, '| generate(canonical) ->', again.index,
            '| stable:', again.index === index);
