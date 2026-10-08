// AI agent tools that look at the map: overview, user context, images, region facts, items, spots, walkability, routes.
// See js/agent-tools.js for the shared parts (regions, fields).
(function (ME) {
'use strict';

const T = ME.agentTools = ME.agentTools || {};
const { G, fail, region, regionMask, presence, itemsMask, distanceField, slopeField, blur, components, bounds, worldBox,
  cellOf, cellX, cellZ, layerOf, itemLayers, heightLayer, zonesLayer, coverLayers, blockingMask, metersIn, fmtU, r2, num, pt, A, any } = ME.agentInternals;

const center = it => A().itemCenter(it);
const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : 0);

function brief(L, it, g) {
  const o = { id: it.id };
  if (L.type === 'notes') Object.assign(o, { x: r2(it.x), z: r2(it.z), text: it.text });
  else if (it.points) {
    Object.assign(o, { kind: it.kind, points: it.points.length > 60 ? `${it.points.length} points` : it.points, length: fmtU(g, L.length(it)) });
    if (it.closed) o.closed = true;
    if (it.width != null) o.width = it.width;
  } else {
    Object.assign(o, { kind: it.kind, x: r2(it.x), z: r2(it.z) });
    if (it.yaw) o.yaw = it.yaw;
    if (it.w != null) Object.assign(o, { w: it.w, d: it.d });
    if (it.a) Object.assign(o, { a: it.a, b: it.b });
  }
  if (it.zone) o.zone = it.zone;
  if (it.props && Object.keys(it.props).length) o.props = it.props;
  return o;
}

// ------------------------------------------------------------------------------------------------ overview

function layerFacts(g, L) {
  const m = L.meta, o = { id: L.id, name: m.name, type: L.type, group: m.group || 'Other', visible: !!m.visible };
  if (m.locked) o.locked = true;
  if (m.note) o.note = m.note;
  const n = g.N * g.R;
  if (L.type === 'mask') {
    let sum = 0, full = 0;
    for (const v of L.data) { sum += v; if (v >= 128) full++; }
    Object.assign(o, { values: '0–100 % per cell', mean_pct: Math.round(sum / n / 2.55 * 10) / 10, cells_over_50_pct: pct(full, n) });
  } else if (L.type === 'category') {
    const counts = new Array(m.classes.length).fill(0);
    for (const v of L.data) counts[v]++;
    o.classes = m.classes.map((c, k) => ({ index: k, name: c.name, share_pct: pct(counts[k], n) }));
  } else if (L.type === 'height') {
    let lo = Infinity, hi = -Infinity, s = 0;
    for (const v of L.data) { if (v < lo) lo = v; if (v > hi) hi = v; s += v; }
    Object.assign(o, { min: fmtU(g, lo, 2), max: fmtU(g, hi, 2), mean: fmtU(g, s / n, 2), contour: m.contour });
  } else if (L.hasItems) {
    o.count = L.items.length;
    if (L.type !== 'notes') {
      const kinds = {};
      for (const it of L.items) kinds[it.kind] = (kinds[it.kind] || 0) + 1;
      o.kinds = Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 40));
      const keys = new Set();
      for (const it of L.items) for (const k of Object.keys(it.props || {})) keys.add(k);
      if (keys.size) o.prop_keys = [...keys].slice(0, 40);
    }
    if (L.type === 'objects') Object.assign(o, { style: m.style, ...(m.style !== 'footprint' ? { marker_size: m.size } : {}), ...(m.label ? { label: m.label } : {}) });
    if (L.type === 'vector') Object.assign(o, { width: m.width, smooth: !!m.smooth, ...(m.dash ? { dashed: true } : {}), total_length: fmtU(g, L.items.reduce((s, it) => s + L.length(it), 0), 0) });
  }
  return o;
}

