// AI agent tools that analyze the map: spots by a measure, walkability (pockets, narrow passages, unreachable items)
// and routes (A* over the terrain). See js/agent-tools.js for the shared parts.
(function (ME) {
'use strict';

const T = ME.agentTools = ME.agentTools || {};
const { G, fail, region, regionMask, presence, itemsMask, distanceField, slopeField, blur, components, cellOf, cellX, cellZ, layerOf, itemLayers, heightLayer, coverLayers, blockingMask, metersIn, fmtU, r2, pt, A, any } = ME.agentInternals;
const { each, inRegion, pct } = ME.agentRead;
const center = it => A().itemCenter(it);

function union(g, layers, opts = {}) {
  const m = new Uint8Array(g.N * g.R);
  for (const L of layers) { const p = presence(g, L, opts); for (let i = 0; i < m.length; i++) m[i] |= p[i]; }
  return m;
}

// ------------------------------------------------------------------------------------------------ spots

T.find_spots = args => {
  const g = G(), r = region(args.region, g), metric = args.metric;
  const radius = (args.radius ?? metersIn(g, 15)) / g.c, limit = Math.max(1, Math.min(50, args.limit || 10));
  let f, used = [], unit = '', thr = null; // unit: what the value of high / low means
  if (['open', 'enclosed', 'empty'].includes(metric)) {
    const cov = coverLayers(args.layers);
    used = cov.map(L => L.id);
    if (!cov.length && metric !== 'empty') fail('No cover layers found: name them in "layers" (e.g. ["trees","rocks","buildings"])');
    const src = union(g, cov);
    if (metric === 'empty') for (const L of itemLayers()) { if (L.type === 'notes') continue; const p = itemsMask(g, L); for (let i = 0; i < src.length; i++) src[i] |= p[i]; used.push(L.id); }
    if (metric === 'enclosed') f = blur(g, Float32Array.from(src), radius / 2);
    else f = any(src) ? distanceField(g, src) : new Float32Array(g.N * g.R).fill(1e6);
  } else if (metric === 'high' || metric === 'low') {
    const H = heightLayer(null, true), mean = blur(g, H.data, radius / 2);
    f = new Float32Array(g.N * g.R);
    for (let i = 0; i < f.length; i++) f[i] = (H.data[i] - mean[i]) * (metric === 'high' ? 1 : -1);
    used = [H.id]; unit = `${g.unit.label} above the surroundings`;
    if (metric === 'low') unit = `${g.unit.label} below the surroundings`;
  } else if (metric === 'flat' || metric === 'steep') {
    const H = heightLayer(null, true), s = slopeField(g, H);
    f = metric === 'flat' ? s.map(v => 90 - v) : s; used = [H.id];
    if (metric === 'flat') thr = 90 - 8; // under 8°
  } else if (metric === 'far_from' || metric === 'near_to') {
    if (!args.layers?.length) fail(`${metric} needs "layers"`);
    const ls = args.layers.map(id => layerOf(id)), src = union(g, ls);
    used = ls.map(L => L.id);
    if (!any(src)) fail(`The layers ${used.join(', ')} have nothing on the map`);
    const d = distanceField(g, src);
    f = metric === 'far_from' ? d : d.map(v => -v);
  } else fail('metric is one of open, enclosed, high, low, flat, steep, empty, far_from, near_to');
  // the cells that stand out: above the 85th percentile in the region (or the fixed threshold), split into parts
  const vals = [];
  each(g, r.b, r.m, i => vals.push(f[i]));
  vals.sort((a, b) => a - b);
  thr ??= vals[Math.floor(vals.length * 0.85)];
  const cand = new Uint8Array(g.N * g.R);
  each(g, r.b, r.m, i => { if (f[i] >= thr) cand[i] = 1; }); // every metric: higher is more of it
  const { lab, parts } = components(g, cand), minCells = Math.max(4, (args.min_area || 0) / (g.c * g.c));
  const best = new Map();
  each(g, r.b, cand, i => { const l = lab[i], b = best.get(l); if (b == null || f[i] > f[b]) best.set(l, i); });
  let spots = parts.filter(p => p.count >= minCells).map(p => {
    const i = best.get(p.label), v = f[i];
    return { center: [r2(cellX(g, i % g.N)), r2(cellZ(g, Math.floor(i / g.N)))], value: v, area: p.count * g.c * g.c };
  });
  spots.sort((a, b) => (metric === 'flat' ? b.area - a.area : b.value * Math.sqrt(b.area) - a.value * Math.sqrt(a.area)));
  const sep = args.min_separation ?? radius * g.c * 2, out = [];
  for (const s of spots) {
    if (out.length >= limit) break;
    if (out.some(o => Math.hypot(o.center[0] - s.center[0], o.center[1] - s.center[1]) < sep)) continue;
    out.push(s);
  }
  const shown = v => (metric === 'enclosed' ? Math.round(v * 100) : metric === 'flat' ? Math.round(90 - v) : metric === 'near_to' ? fmtU(g, -v * g.c) : ['open', 'empty', 'far_from'].includes(metric) ? fmtU(g, v * g.c) : fmtU(g, v, 2));
  return {
    data: {
      metric, layers_used: used,
      value_means: { open: `distance to the nearest cover (${g.unit.label})`, empty: `distance to the nearest item or cover (${g.unit.label})`, enclosed: '% of the neighborhood covered', high: unit, low: unit, flat: 'slope (degrees) at the spot', steep: 'slope (degrees)', far_from: `distance (${g.unit.label})`, near_to: `distance (${g.unit.label})` }[metric],
      spots: out.map(s => ({ center: s.center, value: shown(s.value), area: fmtU(g, s.area, 0) })),
    },
  };
};

// ------------------------------------------------------------------------------------------------ walkability

function walkGrid(g, args, r) {
  const H = heightLayer(null, false), maxSlope = args.max_slope ?? 35;
  const block = blockingMask(g, args.blocking);
  const s = H ? slopeField(g, H) : null, walk = new Uint8Array(g.N * g.R);
  for (let i = 0; i < walk.length; i++) walk[i] = r.m[i] && !block.m[i] && (!s || s[i] <= maxSlope || block.pass?.[i]) ? 1 : 0;
  return { walk, block, s, maxSlope, H };
}

T.analyze_walkability = args => {
  const g = G(), r = region(args.region, g), { walk, block, s, maxSlope } = walkGrid(g, args, r);
  const { lab, parts } = components(g, walk);
  if (!parts.length) return { data: { walkable_pct: 0, note: 'Nothing in the region is walkable', blocking_layers: block.used } };
  let main = null;
  if (args.start) { const i = cellOf(g, ...pt(args.start, 'start')); if (i >= 0 && lab[i]) main = parts[lab[i] - 1]; }
  main ||= parts.reduce((a, b) => (b.count > a.count ? b : a));
  const at = p => [r2(cellX(g, p.cx)), r2(cellZ(g, p.cy))];
  const pockets = parts.filter(p => p !== main && p.count >= 4).sort((a, b) => b.count - a.count);
  // narrow passages: the middle line of the main part where it is narrower than narrow_width
  const width = (args.narrow_width ?? metersIn(g, 2)) / g.c, notWalk = walk.map((v, i) => (lab[i] === main.label ? 0 : 1));
  const d = distanceField(g, notWalk), narrow = new Uint8Array(g.N * g.R), N = g.N;
  each(g, r.b, walk, i => {
    if (lab[i] !== main.label || 2 * d[i] >= width) return;
    const x = i % N, y = (i - x) / N;
    if ((x > 0 && d[i - 1] > d[i]) || (x < N - 1 && d[i + 1] > d[i]) || (y > 0 && d[i - N] > d[i]) || (y < g.R - 1 && d[i + N] > d[i])) return;
    narrow[i] = 1;
  });
  const nar = components(g, narrow).parts.filter(p => p.count >= 2).sort((a, b) => b.count - a.count);
  // items standing where the player cannot get
  const check = args.check?.length ? args.check.map(id => layerOf(id)) : itemLayers().filter(L => L.type === 'objects' && L.meta.style !== 'footprint');
  const problems = [];
  for (const L of check) {
    for (const it of L.items) {
      if (!inRegion(g, r.m, it)) continue;
      const i = cellOf(g, ...center(it));
      if (i < 0) continue;
      let why = null;
      if (block.m[i]) why = 'on blocked ground';
      else if (s && s[i] > maxSlope) why = `on a slope of ${Math.round(s[i])}°`;
      else if (lab[i] && lab[i] !== main.label) why = 'in an isolated pocket';
      else if (!lab[i]) why = 'not on walkable ground';
      if (why) problems.push({ layer: L.id, id: it.id, kind: it.kind, x: r2(center(it)[0]), z: r2(center(it)[1]), problem: why });
    }
  }
  return {
    data: {
      max_slope_deg: maxSlope, blocking_layers: block.used, region_area: fmtU(g, r.area, 0),
      walkable_pct: pct(parts.reduce((a, p) => a + p.count, 0), r.b.count),
      main_part: { area: fmtU(g, main.count * g.c * g.c, 0), center: at(main), share_of_walkable_pct: pct(main.count, parts.reduce((a, p) => a + p.count, 0)) },
      pockets: { count: pockets.length, note: 'Walkable ground cut off from the main part: a player there is stuck, a player outside never gets in', list: pockets.slice(0, 25).map(p => ({ center: at(p), area: fmtU(g, p.count * g.c * g.c, 0) })) },
      narrow_passages: { width: fmtU(g, width * g.c), count: nar.length, list: nar.slice(0, 20).map(p => ({ center: at(p), length: fmtU(g, p.count * g.c) })) },
      unreachable_items: { count: problems.length, list: problems.slice(0, 60) },
    },
  };
};

// ------------------------------------------------------------------------------------------------ routes

function endpoint(g, spec, name) {
  if (!spec || typeof spec !== 'object') fail(`${name} is {"point":[x,z]}, {"item":{"layer":"...","id":1}} or a region`);
  if (spec.point) return pt(spec.point, name);
  if (spec.item) {
    const L = layerOf(spec.item.layer), it = L.items?.find(i => i.id === spec.item.id);
    if (!it) fail(`${name}: no item ${spec.item.id} in "${L.id}"`);
    return center(it);
  }
  const r = region(spec, g);
  let cx = 0, cy = 0;
  each(g, r.b, r.m, (i, x, y) => { cx += x; cy += y; });
  cx /= r.b.count; cy /= r.b.count;
  let best = null, bd = Infinity; // the cell of the region nearest to its middle
  each(g, r.b, r.m, (i, x, y) => { const d = (x - cx) ** 2 + (y - cy) ** 2; if (d < bd) { bd = d; best = [x, y]; } });
  return [cellX(g, best[0]), cellZ(g, best[1])];
}

/** A* on a coarser grid (at most ~400 cells a side); costs: slope, preferred layers, danger near avoided things. */
function route(g, args) {
  const from = endpoint(g, args.from, 'from'), to = endpoint(g, args.to, 'to');
  const { walk, block, s, maxSlope } = walkGrid(g, args, { m: new Uint8Array(g.N * g.R).fill(1) });
  const f = Math.max(1, Math.ceil(Math.max(g.N, g.R) / 400)), W = Math.ceil(g.N / f), Hh = Math.ceil(g.R / f);
  const fine = (x, y) => Math.min(g.R - 1, y * f + (f >> 1)) * g.N + Math.min(g.N - 1, x * f + (f >> 1));
  const prefer = args.prefer?.length ? args.prefer.map(id => presence(g, layerOf(id))) : [];
  let danger = null, dangerD = 0;
  if (args.avoid?.length) {
    danger = new Float32Array(g.N * g.R).fill(Infinity);
    for (const a of args.avoid) {
      const src = a.region ? regionMask(a.region, g) : presence(g, layerOf(a.layer), { min: a.min ?? 50 });
      if (!any(src)) continue;
      const d = distanceField(g, src), D = (a.distance ?? metersIn(g, 20)) / g.c;
      dangerD = Math.max(dangerD, D);
      for (let i = 0; i < d.length; i++) { const v = d[i] / D; if (v < danger[i]) danger[i] = v; } // 0 at the source, 1 at distance
    }
  }
  const cost = new Float32Array(W * Hh);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const i = fine(x, y);
    if (!walk[i]) { cost[y * W + x] = Infinity; continue; }
    let c = 1 + 3 * (s ? (s[i] / maxSlope) ** 2 : 0);
    if (prefer.some(p => p[i])) c *= 0.35;
    if (danger && danger[i] < 1) c += 25 * (1 - danger[i]);
    cost[y * W + x] = c;
  }
  const toNode = ([x, z]) => {
    const cx = Math.max(0, Math.min(W - 1, Math.floor((x - g.w.x0) / g.c / f))), cy = Math.max(0, Math.min(Hh - 1, Math.floor((z - g.w.z0) / g.c / f)));
    let best = cy * W + cx;
    if (isFinite(cost[best])) return best;
    for (let rad = 1; rad < 30; rad++) { // the nearest walkable node
      for (let y = cy - rad; y <= cy + rad; y++) for (let x = cx - rad; x <= cx + rad; x++) {
        if (x < 0 || y < 0 || x >= W || y >= Hh || Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== rad) continue;
        if (isFinite(cost[y * W + x])) return y * W + x;
      }
    }
    return best;
  };
  const sN = toNode(from), tN = toNode(to);
  if (!isFinite(cost[sN]) || !isFinite(cost[tN])) return { ok: false, why: `The ${!isFinite(cost[sN]) ? 'start' : 'end'} is not on walkable ground (slope over ${maxSlope}° or a blocking layer: ${block.used.join(', ') || 'none'})` };
  const gs = new Float32Array(W * Hh).fill(Infinity), came = new Int32Array(W * Hh).fill(-1), closed = new Uint8Array(W * Hh);
  const tx = tN % W, ty = (tN - tx) / W, h = n => { const x = n % W, y = (n - x) / W; return Math.hypot(x - tx, y - ty) * 0.35; };
  const heap = new Heap();
  gs[sN] = 0; heap.push(sN, h(sN));
  const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (heap.size) {
    const n = heap.pop();
    if (n === tN) break;
    if (closed[n]) continue;
    closed[n] = 1;
    const x = n % W, y = (n - x) / W;
    for (const [dx, dy] of D8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= Hh) continue;
      const m = ny * W + nx, c = cost[m];
      if (!isFinite(c) || closed[m]) continue;
      if (dx && dy && (!isFinite(cost[y * W + nx]) || !isFinite(cost[ny * W + x]))) continue; // no cutting corners
      const ng = gs[n] + c * (dx && dy ? Math.SQRT2 : 1);
      if (ng < gs[m]) { gs[m] = ng; came[m] = n; heap.push(m, ng + h(m)); }
    }
  }
  if (!isFinite(gs[tN])) return { ok: false, why: 'No walkable route connects them (water, cliffs, steep slopes or blocking layers are in between)' };
  let path = [];
  for (let n = tN; n !== -1; n = came[n]) { const x = n % W, y = (n - x) / W; path.push([g.w.x0 + (x * f + f / 2) * g.c, g.w.z0 + (y * f + f / 2) * g.c]); }
  path.reverse();
  path[0] = from; path[path.length - 1] = to;
  path = simplify(path, f * g.c * 0.8).map(([x, z]) => [r2(x), r2(z)]);
  let len = 0, maxS = 0, minDanger = Infinity, onPreferred = 0, samples = 0;
  for (let k = 1; k < path.length; k++) {
    const [ax, az] = path[k - 1], [bx, bz] = path[k], l = Math.hypot(bx - ax, bz - az);
    len += l;
    for (let t = 0; t <= l; t += g.c) {
      const i = cellOf(g, ax + (bx - ax) * t / (l || 1), az + (bz - az) * t / (l || 1));
      if (i < 0) continue;
      samples++;
      if (s) maxS = Math.max(maxS, s[i]);
      if (danger) minDanger = Math.min(minDanger, danger[i] * dangerD * g.c);
      if (prefer.some(p => p[i])) onPreferred++;
    }
  }
  return {
    ok: true, points: path, length: fmtU(g, len, 0), max_slope_deg: Math.round(maxS),
    ...(danger ? { closest_to_avoided: fmtU(g, minDanger) } : {}), ...(prefer.length ? { on_preferred_pct: pct(onPreferred, samples) } : {}),
    blocking_layers: block.used,
  };
}

