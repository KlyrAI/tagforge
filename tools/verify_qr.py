"""Decode the QR-concealed-tag matrix: does the QR still scan, and is the tag still found?

Prints a pass/fail grid per QR version so you can pick a configuration before printing.
QR decoders differ a lot; where available, WeChat's is closer to what a phone does than
OpenCV's built-in one, so it is reported separately rather than averaged in.
"""
import json, os, sys
import numpy as np, cv2

os.chdir(os.path.join(os.path.dirname(__file__), '..'))
d = json.load(open('tools/verify_qr_dump.json'))
PAYLOAD, TAG_ID = d['payload'], d['tagId']

qr_det = cv2.QRCodeDetector()
tag_det = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11))

wechat = None
try:
    wechat = cv2.wechat_qrcode.WeChatQRCode()
    print('WeChat QR detector: available')
except Exception as e:
    print(f'WeChat QR detector: unavailable ({type(e).__name__}) — using OpenCV only')

def decode_qr(img):
    try:
        txt, pts, _ = qr_det.detectAndDecode(img)
        if txt == PAYLOAD:
            return True
    except cv2.error:
        pass
    if wechat is not None:
        try:
            res, _ = wechat.detectAndDecode(img)
            if any(r == PAYLOAD for r in res):
                return True
        except cv2.error:
            pass
    return False

def find_tag(img):
    _, ids, _ = tag_det.detectMarkers(img)
    return ids is not None and TAG_ID in ids.flatten().tolist()

rows = []
for c in d['cases']:
    if 'error' in c:
        rows.append({**c, 'qr': False, 'tag': False})
        continue
    img = np.array(c['img'], np.uint8)
    # pad with white: detectors need clean margin beyond the symbol's own quiet zone
    img = np.pad(img, 40, constant_values=255)
    rows.append({**{k: v for k, v in c.items() if k != 'img'},
                 'qr': decode_qr(img), 'tag': find_tag(img)})

ratios = sorted({r['ratioPct'] for r in rows})
versions = sorted({r['requestedVersion'] for r in rows})
print(f'\npayload {PAYLOAD!r}, hidden tag {d["tagDict"]} #{TAG_ID}')
print('cell = QR / TAG   (o = ok, . = fail)\n')
for v in versions:
    sub = [r for r in rows if r['requestedVersion'] == v]
    n = sub[0].get('n', '?')
    ver = sub[0].get('version', '?')
    print(f'QR v{ver} ({n} modules){"  [auto]" if v == 0 else ""}')
    print('        ' + ''.join(f'{p:>8}%' for p in ratios))
    for ecc in ['L', 'M', 'Q', 'H']:
        cells = []
        for p in ratios:
            m = next((r for r in sub if r['ecc'] == ecc and r['ratioPct'] == p), None)
            if m is None:
                cells.append('     -  ')
            elif m.get('error'):          # payload too big for this version+ecc
                cells.append('   n/a  ')
            else:
                cells.append(f'{"o" if m["qr"] else ".":>5} /{"o" if m["tag"] else "."}')
        print(f'  {ecc}   ' + ''.join(cells))
    areas = {p: next((r['areaPct'] for r in sub if r['ratioPct'] == p), None) for p in ratios}
    print('  area% ' + ''.join(f'{areas[p]:>8}' for p in ratios) + '\n')

# ---- headline: largest overlay that keeps both working, per ecc, on the auto version ----
print('Largest tag size where QR still scans AND tag is still found (auto version):')
best = {}
for ecc in ['L', 'M', 'Q', 'H']:
    ok = [r['ratioPct'] for r in rows
          if r['requestedVersion'] == 0 and r['ecc'] == ecc and r['qr'] and r['tag']]
    best[ecc] = max(ok) if ok else None
    print(f'  {ecc}: ' + (f'{best[ecc]}% of QR width' if best[ecc] else 'none of the tested sizes worked'))

# ---- nested stacks ----
print('\nNested stacks (each layer carries the next in its middle):')
os.makedirs('tools/nested_out', exist_ok=True)
for c in d.get('nested', []):
    if c.get('error'):
        print(f'  {c["name"]:26} compose failed — {c["error"]}')
        continue
    img = np.pad(np.array(c['img'], np.uint8), 60, constant_values=255)
    qr_ok = decode_qr(img) if c['hasQr'] else None
    tag_ok = find_tag(img)
    safe = c['name'].replace(' ', '').replace('>', '-')
    cv2.imwrite(f'tools/nested_out/{safe}.png', img)
    qr_txt = 'n/a' if qr_ok is None else ('ok' if qr_ok else 'FAIL')
    print(f'  {c["name"]:26} depth {c["depth"]}  QR {qr_txt:>4}   tag {"ok" if tag_ok else "FAIL"}')
    for n in c['notes']:
        print(f'{"":30}- {n}')

json.dump(rows, open('tools/verify_qr_results.json', 'w'), indent=1)
fails = [r for r in rows if r.get('error')]
print(f'\n{len(rows)} configurations tested, {len(fails)} failed to compose')
sys.exit(0)
