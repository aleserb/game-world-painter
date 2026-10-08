"""Builds examples/demo-island: a small GameWorld Painter project to try the tool with.

    python3 examples/make_demo.py      (Python 3, numpy, Pillow)

An island of 256 x 256 m (cells of 0.5 m): terrain height with hills and a mountain, a lake, ground types, zones,
water, roads, bushes, trees, a village of buildings, enemies, chests and notes. The files follow
docs/project-format.md; the random seed is fixed, so the output is the same every time.
"""
import json
import os
import shutil

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'demo-island')
X0, Z0, SIZE, CELL = -128.0, -128.0, 256.0, 0.5
N = int(SIZE / CELL)
rng = np.random.default_rng(7)

c = X0 + (np.arange(N) + 0.5) * CELL
X, Z = np.meshgrid(c, c)  # X east, Z south; row 0 is the north edge


def noise(scale, octaves=4):
    """Fractal value noise in 0..1: random grids, smoothly resized and added."""
    out, amp, total = np.zeros((N, N)), 1.0, 0.0
    for o in range(octaves):
        cells = max(2, int(SIZE / scale * 2 ** o))
        grid = Image.fromarray((rng.random((cells, cells)) * 255).astype(np.uint8))
        out += np.asarray(grid.resize((N, N), Image.BICUBIC), dtype=np.float64) / 255 * amp
        total += amp
        amp *= 0.5
    return out / total


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def to_px(x, z):
    return ((x - X0) / CELL, (z - Z0) / CELL)


# --- terrain height (m)
r = np.hypot(X, Z * 1.08) / 112 + (noise(48) - 0.5) * 0.35
land = 1 - smooth(0.72, 1.0, r)
hills = noise(40, 5)
mountain = np.exp(-((X - 55) ** 2 + (Z + 50) ** 2) / (2 * 26 ** 2))
lake = np.exp(-((X + 55) ** 2 + (Z - 5) ** 2) / (2 * 14 ** 2))
height = -7 + land * (8.5 + hills * 9 + mountain * 30) - lake * 9 * land
village = np.exp(-((X - 0) ** 2 + (Z - 25) ** 2) / (2 * 22 ** 2))
height = height * (1 - village * 0.7) + village * 0.7 * 3.0  # flat ground for the village
water = height < 0

# --- roads (drawn as lines, a bit soft)
roads_img = Image.new('L', (N, N), 0)
d = ImageDraw.Draw(roads_img)
paths = [
    [(0, 25), (5, 0), (20, -25), (40, -40)],          # village -> mountain
    [(0, 25), (-25, 15), (-40, 8)],                   # village -> lake
    [(0, 25), (30, 40), (60, 48), (88, 52)],          # village -> east beach
    [(0, 25), (-8, 55), (-12, 85)],                   # village -> south coast
]
for p in paths:
    d.line([to_px(x, z) for x, z in p], fill=255, width=int(3.5 / CELL), joint='curve')
roads = np.asarray(roads_img.filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float64) / 255
roads = np.where(water, 0, roads)

# flatten the ground a little under the roads
height = height - roads * 0.15

# --- ground types: 1 sand, 2 grass, 3 dirt, 4 rock
gy, gx = np.gradient(height, CELL)
slope = np.hypot(gx, gy)
ground = np.full((N, N), 2, np.uint8)
ground[(height < 1.3) & ~water] = 1
ground[roads > 0.35] = 3
ground[(slope > 0.9) | (height > 19)] = 4
ground[water] = 0

# --- zones: 1 village, 2 woods, 3 mountains, 4 coast
zones = np.zeros((N, N), np.uint8)
zones[~water] = 2
zones[(mountain > 0.35) & ~water] = 3
zones[(height < 2.2) & ~water & (zones == 2)] = 4
zones[(np.hypot(X, Z - 25) < 30) & ~water] = 1

# --- vegetation
forest = noise(30, 4)
free = (~water) & (roads < 0.15) & (np.hypot(X, Z - 25) > 26) & (height < 18)
trees = np.clip((forest - 0.45) * 5, 0, 1) * free * (1 - smooth(1.0, 2.5, slope))
bushes = np.clip((noise(14, 3) - 0.55) * 4, 0, 1) * free * (trees < 0.4)

# --- objects
houses = [(-14, 14, 15), (-2, 10, -5), (12, 14, 20), (-16, 30, 80), (16, 32, 95), (-6, 42, 10), (8, 44, -12), (24, 22, 40)]
buildings = [{'id': k + 1, 'kind': 'house' if k else 'tavern', 'x': x, 'z': z, 'yaw': yaw, 'w': 8 if k else 12, 'd': 6 if k else 9,
              'ox': 0, 'oz': 0, 'zone': 'village'} for k, (x, z, yaw) in enumerate(houses)]
buildings.append({'id': 9, 'kind': 'watchtower', 'x': 42, 'z': -40, 'yaw': 0, 'w': 4, 'd': 4, 'ox': 0, 'oz': 0, 'zone': 'mountains'})
buildings.append({'id': 10, 'kind': 'pier', 'x': 92, 'z': 54, 'yaw': 70, 'w': 3, 'd': 14, 'ox': 0, 'oz': 0, 'zone': 'coast'})
enemies = []
for k, (kind, x, z, n, zone) in enumerate([
        ('wolf', -60, -40, 3, 'woods'), ('wolf', -30, -70, 4, 'woods'), ('boar', -80, 30, 2, 'woods'),
        ('bandit', 50, -30, 3, 'mountains'), ('bandit', 62, -58, 2, 'mountains'), ('crab', 40, 75, 4, 'coast'),
        ('crab', -70, 70, 3, 'coast'), ('boar', 30, -5, 2, 'woods')]):
    enemies.append({'id': k + 1, 'kind': kind, 'x': x, 'z': z, 'yaw': 0, 'zone': zone, 'props': {'pack_size': n}})