/** Ramer–Douglas–Peucker. */
function simplify(p, tol) {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bd = tol;
    for (let k = a + 1; k < b; k++) {
      const [x, z] = p[k], [ax, az] = p[a], [bx, bz] = p[b], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0, d = Math.hypot(x - ax - dx * t, z - az - dz * t);
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return p.filter((_, k) => keep[k]);
}

class Heap {
  constructor() { this.n = []; this.p = []; }
  get size() { return this.n.length; }
  push(node, pri) {
    const n = this.n, p = this.p;
    let i = n.length;
    n.push(node); p.push(pri);
    while (i > 0) { const j = (i - 1) >> 1; if (p[j] <= pri) break; n[i] = n[j]; p[i] = p[j]; i = j; }
    n[i] = node; p[i] = pri;
  }
  pop() {
    const n = this.n, p = this.p, top = n[0], ln = n.pop(), lp = p.pop();
    if (n.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n.length) break;
        if (c + 1 < n.length && p[c + 1] < p[c]) c++;
        if (p[c] >= lp) break;
        n[i] = n[c]; p[i] = p[c]; i = c;
      }
      n[i] = ln; p[i] = lp;
    }
    return top;
  }
}

T.find_route = (args, ctx) => {
  const g = G(), r = route(g, args);
  if (!r.ok) return { data: { found: false, why: r.why } };
  const { ok: _ok, ...data } = r;
  if (args.add_to) {
    if (!ctx.canWrite) fail('The user lets the agent read only: the route was found but not added');
    const L = layerOf(args.add_to.layer, ['vector']);
    ME.agentWrite.addItems(L, [{ kind: args.add_to.kind || 'route', points: r.points, ...(args.add_to.width != null ? { width: args.add_to.width } : {}), ...(args.add_to.props ? { props: args.add_to.props } : {}) }], `AI: route on ${L.meta.name}`, ctx);
    data.added_to = { layer: L.id, id: L.items.at(-1).id };
  }
  return { data: { found: true, ...data } };
};

ME.agentAnalysis = { route, simplify };
})(window.ME);
