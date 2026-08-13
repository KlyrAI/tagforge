// Tile -> SVG string / PNG blob. Physical size carried in mm width/height attrs.
'use strict';

const SvgOut = (() => {
  function shapeSvg(s) {
    const f = s.black ? '#000' : '#fff';
    if (s.t === 'rect')
      return `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" fill="${f}"/>`;
    return `<circle cx="${n(s.cx)}" cy="${n(s.cy)}" r="${n(s.r)}" fill="${f}"/>`;
  }
  const n = v => Math.round(v * 10000) / 10000;

  function physMm(tile, sizeMm) {
    return tile.board ? { w: tile.wu * tile.unitMm, h: tile.hu * tile.unitMm }
                      : { w: sizeMm, h: sizeMm * tile.hu / tile.wu };
  }

  function toSvg(tile, sizeMm) {
    const p = physMm(tile, sizeMm);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(p.w)}mm" height="${n(p.h)}mm" ` +
      `viewBox="0 0 ${n(tile.wu)} ${n(tile.hu)}" shape-rendering="crispEdges">` +
      `<rect x="0" y="0" width="${n(tile.wu)}" height="${n(tile.hu)}" fill="#fff"/>` +
      tile.shapes.map(shapeSvg).join('') + `</svg>`;
  }

  function toPngBlob(tile, sizeMm, dpi, cb) {
    const p = physMm(tile, sizeMm);
    const wPx = Math.round(p.w / 25.4 * dpi), hPx = Math.round(p.h / 25.4 * dpi);
    const canvas = document.createElement('canvas');
    canvas.width = wPx; canvas.height = hPx;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, wPx, hPx);
    const sc = wPx / tile.wu;
    for (const s of tile.shapes) {
      ctx.fillStyle = s.black ? '#000' : '#fff';
      if (s.t === 'rect') {
        const x0 = Math.round(s.x * sc), y0 = Math.round(s.y * sc);
        ctx.fillRect(x0, y0, Math.round((s.x + s.w) * sc) - x0, Math.round((s.y + s.h) * sc) - y0);
      } else {
        ctx.beginPath();
        ctx.arc(s.cx * sc, s.cy * sc, s.r * sc, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    canvas.toBlob(cb, 'image/png');
  }

  function download(name, blobOrText, mime) {
    const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  return { toSvg, toPngBlob, physMm, download };
})();