chests = [{'id': k + 1, 'kind': kind, 'x': x, 'z': z, 'yaw': 0, 'zone': zone} for k, (kind, x, z, zone) in enumerate([
    ('wooden_chest', -50, -55, 'woods'), ('iron_chest', 58, -46, 'mountains'), ('wooden_chest', -60, 18, 'woods'), ('treasure', 70, 60, 'coast')])]
notes = [
    {'id': 1, 'x': 0, 'z': 25, 'text': 'Village square: the player starts here.', 'date': '2026-10-08'},
    {'id': 2, 'x': 52, 'z': -44, 'text': 'Bandit camp. A second way up the mountain?', 'date': '2026-10-08', 'color': '#ff9eb0'},
    {'id': 3, 'x': -55, 'z': 5, 'text': 'Lake: fishing spot and a hidden cave under the cliff', 'date': '2026-10-08', 'color': '#8fd0ff'},
]


# --- files
def js(v):
    return json.dumps(v, ensure_ascii=False, separators=(',', ':'))


def mask_png(a, path):
    Image.fromarray((np.clip(a, 0, 1) * 255).round().astype(np.uint8)).save(path, optimize=True)


def category_png(a, classes, path):
    im = Image.fromarray(a.astype(np.uint8))  # mode L, made a palette image below
    pal = []
    for cl in classes:
        h = (cl['color'] or '#000000').lstrip('#')
        pal += [int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)]
    im.putpalette(pal + [0] * (768 - len(pal)))
    im.save(path, transparency=0, optimize=True)


def objects_json(items, path):
    with open(path, 'w') as f:
        f.write('{"items": [\n' + ',\n'.join(js(it) for it in items) + '\n]}\n')


if os.path.exists(OUT):
    shutil.rmtree(OUT)
os.makedirs(os.path.join(OUT, 'layers'))
L = lambda p: os.path.join(OUT, 'layers', p)  # noqa: E731

encoding = {'offset': -20, 'step': 0.001}
Image.fromarray(np.clip((height - encoding['offset']) / encoding['step'], 0, 65535).round().astype(np.uint16)).save(L('height.png'))
ground_classes = [{'name': 'none', 'color': None}, {'name': 'sand', 'color': '#d8c48a'}, {'name': 'grass', 'color': '#6f9a45'},
                  {'name': 'dirt', 'color': '#8a6a45'}, {'name': 'rock', 'color': '#7a7672'}]
zone_classes = [{'name': 'none', 'color': None}, {'name': 'village', 'color': '#e0a050'}, {'name': 'woods', 'color': '#4f9a4a'},
                {'name': 'mountains', 'color': '#9a8a7a'}, {'name': 'coast', 'color': '#4a8ad0'}]
category_png(ground, ground_classes, L('ground.png'))
category_png(zones, zone_classes, L('zones.png'))
mask_png(water * 1.0, L('water.png'))
mask_png(roads, L('roads.png'))
mask_png(bushes, L('bushes.png'))
mask_png(trees, L('trees.png'))
objects_json(buildings, L('buildings.json'))
objects_json(chests, L('chests.json'))
objects_json(enemies, L('enemies.json'))
objects_json(notes, L('notes.json'))


def layer(id, name, group, type, **kw):
    e = {'id': id, 'name': name, 'group': group, 'type': type, 'visible': True, 'opacity': 1, 'locked': False}
    e.update(kw)
    e['file'] = 'layers/%s.%s' % (id, 'json' if type in ('objects', 'notes') else 'png')
    return e


layers = [
    layer('height', 'Terrain height', 'Terrain', 'height', encoding=encoding, contour=1, note='Meters above the sea.'),
    layer('ground', 'Ground', 'Terrain', 'category', opacity=0.85, classes=ground_classes, note='The ground texture.'),
    layer('zones', 'Zones', 'Terrain', 'category', visible=False, opacity=0.35, classes=zone_classes,
          note='Areas of the world; new objects take the zone under them.'),
    layer('water', 'Water', 'Terrain', 'mask', color='#3d7fb5', opacity=0.6),
    layer('roads', 'Roads & paths', 'Terrain', 'mask', color='#c8a46a', opacity=0.8),
    layer('bushes', 'Bushes', 'Greenery', 'mask', color='#5fa63c', opacity=0.75),
    layer('trees', 'Trees', 'Greenery', 'mask', color='#2c6a2a', opacity=0.8, note='Tree crowns: density 0-100 %.'),
    layer('buildings', 'Buildings', 'Structures', 'objects', color='#e07a4a', style='footprint', label='{kind}'),
    layer('chests', 'Chests', 'Gameplay', 'objects', color='#ffc83c', style='marker', marker='square', size=2, label='{kind}'),
    layer('enemies', 'Enemies', 'Gameplay', 'objects', color='#ff4a4a', style='marker', marker='circle', size=2.4,
          label='{kind} ×{pack_size}', note='kind = the enemy type, pack_size = how many are in the pack.'),
    layer('notes', 'Notes', 'Notes', 'notes', color='#ffd25a', note='Notes pinned to the map (Note tool, N).'),
]
head = {'version': 3, 'title': 'Demo island', 'created': 'examples/make_demo.py',
        'world': {'x0': X0, 'z0': Z0, 'width': SIZE, 'height': SIZE, 'cols': N, 'rows': N}}
with open(os.path.join(OUT, 'metadata.json'), 'w') as f:
    f.write(js(head)[:-1] + ',"layers":[\n' + ',\n'.join(js(e) for e in layers) + '\n]}\n')
print('wrote', OUT, 'height %.1f .. %.1f m' % (height.min(), height.max()))
