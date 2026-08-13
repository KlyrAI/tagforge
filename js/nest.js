// Superimposed markers: a stack of hosts, each carrying the next one in its middle.
//
// A host is any tile that publishes a `hostRegion` — the area it can give up without
// destroying itself. A RuneTag's dot rings leave the centre empty, so it hosts for free;
// a QR sacrifices the modules under the overlay and pays for them out of its error
// correction budget. Grid tags (ArUco / AprilTag) are data everywhere, so they can only
// ever be the innermost layer.
//
// Layers are listed outermost first, e.g. ['runetag', 'qr'] + an AprilTag leaf gives
// a RuneTag holding a QR holding an AprilTag.

'use strict';

const Nest = (() => {

  function buildLeaf(leaf) {
    if (leaf.kind === 'april3') return Render.aprilTag3(leaf.family, leaf.id, 1);
    return Render.gridTag(leaf.dict, leaf.id, 1);
  }

  function leafLabel(leaf) {
    return leaf.kind === 'april3'
      ? `${leaf.family} #${leaf.id}`
      : `${window.ARUCO_DICTS[leaf.dict].label} #${leaf.id}`;
  }

  // Place `inner` into `host`'s free region, scaled to fit and centred.
  function place(host, inner) {
    const r = host.hostRegion;
    const s = Math.min(r.w / inner.wu, r.h / inner.hu);
    const ox = r.x + (r.w - inner.wu * s) / 2;
    const oy = r.y + (r.h - inner.hu * s) / 2;
    const shapes = host.shapes.slice();
    // White out the host region first: a RuneTag's centre is bare paper, but the inner
    // tile may not fill the whole square once aspect-fitted.
    shapes.push({ t: 'rect', x: r.x, y: r.y, w: r.w, h: r.h, black: false });
    for (const sh of inner.shapes) {
      if (sh.t === 'rect') {
        shapes.push({ t: 'rect', x: ox + sh.x * s, y: oy + sh.y * s,
                      w: sh.w * s, h: sh.h * s, black: sh.black });
      } else {
        shapes.push({ t: 'circle', cx: ox + sh.cx * s, cy: oy + sh.cy * s,
                      r: sh.r * s, black: sh.black });
      }
    }
    return { ...host, shapes };
  }

  // stack: array of wrapper specs, outermost first. leaf: innermost marker spec.
  function compose(stack, leaf) {
    let tile = buildLeaf(leaf);
    let label = leafLabel(leaf);
    const notes = new Array(stack.length);   // indexed like stack: outermost first

    for (let i = stack.length - 1; i >= 0; i--) {
      const layer = stack[i];
      if (layer.type === 'qr') {
        // QR scales the inner tile into its overlay itself, so no extra placement.
        tile = QrApril.compose({
          payload: layer.payload, version: layer.version, ecc: layer.ecc,
          innerTile: tile, innerLabel: label, ratioPct: layer.ratioPct, quiet: layer.quiet,
        });
        label = `QR-${layer.ecc} v${tile.qr.version} > ${label}`;
        notes[i] = `QR-${layer.ecc} overlay ${tile.qr.areaPct.toFixed(0)}% vs budget ~${tile.qr.budgetPct}%` +
                   (tile.qr.overBudget ? ' (OVER)' : tile.qr.marginal ? ' (marginal)' : '');
      } else if (layer.type === 'runetag') {
        const id = window.RuneTag.canonicalAt(layer.ordinal);
        const host = Render.runeTag(id, layer.quietPct / 100);
        tile = place(host, tile);
        label = `RUNE-129 #${id} > ${label}`;
        notes[i] = `RuneTag centre yields ${(host.hostRegion.w / host.wu * 100).toFixed(0)}% of width`;
      } else {
        throw new Error(`Unknown layer type ${layer.type}`);
      }
    }

    const depth = stack.length + 1;
    // The outermost tile's own moduleNote already describes that layer, so only the
    // layers beneath it need spelling out — except a RuneTag outer, whose note reports
    // the hosting budget its moduleNote does not mention.
    const extra = notes.filter((n, i) => n && (i > 0 || stack[i].type === 'runetag'));

    return {
      ...tile,
      stack: { depth, label, notes: notes.filter(Boolean) },
      info: {
        family: `Nested x${depth}`,
        dict: label,
        id: depth,
        hideId: true,   // the layer labels already carry their own ids
        moduleNote: mm => [tile.info ? tile.info.moduleNote(mm) : '', ...extra]
          .filter(Boolean).join(' · '),
      },
    };
  }

  return { compose, place, buildLeaf, leafLabel };
})();
window.Nest = Nest;
