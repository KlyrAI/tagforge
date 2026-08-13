"""Build the visual search index: CLIP vectors for every tag, in every rotation.

Phase 0 (tools/embed_probe.py) established that CLIP does carry real signal on these
binary patterns — "a smiling face" and "a checkerboard" return convincing matches — but
that it is uneven, and flat for precise geometric queries like "a hollow square". The
browser therefore also scores structural descriptors computed from the bits directly
(js/search.js); this file supplies only the semantic half.

Output: data/tag_search.js  (base64 int8 vectors, lazy-loaded by the app)
Run:    python tools/embed_tags.py
"""
import os, sys, json, base64, time
import numpy as np, cv2, torch, open_clip
from PIL import Image
from sklearn.decomposition import PCA

os.chdir(os.path.join(os.path.dirname(__file__), '..'))

# key in data/aruco_dicts.js -> (cv2 dictionary, marker count, data modules)
DICTS = {
    'april_36h11': (cv2.aruco.DICT_APRILTAG_36h11, 587, 6),
    'april_36h10': (cv2.aruco.DICT_APRILTAG_36h10, 2320, 6),
    '4x4_1000':    (cv2.aruco.DICT_4X4_1000,       1000, 4),
    '5x5_1000':    (cv2.aruco.DICT_5X5_1000,       1000, 5),
    '6x6_1000':    (cv2.aruco.DICT_6X6_1000,       1000, 6),
    '7x7_1000':    (cv2.aruco.DICT_7X7_1000,       1000, 7),
    'aruco':       (cv2.aruco.DICT_ARUCO_ORIGINAL, 1024, 5),
}
DIMS = 48                 # PCA target; keeps the shipped file near 2MB
BATCH = 128
ROTS = 4

# Prompt ensemble: these are icons, not photographs, so averaging phrasings helps.
TEMPLATES = ['a photo of {}', 'a black and white icon of {}', 'a pixelated drawing of {}']

VOCAB = """
arrow up down left right cross plus star heart circle square triangle diamond ring
spiral zigzag wave stripe stripes checkerboard grid maze ladder staircase steps
face smiley frown eyes mouth head skull mask person figure body hand
cat dog bird fish snake spider bug butterfly tree leaf flower mushroom
house building tower bridge window door fence road path river mountain
letter A letter B letter C letter E letter F letter H letter I letter L letter T
letter X letter Y letter Z letter O letter S letter U letter N letter M letter K
number one number two number three number four number seven number eight
key lock crown anchor boat car wheel gear cog hammer sword shield
lightning bolt fire flame water drop cloud sun moon snowflake
dense sparse solid hollow empty full thick thin heavy light
symmetric asymmetric mirrored balanced random noisy chaotic ordered regular
diagonal vertical horizontal centered scattered clustered
bar block band border frame corner edge
dots speckles texture pattern chevron arrowhead
robot alien ghost monster creature
music note bell cup bowl bottle flag
eye pupil target bullseye crosshair
chain link knot rope net web
teeth comb fork rake
boxes bricks tiles mosaic
"""


def render(dict_id, marker_id, data_modules, rot, size=224):
    m = data_modules + 2                                   # data + 1 black border each side
    img = cv2.aruco.generateImageMarker(cv2.aruco.getPredefinedDictionary(dict_id),
                                        marker_id, m * 16)
    img = np.pad(img, 16, constant_values=255)             # 1-module quiet zone
    img = np.rot90(img, rot)
    return cv2.resize(img, (size, size), interpolation=cv2.INTER_NEAREST)


def pack(tag_p, text_p, terms):
    """Quantise vectors and write data/tag_search.js.

    Also stores a per-tag similarity baseline. Raw cosine suffers badly from hubness here:
    a handful of tags sit near the centre of the embedding and rank highly for almost every
    query (one tag took 107 of 865 top-5 slots, and the whole vocabulary only ever surfaced
    99 distinct tags). Z-scoring each tag against its own distribution over the vocabulary
    fixes that — 392 distinct tags, and the worst hub drops to ~1% of slots.
    """
    norm = lambda a: a / (np.linalg.norm(a, axis=-1, keepdims=True) + 1e-9)
    tn = norm(text_p)
    base_mean, base_std = {}, {}
    for k, v in tag_p.items():
        S = tn @ norm(v).T                      # vocabulary x (count*ROTS)
        base_mean[k] = S.mean(0)
        base_std[k] = S.std(0) + 1e-6

    scale = max(max(np.abs(v).max() for v in tag_p.values()), np.abs(text_p).max()) / 127.0
    q = lambda a: np.clip(np.round(a / scale), -127, 127).astype(np.int8)
    mean_scale = max(np.abs(v).max() for v in base_mean.values()) / 127.0
    std_scale = max(np.abs(v).max() for v in base_std.values()) / 127.0
    qm = lambda a, s: np.clip(np.round(a / s), -127, 127).astype(np.int8)
    b64 = lambda a: base64.b64encode(a.tobytes()).decode()

    payload = {
        'dims': DIMS,
        'scale': float(scale),
        'meanScale': float(mean_scale),
        'stdScale': float(std_scale),
        'rotations': ROTS,
        'dicts': {k: {'count': n, 'modules': m} for k, (_, n, m) in DICTS.items()},
        'vocab': {t: b64(q(text_p[i])) for i, t in enumerate(terms)},
        'tags': {k: b64(q(v)) for k, v in tag_p.items()},
        'baseMean': {k: b64(qm(v, mean_scale)) for k, v in base_mean.items()},
        'baseStd': {k: b64(qm(v, std_scale)) for k, v in base_std.items()},
    }
    with open('data/tag_search.js', 'w') as f:
        f.write('// Visual search index: CLIP ViT-B-32 vectors, PCA-reduced and int8-quantised.\n')
        f.write('// Generated by tools/embed_tags.py. Vectors are id-major, rotation-minor.\n')
        f.write('window.TAG_SEARCH = ' + json.dumps(payload, separators=(',', ':')) + ';\n')
    print(f'wrote data/tag_search.js — {os.path.getsize("data/tag_search.js") / 1e6:.2f} MB')


