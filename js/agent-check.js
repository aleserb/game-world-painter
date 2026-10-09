// How the agent sees its own changes before the user does: check_change compares the map with the change and
// without it (its undo steps are undone and redone for a moment), lists what changed, checks the placed objects
// (overlaps, water, roads, uneven ground, bridges: both ends on land, across the water), and draws the place before
// and after as images. end_change and the changing calls run the same checks (without images). find_crossing finds
// where a river is narrowest and gives the two bank points for a bridge (add_items with "a" and "b").
(function (ME) {
'use strict';

const T = ME.agentTools;
const { G, fail, region, slopeField, distanceField, bounds, cellOf, cellX, cellZ, layerOf, heightLayer, waterMask, isCrossing, nameOf,
  metersIn, fmtU, r2, num, pt, A } = ME.agentInternals;
const { mapCanvas } = ME.agentRead;

const WATER_OK_RE = /bridge|crossing|ford|stepping|plank|walkway|boardwalk|ferry|pier|dock|jetty|wharf|boat|ship|raft|buoy|reed|lily|fish|water|mill|net|canoe/i;
const ROAD_OK_RE = /road|street|path|trail|bridge|gate|sign|lamp|lantern|post|cart|wagon|milestone|crossing/i;
const ROAD_RE = /road|street|path|trail|track/i;
const deg = rad => rad * 180 / Math.PI;
const ref = (L, it) => ({ layer: L.id, id: it.id, kind: it.kind ?? (L.type === 'notes' ? 'note' : '') });
const name = (L, it) => `${it.kind || 'item'} #${it.id} (${L.id})`;
const P2 = p => [r2(p[0]), r2(p[1])];

// ------------------------------------------------------------------------------------------------ geometry

/** An object on the ground: {poly, ends, len} for footprints and links (a strip), {point} for markers; null for others. */
function shapeOf(g, L, it) {
  if (L.type !== 'objects' || it.points) return null;
  if (L.meta.style === 'link' && it.a && it.b) {
    const [ax, az] = it.a, [bx, bz] = it.b, len = Math.hypot(bx - ax, bz - az) || 1e-6, r = metersIn(g, 0.6);
    const nx = -(bz - az) / len * r, nz = (bx - ax) / len * r;
    return { poly: [[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]], ends: [it.a, it.b], len };
  }
  if (L.meta.style === 'footprint' || it.w != null) {
    const poly = ME.footprintCorners(it, g.k), w = it.w ?? g.k, d = it.d ?? w;
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const ends = w >= d ? [mid(poly[0], poly[3]), mid(poly[1], poly[2])] : [mid(poly[0], poly[1]), mid(poly[3], poly[2])];
    return { poly, ends, len: Math.max(w, d) };
  }
  return typeof it.x === 'number' ? { point: [it.x, it.z] } : null;
}

/** How deep two convex polygons overlap (0: apart or touching), by separating axes. */
function overlapDepth(P, Q) {
  let min = Infinity;
  for (const poly of [P, Q]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
      let nx = z1 - z2, nz = x2 - x1;
      const l = Math.hypot(nx, nz);
      if (!l) continue;
      nx /= l; nz /= l;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, z] of P) { const d = x * nx + z * nz; if (d < a0) a0 = d; if (d > a1) a1 = d; }
      for (const [x, z] of Q) { const d = x * nx + z * nz; if (d < b0) b0 = d; if (d > b1) b1 = d; }
      const o = Math.min(a1, b1) - Math.max(a0, b0);
      if (o <= 0) return 0;
      if (o < min) min = o;
    }
  }
  return min;
}