T.get_map_info = () => {
  const g = G(), w = g.w, S = g.S, Z = zonesLayer();
  return {
    data: {
      title: S.project.title,
      unit: { id: S.project.unit || 'm', name: g.unit.name, label: g.unit.label },
      bounds: { x0: w.x0, z0: w.z0, x1: r2(w.x0 + w.width), z1: r2(w.z0 + w.height), width: w.width, height: w.height },
      cell: r2(g.c), cells: [g.N, g.R],
      axes: 'x grows east (right), z grows south (down): north is up; yaw in degrees, positive turns counter-clockwise seen from above',
      layers_top_to_bottom: [...S.layers].reverse().map(L => layerFacts(g, L)),
      zones: Z ? { layer: Z.id, names: Z.meta.classes.slice(1).map(c => c.name) } : null,
      user: userContext(g, true),
    },
  };
};

function userContext(g, short = false) {
  const { S } = g, v = A().view, [x0, z0] = v.toWorld(0, 0), [x1, z1] = v.toWorld(v.w, v.h);
  const o = {
    active_layer: S.active?.id || null,
    selected_layers: [...S.layerSel],
    tool: S.tool,
    view: { rect: [r2(x0), r2(z0), r2(x1), r2(z1)], px_per_unit: r2(v.scale) },
  };
  if (S.area) {
    const b = { x0: S.area.bbox[0], y0: S.area.bbox[1], x1: S.area.bbox[2], y1: S.area.bbox[3] };
    o.selected_area = { rect: worldBox(g, b), area: fmtU(g, S.area.count * g.c * g.c, 0), use: '{"area":"selection"}' };
  } else o.selected_area = null;
  if (S.sel.layer && S.sel.ids.size) {
    const items = S.sel.layer.items.filter(i => S.sel.ids.has(i.id));
    o.selected_items = { layer: S.sel.layer.id, count: items.length, items: items.slice(0, short ? 10 : 100).map(it => brief(S.sel.layer, it, g)) };
  } else o.selected_items = null;
  if (!short) o.cursor = S.cursor ? [r2(S.cursor[0]), r2(S.cursor[1])] : null;
  return o;
}

T.get_user_context = () => ({ data: userContext(G()) });

// ------------------------------------------------------------------------------------------------ images

