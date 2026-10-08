// The tools the AI agent calls through the MCP server (mcp/, the names and argument schemas are in mcp/lib/tools.mjs).
// They run here, on the open map: regions are evaluated to masks over the cells, analyses work on the layers, and
// every change is one undo step labeled "AI: …" that the user sees at once.
(function (ME) {
'use strict';

const A = () => ME.app;
class ToolError extends Error {}
const fail = msg => { throw new ToolError(msg); };
const r2 = v => +(+v).toFixed(2);
const num = (v, name) => { if (typeof v !== 'number' || !isFinite(v)) fail(`${name} must be a number`); return v; };
const pt = (v, name) => { if (!Array.isArray(v) || v.length < 2) fail(`${name} must be [x, z]`); return [num(v[0], name), num(v[1], name)]; };

// ------------------------------------------------------------------------------------------------ the map

function G() {
  const { S } = A();
  if (!S.project) fail('No map is open in GameWorld Painter. Ask the user to open a project folder (Open Folder) or make one (New Map).');
  const w = S.project.world, c = w.width / w.cols;
  return { S, w, N: w.cols, R: w.rows, c, unit: ME.unitOf(S.project.unit), k: ME.unitOf(S.project.unit).k };
}
const cellX = (g, i) => g.w.x0 + (i + 0.5) * g.c;
const cellZ = (g, j) => g.w.z0 + (j + 0.5) * g.c;
const cellOf = (g, x, z) => { const i = Math.floor((x - g.w.x0) / g.c), j = Math.floor((z - g.w.z0) / g.c); return i >= 0 && j >= 0 && i < g.N && j < g.R ? j * g.N + i : -1; };
const metersIn = (g, m) => m * g.k; // a default given in meters, in the unit of the map
const fmtU = (g, v, d = 1) => +(+v).toFixed(Math.max(0, d - Math.round(Math.log10(g.k))));

function layerOf(id, types, what = 'layer') {
  const { S } = G();
  if (typeof id !== 'string' || !id) fail(`Give the ${what} id`);
  const L = S.layers.find(l => l.id === id) || S.layers.find(l => l.meta.name.toLowerCase() === id.toLowerCase());
  if (!L) fail(`No layer "${id}". Layers: ${S.layers.map(l => `${l.id} (${l.type})`).join(', ')}`);
  if (types && !types.includes(L.type)) fail(`"${L.id}" is a ${L.type} layer; this needs ${types.join(' or ')}`);
  return L;
}

function editable(L) {
  if (L.meta.locked) fail(`The layer "${L.meta.name}" is locked by the user: ask them to unlock it`);
}

const itemLayers = () => G().S.layers.filter(l => l.hasItems);
const heightLayer = (id, need = false) => {
  const { S } = G();
  const H = id ? layerOf(id, ['height']) : S.layers.find(l => l.type === 'height' && l.meta.visible) || S.layers.find(l => l.type === 'height');
  if (!H && need) fail('The map has no height layer');
  return H || null;
};
function zonesLayer() {
  const { S } = G();
  const cats = S.layers.filter(l => l.type === 'category');
  return cats.find(l => l.id === 'zones') || cats.find(l => /zone/i.test(l.meta.name) || /zone/i.test(l.id)) || null;
}
function classIndex(L, name) {
  if (typeof name === 'number') return name;
  const k = L.meta.classes.findIndex(c => c.name.toLowerCase() === String(name).toLowerCase());
  if (k < 0) fail(`"${L.meta.name}" has no class "${name}". Classes: ${L.meta.classes.map(c => c.name).join(', ')}`);
  return k;
}

// ------------------------------------------------------------------------------------------------ cell masks

/** A canvas over the cells (one pixel per cell) to draw shapes into; read() gives the cells it covers. */
function cellCanvas(g) {
  const cv = document.createElement('canvas');
  cv.width = g.N; cv.height = g.R;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1 / g.c, 0, 0, 1 / g.c, -g.w.x0 / g.c, -g.w.z0 / g.c); // world -> cells
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.lineJoin = ctx.lineCap = 'round';
  return {
    ctx,
    read(min = 100) {
      const px = ctx.getImageData(0, 0, g.N, g.R).data, m = new Uint8Array(g.N * g.R);
      for (let i = 0; i < m.length; i++) if (px[i * 4 + 3] >= min) m[i] = 1;
      return m;
    },
  };
}

/** The shapes of items drawn into a cell mask: footprints, markers, links, notes; paths as wide ribbons, closed ones filled. */
function itemsMask(g, L, items = L.items) {
  const { ctx, read } = cellCanvas(g), min = g.c * 0.75;
  for (const it of items) {
    if (it.points) {
      if (it.points.length < 2) continue;
      const s = L.samples(it);
      if (it.closed && s.length > 2) { ctx.beginPath(); s.forEach(([x, z], k) => (k ? ctx.lineTo(x, z) : ctx.moveTo(x, z))); ctx.closePath(); ctx.fill(); }
      ctx.fill(ME.ribbonPath(s, false, min));
    } else if (L.meta.style === 'footprint') {
      const p = ME.footprintCorners(it, g.k);
      ctx.beginPath(); p.forEach(([x, z], k) => (k ? ctx.lineTo(x, z) : ctx.moveTo(x, z))); ctx.closePath(); ctx.fill();
      ctx.lineWidth = min; ctx.stroke();
    } else if (L.meta.style === 'link' && it.a && it.b) {
      ctx.lineWidth = min; ctx.beginPath(); ctx.moveTo(it.a[0], it.a[1]); ctx.lineTo(it.b[0], it.b[1]); ctx.stroke();
    } else if (typeof it.x === 'number') {
      ctx.beginPath(); ctx.arc(it.x, it.z, Math.max((L.meta.size || 0) / 2, min / 2), 0, Math.PI * 2); ctx.fill();
    }
  }
  return read();
}

/** Where a layer has something: a mask at least min %, a categories class (or any), the shapes of its items. */
function presence(g, L, { min = 50, max = 100, cls = null } = {}) {
  const m = new Uint8Array(g.N * g.R), d = L.data;
  if (L.type === 'mask') {
    const a = min * 2.55 - 0.5, b = max * 2.55 + 0.5;
    for (let i = 0; i < m.length; i++) if (d[i] >= a && d[i] <= b) m[i] = 1;
  } else if (L.type === 'category') {
    const set = cls == null ? null : new Set((Array.isArray(cls) ? cls : [cls]).map(c => classIndex(L, c)));
    for (let i = 0; i < m.length; i++) if (set ? set.has(d[i]) : d[i]) m[i] = 1;
  } else if (L.type === 'height') m.fill(1);
  else if (L.hasItems) return itemsMask(g, L);
  else fail(`"${L.meta.name}" is a picture: it has no cells to use`);
  return m;
}

/** Exact Euclidean distance (in cells) from every cell to the nearest set cell of src (Felzenszwalb & Huttenlocher). */
function distanceField(g, src) {
  const { N, R } = g, INF = 1e20, n = Math.max(N, R);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const out = new Float64Array(N * R);
  const pass = len => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < R; y++) f[y] = src[y * N + x] ? 0 : INF;
    pass(R);
    for (let y = 0; y < R; y++) out[y * N + x] = d[y];
  }
  const res = new Float32Array(N * R);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < N; x++) f[x] = out[y * N + x];
    pass(N);
    for (let x = 0; x < N; x++) res[y * N + x] = Math.sqrt(d[x]);
  }
  return res;
}