function inPoly(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** The cells whose centers are inside a polygon (at least the cell of its middle). */
function cellsIn(g, poly) {
  const xs = poly.map(p => p[0]), zs = poly.map(p => p[1]), out = [];
  const i0 = Math.max(0, Math.floor((Math.min(...xs) - g.w.x0) / g.c)), i1 = Math.min(g.N - 1, Math.floor((Math.max(...xs) - g.w.x0) / g.c));
  const j0 = Math.max(0, Math.floor((Math.min(...zs) - g.w.z0) / g.c)), j1 = Math.min(g.R - 1, Math.floor((Math.max(...zs) - g.w.z0) / g.c));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (inPoly(poly, cellX(g, i), cellZ(g, j))) out.push(j * g.N + i);
  if (!out.length) { const k = cellOf(g, xs.reduce((a, b) => a + b) / xs.length, zs.reduce((a, b) => a + b) / zs.length); if (k >= 0) out.push(k); }
  return out;
}

const inMap = (g, x, z) => x >= g.w.x0 && z >= g.w.z0 && x <= g.w.x0 + g.w.width && z <= g.w.z0 + g.w.height;

/** The share of cells within r of a point that are set in mask m. */
function shareNear(g, m, x, z, r) {
  const R = Math.max(1, Math.round(r / g.c)), ci = Math.floor((x - g.w.x0) / g.c), cj = Math.floor((z - g.w.z0) / g.c);
  let n = 0, k = 0;
  for (let j = cj - R; j <= cj + R; j++) for (let i = ci - R; i <= ci + R; i++) {
    if (i < 0 || j < 0 || i >= g.N || j >= g.R || (i - ci) ** 2 + (j - cj) ** 2 > R * R) continue;
    n++; if (m[j * g.N + i]) k++;
  }
  return n ? k / n : 0;
}

/** The direction the water runs at a point: along the nearest river path, else along the banks around it (the main
 *  axis of the water's edge cells within radius). null where it is unclear (a pond, a bend, open water). */
function flowAt(g, W, x, z, radius) {
  let best = null;
  for (const L of g.S.layers) {
    if (L.type !== 'vector' || !/river|stream|creek|canal|water/i.test(nameOf(L))) continue;
    for (const it of L.items) {
      const s = L.samples(it);
      for (let k = 1; k < s.length; k++) {
        const [ax, az] = s[k - 1], [bx, bz] = s[k], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        if (!l2) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)), d = Math.hypot(ax + t * dx - x, az + t * dz - z);
        if (!best || d < best.d) best = { d, dir: [dx / Math.sqrt(l2), dz / Math.sqrt(l2)], width: (s[k][2] || L.widthOf(it) || 0) };
      }
    }
  }
  if (best && best.d <= best.width / 2 + metersIn(g, 3)) return { dir: best.dir, by: 'the river path' };
  const r = Math.max(2, Math.round(radius / g.c)), ci = Math.floor((x - g.w.x0) / g.c), cj = Math.floor((z - g.w.z0) / g.c), N = g.N;
  let n = 0, sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0;
  for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
    if (i < 1 || j < 1 || i >= N - 1 || j >= g.R - 1 || (i - ci) ** 2 + (j - cj) ** 2 > r * r) continue;
    const k = j * N + i;
    if (!W[k] || (W[k - 1] && W[k + 1] && W[k - N] && W[k + N])) continue; // the water's edge only
    n++; sx += i; sz += j; sxx += i * i; szz += j * j; sxz += i * j;
  }
  if (n < 6) return null;
  const a = sxx / n - (sx / n) ** 2, c = szz / n - (sz / n) ** 2, b = sxz / n - (sx / n) * (sz / n);
  const h = Math.sqrt(((a - c) / 2) ** 2 + b * b), l1 = (a + c) / 2 + h, l2 = (a + c) / 2 - h;
  if (!(l1 > 0) || l2 / l1 > 0.35) return null; // no clear channel
  const th = 0.5 * Math.atan2(2 * b, a - c);
  return { dir: [Math.cos(th), Math.sin(th)], by: 'the banks' };
}

/** The angle between a line and the flow, 0–90° (90: straight across). */
const angleTo = (dir, flow) => r2(deg(Math.acos(Math.min(1, Math.abs(dir[0] * flow[0] + dir[1] * flow[1])))));

// ------------------------------------------------------------------------------------------------ checks of objects

/** Lazily computed facts of the map that the checks need. */
function facts(g) {
  const f = {};
  return {
    get water() { return (f.water ??= waterMask(g)).m; },
    get roads() {
      if (!f.roads) {
        f.roads = new Uint8Array(g.N * g.R);
        for (const L of g.S.layers) {
          if (!ROAD_RE.test(nameOf(L)) || /rail|border/i.test(nameOf(L))) continue;
          if (L.type === 'mask') { const d = L.data; for (let i = 0; i < d.length; i++) if (d[i] >= 128) f.roads[i] = 1; }
          else if (L.type === 'vector') { const m = ME.agentInternals.itemsMask(g, L); for (let i = 0; i < m.length; i++) if (m[i]) f.roads[i] = 1; }
        }
      }
      return f.roads;
    },
    get H() { return (f.H ??= { L: heightLayer(null, false) }).L; },
    get slope() { return (f.slope ??= this.H ? slopeField(g, this.H) : null); },
    get solids() { // every object with an outline on the ground
      if (!f.solids) {
        f.solids = [];
        for (const L of g.S.layers) if (L.type === 'objects') for (const it of L.items) { const s = shapeOf(g, L, it); if (s?.poly) f.solids.push({ L, it, s }); }
      }
      return f.solids;
    },
    get points() {
      if (!f.points) {
        f.points = [];
        for (const L of g.S.layers) if (L.type === 'objects') for (const it of L.items) { const s = shapeOf(g, L, it); if (s?.point) f.points.push({ L, it, s }); }
      }
      return f.points;
    },
  };
}

