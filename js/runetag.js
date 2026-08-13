// RUNE-129 tag generation — JS port of artursg/RUNEtag (MIT):
//   RUNETag/coding.cpp        (GF(7) cyclic code, length 43, spectral alignment)
//   RUNETagGenerator/*.cpp    (dot layout: 43 sectors x 3 rings)
// Generation side only; no BCH decoding needed to mint markers.

'use strict';

const RuneTag = (() => {
  const GEN = [1, 1, 6, 4, 6, 0, 3, 1, 5, 3, 5, 4, 0, 4, 6, 3, 4, 6, 3, 6, 4, 3, 6, 4, 0, 4, 5, 3, 5, 1, 3, 0, 6, 4, 6, 1, 1, 0, 0, 0, 0, 0, 0];
  const LEN = 43, NUM_WORDS = 117649;           // 7^6 ids
  const K = 4, P = 173, ROOT = 2, LOGN1 = 89;   // alignment transform params
  const LAYERS = 3, RADIUS_RATIO = 17.8, ELLY = 1 / RADIUS_RATIO;

  // pow/log tables mod P
  const pow = new Array(P), log = new Array(P);
  {
    let a = 1;
    for (let i = 0; i < P - 1; i++) { pow[i] = a; log[a] = i; a = (a * ROOT) % P; }
  }

  function sft(code) {
    const out = new Array(LEN);
    for (let i = 0; i < LEN; i++) {
      const strobe = (K * i) % (P - 1);
      let s = 0;
      for (let j = 0; j < LEN; j++) s = (s + pow[(strobe * j) % (P - 1)] * code[j]) % P;
      out[i] = s;
    }
    return out;
  }

  function isft(ft) {
    const out = new Array(LEN);
    for (let i = 0; i < LEN; i++) {
      const strobe = (K * i) % (P - 1);
      let s = 0;
      for (let j = 0; j < LEN; j++) {
        const psn = (strobe * j) % (P - 1);
        s = (s + pow[(LOGN1 + P - 2 - psn) % (P - 1)] * ft[j]) % P;
      }
      out[i] = s;
    }
    return out;
  }

  function getIndex(c) {
    let index = 0;
    index += (5 * c[0] + 2 * c[3] + 6 * c[4] + c[5]) % 7;
    index = index * 7 + (2 * c[2] + 6 * c[3] + c[4]) % 7;
    index = index * 7 + (2 * c[1] + 6 * c[2] + c[3]) % 7;
    index = index * 7 + (2 * c[0] + 6 * c[1] + c[2]) % 7;
    index = index * 7 + (6 * c[0] + c[1]) % 7;
    index = index * 7 + c[0];
    return index;
  }

  // Returns { code: aligned 43 symbols (0..6), index: canonical id the detector will report }
  function generate(id) {
    let index = ((id % NUM_WORDS) + NUM_WORDS) % NUM_WORDS;
    const code = new Array(LEN).fill(0);
    let start = 0;
    while (index) {
      const val = index % 7;
      for (let i = 0; i < LEN; i++) code[(start + i) % LEN] += (val * GEN[i]) % 7;
      index = Math.floor(index / 7);
      start++;
    }
    for (let i = 0; i < LEN; i++) code[i] %= 7;

    // align to canonical rotation (what the detector reports)
    const ft = sft(code);
    if (ft[1] === 0) throw new Error(`RuneTag id ${id} yields a periodic code — pick another id`);
    const rotation = Math.floor(log[ft[1]] / K);
    const rotIdx = P - 1 - K * rotation;
    for (let i = 1; i < LEN; i++) ft[i] = (ft[i] * pow[(rotIdx * i) % (P - 1)]) % P;
    const aligned = isft(ft);
    return { code: aligned, index: getIndex(aligned) };
  }

  // 43 symbols -> 129 dot booleans; bcode[sector*3 + layer], layer 0 = innermost ring
  function unpack(code) {
    const bits = new Array(LEN * 3);
    let idx = 0;
    for (const v of code) {
      const c = v + 1;                       // 1..7; 0 reserved for erasures
      bits[idx++] = Math.floor(c / 4) % 2 === 1;
      bits[idx++] = Math.floor(c / 2) % 2 === 1;
      bits[idx++] = c % 2 === 1;
    }
    return bits;
  }

  // A code is "canonical" when generating from index i yields rotation 0 and re-derives i.
  // codegen.cpp enumerates the official RUNE-129 set with exactly this test, so a canonical
  // id is the id a detector reports. Only ~2.5% of indices qualify, so the app addresses
  // tags by ordinal (1st, 2nd, 3rd valid tag) — consecutive ordinals give distinct tags,
  // where consecutive raw indices would mostly repeat the same one.
  const CANON = [];        // CANON[n-1] = index of the nth valid tag
  let scanned = 0;         // highest index examined so far

  function canonicalAt(ordinal) {
    const n = Math.max(1, Math.floor(ordinal));
    while (CANON.length < n && scanned < NUM_WORDS) {
      scanned++;
      try {
        if (generate(scanned).index === scanned) CANON.push(scanned);
      } catch (e) { /* periodic code — not a usable tag */ }
    }
    if (CANON.length < n) throw new Error(`Only ${CANON.length} RUNE-129 tags exist`);
    return CANON[n - 1];
  }

  // quiet = fraction of tag diameter added around it as white margin
  function render(id, quiet) {
    const { code, index } = generate(id);
    const bits = unpack(code);
    const extent = 1 + ELLY;                 // tag radius incl. outer dot bulge
    const wu = 2 * extent * (1 + 2 * quiet);
    const c = wu / 2;
    const scale = 1;                          // units == generator units
    const shapes = [];
    const alpha = 2 * Math.PI / LEN;
    for (let i = 0; i < LEN; i++) {
      for (let L = 0; L < LAYERS; L++) {
        if (!bits[i * 3 + L]) continue;
        const R = (LAYERS + L + 1) / (LAYERS * 2);
        const ang = alpha * i;
        shapes.push({ t: 'circle', cx: c + R * Math.cos(ang) * scale,
                      cy: c - R * Math.sin(ang) * scale, r: ELLY * R * scale, black: true });
      }
    }
    // The dot rings start at radius 2/3, so the middle of a RuneTag is empty and can
    // host another marker. Largest square inscribed in that clear circle, less a margin
    // so nothing crowds the innermost ring.
    const clearR = (LAYERS + 1) / (LAYERS * 2) - ELLY * ((LAYERS + 1) / (LAYERS * 2));
    const side = clearR * Math.SQRT2 * 0.94;
    const hostRegion = { x: c - side / 2, y: c - side / 2, w: side, h: side };

    return {
      wu, hu: wu, shapes, hostRegion,
      info: {
        family: 'RuneTag', dict: 'RUNE-129', id: index, requestedId: id,
        dots: shapes.length,
        moduleNote: mm => `dot ⌀ ${(2 * ELLY * mm / wu).toFixed(1)}mm`,
      },
    };
  }

  return { generate, unpack, render, canonicalAt, NUM_WORDS };
})();
window.RuneTag = RuneTag;