const any = m => m.some(v => v);
function bounds(g, m) {
  let x0 = g.N, y0 = g.R, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < g.R; y++) for (let x = 0, i = y * g.N; x < g.N; x++, i++) {
    if (!m[i]) continue;
    count++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return count ? { x0, y0, x1: x1 + 1, y1: y1 + 1, count } : { x0: 0, y0: 0, x1: 0, y1: 0, count: 0 };
}
const worldBox = (g, b) => [r2(g.w.x0 + b.x0 * g.c), r2(g.w.z0 + b.y0 * g.c), r2(g.w.x0 + b.x1 * g.c), r2(g.w.z0 + b.y1 * g.c)];

// ------------------------------------------------------------------------------------------------ regions

const AREAS = ['map', 'selection', 'view'];

/** A region (see REGION_DOC in mcp/lib/tools.mjs) -> a 0/1 mask over the cells. */
function regionMask(spec, g = G(), depth = 0) {
  if (depth > 12) fail('The region is nested too deep');
  if (spec == null) spec = { area: 'map' };
  if (typeof spec === 'string') spec = AREAS.includes(spec) ? { area: spec } : { zone: spec };
  if (typeof spec !== 'object' || Array.isArray(spec)) fail('A region is an object such as {"zone":"village"} or {"area":"selection"}');
  const m = new Uint8Array(g.N * g.R);
  const shape = draw => { const cc = cellCanvas(g); draw(cc.ctx); return cc.read(); };
  if (spec.area) {
    if (spec.area === 'map') m.fill(1);
    else if (spec.area === 'selection') {
      const { S } = g;
      if (S.area) m.set(S.area.mask);
      else if (S.sel.layer && S.sel.ids.size) return itemsMask(g, S.sel.layer, S.sel.layer.items.filter(i => S.sel.ids.has(i.id)));
      else fail('The user has not selected an area or items in the app. Ask them to select one (Select area tool, L), or use another region');
    } else if (spec.area === 'view') {
      const v = A().view, [x0, z0] = v.toWorld(0, 0), [x1, z1] = v.toWorld(v.w, v.h);
      return shape(ctx => ctx.fillRect(x0, z0, x1 - x0, z1 - z0));
    } else fail(`"area" is one of ${AREAS.join(', ')}`);
    return m;
  }
  if (spec.rect) { const [x0, z0, x1, z1] = spec.rect.map(v => num(v, 'rect')); return shape(ctx => ctx.fillRect(Math.min(x0, x1), Math.min(z0, z1), Math.abs(x1 - x0), Math.abs(z1 - z0))); }
  if (spec.circle) { const [x, z, r] = spec.circle.map(v => num(v, 'circle')); return shape(ctx => { ctx.beginPath(); ctx.arc(x, z, Math.max(r, g.c / 2), 0, Math.PI * 2); ctx.fill(); }); }
  if (spec.polygon) {
    const p = spec.polygon.map(q => pt(q, 'polygon point'));
    if (p.length < 3) fail('A polygon needs 3 points or more');
    return shape(ctx => { ctx.beginPath(); p.forEach(([x, z], k) => (k ? ctx.lineTo(x, z) : ctx.moveTo(x, z))); ctx.closePath(); ctx.fill(); });
  }
  if (spec.zone != null) {
    const Z = spec.layer ? layerOf(spec.layer, ['category']) : zonesLayer();
    if (!Z) fail('The map has no zones layer (a categories layer named zones); use {"layer":"<categories layer>","class":"<name>"}');
    return presence(g, Z, { cls: spec.zone });
  }
  if (spec.all) { const parts = list(spec.all, 'all').map(s => regionMask(s, g, depth + 1)); m.fill(1); for (const p of parts) for (let i = 0; i < m.length; i++) m[i] &= p[i]; return m; }
  if (spec.any) { for (const s of list(spec.any, 'any')) { const p = regionMask(s, g, depth + 1); for (let i = 0; i < m.length; i++) m[i] |= p[i]; } return m; }
  if (spec.not) { const p = regionMask(spec.not, g, depth + 1); for (let i = 0; i < m.length; i++) m[i] = p[i] ? 0 : 1; return m; }
  if (spec.near != null) {
    const dist = num(spec.distance ?? metersIn(g, 5), 'distance') / g.c;
    let src;
    if (Array.isArray(spec.near)) { const [x, z] = pt(spec.near, 'near'); src = new Uint8Array(g.N * g.R); const i = cellOf(g, x, z); if (i >= 0) src[i] = 1; else fail('near: the point is outside the map'); }
    else if (typeof spec.near === 'string') src = presence(g, layerOf(spec.near), { min: spec.min ?? 50, cls: spec.class ?? null });
    else src = regionMask(spec.near, g, depth + 1);
    if (!any(src)) return m;
    const d = distanceField(g, src);
    for (let i = 0; i < m.length; i++) if (d[i] <= dist) m[i] = 1;
    return m;
  }
  if (spec.items) {
    const L = layerOf(spec.items.layer);
    if (!L.hasItems) fail(`"${L.id}" has no items`);
    const ids = spec.items.ids ? new Set(spec.items.ids) : null;
    return itemsMask(g, L, L.items.filter(i => !ids || ids.has(i.id)));
  }
  if (spec.height || spec.slope) {
    const H = heightLayer(spec.layer && layerOf(spec.layer).type === 'height' ? spec.layer : null, true);
    const h = spec.height || {}, s = spec.slope || {}, sl = spec.slope ? slopeField(g, H) : null;
    for (let i = 0; i < m.length; i++) {
      const v = H.data[i];
      if (spec.height && ((h.min != null && v < h.min) || (h.max != null && v > h.max))) continue;
      if (sl && ((s.min != null && sl[i] < s.min) || (s.max != null && sl[i] > s.max))) continue;
      m[i] = 1;
    }
    return m;
  }
  if (spec.layer) return presence(g, layerOf(spec.layer), { min: spec.min ?? (spec.max != null ? 0 : 50), max: spec.max ?? 100, cls: spec.class ?? null });
  if (spec.point) { const [x, z] = pt(spec.point, 'point'); return regionMask({ circle: [x, z, spec.radius ?? g.c] }, g, depth + 1); }
  fail(`Unknown region ${JSON.stringify(spec).slice(0, 120)}. Use area, rect, circle, polygon, zone, layer (+ class or min/max), height, slope, near, items, all, any or not`);
}
const list = (v, name) => { if (!Array.isArray(v) || !v.length) fail(`"${name}" needs a list of regions`); return v; };