def main():
    # Re-pack from the cached float vectors instead of spending 20 minutes on CLIP again.
    if '--repack' in sys.argv:
        ref = np.load('tools/tag_search_float.npz', allow_pickle=True)
        terms = [str(t) for t in ref['terms']]
        tag_p = {k: ref[f'tags_{k}'] for k in DICTS}
        pack(tag_p, ref['text'], terms)
        return

    print('loading CLIP ViT-B-32...')
    model, _, preprocess = open_clip.create_model_and_transforms(
        'ViT-B-32', pretrained='laion2b_s34b_b79k')
    model.eval()
    tokenizer = open_clip.get_tokenizer('ViT-B-32')

    total = sum(n for _, n, _ in DICTS.values()) * ROTS
    print(f'embedding {total} images ({sum(n for _, n, _ in DICTS.values())} tags x {ROTS} rotations)')
    t0 = time.time()

    per_dict = {}
    done = 0
    with torch.no_grad():
        for key, (dict_id, count, data_modules) in DICTS.items():
            vecs = []
            jobs = [(i, r) for i in range(count) for r in range(ROTS)]
            for start in range(0, len(jobs), BATCH):
                chunk = jobs[start:start + BATCH]
                batch = torch.stack([
                    preprocess(Image.fromarray(render(dict_id, i, data_modules, r)).convert('RGB'))
                    for i, r in chunk])
                f = model.encode_image(batch)
                vecs.append((f / f.norm(dim=-1, keepdim=True)).cpu().numpy())
                done += len(chunk)
                el = time.time() - t0
                print(f'  {key:12} {done}/{total}  {el:5.0f}s elapsed, '
                      f'~{el / max(done, 1) * (total - done):4.0f}s left   ', end='\r')
            per_dict[key] = np.concatenate(vecs)            # (count*ROTS, 512), id-major
    print(f'\nembedding took {time.time() - t0:.0f}s')

    all_vecs = np.concatenate(list(per_dict.values()))
    print(f'fitting PCA {all_vecs.shape[1]} -> {DIMS}')
    pca = PCA(n_components=DIMS, random_state=0).fit(all_vecs)
    print(f'  explained variance retained: {pca.explained_variance_ratio_.sum():.1%}')

    # Vocabulary through the text encoder, averaged over the prompt templates.
    words = [w.strip() for w in VOCAB.split('\n') if w.strip()]
    terms = []
    for line in words:
        terms += [t for t in line.split() if t]
    # rebuild multi-word terms like "letter A" / "lightning bolt"
    terms = []
    for line in words:
        toks = line.split()
        i = 0
        while i < len(toks):
            if toks[i] in ('letter', 'number', 'music', 'lightning') and i + 1 < len(toks):
                terms.append(f'{toks[i]} {toks[i + 1]}')
                i += 2
            else:
                terms.append(toks[i])
                i += 1
    terms = sorted(set(terms))
    print(f'embedding {len(terms)} vocabulary terms')
    with torch.no_grad():
        tv = []
        for t in terms:
            tok = tokenizer([tpl.format(t) for tpl in TEMPLATES])
            f = model.encode_text(tok)
            f = f / f.norm(dim=-1, keepdim=True)
            f = f.mean(0)
            tv.append((f / f.norm()).cpu().numpy())
    text_vecs = np.stack(tv)

    # Project both sides through the same basis.
    tag_p = {k: pca.transform(v) for k, v in per_dict.items()}
    text_p = pca.transform(text_vecs)

    # Float vectors kept out of the repo: reference for verification, and the input to
    # `--repack` so the packing can be changed without re-running CLIP.
    np.savez_compressed('tools/tag_search_float.npz',
                        text=text_p, terms=np.array(terms), **{f'tags_{k}': v for k, v in tag_p.items()})
    print('wrote tools/tag_search_float.npz (reference for verification)')
    pack(tag_p, text_p, terms)


if __name__ == '__main__':
    main()
    sys.exit(0)
