"""Cross-check TagForge output against OpenCV, apriltag-imgs, and RuneTag reference files."""
import json, os, sys, urllib.request
import numpy as np
import cv2

os.chdir(os.path.join(os.path.dirname(__file__), '..'))
dump = json.load(open('tools/verify_dump.json'))
fails = []
base_imgs = 'https://raw.githubusercontent.com/AprilRobotics/apriltag-imgs/master/'
W_SIZE = {'april_16h5': 4, 'april_25h9': 5, 'april_36h10': 6, 'april_36h11': 6}
os.makedirs('tools/ref_imgs', exist_ok=True)

def check(name, ok):
    print(('PASS ' if ok else 'FAIL ') + name)
    if not ok:
        fails.append(name)

# ---- 1. ArUco / AprilTag classic bit grids vs cv2 ----
CV_NAMES = {
    '4x4_1000': cv2.aruco.DICT_4X4_1000, '5x5_1000': cv2.aruco.DICT_5X5_1000,
    '6x6_1000': cv2.aruco.DICT_6X6_1000, '7x7_1000': cv2.aruco.DICT_7X7_1000,
    'aruco': cv2.aruco.DICT_ARUCO_ORIGINAL,
    'mip_36h12': getattr(cv2.aruco, 'DICT_ARUCO_MIP_36h12', getattr(cv2.aruco, 'DICT_ARUCO_MIP_36H12', None)),
    'april_16h5': cv2.aruco.DICT_APRILTAG_16h5, 'april_25h9': cv2.aruco.DICT_APRILTAG_25h9,
    'april_36h10': cv2.aruco.DICT_APRILTAG_36h10, 'april_36h11': cv2.aruco.DICT_APRILTAG_36h11,
}
for dict_key, ids in dump['grids'].items():
    cvd = CV_NAMES.get(dict_key)
    if cvd is None:
        print(f'SKIP {dict_key}: not in this cv2 build')
        continue
    d = cv2.aruco.getPredefinedDictionary(cvd)
    n = d.markerSize
    for id_str, bits in ids.items():
        mid = int(id_str)
        img = cv2.aruco.generateImageMarker(d, mid, n + 2)  # 1px per module incl. 1-module border
        inner = (img[1:-1, 1:-1] > 127).astype(int)
        mine = np.array(bits).reshape(n, n)
        if dict_key.startswith('april'):
            # OpenCV stores AprilTag families rotated 180° from AprilRobotics' canonical
            # images; we follow AprilRobotics (checked against apriltag-imgs below).
            check(f'grid {dict_key} #{mid} (cv2, 180°)', np.array_equal(np.rot90(mine, 2), inner))
        else:
            check(f'grid {dict_key} #{mid}', np.array_equal(mine, inner))

# ---- 1b. AprilTag classic vs official apriltag-imgs (canonical orientation) ----
AT2_IMG = {'april_16h5': ('tag16h5', 'tag16_05_%05d.png'), 'april_25h9': ('tag25h9', 'tag25_09_%05d.png'),
           'april_36h10': ('tag36h10', 'tag36_10_%05d.png'), 'april_36h11': ('tag36h11', 'tag36_11_%05d.png')}
for dict_key, (folder, pat) in AT2_IMG.items():
    n = W_SIZE[dict_key]
    for id_str, bits in dump['grids'][dict_key].items():
        mid = int(id_str)
        local = f'tools/ref_imgs/{folder}_{mid}.png'
        if not os.path.exists(local):
            try:
                urllib.request.urlretrieve(base_imgs + f'{folder}/' + pat % mid, local)
            except Exception as e:
                print(f'SKIP {dict_key} #{mid} official img ({e})')
                continue
        ref = cv2.imread(local, cv2.IMREAD_GRAYSCALE)
        inner = (ref[2:2 + n, 2:2 + n] > 127).astype(int)   # strip white quiet + black border
        check(f'official {dict_key} #{mid}', np.array_equal(np.array(bits).reshape(n, n), inner))

