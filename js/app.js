// TagForge UI: family controls, live preview, sheet cart, size sweeps, minting.
'use strict';

(() => {
  const $ = sel => document.querySelector(sel);
  const el = (tag, attrs = {}, html = '') => {
    const e = document.createElement(tag);
    Object.assign(e, attrs);
    if (html) e.innerHTML = html;
    return e;
  };

  const ARUCO_KEYS = ['4x4_1000', '5x5_1000', '6x6_1000', '7x7_1000', 'aruco', 'mip_36h12'];
  const APRIL_KEYS = ['april_16h5', 'april_25h9', 'april_36h10', 'april_36h11'];
  const AT3_KEYS = Object.keys(window.APRILTAG3);

  const FAMILIES = {
    aruco:    { label: 'ArUco' },
    april:    { label: 'AprilTag v2 (classic)' },
    april3:   { label: 'AprilTag 3' },
    runetag:  { label: 'RuneTag (RUNE-129)' },
    charuco:  { label: 'ChArUco board' },
    gridboard:{ label: 'ArUco grid board' },
    qrtag:    { label: 'Nested / concealed markers' },
  };

  const INNER_KEYS = ['april_36h11', 'april_36h10', 'april_25h9', 'april_16h5',
                      '4x4_1000', '5x5_1000', '6x6_1000'];

  const state = {
    family: 'aruco',
    dict: '6x6_1000', aprilDict: 'april_36h11', at3: 'tagStandard41h12',
    id: 0, quietModules: 1, runeQuietPct: 5, runeId: 1,
    idRange: '0-9',
    sizeMm: 60,
    sweep: '15, 20, 30, 40, 60, 80, 100',
    qr: { payload: 'https://klyrai.github.io/tagforge/', ecc: 'H', version: 0,
          innerDict: 'april_36h11', innerId: 0, ratioPct: 35, quiet: 4,
          matrixRatios: '25, 30, 35, 40, 45',
          // wrapper layers, outermost first; leaf tag is configured separately
          stack: ['qr'], runeOrdinal: 1, runeQuietPct: 5 },
    charuco: { sx: 5, sy: 7, squareMm: 30, markerMm: 22, legacy: false, quietMm: 5 },
    grid: { mx: 4, my: 5, markerMm: 35, sepMm: 7, firstId: 0, quietMm: 5 },
    page: 'letter',
    cart: [],
  };

  /**
   * Blow the current board up to the largest that fits the selected page.
   *
   * A calibration/rig board wants to be as physically large as the paper
   * allows: pose accuracy scales with how many pixels the board spans in the
   * image, and marker decodability scales with the printed marker size. Both
   * improve linearly with this, and nothing else on the sheet competes for the
   * space — so "as big as it goes" is simply the right answer, and doing it by
   * hand is arithmetic nobody should repeat.
   *
   * The grid COUNTS are left alone; only the cell size grows. That keeps the
   * result predictable and keeps the dictionary's id usage unchanged.
   *
   * Rounded DOWN to 0.5mm: rounding up would overflow the printable area, and
   * the exactness that makes a printed board trustworthy comes from the
   * generator laying an exact grid, not from the cell being a round number.
   */
  function fitBoardToPage() {
    const usable = PdfOut.usableMm(state.page);
    if (state.family === 'charuco') {
      const ch = state.charuco;
      // Preserve the marker/square ratio the user already chose; the marker has
      // to stay inside its square with a white border, so it cannot simply
      // track the square 1:1.
      const ratio = ch.squareMm > 0 ? ch.markerMm / ch.squareMm : 0.75;
      const square = Math.min(
        (usable.w - 2 * ch.quietMm) / ch.sx,
        (usable.h - 2 * ch.quietMm) / ch.sy,
      );
      ch.squareMm = Math.max(5, Math.floor(square * 2) / 2);
      ch.markerMm = Math.max(3, Math.floor(ch.squareMm * ratio * 2) / 2);
    } else if (state.family === 'gridboard') {
      const g = state.grid;
      const marker = Math.min(
        (usable.w - 2 * g.quietMm - (g.mx - 1) * g.sepMm) / g.mx,
        (usable.h - 2 * g.quietMm - (g.my - 1) * g.sepMm) / g.my,
      );
      g.markerMm = Math.max(5, Math.floor(marker * 2) / 2);
    }
    renderControls();
    update();
  }

  /**
   * Printed extent of the current board, mm — what fitBoardToPage maximises.
   * Mirrors the tile geometry in render.js.
   */
  function boardExtentMm() {
    if (state.family === 'charuco') {
      const c = state.charuco;
      return { w: c.sx * c.squareMm + 2 * c.quietMm, h: c.sy * c.squareMm + 2 * c.quietMm };
    }
    if (state.family === 'gridboard') {
      const g = state.grid;
      return {
        w: g.mx * g.markerMm + (g.mx - 1) * g.sepMm + 2 * g.quietMm,
        h: g.my * g.markerMm + (g.my - 1) * g.sepMm + 2 * g.quietMm,
      };
    }
    return null;
  }

  /**
   * Roughly how far this board's MARKERS stay decodable.
   *
   * A marker needs about 15px across to decode, and px = focal_px * size /
   * distance. A phone main camera is ~26mm equivalent, so on a 4000px-wide
   * still focal_px ~= 3000. Deliberately approximate — it exists to catch
   * "these markers are far too small for the room" before you print, not to
   * predict a threshold.
   */
  function markerRangeM(markerMm) {
    if (!(markerMm > 0)) return null;
    return (3000 * (markerMm / 1000)) / 15;
  }

  /**
   * "Fit to page" button plus the sizing facts that decide whether the result
   * is usable: printed extent, marker size, and the range those markers hold.
   */
  function fitControls() {
    const wrap = el('div', {});
    const btn = el('button', {}, `Fit to ${state.page === 'a4' ? 'A4' : 'US Letter'}`);
    btn.onclick = () => fitBoardToPage();
    const br = el('div', { className: 'btnrow' });
    br.appendChild(btn);
    wrap.appendChild(br);

    const extent = boardExtentMm();
    const markerMm = state.family === 'charuco' ? state.charuco.markerMm : state.grid.markerMm;
    const range = markerRangeM(markerMm);
    const usable = PdfOut.usableMm(state.page);
    const overflows = extent && (extent.w > usable.w + 0.01 || extent.h > usable.h + 0.01);
    wrap.appendChild(el('p', { className: 'hint' },
      (extent ? `Printed ${extent.w.toFixed(1)} x ${extent.h.toFixed(1)} mm ` +
                `(page fits ${usable.w.toFixed(1)} x ${usable.h.toFixed(1)} mm). ` : '') +
      (range ? `${markerMm} mm markers decode to roughly ${range.toFixed(1)} m. ` : '') +
      (overflows ? 'TOO BIG — this board will be skipped when the sheet is minted.'
                 : 'Bigger is strictly better for pose accuracy and range; nothing else competes for the sheet.')));
    return wrap;
  }

  // ---- tile construction ----
  function currentTile() {
    switch (state.family) {
      case 'aruco':   return Render.gridTag(state.dict, state.id, state.quietModules);
      case 'april':   return Render.gridTag(state.aprilDict, state.id, state.quietModules);
      case 'april3':  return Render.aprilTag3(state.at3, state.id, state.quietModules);
      case 'runetag': return Render.runeTag(window.RuneTag.canonicalAt(state.runeId), state.runeQuietPct / 100);
      case 'charuco': {
        const c = state.charuco;
        return Render.charucoBoard(state.dict, c.sx, c.sy, c.squareMm, c.markerMm, c.legacy, c.quietMm);
      }
      case 'gridboard': {
        const g = state.grid;
        return Render.gridBoard(state.dict, g.mx, g.my, g.markerMm, g.sepMm, g.firstId, g.quietMm);
      }
      case 'qrtag': return qrTile(state.qr);
    }
  }

  // Overridable fields let the robustness matrix vary ecc/ratio without touching state.
  function qrTile(q, over = {}) {
    const cfg = { ...q, ...over };
    if (!cfg.stack.length) throw new Error('Add at least one outer layer');
    const layers = cfg.stack.map(type => type === 'qr'
      ? { type: 'qr', payload: cfg.payload, version: cfg.version, ecc: cfg.ecc,
          ratioPct: cfg.ratioPct, quiet: cfg.quiet }
      : { type: 'runetag', ordinal: cfg.runeOrdinal, quietPct: cfg.runeQuietPct });
    return Nest.compose(layers, { kind: 'grid', dict: cfg.innerDict, id: cfg.innerId });
  }

  function tileLabel(tile, sizeMm) {
    const i = tile.info;
    // dict labels already name the family for ArUco/AprilTag; don't say it twice
    const head = i.dict.toLowerCase().includes(i.family.toLowerCase()) ? i.dict : `${i.family} ${i.dict}`;
    const size = tile.board ? `${(tile.wu * tile.unitMm).toFixed(0)}x${(tile.hu * tile.unitMm).toFixed(0)}mm`
                            : `${sizeMm}mm`;
    const idPart = i.hideId ? '' : tile.board ? `${i.id} board ` : `#${i.id} `;
    return `${head} ${idPart}— ${size}, ${i.moduleNote(sizeMm)}`;
  }

  function fileBase(tile, sizeMm) {
    const i = tile.info;
    return `${i.family}_${i.dict}_${i.id}_${tile.board ? 'board' : sizeMm + 'mm'}`
      .replace(/[^\w.-]+/g, '-').toLowerCase();
  }

  // ---- controls ----
  function dictSelect(keys, cur, onchange) {
    const s = el('select');
    for (const k of keys) s.appendChild(el('option', { value: k, selected: k === cur }, window.ARUCO_DICTS[k].label));
    s.onchange = () => { onchange(s.value); update(); };
    return s;
  }

  function numInput(val, min, max, step, onchange) {
    const i = el('input', { type: 'number', value: val, min, max, step });
    i.oninput = () => { const v = Number(i.value); if (!Number.isNaN(v)) { onchange(v); update(); } };
    return i;
  }

  // "0-9, 12, 20-24" -> [0..9, 12, 20..24]. Ranges may be given either way round.
  function parseIds(spec, max) {
    const ids = [];
    for (const part of spec.split(',')) {
      const s = part.trim();
      if (!s) continue;
      const m = s.match(/^(\d+)\s*(?:-|–|\.\.|to)\s*(\d+)$/);
      if (m) {
        let [a, b] = [Number(m[1]), Number(m[2])];
        if (a > b) [a, b] = [b, a];
        for (let i = a; i <= b; i++) ids.push(i);
      } else if (/^\d+$/.test(s)) {
        ids.push(Number(s));
      } else {
        throw new Error(`Cannot read "${s}" — use numbers and ranges like 0-9, 12, 20-24`);
      }
    }
    const uniq = [...new Set(ids)].sort((a, b) => a - b);
    const over = uniq.filter(i => i >= max);
    if (over.length) throw new Error(`id ${over[0]} is past the end of this dictionary (max ${max - 1})`);
    if (!uniq.length) throw new Error('No ids in that range');
    return uniq;
  }

  // An ID range plus the size sweep would multiply into hundreds of prints, so the range
  // is queued at the current print size only.
  function rangeControls(getDict, setId) {
    const box = document.createDocumentFragment();
    const input = el('input', { type: 'text', value: state.idRange, placeholder: '0-9, 12, 20-24' });
    input.oninput = () => { state.idRange = input.value; };
    const r = el('div', { className: 'row' });
    r.appendChild(el('label', {}, 'ID range'));
    r.appendChild(input);
    box.appendChild(r);

    const btn = el('button', { className: 'primary' }, 'Add range to sheet');
    btn.onclick = () => {
      const dictKey = getDict();
      const max = dictKey === 'runetag' ? 2001
        : window.ARUCO_DICTS[dictKey] ? window.ARUCO_DICTS[dictKey].markers.length
        : window.APRILTAG3[dictKey].embedded;
      let ids;
      try {
        ids = parseIds(state.idRange, max);
      } catch (e) { alert(e.message); return; }
      const before = state.cart.length;
      const keep = state.id;
      for (const id of ids) {
        setId(id);
        addToCart([state.sizeMm]);
      }
      setId(keep);
      update();
      $('#rangeNote').textContent = `added ${state.cart.length - before} markers at ${state.sizeMm}mm`;
    };
    const bar = el('div', { className: 'btnrow' });
    bar.appendChild(btn);
    box.appendChild(bar);
    box.appendChild(el('p', { className: 'hint', id: 'rangeNote' },
      'Queues every id in the range at the current print size.'));
    return box;
  }

  // A picked result may be from a dictionary the caller does not offer; the pick handler
  // decides what to do with it, so it can switch dictionary as well as id.
  function findButton(onPick, preferDict) {
    const b = el('button', { className: 'findbtn' }, '🔍 Find a marker that looks like…');
    b.onclick = () => openSearch(onPick, preferDict());
    const wrap = el('div', { className: 'btnrow' });
    wrap.appendChild(b);
    return wrap;
  }

  function row(label, control) {
    const r = el('div', { className: 'row' });
    r.appendChild(el('label', {}, label));
    r.appendChild(control);
    return r;
  }

  function renderControls() {
    const c = $('#controls');
    c.innerHTML = '';
    const f = state.family;

    if (f === 'aruco') {
      c.appendChild(row('Dictionary', dictSelect(ARUCO_KEYS, state.dict, v => state.dict = v)));
      c.appendChild(row('Marker ID', numInput(state.id, 0, 1023, 1, v => state.id = v)));
      c.appendChild(row('Quiet zone (modules)', numInput(state.quietModules, 0, 4, 1, v => state.quietModules = v)));
      c.appendChild(rangeControls(() => state.dict, id => state.id = id));
      c.appendChild(findButton(r => { state.dict = r.dict; state.id = r.id; renderControls(); update(); },
                               () => state.dict));
    } else if (f === 'april') {
      c.appendChild(row('Family', dictSelect(APRIL_KEYS, state.aprilDict, v => state.aprilDict = v)));
      c.appendChild(row('Marker ID', numInput(state.id, 0, 2319, 1, v => state.id = v)));
      c.appendChild(row('Quiet zone (modules)', numInput(state.quietModules, 0, 4, 1, v => state.quietModules = v)));
      c.appendChild(rangeControls(() => state.aprilDict, id => state.id = id));
      c.appendChild(findButton(r => { state.aprilDict = r.dict; state.id = r.id; renderControls(); update(); },
                               () => state.aprilDict));
    } else if (f === 'april3') {
      const s = el('select');
      for (const k of AT3_KEYS) {
        const fam = window.APRILTAG3[k];
        s.appendChild(el('option', { value: k, selected: k === state.at3 },
          `${k} (${fam.embedded} of ${fam.ncodes} ids embedded)`));
      }
      s.onchange = () => { state.at3 = s.value; update(); };
      c.appendChild(row('Family', s));
      c.appendChild(row('Marker ID', numInput(state.id, 0, 999, 1, v => state.id = v)));
      c.appendChild(row('Quiet zone (modules)', numInput(state.quietModules, 0, 4, 1, v => state.quietModules = v)));
      c.appendChild(rangeControls(() => state.at3, id => state.id = id));
    } else if (f === 'runetag') {
      c.appendChild(row('Tag number', numInput(state.runeId, 1, 2000, 1, v => state.runeId = v)));
      c.appendChild(row('Quiet zone (% of ⌀)', numInput(state.runeQuietPct, 0, 25, 1, v => state.runeQuietPct = v)));
      c.appendChild(el('p', { className: 'hint' },
        'Counts through valid RUNE-129 codes — tag 1, 2, 3 are consecutive distinct tags. ' +
        'Only ~1 raw index in 40 is a valid code, so the label shows the actual code number ' +
        'a detector reports (tag 1 = code 24).'));
      c.appendChild(rangeControls(() => 'runetag', id => state.runeId = id));
    } else if (f === 'qrtag') {
      const q = state.qr;

      // --- layer stack, outermost first, with the leaf tag pinned at the bottom ---
      c.appendChild(el('h2', {}, 'Layers (outer → inner)'));
      const stackBox = el('div', { className: 'stackbox' });
      q.stack.forEach((type, i) => {
        const li = el('div', { className: 'layer' });
        li.appendChild(el('span', {}, `${i + 1}. ${type === 'qr' ? 'QR code' : 'RuneTag'}`));
        const rm = el('button', { className: 'ghost', title: 'remove layer' }, '✕');
        rm.onclick = () => { q.stack.splice(i, 1); renderControls(); update(); };
        li.appendChild(rm);
        stackBox.appendChild(li);
      });
      const leafRow = el('div', { className: 'layer leaf' });
      const leafText = () => `${q.stack.length + 1}. ${window.ARUCO_DICTS[q.innerDict].label} #${q.innerId}`;
      const leafSpan = el('span', {}, leafText());
      leafRow.appendChild(leafSpan);
      stackBox.appendChild(leafRow);
      // Updated in place rather than by re-rendering, so typing an id keeps focus.
      const setLeafId = v => { q.innerId = v; leafSpan.textContent = leafText(); };
      c.appendChild(stackBox);

      const addRow = el('div', { className: 'btnrow' });
      for (const [type, name] of [['qr', '+ QR layer'], ['runetag', '+ RuneTag layer']]) {
        const b = el('button', {}, name);
        b.onclick = () => { q.stack.push(type); renderControls(); update(); };
        addRow.appendChild(b);
      }
      c.appendChild(addRow);
      c.appendChild(el('p', { className: 'hint' },
        'Each layer carries the next one in its middle. A RuneTag has an empty centre so it ' +
        'hosts for free; a QR pays for the covered modules out of its error correction.'));

      const hasQr = q.stack.includes('qr');
      const hasRune = q.stack.includes('runetag');

      if (hasRune) {
        c.appendChild(el('h2', {}, 'RuneTag layer'));
        c.appendChild(row('Tag number', numInput(q.runeOrdinal, 1, 2000, 1, v => q.runeOrdinal = v)));
        c.appendChild(row('Quiet zone (% of ⌀)', numInput(q.runeQuietPct, 0, 25, 1, v => q.runeQuietPct = v)));
      }
      if (!hasQr) {
        c.appendChild(el('h2', {}, 'Inner tag'));
        const innerSel2 = el('select');
        for (const k of INNER_KEYS)
          innerSel2.appendChild(el('option', { value: k, selected: k === q.innerDict },
            window.ARUCO_DICTS[k].label));
        innerSel2.onchange = () => { q.innerDict = innerSel2.value; renderControls(); update(); };
        c.appendChild(row('Hidden tag', innerSel2));
        c.appendChild(row('Tag ID', numInput(q.innerId, 0, 999, 1, setLeafId)));
        return;
      }

      c.appendChild(el('h2', {}, 'QR layer'));
      const pay = el('input', { type: 'text', value: q.payload });
      pay.oninput = () => { q.payload = pay.value; update(); };
      const payRow = el('div');
      payRow.appendChild(el('label', { className: 'stacked' }, 'QR payload'));
      payRow.appendChild(pay);
      c.appendChild(payRow);

      const eccSel = el('select');
      for (const e of ['L', 'M', 'Q', 'H'])
        eccSel.appendChild(el('option', { value: e, selected: e === q.ecc },
          `${e} (~${Math.round(QrApril.ECC_BUDGET[e] * 100)}% recovery)`));
      eccSel.onchange = () => { q.ecc = eccSel.value; update(); };
      c.appendChild(row('Error correction', eccSel));

      const verSel = el('select');
      verSel.appendChild(el('option', { value: '0', selected: q.version === 0 }, 'auto (smallest)'));
      for (let v = 1; v <= 12; v++)
        verSel.appendChild(el('option', { value: String(v), selected: q.version === v },
          `v${v} (${17 + 4 * v} modules)`));
      verSel.onchange = () => { q.version = Number(verSel.value); update(); };
      c.appendChild(row('QR version', verSel));

      const innerSel = el('select');
      for (const k of INNER_KEYS)
        innerSel.appendChild(el('option', { value: k, selected: k === q.innerDict },
          window.ARUCO_DICTS[k].label));
      innerSel.onchange = () => { q.innerDict = innerSel.value; renderControls(); update(); };
      c.appendChild(row('Hidden tag', innerSel));
      c.appendChild(row('Tag ID', numInput(q.innerId, 0, 999, 1, setLeafId)));
      c.appendChild(findButton(r => {
        if (INNER_KEYS.includes(r.dict)) q.innerDict = r.dict;
        q.innerId = r.id;
        renderControls(); update();
      }, () => q.innerDict));
      c.appendChild(row('Tag size (% of QR)', numInput(q.ratioPct, 10, 60, 1, v => q.ratioPct = v)));
      c.appendChild(row('Quiet zone (modules)', numInput(q.quiet, 2, 8, 1, v => q.quiet = v)));

      c.appendChild(el('h2', {}, 'Robustness matrix'));
      const mr = el('input', { type: 'text', value: q.matrixRatios });
      mr.oninput = () => { q.matrixRatios = mr.value; };
      c.appendChild(mr);
      c.appendChild(el('p', { className: 'hint' },
        'Queues every ECC level (L/M/Q/H) at each tag size above — one sheet tells you which ' +
        'combinations still scan.'));
      const mbtn = el('button', { className: 'primary', id: 'matrixBtn' }, 'Add matrix to sheet');
      mbtn.onclick = () => addMatrix();
      const br = el('div', { className: 'btnrow' });
      br.appendChild(mbtn);
      c.appendChild(br);
    } else if (f === 'charuco') {
      const ch = state.charuco;
      c.appendChild(row('Dictionary', dictSelect(ARUCO_KEYS, state.dict, v => state.dict = v)));
      c.appendChild(row('Squares X', numInput(ch.sx, 2, 20, 1, v => ch.sx = v)));
      c.appendChild(row('Squares Y', numInput(ch.sy, 2, 20, 1, v => ch.sy = v)));
      c.appendChild(row('Square (mm)', numInput(ch.squareMm, 5, 100, 1, v => ch.squareMm = v)));
      c.appendChild(row('Marker (mm)', numInput(ch.markerMm, 3, 95, 1, v => ch.markerMm = v)));
      c.appendChild(row('Quiet zone (mm)', numInput(ch.quietMm, 0, 30, 1, v => ch.quietMm = v)));
      const leg = el('input', { type: 'checkbox', checked: ch.legacy });
      leg.onchange = () => { ch.legacy = leg.checked; update(); };
      c.appendChild(row('Legacy pattern (OpenCV <4.6)', leg));
      c.appendChild(fitControls());
    } else if (f === 'gridboard') {
      const g = state.grid;
      c.appendChild(row('Dictionary', dictSelect(ARUCO_KEYS, state.dict, v => state.dict = v)));
      c.appendChild(row('Markers X', numInput(g.mx, 1, 20, 1, v => g.mx = v)));
      c.appendChild(row('Markers Y', numInput(g.my, 1, 20, 1, v => g.my = v)));
      c.appendChild(row('Marker (mm)', numInput(g.markerMm, 5, 150, 1, v => g.markerMm = v)));
      c.appendChild(row('Separation (mm)', numInput(g.sepMm, 1, 50, 1, v => g.sepMm = v)));
      c.appendChild(row('First ID', numInput(g.firstId, 0, 999, 1, v => g.firstId = v)));
      c.appendChild(row('Quiet zone (mm)', numInput(g.quietMm, 0, 30, 1, v => g.quietMm = v)));
      c.appendChild(fitControls());
    }

    const isBoard = f === 'charuco' || f === 'gridboard';
    $('#sizeRow').style.display = isBoard ? 'none' : '';
    $('#sweepBox').style.display = isBoard ? 'none' : '';
  }

  // ---- preview ----
  function update() {
    const pv = $('#preview'), meta = $('#previewMeta');
    let tile;
    try {
      tile = currentTile();
    } catch (e) {
      pv.innerHTML = `<div class="err">${e.message}</div>`;
      meta.textContent = '';
      return null;
    }
    const svg = SvgOut.toSvg(tile, state.sizeMm);
    pv.innerHTML = svg;
    const s = pv.querySelector('svg');
    s.removeAttribute('width'); s.removeAttribute('height');   // scale to pane
    const phys = SvgOut.physMm(tile, state.sizeMm);
    let warn = '';
    if (!tile.board) {
      const mod = state.sizeMm / tile.wu;
      if (state.family !== 'runetag' && state.family !== 'qrtag' && mod < 5)
        warn = ' ⚠ modules under 5mm — short detection range';
    }
    meta.textContent = `${tileLabel(tile, state.sizeMm)} · prints ${phys.w.toFixed(1)} x ${phys.h.toFixed(1)}mm${warn}`;

    const badge = $('#scanBadge');
    if (tile.qr) {
      const got = QrApril.decodeCheck(tile);
      const ok = got === state.qr.payload;
      badge.style.display = '';
      badge.className = 'badge ' + (ok ? 'ok' : 'bad');
      badge.textContent = ok ? 'QR still decodes ✓'
        : got ? 'decodes, but payload differs ✗' : 'QR does NOT decode ✗';
    } else {
      badge.style.display = 'none';
    }
    return tile;
  }

  // ---- cart ----
  function addToCart(sizes) {
    let added = 0;
    for (const sizeMm of sizes) {
      try {
        const tile = currentTile();
        const phys = SvgOut.physMm(tile, sizeMm);
        state.cart.push({ tile, phys, label: tileLabel(tile, sizeMm), sizeMm });
        added++;
      } catch (e) {
        alert(e.message);
        break;
      }
    }
    renderCart();
    return added;
  }

  // Every ECC level at every listed tag size, at the current print size.
  function addMatrix() {
    const ratios = state.qr.matrixRatios.split(/[,\s]+/).map(Number).filter(v => v > 0);
    if (!ratios.length) { alert('No valid percentages in the matrix list'); return; }
    for (const ecc of ['L', 'M', 'Q', 'H']) {
      for (const ratioPct of ratios) {
        try {
          const tile = qrTile(state.qr, { ecc, ratioPct });
          state.cart.push({ tile, phys: SvgOut.physMm(tile, state.sizeMm),
                            label: tileLabel(tile, state.sizeMm), sizeMm: state.sizeMm });
        } catch (e) {
          alert(`${ecc} @ ${ratioPct}%: ${e.message}`);
          return;
        }
      }
    }
    renderCart();
  }

  function renderCart() {
    const list = $('#cartList');
    list.innerHTML = '';
    state.cart.forEach((it, i) => {
      const li = el('li');
      li.appendChild(el('span', {}, it.label));
      const rm = el('button', { className: 'ghost', title: 'remove' }, '✕');
      rm.onclick = () => { state.cart.splice(i, 1); renderCart(); };
      li.appendChild(rm);
      list.appendChild(li);
    });
    $('#cartCount').textContent = state.cart.length;
    $('#mintBtn').disabled = state.cart.length === 0;
  }

  // ---- visual search modal ----
  // `onPick` decides where a chosen tag lands: the main controls, or the nested stack's
  // hidden tag, depending on which button opened the modal.
  const searchState = { tab: 'concept', sketch: null, n: 6, onPick: null };

  const SEARCHABLE = ['april_36h11', 'april_36h10', '4x4_1000', '5x5_1000',
                      '6x6_1000', '7x7_1000', 'aruco'];

  function openSearch(onPick, preferDict) {
    searchState.onPick = onPick;
    const sel = $('#searchDict');
    if (!sel.options.length) {
      sel.appendChild(el('option', { value: '*' }, 'all indexed dictionaries'));
      for (const k of SEARCHABLE)
        sel.appendChild(el('option', { value: k }, window.ARUCO_DICTS[k].label));
      sel.onchange = () => buildSketchGrid();
    }
    if (preferDict && SEARCHABLE.includes(preferDict)) sel.value = preferDict;
    buildSketchGrid();
    $('#searchModal').style.display = 'flex';
    $('#searchStatus').textContent = '';
    $('#searchResults').innerHTML = '';
    if (searchState.tab === 'concept') $('#conceptQuery').focus();
    TagSearch.load().catch(e => { $('#searchStatus').textContent = e.message; });
  }

  function closeSearch() { $('#searchModal').style.display = 'none'; }

  function dictsToSearch() {
    const v = $('#searchDict').value;
    return v === '*' ? SEARCHABLE : [v];
  }

  function buildSketchGrid() {
    const keys = dictsToSearch();
    // Sketching needs one module size; with "all" selected, use the commonest (6x6).
    const n = keys.length === 1 ? window.ARUCO_DICTS[keys[0]].width : 6;
    searchState.n = n;
    searchState.sketch = new Array(n * n).fill(null);
    const g = $('#sketchGrid');
    g.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    g.innerHTML = '';
    for (let i = 0; i < n * n; i++) {
      const cell = el('div');
      cell.onclick = () => {
        const cur = searchState.sketch[i];
        const next = cur === null ? 1 : cur === 1 ? 0 : null;
        searchState.sketch[i] = next;
        cell.className = next === 1 ? 'on' : next === 0 ? 'off' : '';
      };
      g.appendChild(cell);
    }
  }

  function showHits(results, note) {
    const box = $('#searchResults');
    box.innerHTML = '';
    $('#searchStatus').textContent = note;
    for (const r of results) {
      const tile = Render.gridTag(r.dict, r.id, 1);
      const hit = el('div', { className: 'hit' });
      hit.innerHTML = rotatedSvg(tile, r.rot);
      const pct = (r.score * 100).toFixed(0);
      hit.appendChild(el('div', { className: 'cap' },
        `${window.ARUCO_DICTS[r.dict].label.replace(/ \(\d+\)/, '')}<br>#${r.id}` +
        `${r.rot ? ' · ' + r.rot * 90 + '°' : ''} · ${pct}%`));
      hit.onclick = () => { searchState.onPick(r); closeSearch(); };
      box.appendChild(hit);
    }
  }

  // The index scores rotations, so show the winning rotation rather than the stored one.
  function rotatedSvg(tile, rot) {
    const svg = SvgOut.toSvg(tile, 40);
    if (!rot) return svg;
    return svg.replace('<rect x="0"',
      `<g transform="rotate(${rot * 90} ${tile.wu / 2} ${tile.wu / 2})"><rect x="0"`)
      .replace('</svg>', '</g></svg>');
  }

  function runConcept() {
    const q = $('#conceptQuery').value.trim();
    if (!q) return;
    $('#searchStatus').textContent = 'searching…';
    TagSearch.load().then(() => {
      const r = TagSearch.concept(q, dictsToSearch());
      if (!r.results.length) {
        showHits([], `No vocabulary entry for ${r.unmatched.map(w => `"${w}"`).join(', ')} — ` +
                     `try a shape, object or texture word.`);
        return;
      }
      if (r.mode === 'glyph') {
        // Marker codes are built for Hamming distance, which actively avoids the kind of
        // regular shape a letter is. A few letters have convincing matches, most do not,
        // so the score is stated plainly rather than dressed up as a hit.
        const pct = (r.topScore * 100).toFixed(0);
        const quality = r.topScore >= 0.9 ? 'a good match exists'
          : r.topScore >= 0.85 ? 'approximate — recognisable at best'
          : 'no real match in these dictionaries';
        showHits(r.results, `closest tags to the letter "${r.glyphChar}" — best ${pct}% of ` +
                            `modules agree, ${quality}. Try "all indexed dictionaries": ` +
                            `ArUco 5x5 and ARUCO_ORIGINAL carry letters far better than AprilTag.`);
        return;
      }
      let note = `matched on ${r.used.join(', ')} (${r.mode})`;
      if (r.unmatched.length) note += ` · ignored ${r.unmatched.join(', ')}`;
      // Nothing standing out above the noise floor is what a meaningless query looks
      // like, so say so rather than presenting the top of a flat distribution.
      if (r.mode !== 'structural' && r.topZ < 2.5)
        note += ' · weak signal, these may not really resemble the query';
      showHits(r.results, note);
    }).catch(e => { $('#searchStatus').textContent = e.message; });
  }

  function runSketch() {
    const set = searchState.sketch.filter(v => v !== null).length;
    if (!set) { $('#searchStatus').textContent = 'Set at least one cell first.'; return; }
    const keys = dictsToSearch().filter(k => window.ARUCO_DICTS[k].width === searchState.n);
    const r = TagSearch.sketch(searchState.sketch, searchState.n, keys);
    showHits(r.results, `${r.specified} cells specified · matching ${keys.length} ` +
                        `${searchState.n}x${searchState.n} dictionar${keys.length === 1 ? 'y' : 'ies'}`);
  }

  function initSearchModal() {
    $('#searchClose').onclick = closeSearch;
    $('#searchModal').onclick = e => { if (e.target.id === 'searchModal') closeSearch(); };
    $('#conceptGo').onclick = runConcept;
    $('#conceptQuery').onkeydown = e => { if (e.key === 'Enter') runConcept(); };
    $('#sketchGo').onclick = runSketch;
    $('#sketchClear').onclick = buildSketchGrid;
    for (const t of document.querySelectorAll('.tab')) {
      t.onclick = () => {
        searchState.tab = t.dataset.tab;
        for (const o of document.querySelectorAll('.tab')) o.classList.toggle('active', o === t);
        $('#tabConcept').style.display = searchState.tab === 'concept' ? '' : 'none';
        $('#tabSketch').style.display = searchState.tab === 'sketch' ? '' : 'none';
      };
    }
  }

  // ---- wire up ----
  function init() {
    const famSel = $('#family');
    for (const [k, v] of Object.entries(FAMILIES)) famSel.appendChild(el('option', { value: k }, v.label));
    famSel.value = state.family;
    famSel.onchange = () => { state.family = famSel.value; renderControls(); update(); };

    $('#sizeMm').value = state.sizeMm;
    $('#sizeMm').oninput = () => { state.sizeMm = Number($('#sizeMm').value) || 60; update(); };
    $('#sweepSizes').value = state.sweep;
    $('#sweepSizes').oninput = () => { state.sweep = $('#sweepSizes').value; };

    $('#addBtn').onclick = () => addToCart([state.sizeMm]);
    $('#sweepBtn').onclick = () => {
      const sizes = state.sweep.split(/[,\s]+/).map(Number).filter(v => v > 0);
      if (!sizes.length) { alert('No valid sizes in sweep list'); return; }
      addToCart(sizes);
    };

    $('#svgBtn').onclick = () => {
      const tile = update();
      if (tile) SvgOut.download(fileBase(tile, state.sizeMm) + '.svg', SvgOut.toSvg(tile, state.sizeMm), 'image/svg+xml');
    };
    $('#pngBtn').onclick = () => {
      const tile = update();
      if (tile) SvgOut.toPngBlob(tile, state.sizeMm, 600, b => SvgOut.download(fileBase(tile, state.sizeMm) + '_600dpi.png', b));
    };

    $('#pageFormat').onchange = () => { state.page = $('#pageFormat').value; };
    $('#clearBtn').onclick = () => { state.cart = []; renderCart(); };
    $('#mintBtn').onclick = () => {
      const doc = PdfOut.mint(state.cart, state.page);
      const skipped = state.cart.filter(i => i.skipped);
      doc.save('tagforge-sheet.pdf');
      if (skipped.length) alert(`${skipped.length} item(s) too large for the page and were skipped:\n` +
        skipped.map(i => i.label).join('\n'));
    };

    initSearchModal();
    renderControls();
    update();
    renderCart();
  }

  init();
})();