T.render_map = args => {
  const g = G(), { S } = g;
  let bx0, bz0, bx1, bz1;
  if (args.region) {
    const r = region(args.region, g), [a, b, c, d] = worldBox(g, r.b), pad = Math.max(c - a, d - b) * 0.06 + g.c;
    [bx0, bz0, bx1, bz1] = [a - pad, b - pad, c + pad, d + pad];
  } else {
    const v = A().view;
    [bx0, bz0] = v.toWorld(0, 0); [bx1, bz1] = v.toWorld(v.w, v.h);
  }
  const W0 = bx1 - bx0, H0 = bz1 - bz0;
  if (!(W0 > 0 && H0 > 0)) fail('Nothing to show');
  const size = Math.max(128, Math.min(1600, args.size || 768)), scale = size / Math.max(W0, H0);
  const cw = Math.round(W0 * scale), ch = Math.round(H0 * scale);
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  const v = new ME.View(cv, g.w);
  Object.assign(v, { dpr: 1, w: cw, h: ch, scale, ox: (g.w.x0 - bx0) * scale, oy: (g.w.z0 - bz0) * scale, texture: args.labels === false });
  ctx.fillStyle = '#141416'; ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = '#202024'; ctx.fillRect(v.ox, v.oy, g.w.width * scale, g.w.height * scale);
  const want = args.layers?.length ? new Set(args.layers.map(id => layerOf(id).id)) : null;
  const drawn = [];
  for (const L of S.layers) {
    if (want ? !want.has(L.id) : !L.meta.visible) continue;
    ctx.save();
    ctx.globalAlpha = L.meta.opacity ?? 1;
    L.draw(ctx, v, null);
    ctx.restore();
    drawn.push(L.id);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const outline = (mask, color, dash) => {
    const b = bounds(g, mask);
    if (!b.count) return;
    const path = ME.maskOutline(mask, g.N, [b.x0, b.y0, b.x1, b.y1], g.R), c = v.cellPx();
    ctx.save();
    v.setCellTransform(ctx);
    ctx.lineWidth = 2.2 / c; ctx.strokeStyle = 'rgba(10,8,14,0.9)'; ctx.stroke(path);
    ctx.lineWidth = 1.4 / c; ctx.strokeStyle = color; if (dash) ctx.setLineDash([5 / c, 4 / c]); ctx.stroke(path);
    ctx.restore();
  };
  if (S.area) outline(S.area.mask, '#ffffff', true);
  if (args.highlight) outline(regionMask(args.highlight, g), '#ff4d4d', false);
  let step = 0;
  if (args.grid !== false) {
    step = ME.stepAtLeast(Math.max(W0, H0) / 8);
    ctx.font = '11px system-ui';
    ctx.lineWidth = 1;
    for (let n = Math.ceil(bx0 / step); n * step <= bx1; n++) {
      const x = Math.round((n * step - bx0) * scale) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch); ctx.stroke();
      label(ctx, `x ${A().fmt(n * step)}`, x + 3, 3);
    }
    for (let n = Math.ceil(bz0 / step); n * step <= bz1; n++) {
      const y = Math.round((n * step - bz0) * scale) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke();
      label(ctx, `z ${A().fmt(n * step)}`, 3, y + 3);
    }
    label(ctx, 'N ↑', cw - 34, 3);
  }
  const png = args.format === 'png', url = cv.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86);
  return {
    text: `"${S.project.title}" from above, north up: x ${r2(bx0)} … ${r2(bx1)} (east), z ${r2(bz0)} … ${r2(bz1)} (south), ${r2(1 / scale)} ${g.unit.label} per pixel`
      + `${step ? `, grid every ${step} ${g.unit.label}` : ''}. Layers drawn (bottom to top): ${drawn.join(', ') || 'none'}.`
      + `${S.area ? ' Dashed white: the user\'s selected area.' : ''}${args.highlight ? ' Red: the highlight.' : ''}`,
    images: [{ data: url.slice(url.indexOf(',') + 1), mimeType: png ? 'image/png' : 'image/jpeg' }],
  };
};

function label(ctx, text, x, y) {
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(16,13,20,0.75)'; ctx.fillRect(x - 2, y - 1, w + 4, 14);
  ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'top'; ctx.fillText(text, x, y);
}

// ------------------------------------------------------------------------------------------------ region facts

function rasterFacts(g, L, r, slope) {
  const { m, b } = r, d = L.data;
  if (L.type === 'mask') {
    let sum = 0, full = 0, max = 0;
    each(g, b, m, i => { sum += d[i]; if (d[i] >= 128) full++; if (d[i] > max) max = d[i]; });
    return { mean_pct: Math.round(sum / b.count / 2.55), over_50_pct: pct(full, b.count), max_pct: Math.round(max / 2.55) };
  }
  if (L.type === 'category') {
    const counts = new Array(L.meta.classes.length).fill(0);
    each(g, b, m, i => counts[d[i]]++);
    return { classes: Object.fromEntries(counts.map((n, k) => [L.meta.classes[k].name, pct(n, b.count)]).filter(([, v]) => v > 0).sort((a, c) => c[1] - a[1])) };
  }
  if (L.type === 'height') {
    let lo = Infinity, hi = -Infinity, s = 0, ss = 0, smax = 0, flat = 0;
    each(g, b, m, i => { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; s += v; ss += slope[i]; if (slope[i] > smax) smax = slope[i]; if (slope[i] < 10) flat++; });
    return { min: fmtU(g, lo, 2), mean: fmtU(g, s / b.count, 2), max: fmtU(g, hi, 2), slope_mean_deg: Math.round(ss / b.count), slope_max_deg: Math.round(smax), flat_pct: pct(flat, b.count) };
  }
  return null;
}

