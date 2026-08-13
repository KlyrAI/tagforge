"""Phase 0: does CLIP see anything meaningful in a 6x6 binary marker?

CLIP was trained on photographs. A marker is 36 bits upscaled to a square, which is well
outside that distribution, so the semantic similarity may be pure noise. This embeds one
dictionary, runs a set of probe queries, and writes a contact sheet per query so the
result can be judged by eye before anything is built on top of it.

Run: python tools/embed_probe.py
Output: tools/probe_out/<query>.png
"""
import os, sys
import numpy as np, cv2, torch, open_clip

os.chdir(os.path.join(os.path.dirname(__file__), '..'))
OUT = 'tools/probe_out'
os.makedirs(OUT, exist_ok=True)

DICT_ID = cv2.aruco.DICT_APRILTAG_36h11
DICT_NAME = 'AprilTag 36h11'
N_TAGS = 587
TOP = 8

QUERIES = [
    'an arrow', 'a smiling face', 'a cross', 'a checkerboard', 'the letter T',
    'a spiral', 'a heart', 'a staircase', 'a diagonal stripe', 'a hollow square',
    'a dense cluster of dots', 'a tree',
]

def render(marker_id, size=224, rot=0):
    """Marker with quiet zone, upscaled the way the app draws it."""
    m = 8                                   # 6 data + 1 border each side
    img = cv2.aruco.generateImageMarker(cv2.aruco.getPredefinedDictionary(DICT_ID),
                                        marker_id, m * 16)
    img = np.pad(img, 16, constant_values=255)
    img = np.rot90(img, rot)
    return cv2.resize(img, (size, size), interpolation=cv2.INTER_NEAREST)

print('loading CLIP ViT-B-32 (first run downloads weights)...')
model, _, preprocess = open_clip.create_model_and_transforms(
    'ViT-B-32', pretrained='laion2b_s34b_b79k')
model.eval()
tokenizer = open_clip.get_tokenizer('ViT-B-32')

from PIL import Image
print(f'embedding {N_TAGS} tags...')
vecs = []
BATCH = 64
with torch.no_grad():
    for start in range(0, N_TAGS, BATCH):
        ids = range(start, min(start + BATCH, N_TAGS))
        batch = torch.stack([preprocess(Image.fromarray(render(i)).convert('RGB')) for i in ids])
        f = model.encode_image(batch)
        vecs.append((f / f.norm(dim=-1, keepdim=True)).cpu().numpy())
        print(f'  {min(start + BATCH, N_TAGS)}/{N_TAGS}', end='\r')
V = np.concatenate(vecs)
print(f'\nembedded {V.shape}')

with torch.no_grad():
    tf = model.encode_text(tokenizer([f'a photo of {q}' for q in QUERIES]))
    T = (tf / tf.norm(dim=-1, keepdim=True)).cpu().numpy()

sims = T @ V.T                                   # queries x tags
print(f'\nsimilarity spread: min {sims.min():.3f}  max {sims.max():.3f}  '
      f'mean {sims.mean():.3f}  std {sims.std():.3f}')
print('(a tiny spread across queries would mean CLIP cannot tell these apart at all)\n')

for qi, q in enumerate(QUERIES):
    order = np.argsort(-sims[qi])[:TOP]
    cell = 128
    sheet = np.full((cell + 22, cell * TOP, 3), 255, np.uint8)
    for k, tid in enumerate(order):
        img = cv2.cvtColor(cv2.resize(render(int(tid)), (cell - 8, cell - 8),
                                      interpolation=cv2.INTER_NEAREST), cv2.COLOR_GRAY2BGR)
        sheet[4:cell - 4, k * cell + 4:(k + 1) * cell - 4] = img
        cv2.putText(sheet, f'#{tid} {sims[qi][tid]:.3f}', (k * cell + 6, cell + 15),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 0), 1, cv2.LINE_AA)
    safe = q.replace(' ', '_')
    cv2.imwrite(f'{OUT}/{safe}.png', sheet)
    per_query_spread = sims[qi].max() - sims[qi].min()
    print(f'{q:28} top {[int(t) for t in order[:5]]}  '
          f'best {sims[qi].max():.3f}  spread {per_query_spread:.3f}')

np.save('tools/probe_vecs.npy', V)
print(f'\ncontact sheets in {OUT}/ — judge these by eye before building on CLIP')
sys.exit(0)
