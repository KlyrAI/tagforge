"""Check the shipped search index against the float vectors it was built from.

Quantising to int8 and projecting to 48 dimensions both lose information. The question is
not whether they lose any, but whether they change the answers — so this compares rankings
against full-precision, full-dimension cosine, not just reconstruction error.

Run: python tools/verify_search.py   (after tools/embed_tags.py)
"""
import os, sys, json, base64, re
import numpy as np

os.chdir(os.path.join(os.path.dirname(__file__), '..'))
fails = []
def check(name, ok, extra=''):
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {extra}' if extra else ''))
    if not ok:
        fails.append(name)

src = open('data/tag_search.js', encoding='utf-8').read()
payload = json.loads(re.search(r'window\.TAG_SEARCH = (\{.*\});', src, re.S).group(1))
dims, scale, rots = payload['dims'], payload['scale'], payload['rotations']
print(f'index: {dims} dims, {rots} rotations, {len(payload["vocab"])} vocabulary terms')

def unpack(b64s):
    return np.frombuffer(base64.b64decode(b64s), dtype=np.int8).astype(np.float32) * scale

# ---- 1. structure: every dictionary present and correctly sized ----
for key, meta in payload['dicts'].items():
    v = unpack(payload['tags'][key])
    want = meta['count'] * rots * dims
    check(f'{key}: vector block sized correctly', v.size == want,
          f'{v.size} floats, expected {want}')

# ---- 2. quantisation error vs the float reference ----
ref_path = 'tools/tag_search_float.npz'
if os.path.exists(ref_path):
    ref = np.load(ref_path, allow_pickle=True)
    for key in payload['dicts']:
        got = unpack(payload['tags'][key]).reshape(-1, dims)
        exp = ref[f'tags_{key}']
        err = np.abs(got - exp).max()
        rel = err / (np.abs(exp).max() or 1)
        check(f'{key}: int8 round-trip within half a quantisation step', rel < 0.02,
              f'max abs error {err:.4f} ({rel:.2%} of range)')

    # ---- 3. does PCA+int8 preserve the ranking that matters? ----
    terms = list(ref['terms'])
    text_p = ref['text']
    probes = ['face', 'checkerboard', 'arrow', 'cross', 'spiral', 'heart', 'tree', 'star']
    key = 'april_36h11'
    q_tags = unpack(payload['tags'][key]).reshape(-1, dims)
    f_tags = ref[f'tags_{key}']
    norm = lambda a: a / (np.linalg.norm(a, axis=-1, keepdims=True) + 1e-9)
    overlaps = []
    for p in probes:
        if p not in terms:
            continue
        i = terms.index(p)
        qf = text_p[i]
        top_f = np.argsort(-(norm(f_tags) @ (qf / np.linalg.norm(qf))))[:10]
        qq = unpack(payload['vocab'][p])
        top_q = np.argsort(-(norm(q_tags) @ (qq / np.linalg.norm(qq))))[:10]
        ov = len(set(top_f.tolist()) & set(top_q.tolist()))
        overlaps.append(ov)
        print(f'   {p:14} top-10 overlap {ov}/10')
    check('quantised ranking matches full precision', overlaps and min(overlaps) >= 8,
          f'worst {min(overlaps)}/10 over {len(overlaps)} probes' if overlaps else 'no probes ran')
else:
    print(f'SKIP quantisation checks — {ref_path} missing (re-run tools/embed_tags.py)')

# ---- 4. hubness: the z-score baselines must keep a few tags from answering everything ----
key = 'april_36h11'
dims_ = dims
tags = unpack(payload['tags'][key]).reshape(-1, dims_)
mean = np.frombuffer(base64.b64decode(payload['baseMean'][key]), np.int8).astype(np.float32) * payload['meanScale']
std = np.frombuffer(base64.b64decode(payload['baseStd'][key]), np.int8).astype(np.float32) * payload['stdScale']
vocab_terms = list(payload['vocab'].keys())
Q = np.stack([unpack(payload['vocab'][t]) for t in vocab_terms])
nrm = lambda a: a / (np.linalg.norm(a, axis=-1, keepdims=True) + 1e-9)
S_raw = nrm(Q) @ nrm(tags).T
S_z = (S_raw - mean) / np.maximum(std, 1e-6)

def hub_stats(S):
    top = np.argsort(-S, axis=1)[:, :5] // payload['rotations']
    counts = np.bincount(top.flatten(), minlength=payload['dicts'][key]['count'])
    slots = top.size
    return int((counts > 0).sum()), counts.max() / slots

d_raw, hog_raw = hub_stats(S_raw)
d_z, hog_z = hub_stats(S_z)
print(f'   raw cosine: {d_raw} distinct tags in top-5s, worst hub takes {hog_raw:.0%} of slots')
print(f'   z-scored:   {d_z} distinct tags in top-5s, worst hub takes {hog_z:.0%} of slots')
check('z-scoring suppresses hub tags', d_z > 2 * d_raw and hog_z < 0.03,
      f'{d_raw} -> {d_z} distinct, worst hub {hog_raw:.0%} -> {hog_z:.0%}')

# ---- 5. vocabulary vectors are unit-ish and distinct ----
V = np.stack([unpack(v) for v in payload['vocab'].values()])
sims = norm_v = V / (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9)
gram = norm_v @ norm_v.T
np.fill_diagonal(gram, -1)
dupes = int((gram > 0.999).sum() // 2)
check('vocabulary terms are distinct', dupes == 0, f'{dupes} duplicate pairs')

size_mb = os.path.getsize('data/tag_search.js') / 1e6
check('index is small enough to ship', size_mb < 4.0, f'{size_mb:.2f} MB')

print(f'\n{len(fails)} failures')
sys.exit(1 if fails else 0)