function each(g, b, m, fn) {
  for (let y = b.y0; y < b.y1; y++) for (let x = b.x0, i = y * g.N + b.x0; x < b.x1; x++, i++) if (m[i]) fn(i, x, y);
}

const inRegion = (g, m, it) => { const i = cellOf(g, ...center(it)); return i >= 0 && !!m[i]; };

T.describe_region = args => {
  const g = G(), r = region(args.region, g), { S } = g, n = args.list_items ?? 20;
  const box = worldBox(g, r.b);
  let cx = 0, cz = 0;
  each(g, r.b, r.m, (i, x, y) => { cx += x; cz += y; });
  const out = {
    area: fmtU(g, r.area, 0), unit: g.unit.label, rect: box, center: [r2(cellX(g, cx / r.b.count - 0.5)), r2(cellZ(g, cz / r.b.count - 0.5))],
    size: [r2(box[2] - box[0]), r2(box[3] - box[1])], layers: {}, items: {},
  };
  for (const L of [...S.layers].reverse()) {
    if (L.raster) {
      const f = rasterFacts(g, L, r, L.type === 'height' ? slopeField(g, L) : null);
      if (f) out.layers[L.id] = f;
    } else if (L.hasItems) {
      const inside = L.items.filter(it => inRegion(g, r.m, it));
      if (!inside.length) continue;
      const kinds = {};
      for (const it of inside) kinds[it.kind ?? 'note'] = (kinds[it.kind ?? 'note'] || 0) + 1;
      out.items[L.id] = { count: inside.length, kinds, ...(n ? { first: inside.slice(0, n).map(it => brief(L, it, g)) } : {}) };
    }
  }
  return { data: out };
};

T.read_layer = args => {
  const g = G(), L = layerOf(args.layer, ['mask', 'category', 'height']), r = region(args.region, g);
  const res = Math.max(4, Math.min(128, args.resolution || 40)), b = r.b;
  const bs = Math.max(1, Math.ceil(Math.max(b.x1 - b.x0, b.y1 - b.y0) / res));
  const gw = Math.ceil((b.x1 - b.x0) / bs), gh = Math.ceil((b.y1 - b.y0) / bs), rows = [];
  for (let gy = 0; gy < gh; gy++) {
    const row = [];
    for (let gx = 0; gx < gw; gx++) {
      let n = 0, sum = 0;
      const counts = L.type === 'category' ? new Map() : null;
      for (let y = b.y0 + gy * bs; y < Math.min(b.y1, b.y0 + (gy + 1) * bs); y++) {
        for (let x = b.x0 + gx * bs, i = y * g.N + x; x < Math.min(b.x1, b.x0 + (gx + 1) * bs); x++, i++) {
          if (!r.m[i]) continue;
          n++;
          if (counts) counts.set(L.data[i], (counts.get(L.data[i]) || 0) + 1); else sum += L.data[i];
        }
      }
      if (!n) row.push('.');
      else if (L.type === 'mask') row.push(String(Math.round(sum / n / 2.55)));
      else if (L.type === 'height') row.push(String(fmtU(g, sum / n, 1)));
      else row.push(String([...counts].sort((a, c) => c[1] - a[1])[0][0]));
    }
    rows.push(row.join(' '));
  }
  const step = bs * g.c;
  return {
    data: {
      layer: L.id, type: L.type,
      values: L.type === 'mask' ? 'percent' : L.type === 'height' ? `height in ${g.unit.label} (mean)` : 'class index (the most cells), see legend',
      legend: L.type === 'category' ? Object.fromEntries(L.meta.classes.map((c, k) => [k, c.name])) : undefined,
      grid_step: r2(step), columns: gw, rows: gh,
      first_cell_center: [r2(g.w.x0 + (b.x0 + bs / 2) * g.c), r2(g.w.z0 + (b.y0 + bs / 2) * g.c)],
      note: 'Rows go north to south, columns west to east; "." is outside the region.',
      grid: rows,
    },
  };
};

// ------------------------------------------------------------------------------------------------ items

