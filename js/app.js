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
    } else if (f === 'april') {
      c.appendChild(row('Family', dictSelect(APRIL_KEYS, state.aprilDict, v => state.aprilDict = v)));
      c.appendChild(row('Marker ID', numInput(state.id, 0, 2319, 1, v => state.id = v)));
      c.appendChild(row('Quiet zone (modules)', numInput(state.quietModules, 0, 4, 1, v => state.quietModules = v)));
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
    } else if (f === 'runetag') {
      c.appendChild(row('Tag number', numInput(state.runeId, 1, 2000, 1, v => state.runeId = v)));
      c.appendChild(row('Quiet zone (% of ⌀)', numInput(state.runeQuietPct, 0, 25, 1, v => state.runeQuietPct = v)));
      c.appendChild(el('p', { className: 'hint' },
        'Counts through valid RUNE-129 codes — tag 1, 2, 3 are consecutive distinct tags. ' +
        'Only ~1 raw index in 40 is a valid code, so the label shows the actual code number ' +
        'a detector reports (tag 1 = code 24).'));
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
    } else if (f === 'gridboard') {
      const g = state.grid;
      c.appendChild(row('Dictionary', dictSelect(ARUCO_KEYS, state.dict, v => state.dict = v)));
      c.appendChild(row('Markers X', numInput(g.mx, 1, 20, 1, v => g.mx = v)));
      c.appendChild(row('Markers Y', numInput(g.my, 1, 20, 1, v => g.my = v)));
      c.appendChild(row('Marker (mm)', numInput(g.markerMm, 5, 150, 1, v => g.markerMm = v)));
      c.appendChild(row('Separation (mm)', numInput(g.sepMm, 1, 50, 1, v => g.sepMm = v)));
      c.appendChild(row('First ID', numInput(g.firstId, 0, 999, 1, v => g.firstId = v)));
      c.appendChild(row('Quiet zone (mm)', numInput(g.quietMm, 0, 30, 1, v => g.quietMm = v)));
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

    renderControls();
    update();
    renderCart();
  }

  init();
})();
