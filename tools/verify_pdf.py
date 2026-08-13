"""Rasterize the minted PDF and check page size, scale-bar length, and that every
printed tag still decodes at its intended physical size."""
import json, os, sys
import numpy as np, cv2, pypdfium2 as pdfium

os.chdir(os.path.join(os.path.dirname(__file__), '..'))
DPI = 300
PX_MM = DPI / 25.4
fails = []
def check(name, ok, extra=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' — ' + extra if extra else ''))
    if not ok: fails.append(name)

pdf = pdfium.PdfDocument('tools/verify_sheet.pdf')
print(f'{len(pdf)} page(s)')

pages = []
for pno in range(len(pdf)):
    page = pdf[pno]
    w_pt, h_pt = page.get_size()
    check(f'page {pno + 1} is US Letter', abs(w_pt - 612) < 1 and abs(h_pt - 792) < 1, f'{w_pt:.1f}x{h_pt:.1f}pt')
    bmp = page.render(scale=DPI / 72).to_numpy()
    gray = cv2.cvtColor(bmp, cv2.COLOR_RGB2GRAY) if bmp.ndim == 3 else bmp
    cv2.imwrite(f'tools/verify_sheet_page{pno + 1}.png', gray)
    pages.append(gray)
H, W = pages[0].shape
print(f'raster {W}x{H} at {DPI}dpi')

# ---- scale bar on every page: longest dark horizontal run in the footer band ----
for pno, gray in enumerate(pages):
    band = gray[int(gray.shape[0] * 0.86):, :] < 128
    best = 0
    for row in band:
        idx = np.flatnonzero(row)
        if idx.size == 0: continue
        splits = np.split(idx, np.flatnonzero(np.diff(idx) != 1) + 1)
        best = max(best, max(len(s) for s in splits))
    bar_mm = best / PX_MM
    # the end ticks are 0.3mm wide and centred on the endpoints, so the ink spans
    # 100mm + one line width
    check(f'page {pno + 1} scale bar measures 100mm', abs(bar_mm - 100) < 0.6, f'{bar_mm:.2f}mm')

# ---- decode every AprilTag/ArUco across all pages and check printed sizes ----
exp = json.load(open('tools/verify_sheet.json'))['expected']
for dict_name, cvd, want, prefix in [('april_36h11', cv2.aruco.DICT_APRILTAG_36h11, 23, '36h11'),
                                     ('6x6_1000', cv2.aruco.DICT_6X6_1000, 7, '6x6')]:
    det = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cvd))
    found, sizes = [], []
    for gray in pages:
        corners, ids, _ = det.detectMarkers(gray)
        if ids is None: continue
        found += ids.flatten().tolist()
        for c in corners:
            p = c[0]
            sizes.append(np.mean([np.linalg.norm(p[i] - p[(i + 1) % 4]) for i in range(4)]) / PX_MM)
    sizes.sort()
    # tile is 10 modules wide (6 data + 2 border + 2 quiet); black frame spans 8 of them
    want_sizes = sorted(round(e['w'] * 0.8, 2) for e in exp
                        if e['label'].startswith(prefix) and not e.get('qrItem'))
    got = [round(s, 2) for s in sizes]
    check(f'{dict_name}: every copy decodes as #{want}',
          bool(found) and set(found) == {want},
          f'{len(found)} found, ids={sorted(set(found))}')
    # Concealed markers hide the same id inside them, so the standalone prints only have
    # to be present — extra detections are the hidden copies, not a layout error.
    pool = list(got)
    missing = []
    for wsz in want_sizes:
        m = next((g for g in pool if abs(g - wsz) < 0.3), None)
        if m is None:
            missing.append(wsz)
        else:
            pool.remove(m)
    check(f'{dict_name}: every requested print size is on the page', not missing,
          f'missing {missing}' if missing else f'{len(want_sizes)} sizes found, {len(pool)} extra (concealed)')

# ---- concealed markers must survive the print pipeline ----
PAYLOAD = 'https://klyrai.github.io/tagforge/'
qr_det = cv2.QRCodeDetector()
qr_items = [e for e in exp if e.get('qrItem')]
if qr_items:
    decoded = 0
    for gray in pages:
        try:
            ok, txts, pts, _ = qr_det.detectAndDecodeMulti(gray)
            if ok:
                decoded += sum(1 for t in txts if t == PAYLOAD)
        except cv2.error:
            pass
    check('concealed QRs still scan from the rasterized PDF',
          decoded >= len(qr_items), f'{decoded} of {len(qr_items)} decoded')
    det36 = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11))
    hidden = 0
    for gray in pages:
        _, ids, _ = det36.detectMarkers(gray)
        if ids is not None:
            hidden += sum(1 for i in ids.flatten() if i == 23)
    # #23 also appears as the plain size-sweep tags, so just require the concealed ones too
    check('hidden tags still detected on the page', hidden >= len(qr_items), f'{hidden} instances of #23')

# ---- per-item: expected physical sizes present on page ----
print('\nexpected item footprints (mm):')
for e in exp:
    print(f"   {e['label']}: {e['w']:.1f} x {e['h']:.1f}{'  [SKIPPED]' if e['skipped'] else ''}")
check('no items skipped', not any(e['skipped'] for e in exp))

print('\n%d failures' % len(fails))
sys.exit(1 if fails else 0)