T.find_items = args => {
  const g = G(), layers = args.layer ? [layerOf(args.layer)] : itemLayers();
  for (const L of layers) if (!L.hasItems) fail(`"${L.id}" is a ${L.type} layer, not objects, notes or paths`);
  const m = args.region ? region(args.region, g).m : null, kinds = args.kind?.length ? new Set(args.kind) : null;
  const near = args.near ? pt(args.near, 'near') : null, maxD = args.max_distance;
  const fields = {}, measures = args.measure || [];
  const H = measures.some(x => x === 'height' || x === 'slope') ? heightLayer(null, true) : null;
  const Z = measures.includes('zone') ? zonesLayer() : null;
  let rows = [];
  for (const L of layers) {
    for (const it of L.items) {
      const [x, z] = center(it), i = cellOf(g, x, z);
      if (m && (i < 0 || !m[i])) continue;
      if (kinds && !kinds.has(it.kind)) continue;
      if (args.props && !Object.entries(args.props).every(([k, v]) => it.props?.[k] === v)) continue;
      let dist = null;
      if (near) { dist = Math.hypot(x - near[0], z - near[1]); if (maxD != null && dist > maxD) continue; }
      const o = { layer: L.id, ...brief(L, it, g) };
      if (dist != null) o.distance = fmtU(g, dist);
      for (const what of measures) {
        if (what === 'height') o.height = i >= 0 ? fmtU(g, H.data[i], 2) : null;
        else if (what === 'slope') o.slope_deg = i >= 0 ? Math.round(slopeField(g, H)[i]) : null;
        else if (what === 'zone') o.zone_here = Z && i >= 0 ? Z.meta.classes[Z.data[i]]?.name : null;
        else {
          if (!(what in fields)) { // a distance field per layer; to its own layer: the nearest other item
            const T2 = layerOf(what);
            fields[what] = T2 === L ? null : (src => (any(src) ? distanceField(g, src) : 'none'))(presence(g, T2, {}));
          }
          const f = fields[what];
          o[`distance_to_${what}`] = f === 'none' ? null : f ? (i >= 0 ? fmtU(g, f[i] * g.c) : null) : nearestOther(L, it);
        }
      }
      rows.push(o);
    }
  }
  if (near) rows.sort((a, b) => a.distance - b.distance);
  const total = rows.length, off = args.offset || 0, lim = args.limit || 200;
  rows = rows.slice(off, off + lim);
  return { data: { total, returned: rows.length, ...(total > off + rows.length ? { next_offset: off + rows.length } : {}), items: rows } };
};

function nearestOther(L, it) {
  const [x, z] = center(it);
  let best = Infinity;
  for (const o of L.items) if (o !== it) { const [ox, oz] = center(o); best = Math.min(best, Math.hypot(ox - x, oz - z)); }
  return isFinite(best) ? r2(best) : null;
}

