// Find a marker by what it looks like.
//
// Two independent scorers, because neither alone is enough:
//
//   semantic  — CLIP vectors built offline (tools/embed_tags.py). Good at texture and
//               gestalt ("checkerboard", "a face", "diagonal"), flat and unreliable for
//               precise geometry, which is exactly what the probe in Phase 0 showed.
//   structural— descriptors computed here from the bits: symmetry, density, run lengths,
//               connected components. Exact and instant, and covers the geometric terms
//               CLIP is useless at.
//
// A query is routed to whichever scorer claims it; structural terms win when both match,
// since a deterministic answer beats a fuzzy one. Sketch search is a third mode: pure
// Hamming distance, no scoring model at all.

'use strict';

const TagSearch = (() => {
  const ROTS = 4;
  let index = null;             // window.TAG_SEARCH once loaded
  let loading = null;

  // ---- lazy load: a script tag, not fetch, so this still works from file:// ----
  function load() {
    if (index) return Promise.resolve(index);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      if (window.TAG_SEARCH) { index = window.TAG_SEARCH; return resolve(index); }
      const s = document.createElement('script');
      s.src = 'data/tag_search.js';
      s.onload = () => {
        index = window.TAG_SEARCH || null;
        index ? resolve(index) : reject(new Error('search index loaded but was empty'));
      };
      s.onerror = () => reject(new Error('could not load data/tag_search.js — run tools/embed_tags.py'));
      document.head.appendChild(s);
    });
    return loading;
  }

  const b64 = str => {
    const bin = atob(str);
    const out = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
    return out;
  };

  const cache = new Map();
  function vectors(key) {
    if (!cache.has(key)) cache.set(key, b64(index.tags[key]));
    return cache.get(key);
  }
  // Per-tag similarity baselines. Raw cosine is dominated by hubs — a few tags that sit
  // near the centre of the embedding and score highly for nearly every query. Z-scoring
  // each tag against its own distribution over the vocabulary removes them.
  const baseCache = new Map();
  function baselines(key) {
    if (!baseCache.has(key)) {
      baseCache.set(key, {
        mean: b64(index.baseMean[key]),
        std: b64(index.baseStd[key]),
      });
    }
    return baseCache.get(key);
  }

  // ---- bit grids, shared by structural scoring and sketch search ----
  const bitCache = new Map();
  function bits(dictKey, id) {
    const k = dictKey + ':' + id;
    if (!bitCache.has(k)) {
      const d = window.ARUCO_DICTS[dictKey];
      bitCache.set(k, Render.decodeBits(d.markers[id], d.width, d.height));
    }
    return bitCache.get(k);
  }

  function rotate(grid, n, times) {
    let g = grid;
    for (let t = 0; t < times; t++) {
      const out = new Array(n * n);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) out[x * n + (n - 1 - y)] = g[y * n + x];
      g = out;
    }
    return g;
  }

  // ---- structural descriptors ----
  function describe(g, n) {
    let on = 0, hSym = 0, vSym = 0, dSym = 0, runs = 0, edges = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = g[y * n + x];
        on += v;
        if (v === g[y * n + (n - 1 - x)]) hSym++;
        if (v === g[(n - 1 - y) * n + x]) vSym++;
        if (v === g[x * n + y]) dSym++;
        if (x + 1 < n && v !== g[y * n + x + 1]) edges++;
        if (y + 1 < n && v !== g[(y + 1) * n + x]) edges++;
        if (x + 1 < n && v !== g[y * n + x + 1]) runs++;
      }
    }
    const cells = n * n;
    // longest straight runs, per axis and diagonal
    const longest = (get) => {
      let best = 0;
      for (let a = 0; a < n; a++) {
        let cur = 0;
        for (let b = 0; b < n; b++) { cur = get(a, b) ? cur + 1 : 0; if (cur > best) best = cur; }
      }
      return best / n;
    };
    const rowRun = longest((y, x) => g[y * n + x]);
    const colRun = longest((x, y) => g[y * n + x]);
    let diagRun = 0;
    for (let d = -n + 1; d < n; d++) {
      let cur = 0;
      for (let y = 0; y < n; y++) {
        const x = y + d;
        if (x < 0 || x >= n) { cur = 0; continue; }
        cur = g[y * n + x] ? cur + 1 : 0;
        if (cur > diagRun) diagRun = cur;
      }
    }
    // 4-connected components over set cells
    const seen = new Uint8Array(cells);
    let comps = 0;
    for (let i = 0; i < cells; i++) {
      if (!g[i] || seen[i]) continue;
      comps++;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const p = stack.pop(), px = p % n, py = (p / n) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const qx = px + dx, qy = py + dy;
          if (qx < 0 || qy < 0 || qx >= n || qy >= n) continue;
          const qi = qy * n + qx;
          if (g[qi] && !seen[qi]) { seen[qi] = 1; stack.push(qi); }
        }
      }
    }
    // centre-of-mass offset and ring bias (set cells near the border vs the middle)
    let cxs = 0, cys = 0, border = 0, middle = 0;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (!g[y * n + x]) continue;
        cxs += x; cys += y;
        (x === 0 || y === 0 || x === n - 1 || y === n - 1) ? border++ : middle++;
      }
    const cx = on ? cxs / on / (n - 1) : 0.5, cy = on ? cys / on / (n - 1) : 0.5;

    return {
      density: on / cells,
      hSym: hSym / cells, vSym: vSym / cells, dSym: dSym / cells,
      edges: edges / (2 * n * (n - 1)),          // 1.0 = perfect checkerboard
      rowRun, colRun, diagRun: diagRun / n,
      comps: comps / cells,
      border: on ? border / on : 0,
      centred: 1 - (Math.abs(cx - 0.5) + Math.abs(cy - 0.5)),
    };
  }

  // Structural concepts: each maps a descriptor set to a score in roughly 0..1.
  const STRUCTURAL = {
    'checkerboard': d => d.edges,
    'dense':        d => d.density,
    'solid':        d => d.density,
    'sparse':       d => 1 - d.density,
    'empty':        d => 1 - d.density,
    'symmetric':    d => Math.max(d.hSym, d.vSym),
    'mirrored':     d => d.hSym,
    'balanced':     d => (d.hSym + d.vSym) / 2,
    'diagonal':     d => d.diagRun,
    'horizontal':   d => d.rowRun,
    'vertical':     d => d.colRun,
    'bar':          d => Math.max(d.rowRun, d.colRun),
    'stripe':       d => Math.max(d.rowRun, d.colRun, d.diagRun),
    'block':        d => d.density * (1 - d.edges),
    'scattered':    d => d.comps,
    'dots':         d => d.comps,
    'speckles':     d => d.comps,
    'clustered':    d => d.density * (1 - d.comps),
    'border':       d => d.border,
    'frame':        d => d.border,
    'hollow':       d => d.border * (1 - d.centred),
    'centered':     d => d.centred,
    'centred':      d => d.centred,
    'noisy':        d => d.edges * d.comps,
    'ordered':      d => Math.max(d.hSym, d.vSym) * (1 - d.comps),
    'random':       d => d.comps * (1 - Math.max(d.hSym, d.vSym)),
    'cross':        d => Math.min(d.rowRun, d.colRun) * d.centred,
    'plus':         d => Math.min(d.rowRun, d.colRun) * d.centred,
  };

  const levenshtein1 = (a, b) => {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (a.length < b.length) j++;
      else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  };

  // Resolve a word to a vocabulary key: exact, then prefix, then one typo away.
  function resolve(word) {
    if (!index) return null;
    const v = index.vocab;
    if (v[word]) return word;
    const keys = Object.keys(v);
    const pref = keys.find(k => k === word + 's' || word === k + 's' || k.startsWith(word + ' '));
    if (pref) return pref;
    const near = keys.find(k => k.length > 3 && levenshtein1(k, word));
    return near || null;
  }

  // ---- main entry: concept search ----
  // Returns { results, used, unmatched, mode, spread }
  function concept(query, dictKeys, topN = 24) {
    const words = query.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 1);
    const structuralHits = words.filter(w => STRUCTURAL[w]);
    const semanticWords = words.filter(w => !STRUCTURAL[w]);

    const resolved = [], unmatched = [];
    for (const w of semanticWords) {
      const r = resolve(w);
      r ? resolved.push(r) : unmatched.push(w);
    }
    if (!structuralHits.length && !resolved.length) {
      return { results: [], used: [], unmatched, mode: 'none', spread: 0,
               reason: index ? 'no vocabulary match' : 'search index not loaded' };
    }

    let qv = null;
    if (resolved.length) {
      const dims = index.dims;
      qv = new Float32Array(dims);
      for (const w of resolved) {
        const v = b64(index.vocab[w]);
        for (let i = 0; i < dims; i++) qv[i] += v[i];
      }
      let norm = 0;
      for (let i = 0; i < dims; i++) norm += qv[i] * qv[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dims; i++) qv[i] /= norm;
    }

    const out = [];
    let bestZ = -Infinity;
    for (const key of dictKeys) {
      // Dictionary shape comes from the marker data, not the index, so structural
      // queries keep working even when the semantic index is missing or failed to load.
      const dict = window.ARUCO_DICTS[key];
      if (!dict) continue;
      if (qv && !(index && index.tags[key])) continue;     // not indexed: no semantic score
      const n = dict.width;
      const vecs = qv ? vectors(key) : null;
      const base = qv ? baselines(key) : null;
      const dims = index ? index.dims : 0;
      for (let id = 0; id < dict.markers.length; id++) {
        const grid = bits(key, id);
        for (let rot = 0; rot < ROTS; rot++) {
          let semantic = 0;
          if (qv) {
            const slot = id * ROTS + rot;
            const off = slot * dims;
            let dot = 0, mag = 0;
            for (let i = 0; i < dims; i++) {
              const t = vecs[off + i];
              dot += qv[i] * t;
              mag += t * t;
            }
            const cos = dot / (Math.sqrt(mag) || 1);
            const mu = base.mean[slot] * index.meanScale;
            const sd = base.std[slot] * index.stdScale;
            semantic = (cos - mu) / (sd || 1e-6);       // z-score against this tag's own spread
            if (semantic > bestZ) bestZ = semantic;
          }
          let structural = 0;
          if (structuralHits.length) {
            const d = describe(rotate(grid, n, rot), n);
            structural = structuralHits.reduce((s, w) => s + STRUCTURAL[w](d), 0) / structuralHits.length;
          }
          // Squash the z-score into 0..1 so it is commensurate with structural scores
          // and displayable as a percentage. Monotone, so semantic-only ranking is
          // unchanged; z=0 (typical for this tag) maps to 0.5, z=4 to about 0.88.
          const semanticNorm = qv ? 1 / (1 + Math.exp(-semantic / 2)) : 0;
          // Structural terms are exact, so they lead when both kinds are present.
          const score = structuralHits.length
            ? (qv ? 0.7 * structural + 0.3 * semanticNorm : structural)
            : semanticNorm;
          out.push({ dict: key, id, rot, score, z: semantic, structural });
        }
      }
    }

    // One entry per tag: keep whichever rotation scored best.
    const best = new Map();
    for (const r of out) {
      const k = r.dict + ':' + r.id;
      const prev = best.get(k);
      if (!prev || r.score > prev.score) best.set(k, r);
    }
    const results = [...best.values()].sort((a, b) => b.score - a.score).slice(0, topN);

    // How far the best match stands out from that tag's own norm. Below about 2.5 nothing
    // really resembles the query — the flat-response case the Phase 0 probe showed for
    // "a hollow square" — and the caller should say so rather than present noise.
    return {
      results,
      used: [...structuralHits, ...resolved],
      unmatched,
      mode: structuralHits.length ? (resolved.length ? 'both' : 'structural') : 'semantic',
      topZ: Number.isFinite(bestZ) ? bestZ : 0,
    };
  }

  // ---- sketch search: exact bit matching, no model involved ----
  // sketch: array of 1 (dark module), 0 (light), or null (don't care), row-major n*n.
  function sketch(pattern, n, dictKeys, topN = 24) {
    const cells = [];
    for (let i = 0; i < pattern.length; i++) if (pattern[i] !== null) cells.push(i);
    if (!cells.length) return { results: [], specified: 0 };

    const out = [];
    for (const key of dictKeys) {
      const d = window.ARUCO_DICTS[key];
      if (!d || d.width !== n) continue;             // only dicts of matching module size
      for (let id = 0; id < d.markers.length; id++) {
        const base = bits(key, id);
        for (let rot = 0; rot < ROTS; rot++) {
          const g = rotate(base, n, rot);
          let hits = 0;
          // app bit convention: 1 = white module, so a "dark" sketch cell wants bit 0
          for (const i of cells) if ((g[i] ? 0 : 1) === pattern[i]) hits++;
          out.push({ dict: key, id, rot, score: hits / cells.length, matched: hits });
        }
      }
    }
    const best = new Map();
    for (const r of out) {
      const k = r.dict + ':' + r.id;
      const prev = best.get(k);
      if (!prev || r.score > prev.score) best.set(k, r);
    }
    return {
      results: [...best.values()].sort((a, b) => b.score - a.score).slice(0, topN),
      specified: cells.length,
    };
  }

  return { load, concept, sketch, describe, rotate, bits, isLoaded: () => !!index };
})();
window.TagSearch = TagSearch;