/** Checks objects placed or moved by the agent. targets: [{L, it}]. Returns {problems, warnings, items}. */
function checkItems(g, targets, F = facts(g)) {
  const problems = [], warnings = [], notes = [], seen = new Set(), k = g.k;
  const same = (a, b) => a.L === b.L && a.it.id === b.it.id;
  const isTarget = o => targets.some(t => same(t, o));
  const add = (list, t, check, message, fix, more = {}) => list.push({ item: ref(t.L, t.it), check, message, ...(fix ? { fix } : {}), ...more });
  for (const t of targets) {
    const { L, it } = t, s = shapeOf(g, L, it);
    if (!s) continue;
    const info = { ...ref(L, it) };
    notes.push(info);
    const waterOk = WATER_OK_RE.test(it.kind || ''), crossing = isCrossing(L, it);
    if (s.point) {
      const [x, z] = s.point;
      if (!inMap(g, x, z)) { add(problems, t, 'outside_map', `${name(L, it)} is outside the map`); continue; }
      const i = cellOf(g, x, z);
      if (!waterOk && F.water[i]) add(warnings, t, 'in_water', `${name(L, it)} stands in the water`, 'move it to dry land (or is it meant to be there?)');
      const inside = F.solids.find(o => !same(o, t) && !isCrossing(o.L, o.it) && inPoly(o.s.poly, x, z));
      if (inside) add(warnings, t, 'inside', `${name(L, it)} is inside ${name(inside.L, inside.it)}`, 'move it out of the outline, unless it belongs inside');
      continue;
    }
    if (s.poly.some(([x, z]) => !inMap(g, x, z))) add(problems, t, 'outside_map', `${name(L, it)} is (partly) outside the map`);
    // overlaps with other objects that have an outline (each pair of the agent's objects once)
    for (const o of F.solids) {
      if (same(o, t)) continue;
      const key = isTarget(o) ? [`${t.L.id}#${t.it.id}`, `${o.L.id}#${o.it.id}`].sort().join('|') : null;
      if (key && seen.has(key)) continue;
      const depth = overlapDepth(s.poly, o.s.poly);
      if (!depth) continue;
      if (key) seen.add(key);
      if (depth >= metersIn(g, 0.5)) add(problems, t, 'overlap', `${name(L, it)} overlaps ${name(o.L, o.it)} by ${fmtU(g, depth)} ${g.unit.label}`, 'move one of them (update_items "move" or new "a"/"b"), or make it smaller', { other: ref(o.L, o.it) });
      else if (depth >= metersIn(g, 0.1)) add(warnings, t, 'touches', `${name(L, it)} touches ${name(o.L, o.it)}`, null, { other: ref(o.L, o.it) });
    }
    const covered = F.points.filter(o => !isTarget(o) && o.L !== L && inPoly(s.poly, ...o.s.point));
    if (covered.length && !crossing) add(warnings, t, 'covers', `${name(L, it)} covers ${covered.length} object(s): ${covered.slice(0, 5).map(o => name(o.L, o.it)).join(', ')}`, 'move them or it');
    // the ground under it
    const cells = cellsIn(g, s.poly), W = F.water;
    let wet = 0, road = 0, lo = Infinity, hi = -Infinity, steep = 0;
    const H = F.H, S = F.slope, roads = !crossing && !ROAD_OK_RE.test(it.kind || '') ? F.roads : null;
    for (const i of cells) {
      if (W[i]) wet++;
      if (roads && roads[i]) road++;
      if (H) { const h = H.data[i]; if (h < lo) lo = h; if (h > hi) hi = h; if (S[i] > steep) steep = S[i]; }
    }
    const n = cells.length || 1;
    info.water_pct = Math.round(wet / n * 100);
    if (H) Object.assign(info, { ground: [fmtU(g, lo, 2), fmtU(g, hi, 2)], max_slope_deg: Math.round(steep) });
    if (crossing) {
      // a bridge: both ends on dry land, over the water between, across the flow
      const [a, b] = s.ends, len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6, dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const endR = Math.max(metersIn(g, 0.5), g.c), wetA = shareNear(g, W, a[0], a[1], endR), wetB = shareNear(g, W, b[0], b[1], endR);
      Object.assign(info, { ends: { a: P2(a), b: P2(b) }, length: fmtU(g, len) });
      for (const [end, p, w] of [['a', a, wetA], ['b', b, wetB]]) {
        if (w >= 0.5) add(problems, t, 'end_in_water', `${name(L, it)}: its end ${end} (${P2(p).join(', ')}) is in the water`, 'make it longer or move it so that both ends are on the banks (find_crossing gives the bank points; place it with "a" and "b")');
      }
      let first = -1, last = -1;
      for (let d = 0, q = 0; d <= len; d += g.c / 2, q++) {
        const i = cellOf(g, a[0] + dir[0] * d, a[1] + dir[1] * d);
        if (i >= 0 && W[i]) { if (first < 0) first = d; last = d; }
      }
      if (first < 0) { add(warnings, t, 'no_water', `${name(L, it)} does not cross any water`, 'is it in the right place? (find_crossing)'); continue; }
      info.water_span = fmtU(g, last - first + g.c / 2);
      const mid = [a[0] + dir[0] * (first + last) / 2, a[1] + dir[1] * (first + last) / 2];
      const flow = flowAt(g, W, mid[0], mid[1], Math.max(metersIn(g, 8), 1.5 * (last - first)));
      if (flow) {
        const angle = angleTo(dir, flow.dir);
        Object.assign(info, { angle_to_flow_deg: angle, flow: P2(flow.dir) });
        if (angle < 60) add(problems, t, 'along_the_water', `${name(L, it)} runs at ${Math.round(angle)}° to the flow (0°: along the water, 90°: straight across)`, `turn it across: find_crossing gives the narrowest place and the bank points a, b (yaw ≈ ${r2(deg(Math.atan2(-flow.dir[0], -flow.dir[1])))})`);
        else if (angle < 75) add(warnings, t, 'oblique', `${name(L, it)} crosses the water at ${Math.round(angle)}° (straight across is 90°)`);
      }
      continue;
    }
    if (!waterOk && wet / n > 0.15) add(problems, t, 'in_water', `${name(L, it)} stands in the water (${info.water_pct} % of its outline)`, 'move it to dry land (describe_region, find_spots "empty" with the water layer)');
    else if (!waterOk && wet / n > 0.03) add(warnings, t, 'wet', `${name(L, it)} touches the water (${info.water_pct} %)`);
    if (roads && road / n > 0.25) add(warnings, t, 'on_road', `${name(L, it)} stands on a road (${Math.round(road / n * 100)} % of its outline)`, 'move it off the road');
    if (H && hi - lo > 1.5 * k) add(warnings, t, 'uneven_ground', `${name(L, it)} stands on uneven ground: heights ${fmtU(g, lo, 2)} … ${fmtU(g, hi, 2)} ${g.unit.label}`, `flatten it: edit_terrain {"op":"flatten","region":{"items":{"layer":"${L.id}","ids":[${it.id}]}}}`);
  }
  return { problems, warnings, items: notes };
}

