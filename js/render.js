// Family renderers. Each returns a "tile":
// { wu, hu: size in abstract units; shapes: [{t:'rect',x,y,w,h,black}|{t:'circle',cx,cy,r,black}];
//   info: { family, dict, id, moduleNote(sizeMm) } }
// Units map linearly to mm at output time (tile is square unless board).
// White paper is the implied background; black shapes drawn first, white cutouts after.

'use strict';

const Render = (() => {

  // ---- ArUco / AprilTag classic (OpenCV bytesList via arucogen packing) ----
  // MSB-first bytes; final byte holds the remainder in its LOW bits. bit=1 -> white module.
  function decodeBits(bytes, w, h) {
    const bitsCount = w * h;
    const bits = [];
    for (const byte of bytes) {
      const start = bitsCount - bits.length;
      for (let i = Math.min(7, start - 1); i >= 0; i--) bits.push((byte >> i) & 1);
    }
    return bits; // row-major
  }

  // Merge horizontal runs of white cells into single rects (clean vector output),
  // with a hair of overlap so adjacent rows never show hairlines in PDF renderers.
  const BLEED = 0.003;
  function mergeRuns(isSet, w, h, ox, oy, shapes, black = false) {
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!isSet(x, y)) { x++; continue; }
        let x2 = x;
        while (x2 + 1 < w && isSet(x2 + 1, y)) x2++;
        shapes.push({ t: 'rect', x: ox + x - BLEED, y: oy + y - BLEED,
                      w: (x2 - x + 1) + 2 * BLEED, h: 1 + 2 * BLEED, black });
        x = x2 + 1;
      }
    }
  }
  const whiteRuns = (isWhite, w, h, ox, oy, shapes) => mergeRuns(isWhite, w, h, ox, oy, shapes, false);

  function gridTag(dictKey, id, quiet) {
    const d = window.ARUCO_DICTS[dictKey];
    if (!d) throw new Error('unknown dict ' + dictKey);
    if (id < 0 || id >= d.markers.length) throw new Error(`${d.label}: id ${id} out of range (0-${d.markers.length - 1})`);
    const w = d.width, h = d.height;
    const bits = decodeBits(d.markers[id], w, h);
    const grid = w + 2;                 // black border = 1 module
    const total = grid + 2 * quiet;
    const shapes = [{ t: 'rect', x: quiet, y: quiet, w: grid, h: grid, black: true }];
    whiteRuns((x, y) => !!bits[y * w + x], w, h, quiet + 1, quiet + 1, shapes);
    return {
      wu: total, hu: total, shapes,
      info: {
        family: dictKey.startsWith('april') ? 'AprilTag' : 'ArUco', dict: d.label, id,
        moduleNote: mm => `module ${(mm / total).toFixed(1)}mm`,
      },
    };
  }

  // ---- AprilTag 3 (port of apriltag_to_image) ----
  function aprilTag3(famKey, id, quiet) {
    const f = window.APRILTAG3[famKey];
    if (!f) throw new Error('unknown family ' + famKey);
    if (id < 0 || id >= f.embedded) throw new Error(`${famKey}: id ${id} out of embedded range (0-${f.embedded - 1}; family has ${f.ncodes})`);
    const tw = f.total_width;
    const px = Array.from({ length: tw }, () => new Uint8Array(tw)); // 0=black 1=white

    const wbw = f.width_at_border + (f.reversed_border ? 0 : 2);
    const wbs = (tw - wbw) >> 1;
    for (let i = 0; i < wbw - 1; i++) {
      px[wbs][wbs + i] = 1;
      px[wbs + i][tw - 1 - wbs] = 1;
      px[tw - 1 - wbs][wbs + i + 1] = 1;
      px[wbs + 1 + i][wbs] = 1;
    }
    const bs = (tw - f.width_at_border) >> 1;
    const code = BigInt('0x' + f.codes[id]);
    for (let i = 0; i < f.nbits; i++) {
      if ((code >> BigInt(f.nbits - i - 1)) & 1n) px[f.bit_y[i] + bs][f.bit_x[i] + bs] = 1;
    }

    const total = tw + 2 * quiet;
    const shapes = [{ t: 'rect', x: quiet, y: quiet, w: tw, h: tw, black: true }];
    whiteRuns((x, y) => !!px[y][x], tw, tw, quiet, quiet, shapes);
    return {
      wu: total, hu: total, shapes,
      info: {
        family: 'AprilTag3', dict: famKey, id,
        moduleNote: mm => `module ${(mm / total).toFixed(1)}mm`,
      },
    };
  }

  // ---- RuneTag (RUNE-129; port of artursg/RUNEtag coding.cpp + generator, MIT) ----
  function runeTag(id, quiet) {
    const tile = window.RuneTag.render(id, quiet);
    return tile;
  }

  // ---- ChArUco board ----
  // OpenCV convention: chessboard with black square at (0,0) (top-left); markers occupy
  // the white squares in row-major order with sequential ids. The pre-4.6 "legacy"
  // pattern only differs when both square counts are even — there it starts on a
  // marker square instead (matches cv2 CharucoBoard.setLegacyPattern).
  function charucoBoard(dictKey, sx, sy, squareMm, markerMm, legacy, quietMm) {
    const d = window.ARUCO_DICTS[dictKey];
    const q = quietMm / squareMm;                     // quiet zone in square units
    const shapes = [];
    const mu = markerMm / squareMm;                   // marker size in square units
    const mw = d.width + 2;                           // marker grid incl. border
    const flip = legacy && sx % 2 === 0 && sy % 2 === 0;
    let idNext = 0;
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const blackSquare = (x % 2 === y % 2) !== flip;
        if (blackSquare) {
          shapes.push({ t: 'rect', x: q + x, y: q + y, w: 1, h: 1, black: true });
        } else {
          if (idNext >= d.markers.length) throw new Error(`${d.label}: board needs more ids than dict has`);
          const bits = decodeBits(d.markers[idNext], d.width, d.height);
          const m = mu / mw;                          // one marker module in square units
          const ox = q + x + (1 - mu) / 2, oy = q + y + (1 - mu) / 2;
          shapes.push({ t: 'rect', x: ox, y: oy, w: mu, h: mu, black: true });
          for (let yy = 0; yy < d.height; yy++) {
            let xx = 0;
            while (xx < d.width) {
              if (!bits[yy * d.width + xx]) { xx++; continue; }
              let x2 = xx;
              while (x2 + 1 < d.width && bits[yy * d.width + x2 + 1]) x2++;
              shapes.push({ t: 'rect', x: ox + (1 + xx) * m - BLEED * m, y: oy + (1 + yy) * m - BLEED * m,
                            w: (x2 - xx + 1) * m + 2 * BLEED * m, h: m + 2 * BLEED * m, black: false });
              xx = x2 + 1;
            }
          }
          idNext++;
        }
      }
    }
    return {
      wu: sx + 2 * q, hu: sy + 2 * q, shapes, unitMm: squareMm, board: true,
      info: {
        family: 'ChArUco', dict: d.label, id: `${sx}x${sy}`,
        moduleNote: () => `square ${squareMm}mm, marker ${markerMm}mm, ids 0-${idNext - 1}${legacy ? ', legacy' : ''}`,
      },
    };
  }

  // ---- ArUco grid board ----
  function gridBoard(dictKey, mx, my, markerMm, sepMm, firstId, quietMm) {
    const d = window.ARUCO_DICTS[dictKey];
    const mw = d.width + 2;
    const u = markerMm;                               // units are mm here
    const pitch = markerMm + sepMm;
    const q = quietMm;
    const shapes = [];
    let id = firstId;
    for (let y = 0; y < my; y++) {
      for (let x = 0; x < mx; x++) {
        if (id >= d.markers.length) throw new Error(`${d.label}: board exceeds dict size`);
        const bits = decodeBits(d.markers[id], d.width, d.height);
        const ox = q + x * pitch, oy = q + y * pitch;
        const m = u / mw;
        shapes.push({ t: 'rect', x: ox, y: oy, w: u, h: u, black: true });
        for (let yy = 0; yy < d.height; yy++) {
          let xx = 0;
          while (xx < d.width) {
            if (!bits[yy * d.width + xx]) { xx++; continue; }
            let x2 = xx;
            while (x2 + 1 < d.width && bits[yy * d.width + x2 + 1]) x2++;
            shapes.push({ t: 'rect', x: ox + (1 + xx) * m - BLEED * m, y: oy + (1 + yy) * m - BLEED * m,
                          w: (x2 - xx + 1) * m + 2 * BLEED * m, h: m + 2 * BLEED * m, black: false });
            xx = x2 + 1;
          }
        }
        id++;
      }
    }
    return {
      wu: mx * pitch - sepMm + 2 * q, hu: my * pitch - sepMm + 2 * q, shapes, unitMm: 1, board: true,
      info: {
        family: 'GridBoard', dict: d.label, id: `${mx}x${my}`,
        moduleNote: () => `marker ${markerMm}mm, gap ${sepMm}mm, ids ${firstId}-${id - 1}`,
      },
    };
  }

  return { gridTag, aprilTag3, runeTag, charucoBoard, gridBoard, decodeBits, mergeRuns };
})();
