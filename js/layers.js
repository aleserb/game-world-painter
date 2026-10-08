// Layers of a GameWorld Painter project. Every layer shows one kind of thing on the map seen from above; see README.md.
//   image     a picture stretched over the whole map (the render of the game map, a sketch)
//   mask      0..255 per cell: where something is and how dense (trees, grass...)
//   category  a class index per cell (ground texture, zones, custom classes)
//   height    meters per cell (terrain)
//   objects   a list of placed things with position, rotation, footprint and properties
//   notes     text notes pinned to the map
// Every layer is a file of the project folder (README.md): masks are 8-bit grayscale PNGs, categories 8-bit palette
// PNGs (index = class), heights 16-bit grayscale PNGs (meters = offset + value * step), objects and notes JSON,
// pictures as they are. A layer keeps "base", its content as it is on the disk, to merge changes made there by others (an AI agent).
(function (ME) {
  'use strict';

const TYPE_NAMES = { mask: 'Mask', category: 'Categories', height: 'Height', objects: 'Objects', notes: 'Notes', image: 'Picture' };

/** The map rectangle: {x0, z0 (the north-west corner, m), width, height (m), cols, rows (cells)}; the cells are square.
 *  Old projects had a square {x0, z0, size, px}. */
function normWorld(w) {
  if (w.width != null) {
    const cols = w.cols | 0, cell = w.width / cols;
    return { x0: +w.x0, z0: +w.z0, width: +w.width, height: +(w.height ?? w.width), cols, rows: (w.rows ?? Math.round((w.height ?? w.width) / cell)) | 0 };
  }
  return { x0: +w.x0, z0: +w.z0, width: +w.size, height: +w.size, cols: w.px | 0, rows: w.px | 0 };
}

/** A rectangle in meters {x0, z0, width, height} (old: {x0, z0, size}). */
function normRect(r) { return { x0: +r.x0, z0: +r.z0, width: +(r.width ?? r.size), height: +(r.height ?? r.size) }; }

function hexToRgb(hex) {
  let h = (hex || '#888888').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

class Layer {
  constructor(meta, project) {
    this.meta = meta;
    this.project = project;
    this.version = 0; // goes up on every change
    this.savedVersion = 0; // the version on the disk
    this.base = null; // the content as it is on the disk (snapshot())
  }

  /** Changed since it was read or written. Setting it to true counts a change; to false marks the layer saved. */
  get dirty() { return this.version !== this.savedVersion; }
  set dirty(v) {
    if (v) {
      this.version++;
      if (ME.onLayerChange) ME.onLayerChange(this);
    } else {
      this.savedVersion = this.version;
    }
  }

  get id() { return this.meta.id; }
  get type() { return this.meta.type; }
  get raster() { return false; }
  /** A list of items (objects, notes) rather than a picture. */
  get hasItems() { return false; }
  /** The file of the layer, relative to the project folder. */
  get file() { return this.meta.file || this.defaultFile(); }
  defaultFile() { return `layers/${this.id}.png`; }
  /** Content of a file (bytes) -> content object (does not change the layer). */
  async parse() { return null; }
  /** Use content (from parse() or snapshot()). */
  apply() {}
  /** A copy of the current content. */
  snapshot() { return null; }
  /** The file bytes (or text) of the current content. */
  async fileData() { return null; }
  /** Three-way merge: keep the local changes (current vs base), take the disk changes (disk vs base) elsewhere.
   *  Returns the number of conflicts (changed on both sides differently; the local version is kept). */
  merge() { return 0; }
  /** A property of the layer meta changed (color, classes...). */
  metaChanged() {}
  describe() { return ''; }
}

class ImageLayer extends Layer {
  defaultFile() { return `layers/${this.id}.${ME.extOf(this.mime || 'image/png')}`; }

  async parse(bytes, name) {
    const mime = ME.mimeOf(name || this.file);
    return { bytes, mime, img: await createImageBitmap(new Blob([bytes], { type: mime })) };
  }

  apply(c) {
    if (!c) return;
    this.bytes = c.bytes;
    this.mime = c.mime;
    this.img = c.img;
  }

  snapshot() { return this.bytes ? { bytes: this.bytes, mime: this.mime, img: this.img } : null; }

  async setPicture(file) {
    this.img = await createImageBitmap(file);
    this.bytes = new Uint8Array(await file.arrayBuffer());
    this.mime = file.type || 'image/png';
    this.meta.file = `layers/${this.id}.${ME.extOf(this.mime)}`;
    this.dirty = true;
  }

  async fileData() { return this.bytes || null; }

  merge(base, disk) {
    this.apply(disk); // a picture cannot be merged: the disk wins unless the picture was replaced here
    return 0;
  }

  draw(ctx, view) {
    if (!this.img) return;
    const w = this.meta.rect ? normRect(this.meta.rect) : this.project.world; // rect: where it lies when the map was resized
    view.setWorldTransform(ctx);
    ctx.imageSmoothingEnabled = true;
    // multiply: white paper disappears, only the drawing shows; screen: black disappears
    ctx.globalCompositeOperation = { multiply: 'multiply', screen: 'screen' }[this.meta.blend] || 'source-over';
    ctx.drawImage(this.img, w.x0, w.z0, w.width, w.height);
    ctx.globalCompositeOperation = 'source-over';
  }
}

class RasterLayer extends Layer {
  constructor(meta, project) {
    super(meta, project);
    this.cols = project.cols; // cells across (x), the row length of data
    this.rows = project.rows; // cells down (z)
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.cols;
    this.canvas.height = this.rows;
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(this.cols, this.rows);
  }

  get raster() { return true; }

  async parse(bytes) { return ME.pngChannel(await ME.decodePNG(bytes), 'gray', this.cols, this.rows); }

  apply(c) {
    if (c) this.data.set(c);
    this.refresh();
  }

  snapshot() { return this.data.slice(); }

  async fileData() { return ME.encodePNG(this.cols, this.rows, 1, this.data); }

  same(a, b) { return a === b; }

  merge(base, disk) {
    const d = this.data;
    let conflicts = 0;
    for (let i = 0; i < d.length; i++) {
      if (this.same(d[i], base[i])) d[i] = disk[i];
      else if (!this.same(disk[i], base[i]) && !this.same(disk[i], d[i])) conflicts++;
    }
    this.refresh();
    return conflicts;
  }

  /** Redraw the display canvas in the cell rectangle [x0, x1) x [y0, y1). */
  refresh(x0 = 0, y0 = 0, x1 = this.cols, y1 = this.rows) {
    x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
    x1 = Math.min(this.cols, Math.ceil(x1)); y1 = Math.min(this.rows, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) return;
    this.paint(x0, y0, x1, y1);
    this.ctx.putImageData(this.img, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }

  draw(ctx, view) {
    view.setCellTransform(ctx);
    ctx.imageSmoothingEnabled = this.smooth(view);
    ctx.drawImage(this.canvas, 0, 0);
  }

  smooth() { return true; }
}

class MaskLayer extends RasterLayer {
  constructor(meta, project) {
    super(meta, project);
    this.data = new Uint8Array(this.cols * this.rows);
    this.rgb = hexToRgb(meta.color);
  }

  metaChanged() {
    this.rgb = hexToRgb(this.meta.color);
    this.refresh();
  }

  paint(x0, y0, x1, y1) {
    const N = this.cols, d = this.img.data, v = this.data, [r, g, b] = this.rgb;
    for (let y = y0; y < y1; y++) {
      for (let x = x0, i = y * N + x0; x < x1; x++, i++) {
        const o = i * 4;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = v[i];
      }
    }
  }

  describe(i) { return Math.round(this.data[i] / 2.55) + '%'; }
}

class CategoryLayer extends RasterLayer {
  constructor(meta, project) {
    super(meta, project);
    this.data = new Uint8Array(this.cols * this.rows);
    if (!meta.classes) meta.classes = [{ name: 'none', color: null }];
    this.metaChanged(false);
  }

  metaChanged(refresh = true) {
    this.palette = this.meta.classes.map(c => (c.color ? [...hexToRgb(c.color), 255] : [0, 0, 0, 0]));
    if (refresh) this.refresh();
  }

  paint(x0, y0, x1, y1) {
    const N = this.cols, d = this.img.data, v = this.data, pal = this.palette, none = [0, 0, 0, 0];
    for (let y = y0; y < y1; y++) {
      for (let x = x0, i = y * N + x0; x < x1; x++, i++) {
        const c = pal[v[i]] || none, o = i * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3];
      }
    }
  }

  smooth(view) { return view.cellPx() < 1; }

  describe(i) { const c = this.meta.classes[this.data[i]]; return c ? c.name : '#' + this.data[i]; }

  async parse(bytes) {
    return ME.pngChannel(await ME.decodePNG(bytes), 'index', this.cols, this.rows, this.meta.classes.map(c => (c.color ? hexToRgb(c.color) : null)));
  }

  /** An indexed PNG: the index is the class, the palette has the class colors (class 0 is transparent). */
  async fileData() {
    let max = 0;
    for (const v of this.data) if (v > max) max = v;
    const palette = [];
    for (let k = 0; k <= Math.max(max, this.meta.classes.length - 1); k++) {
      const c = this.meta.classes[k];
      palette.push(c && c.color ? [...hexToRgb(c.color), 255] : k === 0 ? [0, 0, 0, 0] : [128, 128, 128, 255]);
    }
    return ME.encodePNG(this.cols, this.rows, 1, this.data, { palette });
  }
}

// height colors (meters; heights in other units are divided by their k first): hollows, lowland greens, hills, cliffs, peaks
const HEIGHT_STOPS = [
  [-14, [46, 52, 40]], [-4, [74, 92, 60]], [0, [104, 140, 84]], [2, [128, 158, 92]],
  [6, [172, 168, 104]], [12, [168, 136, 92]], [20, [140, 118, 102]], [30, [196, 188, 180]], [45, [246, 246, 246]],
];

function heightColor(h) {
  const s = HEIGHT_STOPS;
  if (h <= s[0][0]) return s[0][1];
  for (let k = 1; k < s.length; k++) {
    if (h <= s[k][0]) {
      const t = (h - s[k - 1][0]) / (s[k][0] - s[k - 1][0]), a = s[k - 1][1], b = s[k][1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
  }
  return s[s.length - 1][1];
}

class HeightLayer extends RasterLayer {
  constructor(meta, project) {
    super(meta, project);
    this.data = new Float32Array(this.cols * this.rows);
    // 16-bit PNG value v -> offset + v * step: in meters -20 .. 45.5 m in millimeters (scaled for other units)
    const k = project.k || 1;
    if (!meta.encoding) meta.encoding = { offset: -20 * k, step: ME.nice(0.001 * k) };
    if (meta.contour == null) meta.contour = ME.nice(k);
  }

  meters(v) { const e = this.meta.encoding; return Math.fround(e.offset + v * e.step); }

  value(h) { const e = this.meta.encoding; return Math.max(0, Math.min(65535, Math.round((h - e.offset) / e.step))); }

  async parse(bytes) {
    const png = await ME.decodePNG(bytes);
    const v = ME.pngChannel(png, 'u16', this.cols, this.rows);
    const out = new Float32Array(v.length);
    if (png.colorType === 2 && this.meta.range) { // old format: 8-bit RGB, R high byte, G low byte, between range
      const [lo, hi] = this.meta.range;
      for (let i = 0; i < v.length; i++) out[i] = lo + v[i] / 65535 * (hi - lo);
    } else {
      for (let i = 0; i < v.length; i++) out[i] = this.meters(v[i]);
    }
    return out;
  }

  same(a, b) { return Math.abs(a - b) < 1e-4; }

  metaChanged() { this.refresh(); }

  refresh(x0 = 0, y0 = 0, x1 = this.cols, y1 = this.rows) {
    super.refresh(x0 - 1, y0 - 1, x1 + 1, y1 + 1); // shading and contours depend on the neighbors
  }

  paint(x0, y0, x1, y1) {
    const N = this.cols, R = this.rows, d = this.img.data, h = this.data, c = +this.meta.contour || 0;
    const k = 1 / (2 * this.project.world.width / N), perM = 1 / (this.project.k || 1);
    const L = [-0.48, 0.75, -0.45], ll = Math.hypot(...L);
    for (let y = y0; y < y1; y++) {
      for (let x = x0, i = y * N + x0; x < x1; x++, i++) {
        const v = h[i];
        const xr = h[x < N - 1 ? i + 1 : i], xl = h[x > 0 ? i - 1 : i];
        const yd = h[y < R - 1 ? i + N : i], yu = h[y > 0 ? i - N : i];
        const gx = (xr - xl) * k, gz = (yd - yu) * k;
        const lambert = (-gx * L[0] + L[1] - gz * L[2]) / (Math.hypot(gx, 1, gz) * ll);
        let shade = 0.42 + 0.72 * Math.max(lambert, 0);
        if (c > 0) {
          // a line where a contour passes between this cell and the next; on steep slopes (more than one
          // contour per cell) only every 5th, so cliffs do not turn into solid stripes
          const steep = Math.max(Math.abs(xr - v), Math.abs(yd - v)) > c * 0.6;
          const step = steep ? c * 5 : c;
          if (Math.floor(v / step) !== Math.floor(xr / step) || Math.floor(v / step) !== Math.floor(yd / step)) {
            const major = Math.floor(v / (c * 5)) !== Math.floor(xr / (c * 5)) || Math.floor(v / (c * 5)) !== Math.floor(yd / (c * 5));
            shade *= major ? 0.5 : 0.72;
          }
        }
        const col = heightColor(v * perM), o = i * 4;
        d[o] = col[0] * shade; d[o + 1] = col[1] * shade; d[o + 2] = col[2] * shade; d[o + 3] = 255;
      }
    }
  }

  describe(i) { const u = ME.unitOf(this.project.unit); return this.data[i].toFixed(ME.unitDigits(u, 2)) + ' ' + u.label; }

  /** Widen the encoding when the heights do not fit in it (a coarser step for a bigger range). */
  fitEncoding() {
    let lo = Infinity, hi = -Infinity;
    for (const v of this.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const e = this.meta.encoding, k = this.project.k || 1, ten = 10 * k;
    if (lo >= e.offset && hi <= e.offset + 65535 * e.step) return;
    const offset = Math.min(e.offset, Math.floor(lo / ten) * ten - ten);
    let step = ME.stepAtLeast(0.001 * k); // 1 mm in meters, then 2, 5, 10 mm... until the heights fit
    while (offset + 65535 * step < hi + 5 * k) step = ME.stepAtLeast(step * 1.001);
    this.meta.encoding = { offset, step };
    if (ME.onMetaChange) ME.onMetaChange(this);
  }

  /** 16-bit grayscale; the heights are rounded to the step here too, so the base matches the file exactly. */
  async fileData() {
    delete this.meta.range;
    this.fitEncoding();
    const v = new Uint16Array(this.data.length);
    for (let i = 0; i < v.length; i++) { v[i] = this.value(this.data[i]); this.data[i] = this.meters(v[i]); }
    return ME.encodePNG(this.cols, this.rows, 1, v, { depth: 16 });
  }

}

// ------------------------------------------------------------------------------------------------ objects

/** World corners of an item's footprint (Godot yaw: local +X turns toward -Z for positive yaw). k: units per meter,
 *  for the size of an item without one (1 m). */
function footprintCorners(it, k = 1) {
  const a = (it.yaw || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const w = Math.max(it.w || k, 0.1 * k) / 2, d = Math.max(it.d || k, 0.1 * k) / 2, ox = it.ox || 0, oz = it.oz || 0;
  return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([lx, lz]) => {
    lx += ox; lz += oz;
    return [it.x + lx * c + lz * s, it.z - lx * s + lz * c];
  });
}

function localOf(it, x, z) {
  const a = (it.yaw || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), dx = x - it.x, dz = z - it.z;
  return [dx * c - dz * s - (it.ox || 0), dx * s + dz * c - (it.oz || 0)];
}

function label(template, it) {
  return (template || '').replace(/\{(\w+)\}/g, (_, k) => {
    const v = it[k] ?? it.props?.[k];
    return v == null ? '' : String(v);
  }).trim();
}

function segDist(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2)) : 0;
  return Math.hypot(px - a[0] - dx * t, pz - a[1] - dz * t);
}

class ObjectLayer extends Layer {
  constructor(meta, project) {
    super(meta, project);
    this.items = [];
    if (meta.type === 'objects') {
      if (!meta.style) meta.style = 'marker';
      if (!meta.marker) meta.marker = 'circle';
      if (!meta.size) meta.size = 2 * (project.k || 1);
    }
  }

  get hasItems() { return true; }

  defaultFile() { return `layers/${this.id}.json`; }

  async parse(bytes) {
    const j = JSON.parse(new TextDecoder().decode(bytes));
    const items = Array.isArray(j) ? j : j.items;
    if (!Array.isArray(items)) throw new Error('no "items" list');
    return items;
  }

  apply(items) { this.items = items ? structuredClone(items) : []; }

  snapshot() { return structuredClone(this.items); }

  /** One object per line, so file diffs and other tools see single objects. */
  async fileData() {
    return '{"items": [\n' + this.items.map(it => JSON.stringify(it)).join(',\n') + '\n]}\n';
  }

  /** Merge by id: local edits, additions and deletions win; disk edits, additions and deletions are taken. */
  merge(base, disk) {
    const key = it => JSON.stringify(it);
    const B = new Map(base.map(i => [i.id, i])), D = new Map(disk.map(i => [i.id, i])), L = new Map(this.items.map(i => [i.id, i]));
    const out = [], clash = [];
    let conflicts = 0;
    for (const d of disk) {
      const b = B.get(d.id), l = L.get(d.id);
      if (!b) { out.push(d); if (l) clash.push(l); continue; } // new on the disk (a local new one with the same id is renumbered)
      if (!l) { if (key(d) !== key(b)) conflicts++; continue; } // deleted here
      if (key(l) !== key(b)) { if (key(d) !== key(b) && key(d) !== key(l)) conflicts++; out.push(l); } else out.push(d);
    }
    for (const l of this.items) {
      const b = B.get(l.id);
      if (!b && !D.has(l.id)) out.push(l); // added here
      else if (b && !D.has(l.id) && key(l) !== key(b)) { out.push(l); conflicts++; } // deleted there, changed here
    }
    let next = out.reduce((m, i) => Math.max(m, i.id || 0), 0) + 1;
    for (const l of clash) out.push({ ...l, id: next++ });
    this.items = out;
    return conflicts;
  }

  nextId() { return this.items.reduce((m, it) => Math.max(m, it.id || 0), 0) + 1; }

  kinds() {
    const n = {};
    for (const it of this.items) n[it.kind] = (n[it.kind] || 0) + 1;
    return Object.keys(n).sort((a, b) => n[b] - n[a]);
  }

  markerRadius(view) { return Math.max(this.meta.size / 2 * view.scale, 4); }

  draw(ctx, view, selected) {
    const m = this.meta, color = m.color || '#ffffff';
    view.setScreenTransform(ctx);
    const showLabels = m.label && view.scale >= 7 && !view.texture;
    ctx.lineJoin = 'round';
    for (const it of this.items) {
      const sel = selected && selected.has(it.id);
      if (m.style === 'footprint') {
        const pts = footprintCorners(it, this.project.k).map(([x, z]) => view.toScreen(x, z));
        ctx.beginPath();
        pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fillStyle = rgba(color, 0.42);
        ctx.fill();
        ctx.lineWidth = sel ? 2.5 : 1.2;
        ctx.strokeStyle = sel ? '#ffffff' : color;
        ctx.stroke();
      } else if (m.style === 'link' && it.a && it.b) {
        const [ax, ay] = view.toScreen(it.a[0], it.a[1]), [bx, by] = view.toScreen(it.b[0], it.b[1]);
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = sel ? 2.5 : 1.8;
        ctx.strokeStyle = sel ? '#ffffff' : color;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.setLineDash([]);
        const r = this.markerRadius(view) * 0.7;
        for (const [x, y, t] of [[ax, ay, 'A'], [bx, by, 'B']]) {
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = color; ctx.fill();
          ctx.lineWidth = sel ? 2.5 : 1.2; ctx.strokeStyle = sel ? '#ffffff' : '#1a1520'; ctx.stroke();
          if (r >= 6) {
            ctx.fillStyle = '#1a1520'; ctx.font = `bold ${Math.round(r * 1.1)}px system-ui`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, x, y + 0.5);
          }
        }
      } else {
        const [x, y] = view.toScreen(it.x, it.z);
        drawMarker(ctx, m.marker, x, y, this.markerRadius(view), color, sel, it.yaw);
      }
      if (showLabels) {
        const text = label(m.label, it);
        if (text) {
          const [x, y] = m.style === 'link' && it.a ? view.toScreen((it.a[0] + it.b[0]) / 2, (it.a[1] + it.b[1]) / 2)
            : view.toScreen(it.x, it.z);
          const r = m.style === 'footprint' ? 0 : this.markerRadius(view);
          ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(16,13,20,0.85)';
          ctx.strokeText(text, x, y + r + 2);
          ctx.fillStyle = '#f2ecf8'; ctx.fillText(text, x, y + r + 2);
        }
      }
    }
  }

  /** The topmost item under the world point, or null. tol: in the unit of the map. */
  hit(x, z, view) {
    const tol = 4 / view.scale;
    for (let k = this.items.length - 1; k >= 0; k--) {
      const it = this.items[k];
      if (this.meta.style === 'footprint') {
        const [lx, lz] = localOf(it, x, z);
        const k = this.project.k || 1;
        if (Math.abs(lx) <= Math.max(it.w || k, 0.1 * k) / 2 + tol && Math.abs(lz) <= Math.max(it.d || k, 0.1 * k) / 2 + tol) return it;
      } else if (this.meta.style === 'link' && it.a && it.b) {
        const r = this.markerRadius(view) * 0.7 / view.scale + tol;
        if (Math.hypot(x - it.a[0], z - it.a[1]) <= r || Math.hypot(x - it.b[0], z - it.b[1]) <= r) return it;
        if (segDist(x, z, it.a, it.b) <= tol) return it;
      } else if (Math.hypot(x - it.x, z - it.z) <= this.markerRadius(view) / view.scale + tol) {
        return it;
      }
    }
    return null;
  }

  describe() { return `${this.items.length} objects`; }
}

// ------------------------------------------------------------------------------------------------ notes

const NOTE_WIDTH = 220; // screen px of the text
const NOTE_LINES = 6; // lines shown unless the note is selected

/** Lines of text wrapped to maxWidth px (ctx.font set). */
function wrapText(ctx, text, maxWidth) {
  const out = [], fits = t => ctx.measureText(t).width <= maxWidth;
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + ' ' + word : word;
      if (fits(next)) { line = next; continue; }
      if (line) out.push(line);
      line = word;
      while (!fits(line) && line.length > 1) { // a word longer than the line
        let k = line.length - 1;
        while (k > 1 && !fits(line.slice(0, k))) k--;
        out.push(line.slice(0, k));
        line = line.slice(k);
      }
    }
    out.push(line);
  }
  return out;
}

function inkFor(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#1a1520' : '#f7f2fb';
}

/** Text notes pinned to the map: items {id, x, z, text, color?, date?}. The text box keeps its screen size. */
class NoteLayer extends ObjectLayer {
  constructor(meta, project) {
    super(meta, project);
    if (!meta.color) meta.color = '#ffd25a';
    this.boxes = new Map(); // id -> the text box on the screen at the last draw
  }

  kinds() { return []; }

  colorOf(it) { return it.color || this.meta.color || '#ffd25a'; }

  draw(ctx, view, selected) {
    view.setScreenTransform(ctx);
    this.boxes = new Map();
    ctx.font = '12px system-ui';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (const it of this.items) {
      const sel = selected && selected.has(it.id), color = this.colorOf(it);
      const [px, py] = view.toScreen(it.x, it.z);
      let lines = wrapText(ctx, (it.text || '').trim() || '…', NOTE_WIDTH);
      if (!sel && lines.length > NOTE_LINES) lines = [...lines.slice(0, NOTE_LINES - 1), lines[NOTE_LINES - 1] + ' …'];
      const lh = 15, padX = 7, padY = 5;
      const w = Math.ceil(Math.max(...lines.map(l => ctx.measureText(l).width), 10)) + padX * 2, h = lines.length * lh + padY * 2;
      const bx = px + 9, by = py - 9 - h;
      ctx.strokeStyle = 'rgba(20,16,26,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(bx + 4, by + h); ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(bx, by, w, h, 5);
      ctx.fillStyle = rgba(color, 0.94);
      ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
      ctx.fill();
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.lineWidth = sel ? 2.5 : 1;
      ctx.strokeStyle = sel ? '#ffffff' : 'rgba(20,16,26,0.7)';
      ctx.stroke();
      ctx.fillStyle = inkFor(color);
      lines.forEach((l, k) => ctx.fillText(l, bx + padX, by + padY + k * lh + 1));
      ctx.beginPath(); ctx.arc(px, py, sel ? 5.5 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.lineWidth = sel ? 2.5 : 1.5; ctx.strokeStyle = sel ? '#ffffff' : '#1a1520'; ctx.stroke();
      this.boxes.set(it.id, [bx, by, bx + w, by + h]);
    }
  }

  hit(x, z, view) {
    const [sx, sy] = view.toScreen(x, z);
    for (let k = this.items.length - 1; k >= 0; k--) {
      const it = this.items[k], b = this.boxes.get(it.id), [px, py] = view.toScreen(it.x, it.z);
      if (Math.hypot(sx - px, sy - py) <= 8) return it;
      if (b && sx >= b[0] && sx <= b[2] && sy >= b[1] && sy <= b[3]) return it;
    }
    return null;
  }

  describe() { return `${this.items.length} notes`; }
}

function drawMarker(ctx, shape, x, y, r, color, selected, yaw) {
  ctx.beginPath();
  if (shape === 'square') {
    ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
  } else if (shape === 'diamond') {
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
  } else if (shape === 'triangle') {
    ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.9, y + r * 0.7); ctx.lineTo(x - r * 0.9, y + r * 0.7); ctx.closePath();
  } else if (shape === 'cross') {
    const t = r * 0.35;
    ctx.moveTo(x - t, y - r); ctx.lineTo(x + t, y - r); ctx.lineTo(x + t, y - t); ctx.lineTo(x + r, y - t);
    ctx.lineTo(x + r, y + t); ctx.lineTo(x + t, y + t); ctx.lineTo(x + t, y + r); ctx.lineTo(x - t, y + r);
    ctx.lineTo(x - t, y + t); ctx.lineTo(x - r, y + t); ctx.lineTo(x - r, y - t); ctx.lineTo(x - t, y - t);
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = selected ? 2.5 : 1.2;
  ctx.strokeStyle = selected ? '#ffffff' : 'rgba(20,16,26,0.9)';
  ctx.stroke();
  if (selected && yaw != null && r >= 5) { // facing: local +Z
    const a = yaw * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(a) * r * 1.6, y + Math.cos(a) * r * 1.6);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
  }
}

function makeLayer(meta, project) {
  switch (meta.type) {
    case 'image': return new ImageLayer(meta, project);
    case 'mask': return new MaskLayer(meta, project);
    case 'category': return new CategoryLayer(meta, project);
    case 'height': return new HeightLayer(meta, project);
    case 'objects': return new ObjectLayer(meta, project);
    case 'notes': return new NoteLayer(meta, project);
    default: throw new Error('unknown layer type: ' + meta.type);
  }
}

Object.assign(ME, { TYPE_NAMES, normWorld, normRect, hexToRgb, rgba, footprintCorners, localOf, label, drawMarker, makeLayer });
})(window.ME = window.ME || {});