// ------------------------------------------------------------------------------------------------ a change: before and after

const contentOf = P => P.entries.filter(e => e.content);
const layersOf = (g, es) => [...new Set(es.flatMap(e => e.layers || [e.layer]).filter(Boolean))].filter(L => g.S.layers.includes(L));

/** Can the change be undone and redone for a moment? Only while no later step changed its layers. */
function canToggle(es) {
  const h = A().history.undo, set = new Set(es);
  for (const e of es) {
    const k = h.indexOf(e);
    if (k < 0) return false;
    for (let j = k + 1; j < h.length; j++) {
      const f = h[j];
      if (!set.has(f) && f.content && (f.layer === e.layer || f.layers?.includes(e.layer))) return false;
    }
  }
  return true;
}

/** Runs fn on the map before the change (state 'before') or with it ('after'), then leaves it as it was. */
function inState(P, state, fn) {
  const es = contentOf(P), now = P.before ? 'before' : 'after';
  if (state === now) return fn();
  const was = ME.agentApplying;
  ME.agentApplying = true;
  const undo = () => { for (const e of [...es].reverse()) e.undo(); }, redo = () => { for (const e of es) e.redo(); };
  try {
    if (state === 'before') undo(); else redo();
    return fn();
  } finally {
    if (state === 'before') redo(); else undo();
    ME.agentApplying = was;
  }
}

const snap = layers => new Map(layers.map(L => [L, L.hasItems ? structuredClone(L.items) : L.data ? L.data.slice() : null]));

