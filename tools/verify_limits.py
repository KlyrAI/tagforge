"""How small can a tag be printed and still be detected?

The detector does not care about millimetres, it cares about how many camera pixels land
on one module. This measures that threshold, then converts it into a minimum print size.

The simulated camera matters: a tag rendered axis-aligned on an exact integer pixel grid
decodes at absurdly small sizes, because every module lands dead centre on one pixel.
Real cameras never do that, so each trial gets a random pose (rotation, perspective tilt,
sub-pixel offset) before downsampling, plus optical blur and sensor noise.

Sizes are quoted as the width of the black square (data + border), which is what you
measure on a print. TagForge's "print size" also includes the white quiet zone, so a
TagForge size of S mm gives a black square of S * m/(m+2) for an m-module marker.

Run: python tools/verify_limits.py
"""
import os, sys
import numpy as np, cv2

os.chdir(os.path.join(os.path.dirname(__file__), '..'))

FAMILIES = [
    ('AprilTag 16h5',  cv2.aruco.DICT_APRILTAG_16h5,  4),
    ('AprilTag 25h9',  cv2.aruco.DICT_APRILTAG_25h9,  5),
    ('AprilTag 36h10', cv2.aruco.DICT_APRILTAG_36h10, 6),
    ('AprilTag 36h11', cv2.aruco.DICT_APRILTAG_36h11, 6),
    ('ArUco 4x4',      cv2.aruco.DICT_4X4_1000,       4),
    ('ArUco 6x6',      cv2.aruco.DICT_6X6_1000,       6),
    ('ArUco 7x7',      cv2.aruco.DICT_7X7_1000,       7),
]
IDS = [0, 23]
BLUR = [0.4, 0.8, 1.5]        # gaussian sigma, output pixels: sharp / typical / soft
NOISE = 4.0                   # sensor noise, grey levels
TRIALS = 8                    # random poses per configuration
PASS_RATE = 0.875             # 7 of 8 poses must decode
MAX_TILT = 15.0               # degrees off-axis
MAX_ROT = 20.0                # degrees in-plane
HI = 16                       # supersample: pixels per module before downsampling

def hires(dict_id, marker_id, marker_modules):
    img = cv2.aruco.generateImageMarker(cv2.aruco.getPredefinedDictionary(dict_id),
                                        marker_id, marker_modules * HI)
    return np.pad(img, 3 * HI, constant_values=255)      # generous white surround

def posed(img_hi, marker_modules, ppm, blur_sigma, rng):
    """Warp at high resolution, then downsample so one module covers `ppm` pixels."""
    h, w = img_hi.shape
    cx, cy = w / 2, h / 2
    rot = np.radians(rng.uniform(-MAX_ROT, MAX_ROT))
    tilt_x, tilt_y = np.radians(rng.uniform(-MAX_TILT, MAX_TILT, 2))
    half = marker_modules * HI / 2

    src = np.float32([[cx - half, cy - half], [cx + half, cy - half],
                      [cx + half, cy + half], [cx - half, cy + half]])
    pts = []
    for sx, sy in [(-1, -1), (1, -1), (1, 1), (-1, 1)]:
        x, y = sx * half, sy * half
        # foreshorten the far edges, then rotate in plane
        if sx * np.sin(tilt_y) > 0: x *= np.cos(tilt_y)
        if sy * np.sin(tilt_x) > 0: y *= np.cos(tilt_x)
        pts.append([cx + x * np.cos(rot) - y * np.sin(rot),
                    cy + x * np.sin(rot) + y * np.cos(rot)])
    warped = cv2.warpPerspective(img_hi, cv2.getPerspectiveTransform(src, np.float32(pts)),
                                 (w, h), flags=cv2.INTER_LINEAR, borderValue=255)

    out_w = max(8, int(round(w * ppm / HI)))
    small = cv2.resize(warped, (out_w, out_w), interpolation=cv2.INTER_AREA)
    # sub-pixel shift so the module grid never lands on exact pixel boundaries
    dx, dy = rng.uniform(-0.5, 0.5, 2)
    small = cv2.warpAffine(small, np.float32([[1, 0, dx], [0, 1, dy]]), (out_w, out_w),
                           flags=cv2.INTER_LINEAR, borderValue=255)
    if blur_sigma > 0:
        small = cv2.GaussianBlur(small, (0, 0), blur_sigma)
    return np.clip(small.astype(np.float32) + rng.normal(0, NOISE, small.shape),
                   0, 255).astype(np.uint8)

def rate(dict_id, marker_id, marker_modules, ppm, blur_sigma, seed):
    rng = np.random.default_rng(seed)
    det = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(dict_id))
    img_hi = hires(dict_id, marker_id, marker_modules)
    hits = 0
    for _ in range(TRIALS):
        _, ids, _ = det.detectMarkers(posed(img_hi, marker_modules, ppm, blur_sigma, rng))
        if ids is not None and marker_id in ids.flatten().tolist():
            hits += 1
    return hits / TRIALS

PPM_STEPS = [round(1.0 + 0.5 * i, 1) for i in range(23)]     # 1.0 .. 12.0

print('Minimum camera pixels per module for reliable detection')
print(f'({int(PASS_RATE * TRIALS)} of {TRIALS} random poses must decode; '
      f'tilt to {MAX_TILT:.0f}deg, rotation to {MAX_ROT:.0f}deg)\n')
print(f'{"family":16}{"modules":>9}' + ''.join(f'{"blur s=" + str(b):>12}' for b in BLUR))

