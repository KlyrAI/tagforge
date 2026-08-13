"""One-shot converter: dict_raw.json -> data/aruco_dicts.js, tag*.c -> data/apriltag3.js

Source files are downloaded on demand, so they don't have to live in the repo.
"""
import json, re, os, urllib.request

os.chdir(os.path.join(os.path.dirname(__file__), '..'))

SOURCES = {
    'data/dict_raw.json': 'https://raw.githubusercontent.com/okalachev/arucogen/master/dict.json',
    'tools/tagStandard41h12.c': 'https://raw.githubusercontent.com/AprilRobotics/apriltag/master/tagStandard41h12.c',
    'tools/tagCircle49h12.c': 'https://raw.githubusercontent.com/AprilRobotics/apriltag/master/tagCircle49h12.c',
    'tools/tagCustom48h12.c': 'https://raw.githubusercontent.com/AprilRobotics/apriltag/master/tagCustom48h12.c',
}
for dest, url in SOURCES.items():
    if not os.path.exists(dest):
        print(f'fetching {dest}')
        urllib.request.urlretrieve(url, dest)

# ---- ArUco / AprilTag classic dicts (from arucogen dict.json, MIT; data Apache-2 OpenCV) ----
raw = json.load(open('data/dict_raw.json'))
META = {
    '4x4_1000':  {'w': 4, 'h': 4, 'label': 'ArUco 4x4 (1000)'},
    '5x5_1000':  {'w': 5, 'h': 5, 'label': 'ArUco 5x5 (1000)'},
    '6x6_1000':  {'w': 6, 'h': 6, 'label': 'ArUco 6x6 (1000)'},
    '7x7_1000':  {'w': 7, 'h': 7, 'label': 'ArUco 7x7 (1000)'},
    'aruco':     {'w': 5, 'h': 5, 'label': 'ArUco Original (1024)'},
    'mip_36h12': {'w': 6, 'h': 6, 'label': 'ArUco MIP_36h12 (250)'},
    'april_16h5':  {'w': 4, 'h': 4, 'label': 'AprilTag 16h5 (30)'},
    'april_25h9':  {'w': 5, 'h': 5, 'label': 'AprilTag 25h9 (35)'},
    'april_36h10': {'w': 6, 'h': 6, 'label': 'AprilTag 36h10 (2320)'},
    'april_36h11': {'w': 6, 'h': 6, 'label': 'AprilTag 36h11 (587)'},
}
out = {}
for k, m in META.items():
    out[k] = {'width': m['w'], 'height': m['h'], 'label': m['label'], 'markers': raw[k]}
with open('data/aruco_dicts.js', 'w') as f:
    f.write('// ArUco + AprilTag classic dictionaries. Data: OpenCV (Apache-2) via arucogen (MIT).\n')
    f.write('window.ARUCO_DICTS = ' + json.dumps(out, separators=(',', ':')) + ';\n')
print('aruco_dicts.js:', os.path.getsize('data/aruco_dicts.js'), 'bytes')

# ---- AprilTag 3 families ----
CAP = 1000
fams = {}
for name in ['tagStandard41h12', 'tagCircle49h12', 'tagCustom48h12']:
    src = open(f'tools/{name}.c').read()
    def field(fname):
        return int(re.search(rf'tf->{fname}\s*=\s*(\w+)', src).group(1).replace('true', '1').replace('false', '0'))
    nbits = field('nbits')
    bx = [0] * nbits
    by = [0] * nbits
    for axis, arr in (('bit_x', bx), ('bit_y', by)):
        for m in re.finditer(rf'tf->{axis}\[(\d+)\]\s*=\s*(-?\d+)', src):
            arr[int(m.group(1))] = int(m.group(2))
    codes = re.findall(r'0x([0-9a-fA-F]+)UL', src)
    total = len(codes)
    codes = codes[:CAP]
    fams[name] = {
        'nbits': nbits, 'h': field('h'), 'ncodes': field('ncodes'), 'embedded': len(codes),
        'width_at_border': field('width_at_border'), 'total_width': field('total_width'),
        'reversed_border': field('reversed_border'),
        'bit_x': bx, 'bit_y': by, 'codes': codes,  # hex strings, BigInt at runtime
    }
    print(name, 'nbits', nbits, 'codes', total, '-> embedded', len(codes))
with open('data/apriltag3.js', 'w') as f:
    f.write('// AprilTag 3 families (BSD-2, AprilRobotics). Codes capped at %d IDs each.\n' % CAP)
    f.write('window.APRILTAG3 = ' + json.dumps(fams, separators=(',', ':')) + ';\n')
print('apriltag3.js:', os.path.getsize('data/apriltag3.js'), 'bytes')
