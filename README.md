# TagForge

Fiducial marker generator for print. Preview tags in the browser, queue them into a
sheet, mint a vector PDF for the print shop. Built for size-sweep testing: print one
tag at a ladder of physical sizes and find the smallest your camera reliably detects.

Open `index.html` in a browser. No build step, no server, no network — double-click it.

## Families

| Family | Dictionaries | Notes |
|---|---|---|
| ArUco | 4x4/5x5/6x6/7x7 (1000 each), ARUCO_ORIGINAL, MIP_36h12 | matches OpenCV exactly |
| AprilTag v2 | 16h5, 25h9, 36h10, 36h11 | matches AprilRobotics' canonical orientation |
| AprilTag 3 | tagStandard41h12, tagCircle49h12, tagCustom48h12 | first 1000 ids of each embedded |
| RuneTag | RUNE-129 | GF(7) cyclic code, 43 sectors x 3 rings |
| ChArUco board | any ArUco dict | matches `cv2.aruco.CharucoBoard`, incl. legacy pattern |
| ArUco grid board | any ArUco dict | matches `cv2.aruco.GridBoard` |
| Nested / concealed | QR + RuneTag + any grid tag | markers hidden inside other markers — see below |

All commercially usable: ArUco dictionaries are OpenCV (Apache-2), AprilTag is BSD-2
(AprilRobotics), RuneTag's reference implementation is MIT (github.com/artursg/RUNEtag).
Vendored libraries: jsPDF (MIT), qrcode-generator (MIT), jsQR (Apache-2).

## Size sweep

The point of the tool. Pick a family and id, enter a size ladder (default
`15, 20, 30, 40, 60, 80, 100` mm), hit **Add sweep to sheet**. Each print is labeled
with its physical size *and* its module size, so a detection-range test maps straight
back to a minimum print size. The preview warns when modules drop under 5mm.

## Nested / concealed markers

Markers can be stacked so each one carries the next in its middle — an AprilTag hidden
inside a QR code, or a RuneTag holding a QR holding an AprilTag. Build the stack outer-to-
inner in the left panel; the preview shows a live **"QR still decodes ✓/✗"** badge.

Two kinds of host:

- **QR code** — the overlay destroys the modules beneath it, and the symbol's Reed-Solomon
  error correction has to absorb that as damage. That's the budget you're spending.
- **RuneTag** — its dot rings leave the centre empty, so it hosts about 36% of its width
  for free, with no loss of anything.

Grid tags (ArUco / AprilTag) are data edge to edge, so they can only ever be innermost.

### How much can you hide in a QR?

Measured with `tools/verify_qr.py` (OpenCV's decoder, payload `https://klyrai.github.io/tagforge/`,
tag `36h11 #23`, auto version). "Tag width" is the overlay as a percentage of the QR's width:

| ECC | nominal recovery | largest tag that still scanned |
|-----|-----------------|-------------------------------|
| L   | ~7%             | none of the sizes tested (20%+) |
| M   | ~15%            | 25% of QR width |
| Q   | ~25%            | 30% of QR width |
| H   | ~30%            | 40% of QR width |

**Use H.** The hidden tag is found reliably at every size tested — the QR is always the
side that fails first, so the overlay percentage is the only real dial.

Two caveats worth taking seriously. The nominal recovery percentages are a ceiling, not a
promise: a solid block in the middle is harder on a decoder than scattered damage, and
large overlays destroy alignment patterns. And OpenCV's decoder is not a phone — real
scanners vary a lot, some more tolerant, some less. Print the robustness matrix and scan
it with the actual devices you care about before settling on a configuration.

**Add matrix to sheet** queues every ECC level against a list of tag sizes, so one printed
page answers the question for your own hardware.

## Print files

**Mint PDF** produces a vector PDF: true black fills, crop marks, per-tag labels, and a
100mm calibration scale bar on every page. Tags are shelf-packed tallest-first to waste
less paper.

**Tell the print shop: 100% scale / actual size, no "fit to page."** Then check the
printed scale bar with a ruler before trusting any measurement.

Per-tag **SVG** (mm-dimensioned) and **PNG** (600 dpi) exports are also available.

## Notes on ids

- **AprilTag v2**: OpenCV stores these rotated 180° from AprilRobotics' published
  images. TagForge follows AprilRobotics. Either decodes to the same id.
- **RuneTag**: only about 1 raw index in 40 is a valid RUNE-129 codeword, so the field is
  a **tag number**, not a raw code — tag 1, 2, 3 are consecutive distinct tags. The label
  shows the actual code number a detector reports (tag 1 = code 24).
- **AprilTag 3**: 1000 ids per family are embedded (tagCircle49h12 has 65535 total; the
  full table is over a megabyte of tags nobody prints). Raise `CAP` in
  `tools/convert.py` and re-run if you need more.

## Layout

```
index.html            UI
js/render.js          family renderers -> abstract shape list
js/runetag.js         RUNE-129 coding + dot layout
js/svg.js             shapes -> SVG / PNG
js/pdf.js             shapes -> jsPDF sheets
js/app.js             UI state, preview, cart
data/*.js             dictionaries (generated)
vendor/jspdf.umd.min.js
```

Renderers emit one geometry description that both the SVG and PDF writers consume, so
the preview and the print file can't drift apart.

## Regenerating data

`python tools/convert.py` rebuilds `data/aruco_dicts.js` and `data/apriltag3.js` from
`data/dict_raw.json` (arucogen, MIT) and `tools/tag*.c` (AprilRobotics, BSD-2).

## Verification

Requires `opencv-python`, `numpy`, `pypdfium2`, and Node.

```
node tools/verify.mjs     && python tools/verify.py       # bit-level correctness
node tools/verify_qr.mjs  && python tools/verify_qr.py    # QR concealment robustness
node tools/verify_pdf.mjs && python tools/verify_pdf.py   # print geometry
node tools/verify_ui.mjs                                  # browser smoke test (needs playwright)
```

What the suites establish:

- Every ArUco/AprilTag grid matches `cv2.aruco.generateImageMarker` bit for bit, and the
  AprilTag families also match AprilRobotics' own `apriltag-imgs` PNGs.
- AprilTag 3 renders match `apriltag-imgs` pixel for pixel.
- ChArUco (modern and legacy, across board parities) and grid boards match OpenCV's
  generated images pixel for pixel.
- Minted PDFs: correct page size, 100mm scale bar, and every tag re-detects with the
  right id at the right physical size after rasterizing the PDF at 300 dpi. Concealed
  markers are decoded off that same raster — both the QR payload and the hidden tag — so
  the concealment is proven through the actual print path, not just in the abstract.
- Nested stacks (including RuneTag > QR > AprilTag) compose and decode; renders land in
  `tools/nested_out/`.
- RuneTag is checked structurally (valid GF(7) codeword, 129 slots, one dot minimum per
  sector) and its id enumeration mirrors the reference `codegen.cpp`. There is no
  RuneTag detector in Python, so it is **not** verified end-to-end by detection — print
  one and confirm with your detector before committing to a large run.