/** What a change did, layer by layer; changed cells (a mask), and the objects it added, changed and removed. */
function diff(g, P) {
  const es = contentOf(P), layers = layersOf(g, es);
  const after = inState(P, 'after', () => snap(layers)), before = inState(P, 'before', () => snap(layers));
  const out = {}, cells = new Uint8Array(g.N * g.R), targets = [], removed = [], changedBefore = [];
  let anyCells = false;
  for (const L of layers) {
    const a = after.get(L), b = before.get(L);
    if (!a || !b) continue;
    if (L.hasItems) {
      const ba = new Map(b.map(i => [i.id, i])), aa = new Map(a.map(i => [i.id, i]));
      const added = a.filter(i => !ba.has(i.id)), gone = b.filter(i => !aa.has(i.id));
      const changed = a.filter(i => ba.has(i.id) && JSON.stringify(i) !== JSON.stringify(ba.get(i.id)));
      if (!added.length && !gone.length && !changed.length) continue;
      const live = id => L.items.find(i => i.id === id) || aa.get(id);
      for (const i of [...added, ...changed]) targets.push({ L, it: live(i.id), added: added.includes(i) });
      for (const i of gone) removed.push({ L, it: i });
      for (const i of changed) changedBefore.push({ L, it: ba.get(i.id) });
      out[L.id] = {
        ...(added.length ? { added: added.slice(0, 30).map(i => ME.agentRead.brief(L, i, g)), added_count: added.length } : {}),
        ...(changed.length ? { changed: changed.slice(0, 30).map(i => ({ id: i.id, kind: i.kind, fields: Object.keys({ ...i, ...ba.get(i.id) }).filter(f => JSON.stringify(i[f]) !== JSON.stringify(ba.get(i.id)[f])) })), changed_count: changed.length } : {}),
        ...(gone.length ? { removed: gone.slice(0, 30).map(i => ME.agentRead.brief(L, i, g)), removed_count: gone.length } : {}),
      };
    } else {
      let n = 0, lo = Infinity, hi = -Infinity, sum = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        n++; cells[i] = 1; const d = a[i] - b[i]; sum += d; if (d < lo) lo = d; if (d > hi) hi = d;
      }
      if (!n) continue;
      anyCells = true;
      const o = { changed_area: fmtU(g, n * g.c * g.c, 0) };
      if (L.type === 'mask') o.mean_change_pct = Math.round(sum / n / 2.55);
      if (L.type === 'height') Object.assign(o, { height_change: [fmtU(g, lo, 2), fmtU(g, hi, 2)] });
      if (L.type === 'category') {
        const to = {};
        for (let i = 0; i < a.length; i++) if (cells[i] && a[i] !== b[i]) { const c = L.meta.classes[a[i]]?.name ?? a[i]; to[c] = (to[c] || 0) + 1; }
        o.painted = Object.fromEntries(Object.entries(to).map(([c, v]) => [c, fmtU(g, v * g.c * g.c, 0)]));
      }
      out[L.id] = o;
    }
  }
  return { layers: out, cells: anyCells ? cells : null, targets, removed, changedBefore };
}

/** The box around everything a change touched (with some room around it). */
function changeBox(g, d) {
  let b = null;
  const add = (x0, z0, x1, z1) => { b = b ? [Math.min(b[0], x0), Math.min(b[1], z0), Math.max(b[2], x1), Math.max(b[3], z1)] : [x0, z0, x1, z1]; };
  if (d.cells) { const k = bounds(g, d.cells); if (k.count) add(g.w.x0 + k.x0 * g.c, g.w.z0 + k.y0 * g.c, g.w.x0 + k.x1 * g.c, g.w.z0 + k.y1 * g.c); }
  for (const o of [...d.targets, ...d.removed, ...d.changedBefore]) {
    const s = shapeOf(g, o.L, o.it), pts = s?.poly || (s?.point ? [s.point] : o.it.points || (typeof o.it.x === 'number' ? [[o.it.x, o.it.z]] : []));
    for (const [x, z] of pts) add(x, z, x, z);
  }
  if (!b) return null;
  const pad = Math.max((b[2] - b[0]) * 0.25, (b[3] - b[1]) * 0.25, metersIn(g, 6)), min = metersIn(g, 16);
  let [x0, z0, x1, z1] = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  if (x1 - x0 < min) { const c = (x0 + x1) / 2; x0 = c - min / 2; x1 = c + min / 2; }
  if (z1 - z0 < min) { const c = (z0 + z1) / 2; z0 = c - min / 2; z1 = c + min / 2; }
  return [x0, z0, x1, z1];
}

