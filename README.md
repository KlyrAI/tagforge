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

Any grid family also has a **visual search** — find a marker that looks like a face, a
checkerboard, an arrow — see below.

All commercially usable: ArUco dictionaries are OpenCV (Apache-2), AprilTag is BSD-2
(AprilRobotics), RuneTag's reference implementation is MIT (github.com/artursg/RUNEtag).
Vendored libraries: jsPDF (MIT), qrcode-generator (MIT), jsQR (Apache-2). The visual
search index is built with OpenCLIP (MIT) using LAION-2B weights; only the resulting
vectors are shipped, not the model.

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

## Finding a marker that looks like something

Some markers happen to resemble real objects. **🔍 Find a marker that looks like…** lets you
go looking for them, either by describing what you want or by sketching it.

**Describe it** runs two scorers and tells you which one answered:

- *Semantic* — CLIP ViT-B-32 vectors, computed offline for every tag in every rotation
  (`tools/embed_tags.py`) and shipped as a 2MB int8 index that loads only when you open
  the search panel. Nothing is downloaded at runtime.
- *Structural* — descriptors computed from the bits in the browser: symmetry, density, run
  lengths, connected components, border bias. Words like `checkerboard`, `dense`,
  `symmetric`, `diagonal`, `hollow`, `scattered` route here, where the answer is exact.

**Sketch it** is a third mode with no model at all: click cells on a grid to set dark,
light or don't-care, and it ranks every tag by agreement across all four rotations. Feeding
a real tag's own pattern back in returns that tag at 100%, which the test suite checks.

### How well does CLIP actually work here?

CLIP was trained on photographs, and a marker is 36 bits upscaled, so this was validated
before being built on (`tools/embed_probe.py`, contact sheets in `tools/probe_out/`).

The signal is real but uneven. `a smiling face`, `a checkerboard` and `a diagonal stripe`
return convincing matches. `a hollow square` and `a staircase` returned a nearly flat score
distribution — the signature of noise — which is why geometric terms are handled
structurally instead.

Two things make the semantic results usable:

- **Rotation matters**, so all four are indexed and the winning one is shown and applied.
- **Hubness is corrected.** Raw cosine is dominated by a handful of tags sitting near the
  centre of the embedding: one tag took 12% of all top-5 slots and the entire vocabulary
  only ever surfaced 100 distinct tags. Each tag is z-scored against its own similarity
  distribution over the vocabulary, which lifts that to 390 distinct tags with the worst
  hub down to 1%. `tools/verify_search.py` asserts this so it cannot regress.

When nothing stands out above a tag's own noise floor the results are labelled **weak
signal** rather than presented as matches. Trust the picture, not the percentage.

The vocabulary is fixed (~170 terms) because the text encoder stays offline. Unrecognised
words are reported, not silently dropped.

### Rebuilding the index

```
python tools/embed_tags.py            # ~20 min on CPU, downloads CLIP weights once
python tools/embed_tags.py --repack   # re-quantise from cached vectors, seconds
python tools/verify_search.py
```

## How small can a tag go?

Detectors care about **camera pixels per module**, not millimetres, so that is the thing
to measure. `tools/verify_limits.py` finds the threshold by rendering each family at
decreasing sizes under random poses (up to 20° rotation, 15° tilt, sub-pixel offset) with
optical blur and sensor noise, requiring 7 of 8 poses to decode.

| family | modules | sharp (σ=0.4) | typical (σ=0.8) | soft (σ=1.5) |
|--------|---------|---------------|-----------------|--------------|
| AprilTag 16h5  | 6 | 2.0 px | 2.5 px | 4.0 px |
| AprilTag 25h9  | 7 | 2.0 px | 3.0 px | 4.0 px |
| AprilTag 36h10 | 8 | 2.5 px | 3.0 px | 5.0 px |
| AprilTag 36h11 | 8 | 2.0 px | **2.5 px** | 4.0 px |
| ArUco 4x4      | 6 | 2.5 px | 3.5 px | 6.5 px |
| ArUco 6x6      | 8 | 2.5 px | 2.5 px | 4.0 px |
| ArUco 7x7      | 9 | 2.0 px | 3.0 px | 4.5 px |

So ~2.5 px per module for 36h11, meaning about **20 px across the black square**. Fewer
data bits does not help much: 16h5 needs the same pixels per module and only wins because
it has fewer modules — at the cost of a far weaker Hamming distance and many more false
positives. 36h11 is the right default.

Converting to print size — black-square width, at typical blur:

| camera | 0.5 m | 1 m | 2 m | 5 m |
|--------|-------|-----|-----|-----|
| phone 1080p, 65° HFOV | 7 mm | 13 mm | 27 mm | 66 mm |
| phone 4K, 65° HFOV | 3 mm | 7 mm | 13 mm | 33 mm |
| tracking cam 720p, 90° HFOV | 16 mm | 31 mm | 62 mm | 156 mm |

Add ~25% for the quiet zone to get a TagForge print size. Run the script with your own
camera's resolution and field of view for numbers that match your setup.

**Concealed tags need much more room**, because the hidden tag is only a third of the QR's
width and the QR itself is the fragile part. A QR-H with a 35% tag needs roughly 180 px
across the whole symbol — about 60 mm at 0.5 m on a 1080p phone, or 120 mm at 1 m. The
hidden tag clears its own threshold at less than half that, so the QR is always what sets
the size.

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
python tools/verify_limits.py                             # minimum detectable size
python tools/verify_search.py                             # visual search index
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