/** The region mask and facts about it; fails on an empty region unless allowEmpty. */
function region(spec, g = G(), allowEmpty = false) {
  const m = regionMask(spec, g), b = bounds(g, m);
  if (!b.count && !allowEmpty) fail(`The region ${JSON.stringify(spec).slice(0, 160)} has no cells on the map`);
  return { m, b, area: b.count * g.c * g.c };
}

// ------------------------------------------------------------------------------------------------ fields

const slopeCache = new WeakMap();
/** Slope in degrees per cell. */
function slopeField(g, H) {
  const hit = slopeCache.get(H);
  if (hit && hit.version === H.version) return hit.s;
  const { N, R, c } = g, h = H.data, s = new Float32Array(N * R);
  for (let y = 0; y < R; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const gx = (h[x < N - 1 ? i + 1 : i] - h[x > 0 ? i - 1 : i]) / ((x > 0 && x < N - 1 ? 2 : 1) * c);
    const gz = (h[y < R - 1 ? i + N : i] - h[y > 0 ? i - N : i]) / ((y > 0 && y < R - 1 ? 2 : 1) * c);
    s[i] = Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
  }
  slopeCache.set(H, { version: H.version, s });
  return s;
}

/** Box blur (3 passes ~ Gaussian) of a float field over the whole grid; r in cells. */
function blur(g, a, r) {
  r = Math.max(0, Math.round(r));
  if (!r) return Float32Array.from(a);
  const { N, R } = g, tmp = new Float32Array(N * R);
  let src = Float32Array.from(a);
  const pass = (from, to, len, stride, lines, lstride) => {
    for (let l = 0; l < lines; l++) {
      const o = l * lstride;
      let sum = 0, n = 0;
      for (let k = 0; k < Math.min(r, len); k++) { sum += from[o + k * stride]; n++; }
      for (let k = 0; k < len; k++) {
        if (k + r < len) { sum += from[o + (k + r) * stride]; n++; }
        if (k - r - 1 >= 0) { sum -= from[o + (k - r - 1) * stride]; n--; }
        to[o + k * stride] = sum / n;
      }
    }
  };
  for (let p = 0; p < 3; p++) { pass(src, tmp, N, 1, R, N); pass(tmp, src, R, N, N, 1); }
  return src;
}