/** Draws the outlines of objects (and the length of crossings, a → b) over a map image. */
function drawItems(g, m, list, color, { dash = false, tag = '' } = {}) {
  const { ctx, v } = m;
  ctx.save();
  ctx.font = 'bold 11px system-ui';
  for (const o of list) {
    const s = shapeOf(g, o.L, o.it);
    let lx, ly;
    ctx.setLineDash(dash ? [6, 4] : []);
    if (s?.poly) {
      const pts = s.poly.map(p => v.toScreen(p[0], p[1]));
      const path = () => { ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
      path(); ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(10,8,14,0.85)'; ctx.stroke();
      path(); ctx.lineWidth = 2.2; ctx.strokeStyle = color; ctx.stroke();
      [lx, ly] = pts.reduce((a, p) => (p[1] < a[1] ? p : a));
      if (isCrossing(o.L, o.it) || o.L.meta.style === 'link') { // the length, from a to b, with an arrow at b
        const [a, b] = s.ends.map(p => v.toScreen(p[0], p[1])), an = Math.atan2(b[1] - a[1], b[0] - a[0]);
        ctx.setLineDash([]); ctx.lineWidth = 1.6; ctx.strokeStyle = color;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        ctx.lineTo(b[0] - 9 * Math.cos(an - 0.45), b[1] - 9 * Math.sin(an - 0.45)); ctx.moveTo(b[0], b[1]);
        ctx.lineTo(b[0] - 9 * Math.cos(an + 0.45), b[1] - 9 * Math.sin(an + 0.45)); ctx.stroke();
        ctx.fillStyle = color; ctx.fillText('a', a[0] - 10, a[1] - 4); ctx.fillText('b', b[0] + 4, b[1] - 4);
      }
    } else if (s?.point || typeof o.it.x === 'number') {
      const [x, y] = v.toScreen(...(s?.point || [o.it.x, o.it.z]));
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(10,8,14,0.85)'; ctx.stroke();
      ctx.lineWidth = 2.2; ctx.strokeStyle = color; ctx.stroke();
      [lx, ly] = [x + 6, y - 8];
    } else if (o.it.points) {
      const pts = o.L.samples(o.it).map(p => v.toScreen(p[0], p[1]));
      ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.lineWidth = 2.2; ctx.strokeStyle = color; ctx.stroke();
      [lx, ly] = pts[0];
    }
    if (lx != null) {
      ctx.setLineDash([]);
      const text = `${tag}#${o.it.id} ${o.it.kind || ''}`.trim();
      const w = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(16,13,20,0.8)'; ctx.fillRect(lx - 2, ly - 15, w + 4, 14);
      ctx.fillStyle = color; ctx.fillText(text, lx, ly - 4);
    }
  }
  ctx.restore();
}

function corner(m, text, color) {
  const { ctx } = m;
  ctx.save();
  ctx.font = 'bold 15px system-ui';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(16,13,20,0.85)'; ctx.fillRect(6, m.cv.height - 30, w + 14, 24);
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, 13, m.cv.height - 18);
  ctx.restore();
}

/** Checks a change of the agent: what changed, the checks of its objects, and (images) the place before and after. */
function checkChange(g, P, { images = false, size = 640, layers = null } = {}) {
  const es = contentOf(P);
  if (!es.length) return { data: { change: changeRef(P), layers: {}, problems: [], warnings: [], ok: true, note: 'Nothing on the map changed yet' } };
  if (!canToggle(es)) fail('The user changed the same layers after this change: it cannot be compared any more. Look with describe_region and render_map.');
  const d = diff(g, P), res = checkItems(g, d.targets);
  const problemIds = new Set(res.problems.map(p => `${p.item.layer}#${p.item.id}`));
  const data = {
    change: changeRef(P), layers: d.layers, checked_objects: res.items, problems: res.problems.slice(0, 40), warnings: res.warnings.slice(0, 40),
    ok: !res.problems.length,
    ...(res.problems.length > 40 ? { more_problems: res.problems.length - 40 } : {}),
  };
  if (!images) return { data };
  const box = changeBox(g, d);
  if (!box) return { data };
  const draw = () => mapCanvas(g, box, { size, layers, selection: false });
  const after = inState(P, 'after', draw), before = inState(P, 'before', draw);
  const bad = d.targets.filter(t => problemIds.has(`${t.L.id}#${t.it.id}`)), good = d.targets.filter(t => !bad.includes(t));
  for (const [m, label, color] of [[before, 'BEFORE', '#cfd3dc'], [after, 'AFTER', '#ffb347']]) {
    if (d.cells) m.outline(d.cells, '#ffe14d', m === before);
    m.grid();
    corner(m, label, color);
  }
  drawItems(g, before, [...d.changedBefore, ...d.removed], '#ffb347', { dash: true });
  drawItems(g, after, d.removed, '#ff5c5c', { dash: true, tag: 'removed ' });
  drawItems(g, after, good, '#ffb347');
  drawItems(g, after, bad, '#ff4040', { tag: '! ' });
  return {
    data,
    text: `${after.describe()} Image 1: BEFORE the change. Image 2: AFTER — orange: objects added or changed (#id kind; on crossings a line from end a to end b), red with "!": objects with problems, dashed red: removed objects, yellow: changed cells${d.cells ? '' : ' (none)'}.`,
    images: [before.image(), after.image()],
  };
}

const changeRef = P => ({ id: P.id, title: P.title, status: P.status, review: !!P.review });

/** For js/agent-review.js: the checks (no images) of a change or of the steps of one call. */
ME.agentCheck = {
  change(P) {
    try { return checkChange(G(), P).data; } catch (e) { return { problems: [], warnings: [], error: e.message }; }
  },
  steps(entries) { return this.change({ id: 0, title: '', status: 'open', entries, before: false }); },
};

// ------------------------------------------------------------------------------------------------ tools

