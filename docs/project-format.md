# The project folder

A GameWorld Painter project is a folder:

```
my-world/
  metadata.json          the map and the list of layers
  layers/<id>.png        raster layers: masks, categories, height (and pictures)
  layers/<id>.json       object and note layers
  edit.lock              optional: present while another program edits the folder
```

Everything is plain PNG and JSON, meant to be read and written by other programs too: a game's import script, a
level generator, an AI agent. This page describes the files; the app writes them in exactly this form.

## Coordinates

The map is a rectangle in meters on the ground plane, seen from above: **x** grows to the east (right), **z** to
the south (down) — north is up. Heights are meters up.

Raster layers cover the rectangle with `cols` × `rows` square cells. Row 0 is the north edge, column 0 the west edge;
pixel `(i, j)` of a layer file is the cell whose center is

```
x = x0 + (i + 0.5) × width / cols
z = z0 + (j + 0.5) × height / rows
```

A file of another size is resized to the grid when it is read (nearest pixel).

## metadata.json

```json
{"version":3,"title":"Demo island","created":"…","world":{"x0":-128,"z0":-128,"width":256,"height":256,"cols":512,"rows":512},"layers":[
{"id":"height","name":"Terrain height","group":"Terrain","type":"height","encoding":{"offset":-20,"step":0.001},"contour":1,"file":"layers/height.png", …},
{"id":"trees","name":"Trees","group":"Greenery","type":"mask","color":"#2c6a2a","opacity":0.8,"file":"layers/trees.png", …}
]}
```

| Field | Meaning |
|-------|---------|
| `version` | 3 |
| `title`, `created` | The name of the map and a free text about where it comes from |
| `world` | The map rectangle: the north-west corner `x0`, `z0`, the size `width` (along x) and `height` (along z) in meters, and the number of cells across (`cols`) and down (`rows`). The cells are square: `width / cols = height / rows`. (An older square form `{x0, z0, size, px}` is read too.) |
| `layers` | The layers, **bottom to top**; the app writes one per line |

A layer entry:

| Field | Layers | Meaning |
|-------|--------|---------|
| `id` | all | Unique, used for the default file name |
| `name`, `group`, `note` | all | The name, the group in the Layers panel, a description |
| `type` | all | `mask`, `category`, `height`, `objects`, `notes` or `image` |
| `file` | all | The file, relative to the folder. Default: `layers/<id>.png` (`.json` for objects and notes) |
| `visible`, `opacity`, `locked` | all | Defaults; each browser keeps its own view settings |
| `color` | mask, objects, notes | The color it is drawn with (for notes: of the notes without their own color) |
| `classes` | category | `[{name, color}]`; index 0 is “none” with color `null` |
| `encoding` | height | `{offset, step}`: meters = offset + value × step |
| `contour` | height | Contour lines every so many meters (0: none) |
| `style` | objects | `marker` (a symbol), `footprint` (the object's rectangle) or `link` (two ends) |
| `marker`, `size` | objects | The symbol — `circle`, `square`, `diamond`, `triangle`, `cross` — and its size in meters |
| `label` | objects | A label template: `{kind}`, `{<field>}` or `{<property>}`, e.g. `{kind} ×{pack_size}` |
| `blend` | image | `normal`, `multiply` (white is see-through) or `screen` (black is see-through) |
| `rect` | image | `{x0, z0, width, height}`: where the picture lies if it does not cover the map |
| `custom` | all | `true` for layers made in the app |

Other fields are kept as they are, so a script can store its own settings on a layer.

## Layer files

| Type | File | Pixel or content |
|------|------|------------------|
| `mask` | 8-bit grayscale PNG | 0–255 = density 0–100 %: where something is and how much of it |
| `category` | Palette (indexed) PNG | The palette index is the class (the position in `classes`); 0 is “none”. The palette colors are only for viewing |
| `height` | 16-bit grayscale PNG | meters = `encoding.offset` + value × `encoding.step` (e.g. −20 + value / 1000: −20 … 45.535 m) |
| `objects` | JSON | `{"items": [ … ]}`, one object per line (a plain array is read too) |
| `notes` | JSON | `{"items": [ … ]}` |
| `image` | PNG, WebP or JPEG | Any picture, stretched over the map (or over `rect`) |

Reading is lenient: masks may be RGB (luminance is used), categories may be RGB (the nearest class color is used),
and fully transparent pixels count as 0 / none. When heights do not fit the encoding, the app widens it on save
(for example −50 + value × 0.002) and updates `metadata.json`.

### Objects

```json
{"items": [
{"id":1,"kind":"tavern","x":-14,"z":14,"yaw":15,"w":12,"d":9,"ox":0,"oz":0,"zone":"village"},
{"id":2,"kind":"wolf","x":-60,"z":-40,"yaw":0,"zone":"woods","props":{"pack_size":3}},
{"id":3,"kind":"shortcut","x":10,"z":5,"yaw":0,"a":[7,5],"b":[13,5]}
]}
```

| Field | Meaning |
|-------|---------|
| `id` | A number, unique in the layer |
| `kind` | What it is: a model, an enemy type, a building type… |
| `x`, `z` | The position in meters |
| `yaw` | Rotation in degrees; positive turns from +x toward −z (counter-clockwise seen from above) |
| `w`, `d`, `ox`, `oz` | Footprints: the size along the object's own x and z, and the offset of the rectangle from the position |
| `a`, `b` | Links: the two ends `[x, z]` |
| `zone` | The zone name: new objects take it from a categories layer with the id `zones` |
| `props` | Anything else: `{"pack_size": 3, …}`; shown with `{pack_size}` in labels |

### Notes

```json
{"items": [
{"id":1,"x":0,"z":25,"text":"Village square: the player starts here.","date":"2026-10-08","color":"#ffd25a"}
]}
```

`text` may have line breaks; `color` is optional.

## Editing the files from another program

The app reads the folder every second and takes what changed:

- a changed layer file replaces the layer, or is merged with unsaved edits made in the app — per cell for rasters
  (the app keeps the cells it changed), per `id` for objects and notes;
- a changed `metadata.json` adds, removes and reorders layers and updates their settings (unsaved settings changed
  in the app win);
- while `edit.lock` exists in the folder, the app does not write anything.

So a program should create `edit.lock` (any content) for a longer edit, write every file whole — best into a
temporary name, then rename it over the old one — and delete `edit.lock` when it is done. A half-written file is
skipped and read again when it changes. To add a layer, add its entry to `metadata.json` and write its file; a layer
without a file starts empty. To delete one, remove its entry and its file.