results = {}
for name, dict_id, data_modules in FAMILIES:
    marker_modules = data_modules + 2           # data + 1 black border each side
    cells = []
    for b in BLUR:
        thresh = None
        for ppm in PPM_STEPS:
            if all(rate(dict_id, mid, marker_modules, ppm, b,
                        seed=abs(hash((name, mid, b))) % 2**32) >= PASS_RATE for mid in IDS):
                thresh = ppm
                break
        cells.append(thresh)
        results[(name, b)] = thresh
    print(f'{name:16}{marker_modules:>9}' + ''.join(
        (f'{c:>12.1f}' if c is not None else f'{">12":>12}') for c in cells))

# ---- convert to physical size ----
print('\n\nSmallest black-square width that still detects')
print('(add ~25-30% for the white quiet zone to get a TagForge print size)\n')

CAMERAS = [
    ('phone 1080p, 65 deg HFOV', 1920, 65),
    ('phone 4K, 65 deg HFOV',    3840, 65),
    ('tracking cam 720p, 90 deg HFOV', 1280, 90),
]
DISTANCES = [0.5, 1.0, 2.0, 5.0]
BLUR_USED = 0.8

def min_size_mm(marker_modules, ppm, width_px, hfov_deg, dist_m):
    view_mm = 2000.0 * dist_m * np.tan(np.radians(hfov_deg) / 2)
    return marker_modules * ppm * (view_mm / width_px)

for cam, wpx, hfov in CAMERAS:
    print(f'{cam}  (blur s={BLUR_USED})')
    print(f'{"family":16}' + ''.join(f'{str(d) + " m":>12}' for d in DISTANCES))
    for name, dict_id, data_modules in FAMILIES:
        ppm = results[(name, BLUR_USED)]
        if ppm is None:
            print(f'{name:16}' + f'{"n/a":>12}' * len(DISTANCES))
            continue
        print(f'{name:16}' + ''.join(
            f'{min_size_mm(data_modules + 2, ppm, wpx, hfov, d):>11.0f}mm' for d in DISTANCES))
    print()

# ---- concealed tags: the QR sets the size, the hidden tag rides along ----
import json
DUMP = 'tools/verify_qr_dump.json'
if os.path.exists(DUMP):
    d = json.load(open(DUMP))
    PAYLOAD, TAG_ID = d['payload'], d['tagId']
    qr_det = cv2.QRCodeDetector()
    tag_det = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11))

    def try_at(img_hi, out_w, blur_sigma, seed, want):
        """Downsample a clean composite to out_w px, posed, and see what still reads."""
        rng = np.random.default_rng(seed)
        hits = 0
        for _ in range(TRIALS):
            small = cv2.resize(img_hi, (out_w, out_w), interpolation=cv2.INTER_AREA)
            dx, dy = rng.uniform(-0.5, 0.5, 2)
            small = cv2.warpAffine(small, np.float32([[1, 0, dx], [0, 1, dy]]),
                                   (out_w, out_w), flags=cv2.INTER_LINEAR, borderValue=255)
            if blur_sigma > 0:
                small = cv2.GaussianBlur(small, (0, 0), blur_sigma)
            small = np.clip(small.astype(np.float32) + rng.normal(0, NOISE, small.shape),
                            0, 255).astype(np.uint8)
            small = np.pad(small, out_w // 4, constant_values=255)
            if want == 'qr':
                try:
                    txt, _, _ = qr_det.detectAndDecode(small)
                    ok = (txt == PAYLOAD)
                except cv2.error:
                    ok = False
            else:
                _, ids, _ = tag_det.detectMarkers(small)
                ok = ids is not None and TAG_ID in ids.flatten().tolist()
            hits += bool(ok)
        return hits / TRIALS

    print('\nConcealed tags: how big must the whole QR be?')
    print('(minimum width of the printed QR, including its quiet zone, blur s=0.8)\n')
    print(f'{"stack":22}{"QR decodes":>14}{"tag detects":>14}{"both":>10}')
    conceal = {}
    for c in d.get('nested', []):
        if c.get('error') or not c['hasQr'] or c['depth'] != 2:
            continue
        img_hi = np.array(c['img'], np.uint8)
        px = {}
        for want in ('qr', 'tag'):
            found = None
            for out_w in range(40, 561, 10):
                if try_at(img_hi, out_w, 0.8, seed=abs(hash((c['name'], want))) % 2**32,
                          want=want) >= PASS_RATE:
                    found = out_w
                    break
            px[want] = found
        conceal[c['name']] = px
        both = max(v for v in px.values() if v) if all(px.values()) else None
        fmt = lambda v: f'{v}px' if v else '>560px'
        print(f'{c["name"]:22}{fmt(px["qr"]):>14}{fmt(px["tag"]):>14}{fmt(both):>10}')

    print('\nAs a printed size, for the same cameras (width of the whole QR):\n')
    for cam, wpx, hfov in CAMERAS:
        view = lambda dist: 2000.0 * dist * np.tan(np.radians(hfov) / 2) / wpx   # mm per px
        print(f'{cam}')
        print(f'{"stack":22}' + ''.join(f'{str(x) + " m":>12}' for x in DISTANCES))
        for name, px in conceal.items():
            if not all(px.values()):
                print(f'{name:22}' + f'{"n/a":>12}' * len(DISTANCES))
                continue
            need = max(px.values())
            print(f'{name:22}' + ''.join(f'{need * view(x):>11.0f}mm' for x in DISTANCES))
        print()

print('These are floors under favourable conditions: even lighting, a still camera, matte')
print('paper. Motion blur, glare, steep angles and ink bleed all push the real minimum up.')
print('Print a size sweep and confirm on your own hardware before committing.')
sys.exit(0)