T.check_change = args => {
  const g = G(), R = ME.agentReview, size = Math.max(256, Math.min(1200, args.size || 640));
  if (args.items) {
    const L = layerOf(args.items.layer), ids = new Set(args.items.ids || []);
    if (!L.hasItems) fail(`"${L.id}" has no items`);
    const list = L.items.filter(it => !ids.size || ids.has(it.id)).slice(0, 2000).map(it => ({ L, it }));
    if (!list.length) fail(`No such items in "${L.id}"`);
    const res = checkItems(g, list), data = { checked_objects: res.items.slice(0, 60), problems: res.problems.slice(0, 40), warnings: res.warnings.slice(0, 40), ok: !res.problems.length };
    if (args.images === false) return { data };
    const box = changeBox(g, { cells: null, targets: list, removed: [], changedBefore: [] });
    const m = mapCanvas(g, box, { size, layers: args.layers, selection: false });
    const bad = new Set(res.problems.map(p => p.item.id));
    m.grid();
    drawItems(g, m, list.filter(o => !bad.has(o.it.id)), '#ffb347');
    drawItems(g, m, list.filter(o => bad.has(o.it.id)), '#ff4040', { tag: '! ' });
    return { data, text: `${m.describe()} Orange: the checked objects (#id kind), red with "!": problems.`, images: [m.image()] };
  }
  const P = args.id != null ? R.list.find(x => x.id === args.id) : R.active;
  if (!P) fail('There is no open change: check_change looks at a change between begin_change and end_change (a changing call alone reports its checks in its result). To check objects already on the map give "items": {"layer": "...", "ids": [...]}');
  if (!['open', 'pending'].includes(P.status)) fail(`Change #${P.id} is ${P.status}: check what is on the map with "items": {"layer": "...", "ids": [...]}`);
  return checkChange(g, P, { images: args.images !== false, size, layers: args.layers });
};