/** Fractal value noise in -1..1 at world points; scale: the size of the blotches. */
function noiseFn(seed = 1, scale = 10) {
  const hash = (x, y) => { let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
  const smooth = t => t * t * (3 - 2 * t);
  const vn = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), tx = smooth(x - xi), ty = smooth(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  return (x, z) => {
    let sum = 0, amp = 1, f = 1 / scale, norm = 0;
    for (let o = 0; o < 4; o++) { sum += vn(x * f + o * 17.3, z * f - o * 9.1) * amp; norm += amp; amp *= 0.5; f *= 2; }
    return (sum / norm) * 2 - 1;
  };
}

function rng(seed) {
  let a = (seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Connected parts (4-neighbors) of a mask: labels per cell (0 = none) and the parts {label, count, x, z (centroid), cells?}. */
function components(g, m) {
  const { N, R } = g, lab = new Int32Array(N * R), q = new Int32Array(N * R), parts = [];
  let next = 0;
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || lab[s]) continue;
    next++;
    let head = 0, tail = 0, sx = 0, sy = 0;
    q[tail++] = s; lab[s] = next;
    while (head < tail) {
      const i = q[head++], x = i % N, y = (i - x) / N;
      sx += x; sy += y;
      if (x > 0 && m[i - 1] && !lab[i - 1]) { lab[i - 1] = next; q[tail++] = i - 1; }
      if (x < N - 1 && m[i + 1] && !lab[i + 1]) { lab[i + 1] = next; q[tail++] = i + 1; }
      if (y > 0 && m[i - N] && !lab[i - N]) { lab[i - N] = next; q[tail++] = i - N; }
      if (y < R - 1 && m[i + N] && !lab[i + N]) { lab[i + N] = next; q[tail++] = i + N; }
    }
    parts.push({ label: next, count: tail, cx: sx / tail, cy: sy / tail });
  }
  return { lab, parts };
}

// Default layer choices, by their names: cover (trees, rocks, buildings...) and what blocks walking (water, cliffs...)
const COVER_RE = /tree|bush|shrub|forest|wood|jungle|rock|cliff|boulder|stone|building|house|ruin|wall|fence|structure|hiding|cover|prop|crate|barrel/i;
const BLOCK_RE = /water|lake|river|sea|ocean|pond|lava|cliff|wall/i;
const nameOf = L => `${L.id} ${L.meta.name}`;

function coverLayers(ids) {
  if (ids?.length) return ids.map(id => layerOf(id));
  return G().S.layers.filter(L => (L.type === 'mask' || L.type === 'objects' || L.type === 'vector') && COVER_RE.test(nameOf(L)) && !/road|path|trail|water/i.test(nameOf(L)));
}

/** What blocks walking: the given layers, or water / cliff / wall masks and classes, rivers and footprint objects. */
function blockingMask(g, ids) {
  const m = new Uint8Array(g.N * g.R), used = [];
  const add = (p, name) => { for (let i = 0; i < m.length; i++) m[i] |= p[i]; used.push(name); };
  if (ids?.length) { for (const id of ids) { const L = layerOf(id); add(presence(g, L), L.id); } return { m, used }; }
  for (const L of g.S.layers) {
    if (L.type === 'mask' && BLOCK_RE.test(nameOf(L))) add(presence(g, L), L.id);
    else if (L.type === 'category') {
      const cls = L.meta.classes.filter((c, k) => k && BLOCK_RE.test(c.name)).map(c => c.name);
      if (cls.length) add(presence(g, L, { cls }), `${L.id}: ${cls.join(', ')}`);
    } else if (L.type === 'vector' && BLOCK_RE.test(nameOf(L))) add(itemsMask(g, L), L.id);
    else if (L.type === 'objects' && L.meta.style === 'footprint') add(itemsMask(g, L), L.id);
  }
  return { m, used };
}

ME.agentInternals = { G, fail, ToolError, regionMask, region, presence, itemsMask, distanceField, slopeField, blur, noiseFn, rng, components, bounds, worldBox, cellOf, cellX, cellZ, layerOf, editable, itemLayers, heightLayer, zonesLayer, classIndex, coverLayers, blockingMask, metersIn, fmtU, r2, num, pt, A, any };
})(window.ME);