# ---- 2. AprilTag 3 rendered pixels vs apriltag-imgs PNGs ----
AT3_IMG = {
    'tagStandard41h12': 'tagStandard41h12/tag41_12_%05d.png',
    'tagCircle49h12': 'tagCircle49h12/tag49_12_%05d.png',
    'tagCustom48h12': 'tagCustom48h12/tag48_12_%05d.png',
}
for fam, pat in AT3_IMG.items():
    for id_str, px in dump['at3'][fam].items():
        mid = int(id_str)
        local = f'tools/ref_imgs/{fam}_{mid}.png'
        if not os.path.exists(local):
            try:
                urllib.request.urlretrieve(base_imgs + pat % mid, local)
            except Exception as e:
                print(f'SKIP {fam} #{mid}: download failed ({e})')
                continue
        ref = cv2.imread(local, cv2.IMREAD_GRAYSCALE)
        mine = np.array(px)
        tw = mine.shape[0]
        if ref.shape[0] != tw:  # some imgs may have extra margin
            print(f'NOTE {fam} ref {ref.shape} vs total_width {tw}')
            off = (ref.shape[0] - tw) // 2
            ref = ref[off:off + tw, off:off + tw]
        refbits = (ref > 127).astype(int)
        check(f'apriltag3 {fam} #{mid}', np.array_equal(refbits, mine))

# ---- 3. RuneTag structural checks (RUNE-129 invariants from coding.cpp) ----
# (RuneTagDrawer's sample tags predate the 2015 cyclic coding — not a valid reference.)
for rid, r in dump['rune'].items():
    if 'error' in r:
        check(f'rune #{rid} generates', False)
        continue
    code, bits = r['code'], r['bits']
    ok = (len(code) == 43 and all(0 <= c <= 6 for c in code)
          and len(bits) == 129
          # every sector holds symbol c+1 in 1..7 -> at least one dot per sector
          and all(any(bits[3 * i + j] for j in range(3)) for i in range(43))
          and 0 <= r['index'] < 117649)
    check(f'rune #{rid} -> canonical #{r["index"]} structure', ok)

# ---- 3b. Boards vs OpenCV, pixel-exact ----
for key, b in dump['charuco'].items():
    mine = np.array(b['img'], np.uint8)
    board = cv2.aruco.CharucoBoard((b['sx'], b['sy']), 32.0, 24.0,
                                   cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_6X6_1000))
    if b['legacy']:
        board.setLegacyPattern(True)
    ref = board.generateImage((b['sx'] * 32, b['sy'] * 32))
    check(f'charuco {b["sx"]}x{b["sy"]} legacy={b["legacy"]}', np.array_equal(ref > 127, mine > 0))

g = dump['gridboard']
mine = np.array(g['img'], np.uint8)
gb = cv2.aruco.GridBoard((g['mx'], g['my']), float(g['markerMm']), float(g['sepMm']),
                         cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_6X6_1000))
ref = gb.generateImage((mine.shape[1], mine.shape[0]))
check('gridboard 4x5', np.array_equal(ref > 127, mine > 0))

# ---- 4. End-to-end: rasterize my ArUco tile bits and detect with cv2 ----
def raster_from_bits(bits, n, scale=20):
    g = np.array(bits).reshape(n, n)
    img = np.zeros((n + 2, n + 2), np.uint8)
    img[1:-1, 1:-1] = (g * 255).astype(np.uint8)
    img = np.pad(img, 2, constant_values=255)   # quiet zone
    return cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)

det = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_6X6_1000))
img = raster_from_bits(dump['grids']['6x6_1000']['23'], 6)
corners, ids, _ = det.detectMarkers(img)
check('detect 6x6_1000 #23', ids is not None and list(ids.flatten()) == [23])

det = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11))
img = raster_from_bits(dump['grids']['april_36h11']['23'], 6)
corners, ids, _ = det.detectMarkers(img)
check('detect april_36h11 #23', ids is not None and list(ids.flatten()) == [23])

print('\n%d failures' % len(fails))
sys.exit(1 if fails else 0)
