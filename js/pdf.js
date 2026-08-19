// Sheet cart -> vector PDF via jsPDF. All units mm.
'use strict';

const PdfOut = (() => {
  // GAP must exceed 2*(CROP_OFF+CROP) so neighbouring crop marks never touch.
  const MARGIN = 12.7, GAP = 8, CROP = 2, CROP_OFF = 1, FOOTER_H = 10, LABEL_PT = 6;
  // The label is often wider than a small tag, so it must clear the tag's own bottom
  // crop marks rather than sit alongside them.
  const LABEL_BASE = CROP_OFF + CROP + 2.5, LABEL_H = LABEL_BASE + 1.5;

  /** Page sizes this tool offers, mm, portrait. */
  const PAGE_MM = { letter: [215.9, 279.4], a4: [210, 297] };

  /**
   * The largest tile that can actually be placed on a page, mm.
   *
   * Exported so "fit to page" sizes a board against the REAL layout rather than
   * a second copy of these constants — a duplicated margin would silently drift
   * and produce boards that overflow or waste a centimetre.
   */
  function usableMm(pageFormat) {
    const [pw, ph] = PAGE_MM[pageFormat] || PAGE_MM.letter;
    return { w: pw - 2 * MARGIN, h: ph - 2 * MARGIN - FOOTER_H - LABEL_H };
  }

  // items: [{tile, label}] ; physical size from SvgOut.physMm
  function mint(items, pageFormat) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: pageFormat, compress: true });
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const usableW = pw - 2 * MARGIN;
    const bottomLimit = ph - MARGIN - FOOTER_H;

    let x = MARGIN, y = MARGIN, rowH = 0;
    footer(doc, pw, ph);

    // Shelf packing: tallest first, so a row of small tags doesn't inherit a big tag's
    // row height and waste half a page. Each tag carries its own label, so order is free.
    const ordered = items.map((it, i) => ({ it, i }))
      .sort((a, b) => (b.it.phys.h - a.it.phys.h) || (a.i - b.i))
      .map(o => o.it);

    doc.setFontSize(LABEL_PT);
    doc.setTextColor(0);

    for (const it of ordered) {
      const w = it.phys.w, h = it.phys.h;
      // A small tag's label is wider than the tag, so the cell — not the tag — drives
      // layout; otherwise the text runs underneath its neighbour.
      const label = fitLabel(doc, it.label, usableW);
      const cellW = Math.max(w, doc.getTextWidth(label));
      if (cellW > usableW || h + LABEL_H > bottomLimit - MARGIN) {
        it.skipped = true;
        continue;
      }
      if (x + cellW > MARGIN + usableW + 0.01) {      // wrap row
        x = MARGIN; y += rowH + GAP; rowH = 0;
      }
      if (y + h + LABEL_H > bottomLimit) {            // new page
        doc.addPage(pageFormat);
        footer(doc, pw, ph);
        doc.setFontSize(LABEL_PT);
        doc.setTextColor(0);
        x = MARGIN; y = MARGIN; rowH = 0;
      }
      const tx = x + (cellW - w) / 2;                 // centre the tag in its cell
      drawTile(doc, it.tile, tx, y, w, h);
      cropMarks(doc, tx, y, w, h);
      doc.text(label, x + cellW / 2, y + h + LABEL_BASE, { align: 'center' });
      it.placed = { x: tx, y, w, h, cellX: x, cellW, labelY: y + h + LABEL_BASE, page: doc.getNumberOfPages() };
      x += cellW + GAP;
      rowH = Math.max(rowH, h + LABEL_H);
    }
    return doc;
  }

  // Shrink an over-wide label until it fits the page, then give up and clip it.
  function fitLabel(doc, label, maxW) {
    if (doc.getTextWidth(label) <= maxW) return label;
    let s = label;
    while (s.length > 4 && doc.getTextWidth(s + '…') > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  function drawTile(doc, tile, ox, oy, wMm, hMm) {
    const sc = wMm / tile.wu;
    // white base (paper) — draw nothing; just shapes in order
    for (const s of tile.shapes) {
      doc.setFillColor(s.black ? 0 : 255);
      if (s.t === 'rect') doc.rect(ox + s.x * sc, oy + s.y * sc, s.w * sc, s.h * sc, 'F');
      else doc.circle(ox + s.cx * sc, oy + s.cy * sc, s.r * sc, 'F');
    }
  }

  function cropMarks(doc, x, y, w, h) {
    doc.setDrawColor(120);
    doc.setLineWidth(0.1);
    const c = [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]];
    for (const [cx, cy, dx, dy] of c) {
      doc.line(cx + dx * CROP_OFF, cy, cx + dx * (CROP_OFF + CROP), cy);
      doc.line(cx, cy + dy * CROP_OFF, cx, cy + dy * (CROP_OFF + CROP));
    }
  }

  function footer(doc, pw, ph) {
    const y = ph - MARGIN - 2;
    const bx = (pw - 100) / 2;
    doc.setDrawColor(0);
    doc.setLineWidth(0.3);
    doc.line(bx, y, bx + 100, y);
    doc.line(bx, y - 1.5, bx, y + 1.5);
    doc.line(bx + 100, y - 1.5, bx + 100, y + 1.5);
    for (let i = 10; i < 100; i += 10) doc.line(bx + i, y - 0.8, bx + i, y);
    doc.setFontSize(7);
    doc.setTextColor(0);
    doc.text('scale bar = 100 mm exactly — PRINT AT 100% / ACTUAL SIZE, do not "fit to page"', pw / 2, y + 4, { align: 'center' });
    doc.text('TagForge', pw - MARGIN, y + 4, { align: 'right' });
  }

  return { mint, usableMm };
})();