T.analyze_items = args => {
  const g = G(), L = layerOf(args.layer);
  if (!L.hasItems) fail(`"${L.id}" has no items`);
  const r = region(args.region, g), kinds = args.kind?.length ? new Set(args.kind) : null;
  const items = L.items.filter(it => inRegion(g, r.m, it) && (!kinds || kinds.has(it.kind)));
  const n = items.length;
  if (!n) return { data: { count: 0, area: fmtU(g, r.area, 0) } };
  const P = items.map(center);
  // nearest neighbors (a grid of buckets)
  const cell = Math.max(g.c, Math.sqrt(r.area / n)), key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  const buckets = new Map();
  P.forEach((p, k) => { const kk = key(...p); if (!buckets.has(kk)) buckets.set(kk, []); buckets.get(kk).push(k); });
  const around = (p, rad) => {
    const out = [], cx = Math.floor(p[0] / cell), cz = Math.floor(p[1] / cell), s = Math.ceil(rad / cell);
    for (let a = cx - s; a <= cx + s; a++) for (let b = cz - s; b <= cz + s; b++) for (const k of buckets.get(`${a},${b}`) || []) out.push(k);
    return out;
  };
  const nn = P.map((p, k) => {
    let best = Infinity;
    for (let rad = cell; rad < 1e6 && best === Infinity; rad *= 2) {
      for (const j of around(p, rad)) if (j !== k) best = Math.min(best, Math.hypot(P[j][0] - p[0], P[j][1] - p[1]));
      if (n === 1) break;
    }
    return best;
  });
  const sorted = nn.filter(isFinite).sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const out = {
    count: n, area: fmtU(g, r.area, 0), per_1000_sq: r2(n / r.area * 1000),
    nearest_neighbor: sorted.length ? { min: fmtU(g, sorted[0]), median: fmtU(g, median), mean: fmtU(g, sorted.reduce((s, v) => s + v, 0) / sorted.length), max: fmtU(g, sorted.at(-1)) } : null,
  };
  if (args.min_distance) {
    const pairs = [];
    P.forEach((p, k) => { for (const j of around(p, args.min_distance)) if (j > k) { const d = Math.hypot(P[j][0] - p[0], P[j][1] - p[1]); if (d < args.min_distance) pairs.push({ ids: [items[k].id, items[j].id], distance: fmtU(g, d) }); } });
    out.too_close = { count: pairs.length, pairs: pairs.slice(0, 60) };
  }
  // groups: union of items within cluster_distance
  const cd = args.cluster_distance || Math.max(median * 2, g.c * 2), parent = items.map((_, k) => k);
  const find = k => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  P.forEach((p, k) => { for (const j of around(p, cd)) if (j > k && Math.hypot(P[j][0] - p[0], P[j][1] - p[1]) <= cd) parent[find(j)] = find(k); });
  const groups = new Map();
  items.forEach((it, k) => { const root = find(k); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(k); });
  const gl = [...groups.values()].map(ks => {
    const cx = ks.reduce((s, k) => s + P[k][0], 0) / ks.length, cz = ks.reduce((s, k) => s + P[k][1], 0) / ks.length;
    const kinds2 = {};
    for (const k of ks) kinds2[items[k].kind ?? 'note'] = (kinds2[items[k].kind ?? 'note'] || 0) + 1;
    return { count: ks.length, center: [r2(cx), r2(cz)], radius: fmtU(g, Math.max(...ks.map(k => Math.hypot(P[k][0] - cx, P[k][1] - cz)))), kinds: kinds2, ids: ks.map(k => items[k].id) };
  }).sort((a, b) => b.count - a.count);
  out.groups = { cluster_distance: fmtU(g, cd), count: gl.length, singles: gl.filter(x => x.count === 1).length, list: gl.slice(0, 60) };
  // gaps: the largest empty circles inside the region
  const want = args.gaps ?? 5;
  if (want) {
    const src = new Uint8Array(g.N * g.R);
    for (const [x, z] of P) { const i = cellOf(g, x, z); if (i >= 0) src[i] = 1; }
    const d = distanceField(g, src);
    out.gaps = peaks(g, r, d, want, 0).map(s => ({ center: s.center, radius: fmtU(g, s.value * g.c) }));
  }
  return { data: out };
};

/** The highest values of a field inside a region, at least their own value apart (largest empty circles...). */
function peaks(g, r, f, limit, minSep) {
  const cand = [];
  each(g, r.b, r.m, i => cand.push(i));
  cand.sort((a, b) => f[b] - f[a]);
  const out = [];
  for (const i of cand) {
    if (out.length >= limit) break;
    const x = cellX(g, i % g.N), z = cellZ(g, Math.floor(i / g.N)), sep = Math.max(minSep, f[i] * g.c);
    if (out.some(o => Math.hypot(o.center[0] - x, o.center[1] - z) < Math.max(sep, o.value * g.c))) continue;
    out.push({ center: [r2(x), r2(z)], value: f[i] });
  }
  return out;
}

ME.agentRead = { brief, each, inRegion, peaks, userContext, pct };
})(window.ME);
