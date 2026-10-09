// AI agent tools that change the map: items (add, update, delete, scatter), masks and categories, terrain, layers,
// pointing at things on the map, undo. Each change is one undo step labeled "AI: …". See js/agent-tools.js.
(function (ME) {
'use strict';

const T = ME.agentTools = ME.agentTools || {};
const { G, fail, region, itemsMask, worldBox,
  layerOf, editable, zonesLayer, classIndex, r2, num, pt, A } = ME.agentInternals;
const { brief, inRegion } = ME.agentRead;
const center = it => A().itemCenter(it);
const today = () => new Date().toISOString().slice(0, 10);
const flash = (what, msg) => ME.agentFeedback?.flash(what, msg);

function writable(ctx) { if (!ctx.canWrite) fail('The user lets the agent only read the map (AI Agent → Settings in the app). Ask them to allow changes.'); }

// ------------------------------------------------------------------------------------------------ items

/** The yaw that turns an object's length (w, its local x axis) along the direction (dx, dz): the length then
 *  points along (cos yaw, −sin yaw) — yaw 0: east, 90: north, −90: south (x east, z south, seen from above). */
const yawAlong = (dx, dz) => r2(Math.atan2(-dz, dx) * 180 / Math.PI);

/** Where and how an object stands, given one of: x, z (+ yaw) — the center; a, b — the two ends of its length
 *  (a bridge from bank to bank: the center between, the yaw along a→b, w the distance unless given); towards — the
 *  yaw that points its length to a point. Returns {x, z, yaw, w?} or null (nothing about the place). */
function placement(it, n, length = false) {
  const has = k => it[k] != null;
  if (has('a') || has('b')) {
    if (!has('a') || !has('b')) fail(`items[${n}]: give both ends "a" and "b"`);
    const a = pt(it.a, `items[${n}].a`), b = pt(it.b, `items[${n}].b`), dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    if (!(len > 0)) fail(`items[${n}]: "a" and "b" are the same point`);
    const o = { x: r2(has('x') ? it.x : (a[0] + b[0]) / 2), z: r2(has('z') ? it.z : (a[1] + b[1]) / 2), yaw: has('yaw') ? r2(it.yaw) : yawAlong(dx, dz) };
    if (length) o.w = r2(has('w') ? num(it.w, 'w') : len); // footprints: the length is the distance
    return o;
  }
  if (has('towards')) {
    const x = num(it.x, `items[${n}].x`), z = num(it.z, `items[${n}].z`), [tx, tz] = pt(it.towards, `items[${n}].towards`);
    if (tx === x && tz === z) fail(`items[${n}]: "towards" is the center itself`);
    return { x: r2(x), z: r2(z), yaw: yawAlong(tx - x, tz - z) };
  }
  return null;
}

/** Checks and completes new items for a layer; returns clean copies. */
function cleanItems(g, L, list) {
  const k = g.k, zones = L.type === 'objects' ? zonesLayer() : null;
  return list.map((it, n) => {
    if (!it || typeof it !== 'object') fail(`items[${n}] is not an object`);
    const o = {};
    if (L.type === 'vector') {
      if (!Array.isArray(it.points) || it.points.length < 2) fail(`items[${n}]: a path needs "points": [[x,z], [x,z], ...] (2 or more)`);
      o.kind = String(it.kind || L.meta.name.toLowerCase());
      o.points = it.points.map((p, j) => { const q = pt(p, `items[${n}].points[${j}]`).map(r2); if (p[2] != null) q.push(r2(num(p[2], 'point width'))); return q; });
      if (it.closed) { if (o.points.length < 3) fail(`items[${n}]: a closed path needs 3 points or more`); o.closed = true; }
      if (it.width != null) o.width = r2(Math.max(0, num(it.width, 'width')));
      if (it.smooth != null) o.smooth = !!it.smooth;
    } else if (L.type === 'notes') {
      if (!it.text || typeof it.text !== 'string') fail(`items[${n}]: a note needs "text"`);
      Object.assign(o, { x: r2(num(it.x, `items[${n}].x`)), z: r2(num(it.z, `items[${n}].z`)), text: it.text, date: it.date || today() });
      if (it.color) o.color = String(it.color);
    } else {
      if (!it.kind) fail(`items[${n}]: an object needs "kind"`);
      const link = L.meta.style === 'link', p = placement(it, n, L.meta.style === 'footprint');
      Object.assign(o, { kind: String(it.kind), x: p ? p.x : r2(num(it.x, `items[${n}].x`)), z: p ? p.z : r2(num(it.z, `items[${n}].z`)), yaw: p ? p.yaw : r2(it.yaw ?? 0) });
      const w = p?.w ?? it.w;
      if (L.meta.style === 'footprint' || w != null) Object.assign(o, { w: r2(w ?? 2 * k), d: r2(it.d ?? (p?.w != null ? Math.min(p.w, 3 * k) : null) ?? it.w ?? 2 * k), ox: r2(it.ox ?? 0), oz: r2(it.oz ?? 0) });
      if (link) {
        const r = 3 * k;
        o.a = it.a ? pt(it.a, 'a').map(r2) : [r2(o.x - r), o.z];
        o.b = it.b ? pt(it.b, 'b').map(r2) : [r2(o.x + r), o.z];
      }
      const zone = it.zone ?? (zones ? A().zoneAt(o.x, o.z) : null);
      if (zone) o.zone = zone;
    }
    if (it.props && typeof it.props === 'object') o.props = { ...it.props };
    return o;
  });
}

/** The box around items: path points, footprint corners, both ends of links, else the position. */
const boxOf = items => {
  const k = G().k;
  const pts = items.flatMap(it => it.points || (it.w != null ? ME.footprintCorners(it, k) : [[it.x, it.z], ...(it.a && it.b ? [it.a, it.b] : [])]));
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
};

/** Adds items to a layer: one undo step; returns the new items. */
function addItems(L, list, label, ctx) {
  const g = G();
  writable(ctx); editable(L);
  const clean = cleanItems(g, L, list);
  let next = L.nextId();
  for (const it of clean) it.id = next++;
  A().editObjects(L, label, () => L.items.push(...clean));
  A().renderLayers();
  flash({ box: boxOf(clean) }, label.replace(/^AI: /, ''));
  return clean;
}

T.add_items = (args, ctx) => {
  const L = layerOf(args.layer);
  if (!L.hasItems) fail(`"${L.id}" is a ${L.type} layer: add items to an objects, notes or vector layer (paint_layer paints masks)`);
  if (!args.items?.length) fail('Give "items"');
  const what = L.type === 'notes' ? 'note' : L.type === 'vector' ? 'path' : 'object';
  const added = addItems(L, args.items, `AI: add ${args.items.length} ${what}${args.items.length > 1 ? 's' : ''} to ${L.meta.name}`, ctx);
  return { data: { layer: L.id, added: added.length, ids: added.map(i => i.id) } };
};

const it_isPath = it => !!it?.points;

function turnItem(it, deg) {
  if (!it.points) { it.yaw = r2(((((it.yaw || 0) + deg) % 360) + 540) % 360 - 180); return; }
  const [cx, cz] = center(it), a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  it.points = it.points.map(([x, z, ...w]) => [r2(cx + (x - cx) * c + (z - cz) * s), r2(cz - (x - cx) * s + (z - cz) * c), ...w]);
}

function moveItem(it, dx, dz) {
  if (typeof it.x === 'number') { it.x = r2(it.x + dx); it.z = r2(it.z + dz); }
  for (const e of ['a', 'b']) if (it[e]) it[e] = [r2(it[e][0] + dx), r2(it[e][1] + dz)];
  if (it.points) it.points = it.points.map(([x, z, ...w]) => [r2(x + dx), r2(z + dz), ...w]);
}

T.update_items = (args, ctx) => {
  const g = G(), L = layerOf(args.layer);
  if (!L.hasItems) fail(`"${L.id}" has no items`);
  writable(ctx); editable(L);
  const byId = new Map(L.items.map(i => [i.id, i])), missing = args.items.filter(p => !byId.has(p.id)).map(p => p.id);
  if (missing.length) fail(`No items with ids ${missing.join(', ')} in "${L.id}"`);
  const link = L.meta.style === 'link';
  const places = args.items.map((p, n) => (!it_isPath(byId.get(p.id)) && (p.a != null || p.b != null || p.towards != null)
    ? placement({ x: byId.get(p.id).x, z: byId.get(p.id).z, ...p }, n, L.meta.style === 'footprint') : null));
  A().editObjects(L, `AI: change ${args.items.length} item${args.items.length > 1 ? 's' : ''} of ${L.meta.name}`, () => {
    args.items.forEach((p, n) => {
      const it = byId.get(p.id), place = places[n];
      if (place) {
        Object.assign(it, place);
        if (place.w != null && it.d == null) it.d = Math.min(place.w, 3 * g.k);
        if (link && p.a && p.b) { it.a = pt(p.a, 'a').map(r2); it.b = pt(p.b, 'b').map(r2); }
      }
      for (const [key, v] of Object.entries(p)) {
        if (key === 'id' || (place && ['a', 'b', 'towards', 'x', 'z', 'yaw', ...(place.w != null ? ['w'] : [])].includes(key))) continue;
        if (key === 'move') { const [dx, dz] = pt(v, 'move'); moveItem(it, dx, dz); } else if (key === 'turn') turnItem(it, num(v, 'turn'));
        else if (key === 'props') {
          const next = { ...(it.props || {}) };
          for (const [pk, pv] of Object.entries(v || {})) { if (pv === null) delete next[pk]; else next[pk] = pv; }
          if (Object.keys(next).length) it.props = next; else delete it.props;
        } else if (key === 'points') it.points = cleanItems(g, L, [{ kind: 'x', points: v }])[0].points;
        else if (v === null) delete it[key];
        else it[key] = typeof v === 'number' ? r2(v) : v;
      }
    });
  });
  flash({ box: boxOf(args.items.map(p => byId.get(p.id))) }, `changed ${args.items.length} item(s)`);
  return { data: { layer: L.id, changed: args.items.length, items: args.items.slice(0, 50).map(p => brief(L, byId.get(p.id), g)) } };
};

T.delete_items = async (args, ctx) => {
  const g = G(), L = layerOf(args.layer);
  if (!L.hasItems) fail(`"${L.id}" has no items`);
  writable(ctx); editable(L);
  if (!args.ids?.length && !args.region && !args.kind?.length) fail('Give "ids", or "region" and/or "kind" of the items to delete');
  const ids = args.ids?.length ? new Set(args.ids) : null, kinds = args.kind?.length ? new Set(args.kind) : null;
  const m = args.region ? region(args.region, g).m : null;
  const gone = L.items.filter(it => (!ids || ids.has(it.id)) && (!kinds || kinds.has(it.kind)) && (!m || inRegion(g, m, it)));
  if (!gone.length) return { data: { deleted: 0 } };
  if (ctx.confirmDeletes) {
    const kindsText = [...new Set(gone.map(i => i.kind ?? 'note'))].slice(0, 6).join(', ');
    const ok = await A().ask(`${ctx.clientName || 'The AI agent'} wants to delete ${gone.length} item${gone.length > 1 ? 's' : ''} (${kindsText}) from “${L.meta.name}”. Undo brings them back.`,
      { title: 'Let the agent delete?', ok: 'Delete', danger: true });
    if (!ok) fail('The user did not allow the deletion');
  }
  const set = new Set(gone);
  const box = boxOf(gone);
  A().editObjects(L, `AI: delete ${gone.length} item${gone.length > 1 ? 's' : ''} of ${L.meta.name}`, () => { L.items = L.items.filter(it => !set.has(it)); });
  A().select(null, []);
  A().renderLayers();
  flash({ box }, `deleted ${gone.length}`);
  return { data: { layer: L.id, deleted: gone.length, items: gone.slice(0, 50).map(it => brief(L, it, g)) } };
};

// ------------------------------------------------------------------------------------------------ layers

const LAYER_COLORS = ['#e05a9a', '#5ae0c8', '#e0d25a', '#9a7ae0', '#5a9ae0', '#e08a5a'];

T.create_layer = (args, ctx) => {
  const g = G();
  writable(ctx);
  if (!args.name || !args.type) fail('Give "name" and "type"');
  if (!['mask', 'category', 'height', 'objects', 'notes', 'vector'].includes(args.type)) fail('type is mask, category, height, objects, notes or vector');
  const color = args.color || LAYER_COLORS[g.S.layers.length % LAYER_COLORS.length];
  const meta = A().newLayerMeta(args.name, args.type, color, args.group || 'AI', args.note || '');
  meta.custom = true;
  if (args.type === 'category' && args.classes?.length) {
    meta.classes = [{ name: 'none', color: null }, ...args.classes.filter(c => c?.name && c.name !== 'none').map((c, k) => ({ name: String(c.name), color: c.color || LAYER_COLORS[k % LAYER_COLORS.length] }))];
  }
  if (args.type === 'objects') for (const key of ['style', 'marker', 'size', 'label']) if (args[key] != null) meta[key] = args[key];
  if (args.type === 'vector') for (const key of ['width', 'dash', 'label']) if (args[key] != null) meta[key] = args[key];
  const L = ME.makeLayer(meta, g.S.proj), keep = g.S.active;
  L.apply(null);
  L.dirty = true;
  A().insertLayer(L, `AI: new layer ${meta.name}`);
  if (keep && g.S.layers.includes(keep)) A().setActive(keep);
  return { data: { id: L.id, name: meta.name, type: L.type, group: meta.group } };
};

T.update_layer = (args, ctx) => {
  const L = layerOf(args.layer);
  writable(ctx);
  const m = L.meta, viewOnly = ['visible', 'opacity'];
  const keys = Object.keys(args).filter(k => k !== 'layer');
  if (!keys.length) fail('Nothing to change');
  if (m.locked && keys.some(k => !viewOnly.includes(k))) fail(`"${m.name}" is locked by the user: only visible and opacity can change`);
  if (args.group && args.group !== (m.group || 'Other')) A().setLayerGroup(L, String(args.group));
  const before = structuredClone(m), next = structuredClone(m);
  for (const k of ['name', 'note', 'color', 'label']) if (args[k] != null) next[k] = String(args[k]);
  if (args.visible != null) next.visible = !!args.visible;
  if (args.opacity != null) next.opacity = Math.max(0, Math.min(1, +args.opacity));
  if (args.width != null && L.type === 'vector') next.width = Math.max(0, +args.width);
  if (L.type === 'category') {
    for (const c of args.add_classes || []) {
      if (!c?.name) continue;
      if (next.classes.some(x => x.name.toLowerCase() === String(c.name).toLowerCase())) continue;
      if (next.classes.length >= 255) fail('A categories layer holds 255 classes at most');
      next.classes.push({ name: String(c.name), color: c.color || LAYER_COLORS[next.classes.length % LAYER_COLORS.length] });
    }
    for (const [from, to] of Object.entries(args.rename_classes || {})) next.classes[classIndex(L, from)].name = String(to);
  } else if (args.add_classes || args.rename_classes) fail('Classes belong to categories layers');
  const apply = meta => { Object.assign(L.meta, structuredClone(meta)); L.metaChanged(); A().markMeta(); A().viewChanged(); A().renderProps(); };
  apply(next);
  A().pushUndo({ label: `AI: change layer ${next.name}`, undo: () => apply(before), redo: () => apply(next) });
  return { data: { id: L.id, name: L.meta.name, ...(L.type === 'category' ? { classes: L.meta.classes.map(c => c.name) } : {}) } };
};

// ------------------------------------------------------------------------------------------------ pointing and undo

T.show_on_map = args => {
  const g = G();
  let mask = null, box = null;
  if (args.region) { const r = region(args.region, g); mask = r.m; box = worldBox(g, r.b); }
  else if (args.items) {
    const L = layerOf(args.items.layer), ids = new Set(args.items.ids || []);
    const items = L.items?.filter(i => !ids.size || ids.has(i.id)) || [];
    if (!items.length) fail('No such items');
    mask = itemsMask(g, L, items); box = boxOf(items);
  } else if (args.point) { const [x, z] = pt(args.point, 'point'); box = [x, z, x, z]; }
  else fail('Give region, items or point');
  const v = A().view, pad = Math.max(box[2] - box[0], box[3] - box[1], 20 * g.k) * 0.25;
  const [lo, hi] = v.limits(), W = box[2] - box[0] + 2 * pad, H = box[3] - box[1] + 2 * pad;
  v.scale = Math.max(lo, Math.min(hi, Math.min(v.w / W, v.h / H)));
  const [sx, sy] = v.toScreen((box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
  v.pan(v.w / 2 - sx, v.h / 2 - sy);
  if (args.select && mask) A().setArea(mask);
  A().saveUi();
  flash(mask ? { mask } : { box, point: !!args.point }, args.message || '', 5000);
  if (args.message) A().toast(`AI: ${args.message}`, 6000);
  return { data: { shown: box.map(r2), selected: !!(args.select && mask) } };
};

T.undo = (args, ctx) => {
  writable(ctx);
  const n = Math.max(1, Math.min(50, args.steps || 1)), done = [];
  for (let k = 0; k < n; k++) {
    const top = A().history.undo.at(-1);
    if (!top?.label?.startsWith('AI:')) break;
    A().undo();
    done.push(top.label);
  }
  if (!done.length) fail('The latest change in the app is not the agent\'s (the user changed something since): nothing was undone');
  return { data: { undone: done } };
};

// ------------------------------------------------------------------------------------------------ maps by path

/** Saves the open map before another one opens; fails when that is not possible. */
async function saveOpenMap() {
  const app = A();
  if (ME.agentReview?.active) ME.agentReview.drop('the agent opened another map (the proposal was undone)', { revert: true });
  if (app.folder && app.S.project && app.anyDirty()) {
    if (!(await app.settleSave())) fail(`The map open now ("${app.S.project.title}") has changes the app could not save: ask the user to save it or close it first`);
  }
}

/** open_map (mcp/server.mjs): the server granted the folder; the app reads and writes it through the server. */
T._open_map = async ({ root, name }) => {
  await saveOpenMap();
  const f = new ME.RemoteFolder(root, name);
  if ((await f.permission()) !== 'granted') fail(`The MCP server does not let the app use ${root}`);
  await A().connectFolder(f);
  const { S } = A();
  if (!S.project) fail(`${root}: its metadata.json cannot be read`);
  ME.agent.setProjectPath(root);
  return { data: { opened: root, title: S.project.title, unit: S.project.unit || 'm', layers: S.layers.length, note: 'Call get_map_info for its layers.' } };
};

/** create_map (mcp/server.mjs): a new map in a folder the server made and granted. */
T._create_map = async args => {
  const unit = args.unit || 'm', u = ME.unitOf(unit), k = u.k;
  if (args.unit && !ME.UNITS[args.unit]) fail(`unit is one of ${Object.keys(ME.UNITS).join(', ')}`);
  const width = args.width ?? 256 * k, height = args.height ?? width;
  if (!(width > 0 && height > 0)) fail('width and height must be positive');
  let cell = args.cell ?? ME.nice(Math.max(width, height) / 1024);
  if (Math.max(width, height) / cell > 2048) {
    if (args.cell) fail(`At most 2048 cells on a side: with cells of ${cell} the map is ${Math.round(Math.max(width, height) / cell)} cells wide. Take bigger cells (at least ${ME.nice(Math.max(width, height) / 2048)}).`);
    cell = ME.stepAtLeast(Math.max(width, height) / 2048);
  }
  const cols = Math.round(width / cell), rows = Math.round(height / cell);
  if (Math.min(cols, rows) < 16) fail('At least 16 cells on a side: take smaller cells');
  const [cx, cz] = args.center ? pt(args.center, 'center') : [0, 0], W = +(cols * cell).toFixed(4), H = +(rows * cell).toFixed(4);
  const nw = { x0: +(cx - W / 2).toFixed(4), z0: +(cz - H / 2).toFixed(4), width: W, height: H, cols, rows };
  const layers = args.layers || 'basic';
  if (!['basic', 'notes', 'same'].includes(layers)) fail('layers is basic, notes or same');
  if (layers === 'same' && !A().S.project) fail('layers "same" copies the layers of the open map: no map is open');
  await saveOpenMap();
  const f = new ME.RemoteFolder(args.root, args.name);
  if ((await f.permission()) !== 'granted') fail(`The MCP server does not let the app use ${args.root}`);
  const title = String(args.title || args.name || 'New map');
  try { await A().createMapIn(f, nw, title, layers, unit); } catch (e) { fail(e.message); }
  const { S } = A();
  ME.agent.setProjectPath(args.root);
  return { data: { created: args.root, title, unit, bounds: [nw.x0, nw.z0, r2(nw.x0 + W), r2(nw.z0 + H)], cell, cells: [cols, rows], layers: S.layers.map(l => `${l.id} (${l.type})`), note: 'The map is open in the app. Shape it with the other tools (edit_terrain, paint_layer, scatter_items…).' } };
};

ME.agentWrite = { addItems, cleanItems, writable, flash, boxOf, moveItem, turnItem };
})(window.ME);