/** The narrowest places to cross water in a region: for each, the two bank points (a, b) for a bridge. */
T.find_crossing = args => {
  const g = G(), S = g.S;
  const reg = args.region ? region(args.region, g) : region(S.area ? { area: 'selection' } : { area: 'view' }, g);
  const water = waterMask(g, args.water), W = water.m;
  if (!water.used.length) fail('No water layer found (a mask or categories class named water / river / lake, or a vector layer of rivers): give "water": ["<layer id>"]');
  const maxLen = (args.max_length ?? metersIn(g, 40)) / g.c, bank = args.bank ?? metersIn(g, 1.5), width = args.width ?? metersIn(g, 3);
  const limit = Math.max(1, Math.min(10, args.limit ?? 3)), N = g.N;
  // start from the middle line of the water (cells farthest from the banks around them): from the jagged edge a
  // short line along the bank would look like a crossing
  const dry = new Uint8Array(W.length);
  for (let i = 0; i < W.length; i++) dry[i] = W[i] ? 0 : 1;
  const D = distanceField(g, dry), ridge = k => {
    const i = k % N, j = (k - i) / N, d = D[k];
    for (let y = Math.max(0, j - 2); y <= Math.min(g.R - 1, j + 2); y++) for (let x = Math.max(0, i - 2); x <= Math.min(N - 1, i + 2); x++) if (D[y * N + x] > d + 1e-6) return false;
    return true;
  };
  let count = 0;
  for (let i = 0; i < W.length; i++) if (W[i] && reg.m[i]) count++;
  if (!count) fail(`There is no water in the region (water layers: ${water.used.join(', ')})`);
  const stride = Math.max(1, Math.ceil(Math.sqrt(count / 6000)));
  const at = (x, y) => { const i = Math.floor(x), j = Math.floor(y); return i < 0 || j < 0 || i >= N || j >= g.R ? -1 : W[j * N + i]; };
  const march = (x, y, dx, dy) => { // cells to the first dry cell (null: the map's edge or too far)
    for (let t = 0.5; t <= maxLen; t += 0.5) { const v = at(x + dx * t, y + dy * t); if (v < 0) return null; if (!v) return t; }
    return null;
  };
  const chord = (x, y, th) => {
    const dx = Math.cos(th), dy = Math.sin(th), t1 = march(x, y, dx, dy), t2 = t1 == null ? null : march(x, y, -dx, -dy);
    return t2 == null ? null : { th, t1, t2, len: t1 + t2 };
  };
  const cands = [];
  for (let j = 0; j < g.R; j += stride) for (let i = 0; i < N; i += stride) {
    const k = j * N + i;
    if (!W[k] || !reg.m[k] || !ridge(k)) continue;
    const x = i + 0.5, y = j + 0.5;
    let best = null;
    for (let a = 0; a < 180; a += 10) { const c = chord(x, y, a * Math.PI / 180); if (c && (!best || c.len < best.len)) best = c; }
    if (!best) continue;
    const base = best.th;
    for (let a = -8; a <= 8; a += 2) { const c = chord(x, y, base + a * Math.PI / 180); if (c && c.len < best.len) best = c; }
    cands.push({ x, y, ...best });
  }
  const near = args.near ? pt(args.near, 'near') : null;
  const score = c => c.len * g.c + (near ? 0.15 * Math.hypot(g.w.x0 + c.x * g.c - near[0], g.w.z0 + c.y * g.c - near[1]) : 0);
  cands.sort((p, q) => score(p) - score(q));
  const F = facts(g), out = [], H = heightLayer(null, false), slope = H ? slopeField(g, H) : null;
  for (let c of cands) {
    if (out.length >= limit) break;
    // straight across the flow where it is known (on a bend the shortest line can be oblique): within ±10°
    const f0 = flowAt(g, W, g.w.x0 + c.x * g.c, g.w.z0 + c.y * g.c, Math.max(metersIn(g, 8), 1.5 * c.len * g.c));
    if (f0) {
      const across = Math.atan2(f0.dir[1], f0.dir[0]) + Math.PI / 2;
      for (const a of [0, 3, -3, 6, -6, 10, -10]) { const q = chord(c.x, c.y, across + a * Math.PI / 180); if (q) { c = { ...c, ...q }; break; } }
    }
    const dx = Math.cos(c.th), dz = Math.sin(c.th);
    const e1 = [g.w.x0 + (c.x + dx * c.t1) * g.c, g.w.z0 + (c.y + dz * c.t1) * g.c], e2 = [g.w.x0 + (c.x - dx * c.t2) * g.c, g.w.z0 + (c.y - dz * c.t2) * g.c];
    const mid = [(e1[0] + e2[0]) / 2, (e1[1] + e2[1]) / 2];
    if (out.some(o => Math.hypot(o.mid[0] - mid[0], o.mid[1] - mid[1]) < Math.max(metersIn(g, 6), 2 * c.len * g.c))) continue;
    const out1 = t => [e2[0] - dx * t, e2[1] - dz * t], out2 = t => [e1[0] + dx * t, e1[1] + dz * t], wet = p => { const i = cellOf(g, p[0], p[1]); return i < 0 || W[i]; };
    let ta = bank, tb = bank; // on dry land: a little farther if the bank is ragged there
    while (wet(out1(ta)) && ta < bank + metersIn(g, 3)) ta += g.c;
    while (wet(out2(tb)) && tb < bank + metersIn(g, 3)) tb += g.c;
    const a = out1(ta), b = out2(tb);
    if (!inMap(g, ...a) || !inMap(g, ...b)) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const flow = flowAt(g, W, mid[0], mid[1], Math.max(metersIn(g, 8), 1.5 * c.len * g.c));
    const nx = -dir[1] * width / 2, nz = dir[0] * width / 2, poly = [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]];
    const conflicts = F.solids.filter(o => !isCrossing(o.L, o.it) && overlapDepth(poly, o.s.poly) > 0.05 * g.k).map(o => ref(o.L, o.it));
    const end = p => {
      const i = cellOf(g, p[0], p[1]), o = { at: P2(p), dry: !W[i] };
      if (H) Object.assign(o, { height: fmtU(g, H.data[i], 2), slope_deg: Math.round(slope[i]) });
      return o;
    };
    out.push({
      mid, center: P2(mid), a: P2(a), b: P2(b), length: fmtU(g, len), water_width: fmtU(g, c.len * g.c),
      yaw: r2(deg(Math.atan2(-dir[1], dir[0]))), direction: P2(dir),
      ...(flow ? { flow: P2(flow.dir), angle_to_flow_deg: angleTo(dir, flow.dir) } : {}),
      ends: { a: end(a), b: end(b) },
      ...(conflicts.length ? { in_the_way: conflicts.slice(0, 8) } : {}),
    });
  }
  if (!out.length) fail('No crossing found: the water reaches the edge of the map or is wider than max_length here');
  const existing = {};
  for (const L of S.layers) if (L.type === 'objects') for (const it of L.items) if (isCrossing(L, it)) {
    const e = existing[`${L.id}/${it.kind}`] ||= { layer: L.id, kind: it.kind, count: 0, ...(it.w != null ? { w: it.w, d: it.d } : {}) };
    e.count++;
  }
  if (out[0]) ME.agentFeedback?.flash({ box: [Math.min(out[0].a[0], out[0].b[0]), Math.min(out[0].a[1], out[0].b[1]), Math.max(out[0].a[0], out[0].b[0]), Math.max(out[0].a[1], out[0].b[1])] });
  return {
    data: {
      crossings: out.map(({ mid, ...o }) => o), water_layers: water.used,
      existing_crossings: Object.values(existing).slice(0, 20),
      use: 'Place a bridge from bank to bank: add_items {"layer": "<layer>", "items": [{"kind": "<bridge kind>", "a": a, "b": b, "d": <width>}]} — its center, yaw and length follow from a and b. Then check_change.',
    },
  };
};

ME.agentCheckInternals = { shapeOf, overlapDepth, checkItems, flowAt, facts };
})(window.ME);
