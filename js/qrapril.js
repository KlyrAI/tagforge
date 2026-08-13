// QR code with a fiducial tag concealed in the middle.
//
// The overlay destroys whatever QR modules sit under it; the symbol's Reed-Solomon
// error correction has to absorb that as damage. ECC recovers roughly L 7% / M 15% /
// Q 25% / H 30% of codewords, so the overlay's share of the symbol is the budget being
// spent. Those percentages are a ceiling, not a promise — a contiguous central block is
// harder on a decoder than scattered damage, so treat tools/verify_qr.py's pass/fail
// matrix (and a real phone) as the truth, not the arithmetic here.

'use strict';

const QrApril = (() => {
  const ECC_BUDGET = { L: 0.07, M: 0.15, Q: 0.25, H: 0.30 };

  // version -> module count; version 0 asks the encoder for the smallest that fits.
  function build(payload, version, ecc) {
    const qr = qrcode(version, ecc);
    qr.addData(payload);
    qr.make();
    return qr;
  }

  // innerTile: any tile from Render (gridTag / aprilTag3) — square, with its own quiet zone.
  // ratioPct: overlay width as a percentage of the QR symbol width (excluding quiet zone).
  function compose({ payload, version = 0, ecc = 'H', innerTile, innerLabel, ratioPct = 35, quiet = 4 }) {
    const qr = build(payload, version, ecc);
    const n = qr.getModuleCount();
    const actualVersion = (n - 17) / 4;

    // Overlay must share parity with n, otherwise it cannot sit exactly centred.
    let R = Math.round(n * ratioPct / 100);
    if ((n - R) % 2 !== 0) R += 1;
    R = Math.max(2, Math.min(R, n - 2));
    const off = (n - R) / 2;

    const inOverlay = (x, y) => x >= off && x < off + R && y >= off && y < off + R;

    const total = n + 2 * quiet;
    const shapes = [];
    Render.mergeRuns((x, y) => !inOverlay(x, y) && qr.isDark(y, x), n, n, quiet, quiet, shapes, true);

    // Scale the tag tile (including its own quiet zone) to exactly R x R QR modules.
    const s = R / innerTile.wu;
    for (const sh of innerTile.shapes) {
      if (sh.t === 'rect') {
        shapes.push({ t: 'rect', x: quiet + off + sh.x * s, y: quiet + off + sh.y * s,
                      w: sh.w * s, h: sh.h * s, black: sh.black });
      } else {
        shapes.push({ t: 'circle', cx: quiet + off + sh.cx * s, cy: quiet + off + sh.cy * s,
                      r: sh.r * s, black: sh.black });
      }
    }

    const areaPct = (R * R) / (n * n) * 100;
    const budgetPct = ECC_BUDGET[ecc] * 100;
    const overBudget = areaPct > budgetPct;
    // Even under the ceiling, a solid central block is the hard case for a decoder.
    const marginal = !overBudget && areaPct > 0.8 * budgetPct;

    return {
      wu: total, hu: total, shapes,
      hostRegion: { x: quiet + off, y: quiet + off, w: R, h: R },
      qr: { n, version: actualVersion, ecc, overlayModules: R, areaPct, budgetPct, overBudget, marginal },
      info: {
        family: 'QR+Tag',
        dict: `QR-${ecc} v${actualVersion} + ${innerLabel}`,
        id: `${ratioPct}%`,
        moduleNote: mm => {
          const qrMod = mm / total;
          const tagMod = (R * qrMod) / innerTile.wu;
          return `QR module ${qrMod.toFixed(2)}mm, tag module ${tagMod.toFixed(2)}mm, ` +
                 `overlay ${areaPct.toFixed(0)}% of symbol vs ${ecc} budget ~${budgetPct}%` +
                 (overBudget ? ' — OVER BUDGET' : marginal ? ' — marginal' : '');
        },
      },
    };
  }

  // Rasterize a composed tile and ask jsQR whether the symbol still reads.
  // Browser only (needs a canvas); the Python harness covers this headlessly.
  function decodeCheck(tile, pxPerUnit = 6) {
    if (typeof document === 'undefined' || typeof jsQR === 'undefined') return null;
    const size = Math.round(tile.wu * pxPerUnit);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    for (const s of tile.shapes) {
      ctx.fillStyle = s.black ? '#000' : '#fff';
      if (s.t === 'rect') {
        const x0 = Math.round(s.x * pxPerUnit), y0 = Math.round(s.y * pxPerUnit);
        ctx.fillRect(x0, y0, Math.round((s.x + s.w) * pxPerUnit) - x0,
                             Math.round((s.y + s.h) * pxPerUnit) - y0);
      } else {
        ctx.beginPath();
        ctx.arc(s.cx * pxPerUnit, s.cy * pxPerUnit, s.r * pxPerUnit, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    const img = ctx.getImageData(0, 0, size, size);
    const res = jsQR(img.data, size, size);
    return res ? res.data : null;
  }

  return { compose, decodeCheck, ECC_BUDGET };
})();
window.QrApril = QrApril;
