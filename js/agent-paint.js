// AI agent tools that fill regions: scatter objects (blue noise, groups, densities), paint masks and categories, shape
// the terrain. Each is one undo step. See js/agent-tools.js.
(function (ME) {
'use strict';

const T = ME.agentTools = ME.agentTools || {};
const { G, fail, region, regionMask, presence, distanceField, blur, noiseFn, rng, worldBox, cellOf, cellX, cellZ, layerOf, editable,
  heightLayer, zonesLayer, classIndex, metersIn, fmtU, r2, num, pt, A, any } = ME.agentInternals;
const { each, pct } = ME.agentRead;
const { writable, flash, cleanItems } = ME.agentWrite;
const center = it => A().itemCenter(it);

/** The weight (0..1) of every cell of a window around a region: 1 inside, a soft edge of `feather` units. */
function weights(g, r, feather, strength = 100) {
  const pad = Math.ceil((feather || 0) / g.c) + 1;
  const x0 = Math.max(0, r.b.x0 - pad), y0 = Math.max(0, r.b.y0 - pad), x1 = Math.min(g.N, r.b.x1 + pad), y1 = Math.min(g.R, r.b.y1 + pad);
  const w = new Float32Array(g.N * g.R);
  for (let y = y0; y < y1; y++) for (let x = x0, i = y * g.N + x0; x < x1; x++, i++) w[i] = r.m[i];
  const out = feather > 0 ? blur(g, w, feather / g.c / 2) : w;
  const k = Math.max(0, Math.min(100, strength)) / 100;
  if (k !== 1) for (let i = 0; i < out.length; i++) out[i] *= k;
  return { w: out, rect: [x0, y0, x1, y1] };
}

/** Writes a raster change with one undo step and a flash; fn(i, x, y) changes cell i inside rect. */
function rasterEdit(g, L, rect, label, fn) {
  const before = A().copyRect(L.data, g.N, rect);
  let changed = 0;
  for (let y = rect[1]; y < rect[3]; y++) for (let x = rect[0], i = y * g.N + x; x < rect[2]; x++, i++) if (fn(i, x, y)) changed++;
  if (!changed) return 0;
  L.refresh(...rect);
  L.dirty = true;
  A().pushRasterUndoSub(L, label, before, rect);
  A().renderLayers();
  A().renderSaveState();
  A().requestRender();
  flash({ box: worldBox(g, { x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3] }) }, label.replace(/^AI: /, ''));
  return changed;
}

// ------------------------------------------------------------------------------------------------ paint

T.paint_layer = (args, ctx) => {
  const g = G(), L = layerOf(args.layer, ['mask', 'category']);
  writable(ctx); editable(L);
  const r = region(args.region, g), mode = args.mode || 'set';
  const { w, rect } = weights(g, r, args.feather || 0, args.strength ?? 100);
  const noise = args.noise?.amount ? { f: noiseFn(args.noise.seed ?? 1, args.noise.scale ?? metersIn(g, 12)), a: args.noise.amount / 100 } : null;
  const d = L.data;
  let changed;
  if (L.type === 'mask') {
    const v = num(+args.value, 'value (percent)');
    if (v < 0 || v > 100) fail('A mask value is 0–100 (percent)');
    const T0 = v * 2.55;
    changed = rasterEdit(g, L, rect, `AI: paint ${L.meta.name} ${v}%`, (i, x, y) => {
      const wt = w[i];
      if (wt <= 0.001) return false;
      const t = noise ? Math.max(0, Math.min(255, T0 * (1 + noise.a * noise.f(cellX(g, x), cellZ(g, y))))) : T0, old = d[i];
      let nv = old;
      if (mode === 'set') nv = old + (t - old) * wt;
      else if (mode === 'max') nv = Math.max(old, old + (t - old) * wt);
      else if (mode === 'min') nv = Math.min(old, old + (t - old) * wt);
      else if (mode === 'add') nv = old + t * wt;
      else if (mode === 'subtract') nv = old - t * wt;
      else if (mode === 'erase') nv = old * (1 - wt);
      else fail('mode is set, max, min, add, subtract or erase');
      nv = Math.max(0, Math.min(255, Math.round(nv)));
      if (nv === old) return false;
      d[i] = nv;
      return true;
    });
  } else {
    const k = classIndex(L, args.value);
    changed = rasterEdit(g, L, rect, `AI: paint ${L.meta.name}: ${L.meta.classes[k].name}`, (i, x, y) => {
      let wt = w[i];
      if (noise) wt += noise.a * 0.5 * noise.f(cellX(g, x), cellZ(g, y));
      if (wt < 0.5) return false;
      const nv = mode === 'erase' ? (d[i] === k || k === 0 ? 0 : d[i]) : k;
      if (nv === d[i]) return false;
      d[i] = nv;
      return true;
    });
  }
  const after = {};
  if (L.type === 'mask') { let s = 0; each(g, r.b, r.m, i => { s += d[i]; }); after.mean_pct_in_region = Math.round(s / r.b.count / 2.55); }
  else { let n = 0; const k = classIndex(L, args.value); each(g, r.b, r.m, i => { if (d[i] === k) n++; }); after.class_share_in_region_pct = pct(n, r.b.count); }
  return { data: { layer: L.id, changed_cells: changed, changed_area: fmtU(g, changed * g.c * g.c, 0), ...after } };
};

// ------------------------------------------------------------------------------------------------ terrain

function placeOf(g, spec, name) {
  if (!spec || typeof spec !== 'object') fail(`${name} is {"point":[x,z]} or a region, with an optional "height"`);
  if (spec.point) { const [x, z] = pt(spec.point, name); return { x, z, m: regionMask({ circle: [x, z, g.c * 2] }, g) }; }
  const { height, ...reg } = spec, r = region(reg, g);
  let sx = 0, sz = 0;
  each(g, r.b, r.m, (i, x, y) => { sx += cellX(g, x); sz += cellZ(g, y); });
  return { x: sx / r.b.count, z: sz / r.b.count, m: r.m, b: r.b };
}

const meanIn = (g, H, m) => { let s = 0, n = 0; for (let i = 0; i < m.length; i++) if (m[i]) { s += H.data[i]; n++; } return n ? s / n : 0; };

T.edit_terrain = (args, ctx) => {
  const g = G(), H = heightLayer(args.layer, true), op = args.op;
  writable(ctx); editable(H);
  let r, from, to;
  if (op === 'slope') {
    from = placeOf(g, args.from, 'from'); to = placeOf(g, args.to, 'to');
    from.h = args.from.height ?? meanIn(g, H, from.m); to.h = args.to.height ?? meanIn(g, H, to.m);
    if (args.region) r = region(args.region, g);
    else { // from, to and the corridor between them
      const len = Math.hypot(to.x - from.x, to.z - from.z) || g.c, ux = (to.x - from.x) / len, uz = (to.z - from.z) / len;
      const half = Math.max(metersIn(g, 10), ...[from, to].filter(p => p.b).map(p => Math.max(p.b.x1 - p.b.x0, p.b.y1 - p.b.y0) * g.c / 2));
      const corridor = { polygon: [[from.x - uz * half, from.z + ux * half], [to.x - uz * half, to.z + ux * half], [to.x + uz * half, to.z - ux * half], [from.x + uz * half, from.z - ux * half]] };
      const m = regionMask(corridor, g);
      for (let i = 0; i < m.length; i++) m[i] |= from.m[i] | to.m[i];
      r = region({ area: 'map' }, g); r.m = m; r.b = ME.agentInternals.bounds(g, m);
    }
  } else {
    if (!args.region) fail('Give "region" (e.g. {"area":"selection"} or {"zone":"village"})');
    r = region(args.region, g);
  }
  const size = Math.max(r.b.x1 - r.b.x0, r.b.y1 - r.b.y0) * g.c;
  const feather = args.feather ?? (op === 'smooth' ? 0 : size * 0.1);
  const { w, rect } = weights(g, r, feather, args.strength ?? 100), d = H.data;
  const stat = () => { let lo = Infinity, hi = -Infinity, s = 0; each(g, r.b, r.m, i => { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; s += v; }); return { min: fmtU(g, lo, 2), mean: fmtU(g, s / r.b.count, 2), max: fmtU(g, hi, 2) }; };
  const before = stat();
  let target;
  if (op === 'raise' || op === 'lower') {
    const a = num(args.amount, 'amount') * (op === 'lower' ? -1 : 1);
    target = i => d[i] + a;
  } else if (op === 'flatten') {
    const h = args.height ?? meanIn(g, H, r.m);
    target = () => h;
  } else if (op === 'smooth') {
    const b = blur(g, d, (args.radius ?? metersIn(g, 3)) / g.c / 2);
    target = i => b[i];
  } else if (op === 'noise') {
    const f = noiseFn(args.seed ?? 1, args.scale ?? metersIn(g, 20)), a = num(args.amount, 'amount');
    target = (i, x, y) => d[i] + a * f(cellX(g, x), cellZ(g, y));
  } else if (op === 'slope') {
    const dx = to.x - from.x, dz = to.z - from.z, l2 = dx * dx + dz * dz || 1;
    target = (i, x, y) => {
      const t = Math.max(0, Math.min(1, ((cellX(g, x) - from.x) * dx + (cellZ(g, y) - from.z) * dz) / l2)), s = t * t * (3 - 2 * t);
      return from.h + (to.h - from.h) * s;
    };
  } else fail('op is raise, lower, flatten, smooth, slope or noise');
  const changed = rasterEdit(g, H, rect, `AI: ${op} terrain`, (i, x, y) => {
    const wt = w[i];
    if (wt <= 0.001) return false;
    const nv = d[i] + (target(i, x, y) - d[i]) * wt;
    if (Math.abs(nv - d[i]) < 1e-4) return false;
    d[i] = nv;
    return true;
  });
  return { data: { layer: H.id, op, changed_area: fmtU(g, changed * g.c * g.c, 0), before, after: stat(), ...(op === 'slope' ? { from: { at: [r2(from.x), r2(from.z)], height: fmtU(g, from.h, 2) }, to: { at: [r2(to.x), r2(to.z)], height: fmtU(g, to.h, 2) } } : {}) } };
};

// ------------------------------------------------------------------------------------------------ scatter

T.scatter_items = (args, ctx) => {
  const g = G(), L = layerOf(args.layer, ['objects', 'notes']);
  if (!args.dry_run) { writable(ctx); editable(L); }
  const r = region(args.region, g), rand = rng(args.seed);
  const allowed = Uint8Array.from(r.m);
  for (const k of args.keep_away || []) { // distances to keep from other layers
    if (!k?.layer) fail('keep_away items are {"layer":"...","distance":5}');
    const src = presence(g, layerOf(k.layer), { min: k.min ?? 50 });
    if (!any(src)) continue;
    const dist = distanceField(g, src), lim = (k.distance ?? metersIn(g, 2)) / g.c;
    for (let i = 0; i < allowed.length; i++) if (dist[i] <= lim) allowed[i] = 0;
  }
  let dens = null;
  if (args.density) { const D = layerOf(args.density.layer, ['mask']); dens = i => (args.density.invert ? 255 - D.data[i] : D.data[i]) / 255; }
  const kinds = args.kinds?.length ? args.kinds.map(k => ({ ...k, weight: k.weight ?? 1 })) : [{ kind: args.kind || (L.type === 'notes' ? 'note' : null) }];
  if (L.type === 'objects' && kinds.some(k => !k.kind)) fail('Give "kind" or "kinds"');
  const total = kinds.reduce((s, k) => s + (k.weight ?? 1), 0);
  const pick = () => { let t = rand() * total; for (const k of kinds) { t -= k.weight ?? 1; if (t <= 0) return k; } return kinds.at(-1); };
  const groups = args.groups ? { min: args.groups.size?.[0] ?? 3, max: args.groups.size?.[1] ?? args.groups.size?.[0] ?? 5, radius: args.groups.radius ?? metersIn(g, 5) } : null;
  const spacing = Math.max(g.c, args.spacing ?? metersIn(g, 4)), sep = groups ? Math.max(spacing, groups.radius * 2) : spacing;
  const cap = Math.min(args.count ?? 2000, 5000);
  const ok = (x, z) => { const i = cellOf(g, x, z); return i >= 0 && allowed[i] && (!dens || rand() < dens(i)); };
  // blue noise (Bridson) with a grid of buckets; existing items of the layer keep the spacing too
  const cell = sep / Math.SQRT2, gx0 = g.w.x0, gz0 = g.w.z0, GW = Math.ceil(g.w.width / cell) + 1, grid = new Map();
  const keyOf = (x, z) => Math.floor((x - gx0) / cell) + Math.floor((z - gz0) / cell) * GW;
  const far = (x, z, d) => {
    const cx = Math.floor((x - gx0) / cell), cz = Math.floor((z - gz0) / cell), s = Math.ceil(d / cell);
    for (let a = cx - s; a <= cx + s; a++) for (let b = cz - s; b <= cz + s; b++) for (const p of grid.get(a + b * GW) || []) if (Math.hypot(p[0] - x, p[1] - z) < d) return false;
    return true;
  };
  const put = (x, z) => { const k = keyOf(x, z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push([x, z]); };
  if (args.avoid_existing !== false) for (const it of L.items) put(...center(it));
  const [bx0, bz0, bx1, bz1] = worldBox(g, r.b), centers = [], active = [];
  let misses = 0;
  while (centers.length < cap && misses < 400) {
    if (!active.length) { // a new seed somewhere in the region
      const x = bx0 + rand() * (bx1 - bx0), z = bz0 + rand() * (bz1 - bz0);
      if (ok(x, z) && far(x, z, sep)) { centers.push([x, z]); put(x, z); active.push([x, z]); misses = 0; } else misses++;
      continue;
    }
    const k = Math.floor(rand() * active.length), [ax, az] = active[k];
    let found = false;
    for (let t = 0; t < 30 && centers.length < cap; t++) {
      const a = rand() * Math.PI * 2, d = sep * (1 + rand());
      const x = ax + Math.cos(a) * d, z = az + Math.sin(a) * d;
      if (x < bx0 || z < bz0 || x > bx1 || z > bz1 || !ok(x, z) || !far(x, z, sep)) continue;
      centers.push([x, z]); put(x, z); active.push([x, z]); found = true;
    }
    if (!found) active.splice(k, 1);
  }
  // the items: one per center, or a group around it
  const rint = ([a, b]) => (Number.isInteger(a) && Number.isInteger(b) ? a + Math.floor(rand() * (b - a + 1)) : r2(a + rand() * (b - a)));
  const randProps = () => Object.fromEntries(Object.entries(args.random_props || {}).map(([k, v]) => [k, Array.isArray(v) ? rint(v) : v]));
  const yawOf = () => (args.yaw == null || args.yaw === 'random' ? Math.round(rand() * 360 - 180) : num(+args.yaw, 'yaw'));
  const make = (x, z, kind, extraProps) => {
    const o = { x: r2(x), z: r2(z) };
    if (L.type === 'notes') o.text = kind.text || args.props?.text || 'Note';
    else { o.kind = kind.kind; o.yaw = yawOf(); if (kind.w != null) { o.w = kind.w; o.d = kind.d ?? kind.w; } }
    const props = { ...(args.props || {}), ...(kind.props || {}), ...extraProps };
    delete props.text;
    if (Object.keys(props).length) o.props = props;
    return o;
  };
  const out = [];
  centers.forEach(([x, z], gi) => {
    if (!groups) { out.push(make(x, z, pick(), randProps())); return; }
    const n = rint([groups.min, groups.max]), shared = randProps(), kind = pick(), placed = [];
    const minIn = Math.max(g.c, Math.min(spacing, groups.radius * 0.8));
    for (let t = 0; placed.length < n && t < n * 40; t++) {
      const a = rand() * Math.PI * 2, d = groups.radius * Math.sqrt(rand()), px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d, i = cellOf(g, px, pz);
      if (i < 0 || !allowed[i] || placed.some(p => Math.hypot(p[0] - px, p[1] - pz) < minIn)) continue;
      placed.push([px, pz]);
    }
    for (const [px, pz] of placed) out.push(make(px, pz, args.kinds?.length > 1 ? pick() : kind, { ...shared, ...(args.group_prop ? { [args.group_prop]: gi + 1 } : {}) }));
  });
  const byKind = {};
  for (const o of out) byKind[o.kind ?? 'note'] = (byKind[o.kind ?? 'note'] || 0) + 1;
  const info = { placed: out.length, ...(groups ? { groups: centers.length } : {}), by_kind: byKind, spacing: fmtU(g, sep), region_area: fmtU(g, r.area, 0), filled: centers.length < cap };
  if (!out.length) return { data: { ...info, note: 'No place in the region met the conditions (spacing, keep_away, density, existing items)' } };
  if (args.dry_run) return { data: { ...info, dry_run: true, items: out.slice(0, 500) } };
  const added = ME.agentWrite.addItems(L, out, `AI: scatter ${out.length} ${Object.keys(byKind).slice(0, 3).join(', ')} on ${L.meta.name}`, ctx);
  return { data: { ...info, layer: L.id, ids: added.length > 300 ? `${added[0].id}…${added.at(-1).id}` : added.map(i => i.id) } };
};
})(window.ME);
