// GameWorld Painter: paint the layers of a game world seen from above (see README.md). Classic scripts only, so the
// page also works opened from the disk (module scripts are blocked on file://); the project is a folder the user gives
// the tool (see "project folder").
(function (ME) {
'use strict';
const { makeLayer, TYPE_NAMES, View } = ME;

const $ = sel => document.querySelector(sel);
const canvas = $('#view');
const ctx = canvas.getContext('2d');

const RASTER = ['mask', 'category', 'height'];
const TOOLS = [
  { id: 'select', key: 'v', name: 'Select', icon: '↖', types: null },
  { id: 'pan', key: 'h', name: 'Pan', icon: '✥', types: null },
  { id: 'brush', key: 'b', name: 'Brush', icon: '✎', types: RASTER, gap: true },
  { id: 'eraser', key: 'e', name: 'Eraser', icon: '⌫', types: ['mask', 'category'] },
  { id: 'smooth', key: 's', name: 'Smooth', icon: '≈', types: ['mask', 'height'] },
  { id: 'fill', key: 'g', name: 'Fill', icon: '◪', types: ['mask', 'category'] },
  { id: 'shape', key: 'u', name: 'Shapes', icon: '⬠', types: RASTER },
  { id: 'picker', key: 'i', name: 'Pick value', icon: '⊙', types: RASTER },
  { id: 'area', key: 'l', name: 'Select area', icon: '⬚', types: RASTER, gap: true },
  { id: 'add', key: 'a', name: 'Add object', icon: '✚', types: ['objects'], gap: true },
  { id: 'note', key: 'n', name: 'Note', icon: '🗒', types: null },
  { id: 'measure', key: 'm', name: 'Measure', icon: '⟷', types: null, gap: true },
];
const EDIT_TOOLS = ['brush', 'eraser', 'smooth', 'fill', 'shape', 'picker', 'area', 'add'];
const MARKERS = ['circle', 'square', 'diamond', 'triangle', 'cross'];
const STYLES = { marker: 'Marker', footprint: 'Footprint', link: 'Two ends (A–B)' };

const S = {
  project: null,
  layers: [],
  active: null,
  tool: 'brush',
  brush: {
    size: 6, strength: 100, hardness: 50, value: 100, cls: 1, mode: 'raise', amount: 1, target: 0, tolerance: 8,
    shape: 'rect', shapeFill: 'fill', feather: 0, area: 'rect', tolH: 0.25, contiguous: true,
  },
  addKind: '',
  sel: { layer: null, ids: new Set() },
  grid: false,
  collapsed: new Set(),
  cursor: null,
  screen: null,
  measure: null,
  box: null,
  solo: null,
  area: null, // the selected area: {mask (0/1 per cell), bbox, count, path}
  float: null, // moved or pasted cells, not applied yet
  draft: null, // a shape being drawn
  clip: null, // copied cells or objects
  noteEdit: null, // the note being written
  noteColor: null,
  // settings of the layer list (order, names, classes...): version counter like the layers' (layers.js)
  metaVersion: 0,
  metaSaved: 0,
  metaBase: new Map(), // id -> layer settings as in metadata.json on the disk
};
let view;
const history = { undo: [], redo: [] }; // entries: {label, undo, redo, layer?, content? (changes the layer's file)}

// ------------------------------------------------------------------------------------------------ helpers

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

/** Asks in an in-app dialog (not the browser's confirm()); resolves true when the user agrees. */
function ask(text, { title = 'Are you sure?', ok = 'OK', danger = false } = {}) {
  const dlg = $('#confirm-dlg'), btn = dlg.querySelector('.ok');
  dlg.querySelector('h3').textContent = title;
  dlg.querySelector('p').textContent = text;
  btn.textContent = ok;
  btn.classList.toggle('danger', danger);
  btn.classList.toggle('primary', !danger);
  dlg.returnValue = '';
  dlg.showModal();
  btn.focus();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); renderStatus(); });
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

function row(label, ...content) {
  return el('div', { class: 'row' }, el('label', {}, label), el('div', { class: 'inline' }, ...content));
}

function slider(min, max, step, value, onInput) {
  const num = el('input', { type: 'number', min, max, step, value });
  const rng = el('input', { type: 'range', min, max, step, value });
  rng.addEventListener('input', () => { num.value = rng.value; onInput(+rng.value); });
  num.addEventListener('change', () => { rng.value = num.value; onInput(+num.value); });
  return [rng, num];
}

const world = () => S.project.world;
const mpp = () => world().width / world().cols; // meters per cell (the cells are square)

function cellAt(x, z) {
  const w = world();
  const cx = Math.floor((x - w.x0) / mpp()), cy = Math.floor((z - w.z0) / mpp());
  return cx >= 0 && cy >= 0 && cx < w.cols && cy < w.rows ? cy * w.cols + cx : -1;
}

function layerById(id) { return S.layers.find(l => l.id === id); }

function slug(name) {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'layer';
  let id = base, n = 2;
  while (layerById(id)) id = `${base}_${n++}`;
  return id;
}

function markMeta() { S.metaVersion++; scheduleSave(); }

// ------------------------------------------------------------------------------------------------ undo

function pushUndo(entry) {
  history.undo.push(entry);
  if (history.undo.length > 150) history.undo.shift();
  history.redo.length = 0;
  renderSaveState();
}

function undo() {
  if (S.draft) { S.draft = null; requestRender(); return; }
  if (S.float) { cancelFloat(); return; }
  const e = history.undo.pop();
  if (!e) return;
  e.undo();
  history.redo.push(e);
  afterHistory(e);
}

function redo() {
  if (S.float) commitFloat();
  const e = history.redo.pop();
  if (!e) return;
  e.redo();
  history.undo.push(e);
  afterHistory(e);
}

function afterHistory(e) {
  toast((history.redo.includes(e) ? 'Undo: ' : 'Redo: ') + e.label, 1400);
  pruneSelection();
  renderLayers();
  renderProps();
  renderOptions();
  renderSaveState();
  requestRender();
}

function copyRect(arr, N, [x0, y0, x1, y1]) {
  const w = x1 - x0, out = new arr.constructor(w * (y1 - y0));
  for (let y = y0; y < y1; y++) out.set(arr.subarray(y * N + x0, y * N + x1), (y - y0) * w);
  return out;
}

function pasteRect(arr, N, [x0, y0, x1, y1], sub) {
  const w = x1 - x0;
  for (let y = y0; y < y1; y++) arr.set(sub.subarray((y - y0) * w, (y - y0 + 1) * w), y * N + x0);
}

/** One undo step for a change of the cells in rect; b: the cells of rect before (copyRect). */
function pushRasterUndoSub(layer, label, b, rect) {
  const N = layer.cols, a = copyRect(layer.data, N, rect);
  const apply = sub => { pasteRect(layer.data, N, rect, sub); layer.refresh(...rect); layer.dirty = true; };
  pushUndo({ label, layer, content: true, undo: () => apply(b), redo: () => apply(a) });
}

function pushRasterUndo(layer, label, before, rect) { pushRasterUndoSub(layer, label, copyRect(before, layer.cols, rect), rect); }

const cloneItems = items => structuredClone(items);

/** Run fn() that changes layer.items, with one undo step. */
function editObjects(layer, label, fn) {
  const before = cloneItems(layer.items);
  fn();
  const after = cloneItems(layer.items);
  layer.dirty = true;
  const apply = items => { layer.items = cloneItems(items); layer.dirty = true; };
  pushUndo({ label, layer, content: true, undo: () => apply(before), redo: () => apply(after) });
  renderProps();
  requestRender();
}

function setMeta(layer, key, value, label) {
  const before = structuredClone(layer.meta[key]);
  const apply = v => { layer.meta[key] = structuredClone(v); layer.metaChanged(key); markMeta(); };
  apply(value);
  pushUndo({ label: label || `${layer.meta.name}: ${key}`, undo: () => apply(before), redo: () => apply(value) });
  renderLayers();
  requestRender();
}

function setLayers(newList, newActive, label) {
  const before = { list: [...S.layers], active: S.active };
  const after = { list: newList, active: newActive };
  const apply = st => { S.layers = [...st.list]; setActive(st.active, false); markMeta(); saveLayerView(); };
  apply(after);
  pushUndo({ label, undo: () => apply(before), redo: () => apply(after) });
}

// ------------------------------------------------------------------------------------------------ project folder

// The project is a folder: metadata.json (the layer list and settings) and one file per layer in layers/
// (docs/project-format.md). A page opened from the disk cannot read local pictures by itself, so the user gives the tool the
// folder once (Chrome / Edge); the browser remembers it. Changes are written to the files by themselves (Autosave)
// or with Save. The tool checks the files every second: what another program (an AI agent) changed there is loaded,
// and merged with the unsaved changes of the same layer. While the folder has edit.lock, the tool does not write.
const EMPTY_WORLD = { x0: -128, z0: -128, width: 256, height: 256, cols: 1024, rows: 1024 };
const store = ME.store;
const LOCK = 'edit.lock';
const POLL_MS = 1000;
const AUTOSAVE_MS = 800;
let folder = null; // ME.Folder of the project
let busy = false; // a save or a check of the folder is running
let saveTimer = null;
let saveAgain = false;
const failed = new Map(); // file -> error message shown once (a broken file is tried again when it changes)
S.autosave = localStorage.getItem('gwp-autosave') !== 'off';
S.lock = false;
S.access = 'none'; // none | granted | prompt (the stored folder needs a click) | lost

function metaDirty() { return S.metaVersion !== S.metaSaved; }
function anyDirty() { return metaDirty() || S.layers.some(l => l.dirty); }

const META_LOCAL = ['visible', 'opacity', 'locked']; // kept per browser; the file has the defaults
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** What the tool knows of metadata.json: the settings of every layer, by id. */
function metaBaseOf(list) {
  return new Map(list.map(m => [m.id, structuredClone(m)]));
}

function metadataText(project = S.project, list = S.layers) {
  const head = { version: 3, title: project.title, created: project.created, world: project.world };
  const layers = list.map(l => ({ ...l.meta, file: l.file }));
  return JSON.stringify(head).slice(0, -1) + ',"layers":[\n' + layers.map(m => JSON.stringify(m)).join(',\n') + '\n]}\n';
}

function emptyContent(layer) {
  if (layer.raster) return new layer.data.constructor(layer.data.length);
  return layer.hasItems ? [] : null;
}

/** Read the file of a layer into it; a missing file leaves the layer empty. */
async function readLayer(layer) {
  const r = await folder.read(layer.file);
  if (!r) {
    layer.apply(null);
    layer.base = null;
    if (layer.meta.file) toast(`${layer.meta.name}: ${layer.file} is missing`, 4000);
    return;
  }
  try {
    const c = await layer.parse(r.bytes, layer.file);
    layer.apply(c);
    layer.base = layer.snapshot();
    folder.remember(layer.file, r.file);
  } catch (err) {
    layer.apply(null);
    layer.base = null;
    failed.set(layer.file, err.message);
    toast(`${layer.meta.name}: ${layer.file}: ${err.message}`, 5000);
  }
}

/** Open a project (the object of metadata.json) from the folder. */
async function openProject(project) {
  S.project = { title: project.title || 'Map', created: project.created || '', world: ME.normWorld(project.world || EMPTY_WORLD) };
  S.cols = S.project.world.cols;
  S.rows = S.project.world.rows;
  S.proj = { world: S.project.world, cols: S.cols, rows: S.rows };
  S.metaVersion = S.metaSaved = 0;
  S.metaBase = metaBaseOf(project.layers || []);
  S.sel = { layer: null, ids: new Set() };
  S.active = null;
  closeNoteEditor(false);
  S.area = S.float = S.draft = null;
  history.undo = [];
  history.redo = [];
  failed.clear();
  $('#banner').hidden = true;
  $('#project-title').textContent = S.project.title;
  document.title = `${S.project.title} — GameWorld Painter`;
  view3d.reset();
  toast('Loading layers…', 60000);
  const layers = (project.layers || []).map(m => makeLayer(structuredClone(m), S.proj));
  await Promise.all(layers.map(readLayer));
  S.layers = layers;
  view.world = S.project.world;
  view.resize();
  restoreLayerView();
  restoreUi();
  toast(`${S.layers.length} layers loaded from ${folder.name}/`, 2000);
  if (!S.active) setActive([...S.layers].reverse().find(l => l.raster) || S.layers[S.layers.length - 1], false);
  renderAll();
}

/** Use a folder: read its metadata.json, then watch it. */
async function connectFolder(f) {
  folder = f;
  S.access = 'granted';
  if (store.available) store.set('folder', f.root).catch(err => console.warn(err));
  const meta = await folder.readText('metadata.json');
  if (!meta) { showBanner('nometa'); renderSaveState(); return; }
  let project;
  try {
    project = JSON.parse(meta.text);
    if (!Array.isArray(project.layers)) throw new Error('no "layers" list');
  } catch (err) {
    showBanner('badmeta', err.message);
    return;
  }
  folder.remember('metadata.json', meta.file);
  await openProject(project);
  S.lock = await folder.exists(LOCK);
  renderSaveState();
}

async function pickFolder() {
  if (anyDirty() && !await ask('The unsaved changes are lost.', { title: 'Open another folder?', ok: 'Open another folder', danger: true })) return;
  let f;
  try {
    f = await ME.Folder.pick();
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, 5000);
    return;
  }
  await connectFolder(f);
}

/** The stored folder needs the user's permission again (after a browser restart): one click. */
async function reconnect() {
  if (!folder) return pickFolder();
  if ((await folder.permission(true)) !== 'granted') { toast('No access to the folder'); return; }
  if (S.project) { S.access = 'granted'; $('#banner').hidden = true; renderSaveState(); poll(); save({ auto: true }); return; }
  await connectFolder(folder);
}

/** A new project in the open folder (it has no metadata.json): the map render as the first layer if it is there. */
async function newMapHere() {
  const layers = [];
  if (await folder.exists('background.webp')) {
    layers.push({ id: 'background', name: 'Map from above (render)', group: 'Reference', type: 'image', file: 'background.webp',
      visible: true, opacity: 1, locked: true });
  }
  const project = { title: 'New map', created: `Started in GameWorld Painter on ${today()}`, world: EMPTY_WORLD };
  await folder.write('metadata.json', metadataText(project, layers.map(m => makeLayer(m, { world: EMPTY_WORLD, cols: EMPTY_WORLD.cols, rows: EMPTY_WORLD.rows }))));
  await connectFolder(folder);
}

function showBanner(kind, detail) {
  const b = $('#banner');
  b.innerHTML = '';
  const buttons = (...bs) => el('div', { class: 'layer-actions', style: 'margin-top:9px' }, ...bs);
  if (kind === 'unsupported') {
    b.append(el('div', {}, 'GameWorld Painter reads and writes a project folder on your disk, which needs ', el('b', {}, 'Chrome or Edge'),
      ' (the File System Access API). Open this page in one of them.'));
  } else if (kind === 'open') {
    b.append(el('h3', {}, 'GameWorld Painter'),
      el('div', {}, 'Plan a game world on layers seen from above. Open a project folder (one with ', el('code', {}, 'metadata.json'),
        ') and allow editing — the browser remembers it — or make a new map in an empty folder. To try it, download the ',
        el('a', { href: 'https://github.com/aleserb/game-world-painter/tree/main/examples/demo-island', target: '_blank', rel: 'noopener' }, 'demo island'), ' and open its folder.'),
      buttons(el('button', { class: 'primary', onclick: pickFolder }, 'Open folder…'), el('button', { onclick: () => openMapDialog('new') }, 'New map…')));
  } else if (kind === 'prompt') {
    b.append(el('div', {}, 'Allow GameWorld Painter to use the folder ', el('code', {}, folder.name + '/'), ' again.'),
      buttons(el('button', { class: 'primary', onclick: reconnect }, 'Allow'), el('button', { onclick: pickFolder }, 'Another folder…')));
  } else if (kind === 'nometa') {
    b.append(el('div', {}, el('code', {}, folder.name + '/'), ' has no metadata.json: it is not a project. Pick another folder, ' +
      'or start an empty map in this one.'),
    buttons(el('button', { class: 'primary', onclick: pickFolder }, 'Another folder…'), el('button', { onclick: newMapHere }, 'New empty map here')));
  } else if (kind === 'badmeta') {
    b.append(el('div', {}, `metadata.json of ${folder.name}/ cannot be read: ${detail}`),
      buttons(el('button', { class: 'primary', onclick: () => connectFolder(folder) }, 'Try again'), el('button', { onclick: pickFolder }, 'Another folder…')));
  }
  b.hidden = false;
}

// --- save

function scheduleSave() {
  renderSaveState();
  if (!S.autosave || !folder) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (drag || stroke) { scheduleSave(); return; } // not in the middle of a stroke or a drag
    save({ auto: true });
  }, AUTOSAVE_MS);
}

async function hasAccess(ask) {
  const p = await folder.permission(ask);
  if (p === 'granted') return true;
  S.access = p === 'prompt' ? 'prompt' : 'lost';
  renderSaveState();
  return false;
}

/** Write the changed layers and metadata.json. Changes made on the disk meanwhile are merged in first. */
async function save({ auto = false } = {}) {
  if (!folder || !S.project) { if (!auto) toast('Open the project folder first'); return; }
  if (busy) { saveAgain = true; return; }
  if (S.lock) { if (!auto) toast(`${LOCK} is in the folder (an agent is editing): saving waits until it is removed`, 4000); renderSaveState(); return; }
  if (!anyDirty()) { if (!auto) toast('Nothing to save'); return; }
  busy = true;
  S.saveError = null;
  renderSaveState();
  try {
    if (!(await hasAccess(!auto))) return;
    await syncFromDisk(); // never overwrite what was changed on the disk since it was read
    if (S.lock) return;
    let n = 0;
    for (const l of S.layers) {
      if (!l.dirty) continue;
      const v = l.version;
      const data = await l.fileData();
      if (l.version !== v) continue; // edited while encoding: the next save writes it
      await folder.write(l.file, data);
      if (!l.meta.file) { l.meta.file = l.file; S.metaVersion++; }
      l.base = l.snapshot();
      l.savedVersion = v;
      failed.delete(l.file);
      n++;
    }
    if (metaDirty()) {
      const mv = S.metaVersion;
      const before = new Set([...S.metaBase.values()].map(m => m.file).filter(Boolean));
      await folder.write('metadata.json', metadataText());
      S.metaSaved = mv;
      S.metaBase = metaBaseOf(S.layers.map(l => ({ ...l.meta, file: l.file })));
      // files of deleted layers (and old files of replaced pictures)
      const used = new Set(S.layers.map(l => l.file));
      for (const f of before) if (!used.has(f)) await folder.remove(f);
      n++;
    }
    S.savedAt = new Date();
    if (!auto) toast(n ? `Saved ${n} file(s) to ${folder.name}/` : 'Nothing to save');
  } catch (err) {
    console.error(err);
    S.saveError = err.message;
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') S.access = 'lost';
  } finally {
    busy = false;
    renderSaveState();
    if (saveAgain) { saveAgain = false; if (anyDirty()) scheduleSave(); }
  }
}

// --- watching the folder

function dropHistory(layer) {
  history.undo = history.undo.filter(e => !(e.content && e.layer === layer));
  history.redo = history.redo.filter(e => !(e.content && e.layer === layer));
}

/** A layer file changed on the disk: take it, or merge it with the unsaved changes of the layer. */
function takeDiskContent(l, content) {
  if (S.float && S.float.layer === l) commitFloat();
  dropHistory(l);
  if (!l.dirty) {
    l.apply(content);
    l.base = l.snapshot();
    toast(`${l.meta.name}: updated from ${l.file}`, 1800);
  } else {
    const conflicts = l.merge(l.base || emptyContent(l), content);
    l.base = l.hasItems ? structuredClone(content) : content;
    toast(`${l.meta.name}: merged the changes of ${l.file} with yours` +
      (conflicts ? ` (${conflicts} ${l.raster ? 'cells' : 'objects'} changed on both sides: yours kept)` : ''), 4000);
    scheduleSave();
  }
  pruneSelection();
}

/** metadata.json changed on the disk: merge the layer list (3-way, by id) and the settings (local changes win). */
async function takeDiskMetadata(disk) {
  const dw = disk.world && ME.normWorld(disk.world), w = S.project.world;
  if (!dw || ['x0', 'z0', 'width', 'height', 'cols', 'rows'].some(k => dw[k] !== w[k])) {
    toast('The map size changed in metadata.json: the project is opened again', 4000);
    await openProject(disk);
    return;
  }
  const base = S.metaBase, local = new Map(S.layers.map(l => [l.id, l]));
  const diskById = new Map(disk.layers.map(m => [m.id, m]));
  let structure = false;
  const added = [];
  const keep = id => {
    const d = diskById.get(id), l = local.get(id), b = base.get(id);
    if (d && l && d.type === l.type) {
      const keys = new Set([...Object.keys(d), ...Object.keys(l.meta)].filter(k => !META_LOCAL.includes(k)));
      let changed = false;
      for (const k of keys) {
        if (same(l.meta[k], b ? b[k] : undefined) && !same(l.meta[k], d[k])) {
          if (d[k] === undefined) delete l.meta[k]; else l.meta[k] = structuredClone(d[k]);
          changed = true;
        }
      }
      if (changed) l.metaChanged();
      return l;
    }
    if (d && (!l || d.type !== l.type)) {
      if (b && !l) return null; // deleted here
      const n = makeLayer(structuredClone(d), S.proj);
      added.push(n);
      structure = true;
      return n;
    }
    if (l && !d) {
      if (b && !l.dirty) { structure = true; return null; } // deleted there
      return l;
    }
    return null;
  };
  // order: the disk's, unless the layer list was changed here; layers only on one side keep their neighbors
  const primary = metaDirty() ? S.layers.map(l => l.id) : disk.layers.map(m => m.id);
  const secondary = metaDirty() ? disk.layers.map(m => m.id) : S.layers.map(l => l.id);
  const order = [...primary];
  secondary.forEach((id, k) => {
    if (order.includes(id)) return;
    const prev = secondary.slice(0, k).reverse().find(p => order.includes(p));
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id);
  });
  const list = order.map(keep).filter(Boolean);
  await Promise.all(added.map(readLayer));
  if (structure || list.length !== S.layers.length || list.some((l, k) => l !== S.layers[k])) {
    history.undo = [];
    history.redo = [];
    S.layers = list;
    if (!S.layers.includes(S.active)) setActive(S.layers[S.layers.length - 1] || null, false);
    pruneSelection();
  }
  if (disk.title && disk.title !== S.project.title) {
    S.project.title = disk.title;
    $('#project-title').textContent = disk.title;
  }
  S.metaBase = metaBaseOf(disk.layers);
  restoreLayerView();
  toast('metadata.json changed on the disk: layers updated' + (added.length ? ` (+${added.length})` : ''), 2500);
  renderAll();
}

/** Look for changes made on the disk by others: edit.lock, metadata.json, the layer files. */
async function syncFromDisk() {
  const lock = await folder.exists(LOCK);
  if (lock !== S.lock) {
    S.lock = lock;
    toast(lock ? `${LOCK}: an agent is editing the folder, saving waits` : `${LOCK} removed: saving again`, 3000);
    if (!lock && anyDirty()) scheduleSave();
  }
  const mf = await folder.file('metadata.json');
  if (mf && folder.isNew('metadata.json', mf)) {
    let disk = null;
    try {
      disk = JSON.parse(await mf.text());
      if (!Array.isArray(disk.layers)) throw new Error('no "layers" list');
    } catch (err) {
      if (failed.get('metadata.json') !== err.message) toast(`metadata.json: ${err.message} (the layer list is not changed)`, 4000);
      failed.set('metadata.json', err.message);
      disk = null;
    }
    if (disk) {
      failed.delete('metadata.json');
      folder.remember('metadata.json', mf);
      await takeDiskMetadata(disk);
    }
  }
  for (const l of [...S.layers]) {
    const f = await folder.file(l.file);
    if (!f || !folder.isNew(l.file, f)) continue;
    let content;
    try {
      content = await l.parse(new Uint8Array(await f.arrayBuffer()), l.file);
    } catch (err) { // half written, or broken: try again when it changes
      if (failed.get(l.file) !== err.message && Date.now() - f.lastModified > 3000) toast(`${l.file}: ${err.message}`, 4000);
      failed.set(l.file, err.message);
      continue;
    }
    failed.delete(l.file);
    folder.remember(l.file, f);
    takeDiskContent(l, content);
  }
}

async function poll() {
  if (!folder || !S.project || busy || S.access !== 'granted') return;
  busy = true;
  try {
    if ((await folder.permission()) !== 'granted') { S.access = 'prompt'; renderSaveState(); return; }
    await syncFromDisk();
  } catch (err) {
    console.warn('poll', err);
    if (err.name === 'NotFoundError') { S.access = 'lost'; S.saveError = `${folder.name}/ is gone`; renderSaveState(); }
  } finally {
    busy = false;
    if (saveAgain) { saveAgain = false; save({ auto: true }); }
  }
  renderStatus();
  requestRender();
}

async function load() {
  view = new View(canvas, EMPTY_WORLD);
  view.resize();
  if (!ME.Folder.supported) { showBanner('unsupported'); return; }
  let handle = null;
  if (store.available) {
    try { handle = (await store.get('folder')) || null; } catch (err) { console.warn(err); }
  }
  if (!handle) { showBanner('open'); return; }
  folder = new ME.Folder(handle);
  const p = await folder.permission(false);
  if (p === 'granted') await connectFolder(folder);
  else { S.access = 'prompt'; showBanner('prompt'); }
}

setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
window.addEventListener('focus', poll);

// Visibility, opacity and locks are view settings: kept in this browser (project.js has the defaults, written on save).
const VIEW_KEYS = ['visible', 'opacity', 'locked'];

function saveLayerView() {
  if (!S.project) return;
  const v = {};
  for (const l of S.layers) v[l.id] = Object.fromEntries(VIEW_KEYS.map(k => [k, l.meta[k]]));
  localStorage.setItem('gwp-layers|' + location.pathname, JSON.stringify(v));
}

function restoreLayerView() {
  let v = {};
  try { v = JSON.parse(localStorage.getItem('gwp-layers|' + location.pathname) || '{}'); } catch (e) { /* ignore */ }
  for (const l of S.layers) if (v[l.id]) for (const k of VIEW_KEYS) if (k in v[l.id]) l.meta[k] = v[l.id][k];
}

function viewChanged() { saveLayerView(); renderLayers(); requestRender(); }

function saveUi() {
  if (!view) return;
  localStorage.setItem('gwp-ui|' + location.pathname, JSON.stringify({
    view: { scale: view.scale, ox: view.ox, oy: view.oy }, tool: S.tool, brush: S.brush, grid: S.grid,
    collapsed: [...S.collapsed], active: S.active?.id, addKind: S.addKind,
  }));
}

function restoreUi() {
  let ui = {};
  try { ui = JSON.parse(localStorage.getItem('gwp-ui|' + location.pathname) || '{}'); } catch (e) { /* ignore */ }
  if (ui.view) Object.assign(view, ui.view); else view.fit();
  if (ui.brush) Object.assign(S.brush, ui.brush);
  if (ui.tool) S.tool = ui.tool;
  S.grid = !!ui.grid;
  S.collapsed = new Set(ui.collapsed || []);
  S.addKind = ui.addKind || '';
  if (ui.active && layerById(ui.active)) setActive(layerById(ui.active), false);
}

// ------------------------------------------------------------------------------------------------ rendering

function render() {
  if (!view || !S.project) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#141416';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const w = world();
  view.setScreenTransform(ctx);
  const [mx, my] = view.toScreen(w.x0, w.z0);
  ctx.fillStyle = '#202024';
  ctx.fillRect(mx, my, w.width * view.scale, w.height * view.scale);
  for (const l of S.layers) {
    if (!l.meta.visible) continue;
    ctx.save();
    ctx.globalAlpha = l.meta.opacity ?? 1;
    l.draw(ctx, view, S.sel.layer === l ? S.sel.ids : null);
    ctx.restore();
  }
  view.setScreenTransform(ctx);
  ctx.strokeStyle = 'rgba(160,160,170,0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(mx + 0.5, my + 0.5, w.width * view.scale, w.height * view.scale);
  if (S.grid) drawGrid();
  drawSelectionHandles();
  drawArea();
  drawOverlay();
  drawScaleBar();
  positionNoteEditor();
  view3d.cursorTick();
}

function drawGrid() {
  const w = world(), steps = [1, 2, 5, 10, 20, 50, 100];
  const step = steps.find(s => s * view.scale >= 36) || 100;
  const [sx0, sy0] = view.toScreen(w.x0, w.z0), [sx1, sy1] = view.toScreen(w.x0 + w.width, w.z0 + w.height);
  ctx.font = '10px system-ui';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  for (const axis of [0, 1]) {
    const start = Math.ceil((axis ? w.z0 : w.x0) / step) * step;
    for (let v = start; v <= (axis ? w.z0 + w.height : w.x0 + w.width); v += step) {
      const major = Math.round(v / step) % 5 === 0 || v === 0;
      ctx.strokeStyle = v === 0 ? 'rgba(240,163,94,0.55)' : major ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      if (axis) {
        const [, y] = view.toScreen(0, v);
        ctx.moveTo(sx0, y); ctx.lineTo(sx1, y);
        if (major) ctx.fillText(`z ${v}`, Math.max(sx0, 0) + 3, y - 3);
      } else {
        const [x] = view.toScreen(v, 0);
        ctx.moveTo(x, sy0); ctx.lineTo(x, sy1);
        if (major) ctx.fillText(`x ${v}`, x + 3, Math.max(sy0, 0) + 11);
      }
      ctx.stroke();
    }
  }
}

function drawScaleBar() {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500];
  const m = steps.find(st => st * view.scale >= 90) || 500, len = m * view.scale, x = view.w - len - 22, y = view.h - 18;
  ctx.fillStyle = 'rgba(20,20,22,0.72)';
  ctx.fillRect(x - 10, y - 18, len + 20, 28);
  ctx.strokeStyle = '#f2f2f4';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 5); ctx.moveTo(x + len / 2, y); ctx.lineTo(x + len / 2, y - 3); ctx.stroke();
  ctx.fillStyle = '#f2f2f4';
  ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${m} m`, x + len / 2, y - 6);
  // north is up
  const nx = view.w - 30, ny = 22;
  ctx.fillStyle = 'rgba(20,20,22,0.72)';
  ctx.beginPath(); ctx.arc(nx, ny + 12, 17, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f2f2f4'; ctx.font = 'bold 11px system-ui'; ctx.textBaseline = 'top';
  ctx.fillText('N', nx, ny - 1);
  ctx.beginPath(); ctx.moveTo(nx, ny + 11); ctx.lineTo(nx + 6, ny + 24); ctx.lineTo(nx, ny + 20); ctx.lineTo(nx - 6, ny + 24); ctx.closePath();
  ctx.lineWidth = 1.4; ctx.strokeStyle = '#f2f2f4'; ctx.stroke();
}

function rotateHandle(layer, it) {
  if (layer.meta.style === 'link' || layer.type === 'notes') return null;
  const a = (it.yaw || 0) * Math.PI / 180;
  const reach = layer.meta.style === 'footprint' ? Math.max(it.d || 1, it.w || 1) / 2 * view.scale : layer.markerRadius(view);
  const [x, y] = view.toScreen(it.x, it.z);
  return [x - Math.sin(a) * (reach + 22), y - Math.cos(a) * (reach + 22), x, y];
}

function drawSelectionHandles() {
  const L = S.sel.layer;
  if (!L || !L.meta.visible || S.sel.ids.size !== 1) return;
  const it = L.items.find(i => S.sel.ids.has(i.id));
  if (!it) return;
  const h = rotateHandle(L, it);
  if (!h) return;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(h[2], h[3]); ctx.lineTo(h[0], h[1]); ctx.stroke();
  ctx.beginPath(); ctx.arc(h[0], h[1], 6, 0, Math.PI * 2);
  ctx.fillStyle = '#f0a35e'; ctx.fill(); ctx.stroke();
}

function brushRadiusPx() { return S.brush.size / 2 * view.scale; }

function drawOverlay() {
  if (S.box) {
    const [x0, y0] = view.toScreen(S.box[0], S.box[1]), [x1, y1] = view.toScreen(S.box[2], S.box[3]);
    ctx.fillStyle = 'rgba(240,163,94,0.12)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = '#f0a35e'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0); ctx.setLineDash([]);
  }
  if (S.measure) {
    const [a, b] = S.measure, [x0, y0] = view.toScreen(...a), [x1, y1] = view.toScreen(...b);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    for (const [x, y] of [[x0, y0], [x1, y1]]) { ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); }
    const text = `${d.toFixed(1)} m`;
    ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(16,13,20,0.9)';
    ctx.strokeText(text, (x0 + x1) / 2, (y0 + y1) / 2 - 6);
    ctx.fillStyle = '#ffffff'; ctx.fillText(text, (x0 + x1) / 2, (y0 + y1) / 2 - 6);
  }
  if (S.draft) drawDraft();
  if (S.noteEdit && S.noteEdit.id == null) { // the pin of a new note
    const [x, y] = view.toScreen(S.noteEdit.x, S.noteEdit.z);
    ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = S.noteEdit.color || S.noteEdit.layer.meta.color; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
  }
  const t = effectiveTool();
  if (S.screen && ['brush', 'eraser', 'smooth'].includes(t) && S.active?.raster) {
    const [x, y] = S.screen, r = brushRadiusPx();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    if (S.brush.hardness < 100 && S.active.type !== 'category') {
      ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath(); ctx.arc(x, y, r * S.brush.hardness / 100, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
  }
}

// ------------------------------------------------------------------------------------------------ raster tools

let stroke = null;
let lastStroke = null;

/** The mask painting is limited to: the selected area, unless “Affect only the selected area” is off. */
function areaClip() { return S.area && S.brush.clip !== false ? S.area.mask : null; }

function toCell(x, z) { const w = world(); return [(x - w.x0) / mpp(), (z - w.z0) / mpp()]; }

function canEdit(layer, quiet) {
  if (!layer) return false;
  let msg = null;
  if (layer.meta.locked) msg = `“${layer.meta.name}” is locked: unlock it in the layer list`;
  else if (!layer.meta.visible) msg = `“${layer.meta.name}” is hidden`;
  if (msg && !quiet) toast(msg);
  return !msg;
}

function beginStroke(layer, tool, cx, cy, line) {
  stroke = {
    layer, tool, snap: layer.data.slice(), alpha: new Float32Array(layer.data.length),
    bbox: [Infinity, Infinity, -Infinity, -Infinity], last: [cx, cy],
  };
  if (line && lastStroke && lastStroke.layer === layer) strokeLine(lastStroke.end[0], lastStroke.end[1], cx, cy, true);
  else stamp(cx, cy);
}

function strokeLine(ax, ay, bx, by, includeStart) {
  const r = S.brush.size / 2 / mpp(), step = Math.max(r * 0.22, 0.35);
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
  if (includeStart) stamp(ax, ay);
  for (let k = 1; k <= n; k++) stamp(ax + (bx - ax) * k / n, ay + (by - ay) * k / n);
  stroke.last = [bx, by];
}

function falloff(d) {
  const h = S.brush.hardness / 100;
  if (d <= h) return 1;
  const t = (d - h) / (1 - h);
  return 1 - t * t * (3 - 2 * t);
}

function stamp(cx, cy) {
  const L = stroke.layer, N = L.cols, R = L.rows, data = L.data, snap = stroke.snap, alpha = stroke.alpha;
  const r = Math.max(S.brush.size / 2 / mpp(), 0.5), str = S.brush.strength / 100;
  const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(N, Math.ceil(cx + r)), y1 = Math.min(R, Math.ceil(cy + r));
  if (x1 <= x0 || y1 <= y0) return;
  const tool = stroke.tool, type = L.type, b = S.brush;
  let smoothSrc = null;
  if (tool === 'smooth') { // average of the 3x3 neighbors (5x5 for big brushes), read before this stamp
    const k = r > 8 ? 2 : 1;
    smoothSrc = new Float32Array((x1 - x0) * (y1 - y0));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let s = 0, n = 0;
        for (let v = Math.max(0, y - k); v <= Math.min(R - 1, y + k); v++) {
          for (let u = Math.max(0, x - k); u <= Math.min(N - 1, x + k); u++) { s += data[v * N + u]; n++; }
        }
        smoothSrc[(y - y0) * (x1 - x0) + (x - x0)] = s / n;
      }
    }
  }
  const maskV = tool === 'eraser' ? 0 : Math.round(b.value * 2.55);
  const cls = tool === 'eraser' ? 0 : b.cls;
  const clip = areaClip(); // paint only inside the selected area
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
      if (d >= 1) continue;
      const i = y * N + x;
      if (clip && !clip[i]) continue;
      if (type === 'category') { data[i] = cls; continue; }
      const f = falloff(d);
      if (tool === 'smooth') {
        const avg = smoothSrc[(y - y0) * (x1 - x0) + (x - x0)];
        const v = data[i] + (avg - data[i]) * f * str * 0.5;
        data[i] = type === 'mask' ? Math.round(v) : v;
        continue;
      }
      const a = Math.max(alpha[i], f * str);
      alpha[i] = a;
      if (type === 'mask') data[i] = Math.round(snap[i] + (maskV - snap[i]) * a);
      else if (b.mode === 'flatten') data[i] = snap[i] + (b.target - snap[i]) * a;
      else data[i] = snap[i] + (b.mode === 'lower' ? -1 : 1) * b.amount * a;
    }
  }
  const bb = stroke.bbox;
  bb[0] = Math.min(bb[0], x0); bb[1] = Math.min(bb[1], y0); bb[2] = Math.max(bb[2], x1); bb[3] = Math.max(bb[3], y1);
  L.refresh(x0, y0, x1, y1);
  L.dirty = true;
}

function endStroke() {
  if (!stroke) return;
  const { layer, bbox, snap, tool } = stroke;
  if (bbox[0] < bbox[2]) {
    const name = tool === 'brush' && layer.type === 'height' ? S.brush.mode : tool;
    pushRasterUndo(layer, `${name} on ${layer.meta.name}`, snap, bbox);
  }
  lastStroke = { layer, end: stroke.last };
  stroke = null;
  renderSaveState();
}

function floodFill(layer, x, z) {
  const N = layer.cols, R = layer.rows, data = layer.data, start = cellAt(x, z);
  if (start < 0) return;
  const seed = data[start];
  const isCat = layer.type === 'category';
  const V = isCat ? S.brush.cls : Math.round(S.brush.value * 2.55);
  const tol = isCat ? 0 : Math.round(S.brush.tolerance * 2.55);
  if (isCat && seed === V) return;
  const snap = data.slice(), seen = new Uint8Array(data.length), stack = [start], clip = areaClip();
  const bb = [N, R, 0, 0];
  let count = 0;
  while (stack.length) {
    const i = stack.pop();
    if (seen[i] || (clip && !clip[i]) || Math.abs(snap[i] - seed) > tol) continue;
    seen[i] = 1;
    data[i] = V;
    count++;
    const x0 = i % N, y0 = (i / N) | 0;
    if (x0 < bb[0]) bb[0] = x0; if (y0 < bb[1]) bb[1] = y0;
    if (x0 + 1 > bb[2]) bb[2] = x0 + 1; if (y0 + 1 > bb[3]) bb[3] = y0 + 1;
    if (x0 > 0) stack.push(i - 1);
    if (x0 < N - 1) stack.push(i + 1);
    if (y0 > 0) stack.push(i - N);
    if (y0 < R - 1) stack.push(i + N);
  }
  if (!count) return;
  layer.refresh(...bb);
  layer.dirty = true;
  pushRasterUndo(layer, `fill on ${layer.meta.name}`, snap, bb);
  toast(`Filled ${(count * mpp() * mpp()).toFixed(0)} m²`, 1500);
}

function pickValue(layer, x, z) {
  const i = cellAt(x, z);
  if (i < 0 || !layer?.raster) return;
  if (layer.type === 'mask') S.brush.value = Math.round(layer.data[i] / 2.55);
  else if (layer.type === 'category') S.brush.cls = layer.data[i];
  else { S.brush.target = Math.round(layer.data[i] * 100) / 100; S.brush.mode = 'flatten'; }
  toast(`Picked ${layer.describe(i)}`, 1200);
  renderOptions();
  if (layer.type === 'category') renderProps();
}

// ------------------------------------------------------------------------------------------------ object tools

function objectLayersTopDown() {
  return S.layers.filter(l => l.hasItems && l.meta.visible && !l.meta.locked).reverse();
}

function pickObject(x, z) {
  const order = [S.active, ...objectLayersTopDown().filter(l => l !== S.active)];
  for (const l of order) {
    if (!l?.hasItems || !l.meta.visible || l.meta.locked) continue;
    const it = l.hit(x, z, view);
    if (it) return { layer: l, it };
  }
  return null;
}

function select(layer, ids) {
  const had = S.sel.ids.size;
  S.sel = { layer, ids: new Set(ids) };
  if (S.sel.ids.size && S.propsTab === 'layer') S.propsTab = 'selection';
  else if (!S.sel.ids.size && had && S.propsTab === 'selection') S.propsTab = 'layer';
  renderProps();
  requestRender();
}

function pruneSelection() {
  const L = S.sel.layer;
  if (!L) return;
  if (!S.layers.includes(L)) { S.sel = { layer: null, ids: new Set() }; return; }
  const have = new Set(L.items.map(i => i.id));
  S.sel.ids = new Set([...S.sel.ids].filter(id => have.has(id)));
}

function selectedItems() {
  const L = S.sel.layer;
  return L ? L.items.filter(i => S.sel.ids.has(i.id)) : [];
}

function zoneAt(x, z) {
  const zl = S.layers.find(l => l.id === 'zones' && l.type === 'category');
  const i = cellAt(x, z);
  if (!zl || i < 0 || !zl.data[i]) return '';
  return zl.meta.classes[zl.data[i]]?.name || '';
}

function addObject(layer, x, z) {
  const kinds = layer.kinds();
  const kind = (S.addKind || kinds[0] || 'object').trim();
  const like = [...layer.items].reverse().find(i => i.kind === kind);
  const it = { id: layer.nextId(), kind, x: +x.toFixed(2), z: +z.toFixed(2), yaw: like?.yaw ?? 0 };
  if (layer.meta.style === 'footprint') Object.assign(it, { w: like?.w ?? 2, d: like?.d ?? 2, ox: like?.ox ?? 0, oz: like?.oz ?? 0 });
  const zone = zoneAt(x, z);
  if (zone) it.zone = zone;
  if (like?.props) it.props = structuredClone(like.props);
  if (layer.meta.style === 'link') { it.a = [+(x - 3).toFixed(2), +z.toFixed(2)]; it.b = [+(x + 3).toFixed(2), +z.toFixed(2)]; }
  editObjects(layer, `add ${kind}`, () => layer.items.push(it));
  select(layer, [it.id]);
}

function deleteSelected() {
  const L = S.sel.layer, n = S.sel.ids.size;
  if (!L || !n) return;
  editObjects(L, `delete ${n} object(s)`, () => { L.items = L.items.filter(i => !S.sel.ids.has(i.id)); });
  select(L, []);
}

function duplicateSelected() {
  const L = S.sel.layer;
  if (!L || !S.sel.ids.size) return;
  const ids = [];
  editObjects(L, 'duplicate', () => {
    let next = L.nextId();
    for (const it of selectedItems()) {
      const c = structuredClone(it);
      c.id = next++;
      c.x += 1; c.z += 1;
      if (c.a) { c.a[0] += 1; c.a[1] += 1; c.b[0] += 1; c.b[1] += 1; }
      L.items.push(c);
      ids.push(c.id);
    }
  });
  select(L, ids);
}

function moveSelected(dx, dz, label = 'move') {
  const L = S.sel.layer;
  if (!L || !S.sel.ids.size) return;
  editObjects(L, label, () => {
    for (const it of selectedItems()) {
      it.x = +(it.x + dx).toFixed(2); it.z = +(it.z + dz).toFixed(2);
      if (it.a) { it.a = [+(it.a[0] + dx).toFixed(2), +(it.a[1] + dz).toFixed(2)]; it.b = [+(it.b[0] + dx).toFixed(2), +(it.b[1] + dz).toFixed(2)]; }
    }
  });
}

function rotateSelected(deg) {
  const L = S.sel.layer;
  if (!L || !S.sel.ids.size || L.type === 'notes') return;
  editObjects(L, 'rotate', () => {
    for (const it of selectedItems()) it.yaw = +(((it.yaw || 0) + deg + 540) % 360 - 180).toFixed(1);
  });
}

// ------------------------------------------------------------------------------------------------ shapes & selected area

// Shapes are drawn on the map, then painted into the active raster layer. The selected area (S.area) is a 0/1 mask
// over the cells shared by the raster layers: brushes, shapes and fills paint only inside it. Moved or pasted cells
// float (S.float) above their layer until they are applied (Enter, a click outside, another tool or layer).
const SHAPES = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', line: 'Line', free: 'Freehand' };
const AREA_MODES = { rect: 'Rectangle', ellipse: 'Ellipse', free: 'Lasso', polygon: 'Polygon', wand: 'Magic wand' };
const CLICK_SHAPES = ['polygon', 'line']; // drawn point by point

const cellToWorld = (cx, cy) => [world().x0 + cx * mpp(), world().z0 + cy * mpp()];
const m2 = cells => `${(cells * mpp() * mpp()).toFixed(0)} m²`;

/** Paint a coverage (ME.shapeCoverage) into a raster layer with the brush settings, inside the selected area.
 *  full: the whole value (fill), else the strength of the brush. */
function paintCoverage(L, c, label, full = false) {
  const N = L.cols, data = L.data, b = S.brush, clip = full ? (S.area ? S.area.mask : null) : areaClip();
  const { x0, y0, x1, y1, cov } = c, w = x1 - x0, str = full ? 1 : b.strength / 100, V = Math.round(b.value * 2.55);
  const before = copyRect(data, N, [x0, y0, x1, y1]);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const a = cov[(y - y0) * w + x - x0] / 255, i = y * N + x;
      if (!a || (clip && !clip[i])) continue;
      n++;
      if (L.type === 'category') { if (a >= 0.5) data[i] = b.cls; continue; }
      const t = a * str;
      if (L.type === 'mask') data[i] = Math.round(data[i] + (V - data[i]) * t);
      else if (full || b.mode === 'flatten') data[i] += (b.target - data[i]) * t;
      else data[i] += (b.mode === 'lower' ? -1 : 1) * b.amount * t;
    }
  }
  if (!n) { toast(clip ? 'Nothing painted: the shape is outside the selected area' : 'The shape is too small', 1800); return; }
  L.refresh(x0, y0, x1, y1);
  L.dirty = true;
  pushRasterUndoSub(L, label, before, [x0, y0, x1, y1]);
}

function setArea(mask) {
  const b = mask && ME.maskBounds(mask, S.cols, S.rows);
  S.area = b ? { mask, bbox: b.bbox, count: b.count, path: ME.maskOutline(mask, S.cols, b.bbox, S.rows) } : null;
  renderOptions();
  requestRender();
}

/** Combine a 0/1 mask with the selected area: 'replace', 'add' or 'subtract'. */
function combineArea(mask, op) {
  if (op !== 'replace' && S.area) {
    const m = S.area.mask.slice();
    for (let i = 0; i < m.length; i++) if (mask[i]) m[i] = op === 'add' ? 1 : 0;
    mask = m;
  } else if (op === 'subtract') return;
  setArea(mask);
}

const areaOp = e => (e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace');

function selectAllArea() { commitFloat(); setArea(new Uint8Array(S.cols * S.rows).fill(1)); }
function deselectArea() { commitFloat(); setArea(null); }

function invertArea() {
  commitFloat();
  const a = S.area ? S.area.mask : null, m = new Uint8Array(S.cols * S.rows);
  for (let i = 0; i < m.length; i++) m[i] = a && a[i] ? 0 : 1;
  setArea(m);
}

function growArea(meters) {
  commitFloat();
  if (S.area) setArea(ME.growMask(S.area.mask, S.cols, S.rows, Math.round(meters / mpp())));
}

function inArea(x, z) { const i = cellAt(x, z); return i >= 0 && !!S.area && !!S.area.mask[i]; }

function inFloat(x, z) {
  const F = S.float;
  if (!F) return false;
  const [cx, cy] = toCell(x, z);
  return cx >= F.x && cy >= F.y && cx < F.x + F.w && cy < F.y + F.h;
}

function wandAt(x, z, op) {
  const L = S.active, i = cellAt(x, z);
  if (!L?.raster) { toast('The magic wand picks similar cells of a mask, categories or height layer: select one'); return; }
  if (i < 0) return;
  const b = S.brush, tol = L.type === 'height' ? b.tolH : L.type === 'mask' ? b.tolerance * 2.55 : 0;
  commitFloat();
  combineArea(ME.regionOf(L.data, L.cols, i, tol + 1e-6, b.contiguous), op);
}

/** The value of cleared cells: none for masks and categories; for the height, the mean height around the area. */
function clearValue(L, mask, [x0, y0, x1, y1]) {
  if (L.type !== 'height') return 0;
  const N = L.cols, R = L.rows, d = L.data;
  let s = 0, n = 0;
  for (let y = Math.max(0, y0 - 1); y < Math.min(R, y1 + 1); y++) {
    for (let x = Math.max(0, x0 - 1); x < Math.min(N, x1 + 1); x++) {
      const i = y * N + x;
      if (mask[i]) continue;
      if ((x > 0 && mask[i - 1]) || (x < N - 1 && mask[i + 1]) || (y > 0 && mask[i - N]) || (y < R - 1 && mask[i + N])) { s += d[i]; n++; }
    }
  }
  return n ? s / n : 0;
}

function editableRaster() {
  const L = S.active;
  if (!L?.raster) { toast('Select a mask, categories or height layer'); return null; }
  return canEdit(L) ? L : null;
}

function setCells(L, mask, [x0, y0, x1, y1], v) {
  const N = L.cols;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (mask[y * N + x]) L.data[y * N + x] = v;
}

function clearArea(label = 'clear') {
  commitFloat();
  const L = editableRaster();
  if (!L || !S.area) return;
  const { mask, bbox } = S.area, before = copyRect(L.data, L.cols, bbox);
  setCells(L, mask, bbox, clearValue(L, mask, bbox));
  L.refresh(...bbox);
  L.dirty = true;
  pushRasterUndoSub(L, `${label} on ${L.meta.name}`, before, bbox);
  requestRender();
}

function fillArea() {
  commitFloat();
  const L = editableRaster();
  if (!L || !S.area) return;
  const [x0, y0, x1, y1] = S.area.bbox, N = L.cols, w = x1 - x0, cov = new Uint8Array(w * (y1 - y0));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (S.area.mask[y * N + x]) cov[(y - y0) * w + x - x0] = 255;
  paintCoverage(L, { cov, x0, y0, x1, y1 }, `fill selection on ${L.meta.name}`, true);
  requestRender();
}

/** The selected cells of a layer as a block {data, mask, w, h, x, y}. */
function areaBlock(L) {
  const { mask, bbox: [x0, y0, x1, y1] } = S.area, N = L.cols, w = x1 - x0, h = y1 - y0;
  const data = new L.data.constructor(w * h), m = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * N + x, k = (y - y0) * w + x - x0;
      if (mask[i]) { m[k] = 1; data[k] = L.data[i]; }
    }
  }
  return { data, mask: m, w, h, x: x0, y: y0 };
}

// --- floating cells: {layer, before (the layer before), base (under the cells), data, mask, w, h, x, y, touched}

function floatRect(F) {
  const L = F.layer;
  return [Math.max(0, F.x), Math.max(0, F.y), Math.min(L.cols, F.x + F.w), Math.min(L.rows, F.y + F.h)];
}

/** Take the floating cells off the layer: it shows what is under them. */
function unplaceFloat() {
  const F = S.float, L = F.layer;
  if (!F.placed) return;
  F.placed = false;
  const r = floatRect(F);
  if (r[0] >= r[2] || r[1] >= r[3]) return;
  pasteRect(L.data, L.cols, r, copyRect(F.base, L.cols, r));
  L.refresh(...r);
  L.dirty = true;
}

/** Put the floating cells with their corner at cell (x, y). */
function placeFloat(x, y) {
  const F = S.float, L = F.layer, N = L.cols;
  unplaceFloat();
  F.x = x; F.y = y; F.placed = true;
  const r = floatRect(F);
  if (r[0] < r[2] && r[1] < r[3]) {
    for (let v = r[1]; v < r[3]; v++) {
      for (let u = r[0]; u < r[2]; u++) {
        const k = (v - y) * F.w + (u - x);
        if (F.mask[k]) L.data[v * N + u] = F.data[k];
      }
    }
    L.refresh(...r);
    const t = F.touched;
    F.touched = t ? [Math.min(t[0], r[0]), Math.min(t[1], r[1]), Math.max(t[2], r[2]), Math.max(t[3], r[3])] : r;
  }
  L.dirty = true;
  requestRender();
}

function startFloat(L, block, label, before, touched) {
  S.float = {
    layer: L, before, base: L.data.slice(), data: block.data, mask: block.mask, w: block.w, h: block.h,
    x: block.x, y: block.y, placed: false, touched, areaBefore: S.area, label,
    path: ME.maskOutline(block.mask, block.w, [0, 0, block.w, block.h], block.h),
  };
  S.area = null;
  placeFloat(block.x, block.y);
  renderOptions();
}

/** The selected cells of the active layer start floating: moved (cut from the layer), or a copy. */
function liftArea(copy) {
  const L = S.active;
  if (!L?.raster || !S.area || !canEdit(L)) return false;
  const block = areaBlock(L), before = L.data.slice(), { mask, bbox } = S.area;
  if (!copy) setCells(L, mask, bbox, clearValue(L, mask, bbox));
  startFloat(L, block, copy ? 'move a copy' : 'move', before, copy ? null : [...bbox]);
  return true;
}

function transformFloat(op) {
  const F = S.float;
  if (!F) return;
  unplaceFloat();
  const cx = F.x + F.w / 2, cy = F.y + F.h / 2;
  Object.assign(F, ME.transformBlock(F.data, F.mask, F.w, F.h, op));
  F.path = ME.maskOutline(F.mask, F.w, [0, 0, F.w, F.h], F.h);
  placeFloat(Math.round(cx - F.w / 2), Math.round(cy - F.h / 2));
}

/** Apply the floating cells: the whole move or paste is one undo step; the area follows the cells. */
function commitFloat() {
  const F = S.float;
  if (!F) return;
  S.float = null;
  const L = F.layer, N = L.cols, R = L.rows, m = new Uint8Array(N * R);
  for (let v = 0; v < F.h; v++) {
    for (let u = 0; u < F.w; u++) {
      const x = F.x + u, y = F.y + v;
      if (F.mask[v * F.w + u] && x >= 0 && y >= 0 && x < N && y < R) m[y * N + x] = 1;
    }
  }
  setArea(m);
  const rect = F.touched;
  if (!rect) return;
  const b = copyRect(F.before, N, rect), a = copyRect(L.data, N, rect);
  if (a.every((v, k) => v === b[k])) return;
  const areaBefore = F.areaBefore, areaAfter = S.area;
  const apply = (sub, area) => { pasteRect(L.data, N, rect, sub); L.refresh(...rect); L.dirty = true; S.area = area; };
  pushUndo({ label: `${F.label} on ${L.meta.name}`, layer: L, content: true, undo: () => apply(b, areaBefore), redo: () => apply(a, areaAfter) });
}

function cancelFloat() {
  const F = S.float;
  if (!F) return;
  S.float = null;
  const L = F.layer, N = L.cols;
  if (F.touched) {
    pasteRect(L.data, N, F.touched, copyRect(F.before, N, F.touched));
    L.refresh(...F.touched);
    L.dirty = true;
  }
  S.area = F.areaBefore;
  toast(`Cancelled: ${F.label}`, 1200);
  renderOptions();
  requestRender();
}

function deleteFloat() {
  const F = S.float;
  if (!F) return;
  unplaceFloat();
  F.mask = new Uint8Array(F.w * F.h);
  F.label = F.label === 'paste' ? 'paste' : 'delete';
  commitFloat();
  requestRender();
}

// --- copy and paste: objects and notes, or the cells of the selected area

function copySelection(cut) {
  if (S.sel.ids.size) { copyItems(cut); return; }
  const L = S.active;
  if (!L?.raster) { toast('Nothing to copy: select objects or notes, or an area of a mask, categories or height layer'); return; }
  commitFloat();
  if (!S.area) { toast('Select an area first (Select area, L)'); return; }
  const count = S.area.count;
  S.clip = { kind: 'cells', type: L.type, ...areaBlock(L), classes: L.type === 'category' ? L.meta.classes.map(c => c.name) : null };
  if (cut) clearArea('cut');
  toast(`${cut ? 'Cut' : 'Copied'} ${m2(count)} of ${L.meta.name}`, 1800);
  renderOptions();
}

function pasteClip() {
  const C = S.clip;
  if (!C) { toast('Nothing copied yet'); return; }
  if (C.kind === 'items') { pasteItems(); return; }
  const L = S.active;
  if (!L?.raster || L.type !== C.type) { toast(`The copied cells are from a ${TYPE_NAMES[C.type]} layer: select a ${TYPE_NAMES[C.type]} layer to paste into`, 3000); return; }
  if (!canEdit(L)) return;
  commitFloat();
  let data = C.data.slice();
  if (C.classes) { // categories: the classes of the same name, else of the same number
    const names = L.meta.classes.map(c => c.name);
    const map = C.classes.map((n, k) => { const j = names.indexOf(n); return j >= 0 ? j : k < names.length ? k : 0; });
    data = data.map(v => map[v] ?? 0);
  }
  let { x, y } = C;
  const [sx, sy] = view.toScreen(...cellToWorld(x + C.w / 2, y + C.h / 2));
  if (sx < 0 || sy < 0 || sx > view.w || sy > view.h) { // not in sight: to the middle of the view
    const [cx, cy] = toCell(...view.toWorld(view.w / 2, view.h / 2));
    x = Math.round(cx - C.w / 2);
    y = Math.round(cy - C.h / 2);
  }
  startFloat(L, { data, mask: C.mask.slice(), w: C.w, h: C.h, x, y }, 'paste', L.data.slice(), null);
  if (S.tool !== 'area') setTool('area');
  toast('Pasted: drag it into place; Enter applies, Esc cancels', 3000);
}

function copyItems(cut) {
  const L = S.sel.layer, items = selectedItems();
  if (!L || !items.length) return;
  S.clip = { kind: 'items', type: L.type, items: cloneItems(items) };
  const what = `${items.length} ${L.type === 'notes' ? 'note' : 'object'}${items.length > 1 ? 's' : ''}`;
  if (cut) { if (!canEdit(L)) return; deleteSelected(); }
  toast(`${cut ? 'Cut' : 'Copied'} ${what}`, 1500);
  renderOptions();
}

function pasteItems() {
  const C = S.clip, L = S.active;
  if (!L?.hasItems || L.type !== C.type) { toast(`Select ${C.type === 'notes' ? 'a notes' : 'an objects'} layer to paste into`); return; }
  if (!canEdit(L)) return;
  let dx = 2, dz = 2; // next to the copied ones, or at the cursor
  if (S.screen && S.cursor) {
    dx = S.cursor[0] - C.items.reduce((s, i) => s + i.x, 0) / C.items.length;
    dz = S.cursor[1] - C.items.reduce((s, i) => s + i.z, 0) / C.items.length;
  }
  const r2 = v => +v.toFixed(2), ids = [];
  editObjects(L, `paste ${C.items.length}`, () => {
    let next = L.nextId();
    for (const it of C.items) {
      const c = structuredClone(it);
      c.id = next++;
      c.x = r2(c.x + dx); c.z = r2(c.z + dz);
      if (c.a) { c.a = [r2(c.a[0] + dx), r2(c.a[1] + dz)]; c.b = [r2(c.b[0] + dx), r2(c.b[1] + dz)]; }
      L.items.push(c);
      ids.push(c.id);
    }
  });
  select(L, ids);
  renderLayers();
}

// --- shapes being drawn (S.draft): {kind: 'shape' (painted) | 'area' (selected), type, pts (world), op, layer}

function snapPoint(d, p, shift) {
  if (!shift || d.pts.length < 2) return p;
  const q = d.pts[d.pts.length - 2], len = Math.hypot(p[0] - q[0], p[1] - q[1]);
  const a = Math.round(Math.atan2(p[1] - q[1], p[0] - q[0]) / (Math.PI / 12)) * (Math.PI / 12);
  return [q[0] + Math.cos(a) * len, q[1] + Math.sin(a) * len];
}

/** Start a shape, or add a point to the polygon / line being drawn. */
function draftDown(kind, type, x, z, e, sx, sy, extra = {}) {
  const d = S.draft;
  if (d && CLICK_SHAPES.includes(d.type)) {
    const [fx, fy] = view.toScreen(...d.pts[0]);
    if (d.type === 'polygon' && d.pts.length > 3 && Math.hypot(sx - fx, sy - fy) <= 8) { finishDraft(); return; }
    const p = snapPoint(d, [x, z], e.shiftKey);
    d.pts[d.pts.length - 1] = p;
    d.pts.push([...p]);
    requestRender();
    return;
  }
  S.draft = { kind, type, pts: [[x, z], [x, z]], start: [x, z], center: kind === 'shape' && !!e.altKey, layer: S.active, ...extra };
  drag = { mode: 'draft', sx, sy, moved: false };
  requestRender();
}

function draftMove(x, z, e, sx, sy) {
  const d = S.draft;
  if (CLICK_SHAPES.includes(d.type)) d.pts[d.pts.length - 1] = snapPoint(d, [x, z], e.shiftKey);
  else if (drag?.mode === 'draft') {
    if (d.type === 'free') {
      const q = d.pts[d.pts.length - 1];
      if (Math.hypot(x - q[0], z - q[1]) * view.scale >= 2) d.pts.push([x, z]);
    } else {
      let [ax, az] = d.start, bx = x, bz = z;
      if (e.shiftKey && d.kind === 'shape') { // square, circle
        const s = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
        bx = ax + (bx < ax ? -s : s);
        bz = az + (bz < az ? -s : s);
      }
      if (d.center) { ax = 2 * d.start[0] - bx; az = 2 * d.start[1] - bz; }
      d.pts = [[ax, az], [bx, bz]];
    }
  }
  if (drag?.mode === 'draft' && Math.hypot(sx - drag.sx, sy - drag.sy) > 4) drag.moved = true;
}

function draftUp(dr) {
  const d = S.draft;
  if (!d) return;
  if (!CLICK_SHAPES.includes(d.type)) {
    if (dr.moved) finishDraft();
    else { S.draft = null; if (d.kind === 'area' && d.op === 'replace') deselectArea(); } // a click: deselect
  } else if (dr.moved) {
    if (d.type === 'line' && d.pts.length === 2) finishDraft(true); // one segment, dragged
    else d.pts.push([...d.pts[d.pts.length - 1]]);
  }
}

/** Finish the shape: paint it, or select it. keepLast: the last point is not the rubber band point. */
function finishDraft(keepLast = false) {
  const d = S.draft;
  if (!d) return;
  S.draft = null;
  let pts = d.pts;
  if (CLICK_SHAPES.includes(d.type)) {
    if (!keepLast) pts = pts.slice(0, -1);
    pts = pts.filter((p, k) => !k || Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) * view.scale > 3);
  }
  requestRender();
  if (pts.length < (d.type === 'polygon' || d.type === 'free' ? 3 : 2)) return;
  const cells = pts.map(p => toCell(...p));
  if (d.kind === 'area') {
    const c = ME.shapeCoverage(S.cols, S.rows, { type: d.type, pts: cells, fill: true }), m = new Uint8Array(S.cols * S.rows);
    if (c) {
      const w = c.x1 - c.x0;
      for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) if (c.cov[(y - c.y0) * w + x - c.x0] >= 128) m[y * S.cols + x] = 1;
    }
    combineArea(m, d.op);
    return;
  }
  const L = d.layer;
  if (!S.layers.includes(L) || !canEdit(L)) return;
  const b = S.brush, outline = d.type === 'line' || b.shapeFill === 'outline';
  const c = ME.shapeCoverage(L.cols, L.rows, { type: d.type, pts: cells, fill: !outline, width: b.size / mpp(), feather: L.type === 'category' ? 0 : b.feather / mpp() });
  if (c) paintCoverage(L, c, `${SHAPES[d.type].toLowerCase()} on ${L.meta.name}`);
  renderSaveState();
}

function previewColor(L) {
  if (!L) return '#ffffff';
  if (L.type === 'mask') return L.meta.color || '#ffffff';
  if (L.type === 'category') return L.meta.classes[S.brush.cls]?.color || '#ffffff';
  return S.brush.mode === 'lower' ? '#7ab8ff' : S.brush.mode === 'raise' ? '#ffcf7a' : '#ffffff';
}

function drawDraft() {
  const d = S.draft, b = S.brush, pts = d.pts.map(p => view.toScreen(...p));
  ctx.beginPath();
  if (d.type === 'rect' || d.type === 'ellipse') {
    const [[ax, ay], [bx, by]] = pts, x0 = Math.min(ax, bx), y0 = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
    if (d.type === 'rect') ctx.rect(x0, y0, w, h);
    else ctx.ellipse(x0 + w / 2, y0 + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else {
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (d.type !== 'line') ctx.closePath();
  }
  const color = d.kind === 'shape' ? previewColor(d.layer) : '#ffffff';
  if (d.kind === 'shape' && (d.type === 'line' || b.shapeFill === 'outline')) {
    ctx.lineWidth = Math.max(b.size * view.scale, 1);
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.strokeStyle = ME.rgba(color, 0.45);
    ctx.stroke();
  } else {
    ctx.fillStyle = ME.rgba(color, d.kind === 'shape' ? 0.35 : 0.08);
    ctx.fill();
  }
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.setLineDash([]);
  if (CLICK_SHAPES.includes(d.type)) {
    pts.slice(0, -1).forEach(([x, y], k) => {
      const r = k === 0 && d.type === 'polygon' ? 5 : 3.5;
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#1a1520'; ctx.lineWidth = 1.5;
      ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.strokeRect(x - r, y - r, r * 2, r * 2);
    });
  }
  let text = '';
  if (d.type === 'rect' || d.type === 'ellipse') {
    text = `${Math.abs(d.pts[1][0] - d.pts[0][0]).toFixed(1)} × ${Math.abs(d.pts[1][1] - d.pts[0][1]).toFixed(1)} m`;
  } else if (d.type === 'line') {
    let len = 0;
    for (let k = 1; k < d.pts.length; k++) len += Math.hypot(d.pts[k][0] - d.pts[k - 1][0], d.pts[k][1] - d.pts[k - 1][1]);
    text = `${len.toFixed(1)} m`;
  }
  if (text) {
    const [x, y] = pts[pts.length - 1];
    ctx.font = '12px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(16,13,20,0.9)'; ctx.strokeText(text, x + 12, y + 10);
    ctx.fillStyle = '#ffffff'; ctx.fillText(text, x + 12, y + 10);
  }
}

/** The outline of the selected area or of the floating cells (two-tone dashes). */
function drawArea() {
  const F = S.float, A = S.area;
  if (!F && !A) return;
  const c = view.cellPx();
  view.setCellTransform(ctx);
  if (F) ctx.translate(F.x, F.y);
  const path = F ? F.path : A.path;
  ctx.lineWidth = 1.3 / c;
  ctx.strokeStyle = 'rgba(10,8,14,0.9)';
  ctx.stroke(path);
  ctx.setLineDash([4 / c, 4 / c]);
  ctx.strokeStyle = F ? '#f0a35e' : '#ffffff';
  ctx.stroke(path);
  ctx.setLineDash([]);
  view.setScreenTransform(ctx);
}

// ------------------------------------------------------------------------------------------------ notes

const NOTE_COLORS = ['#ffd25a', '#ff9eb0', '#8fd0ff', '#a6e39a', '#d4b3ff', '#ffffff'];

function today() { return new Date().toISOString().slice(0, 10); }

/** The notes layer under the world point, top first. */
function pickNote(x, z) {
  for (const l of [...S.layers].reverse()) {
    if (l.type !== 'notes' || !l.meta.visible || l.meta.locked) continue;
    const it = l.hit(x, z, view);
    if (it) return { layer: l, it };
  }
  return null;
}

/** The layer new notes go to: the selected notes layer, else the top one; made when there is none. */
function notesLayer() {
  if (S.active?.type === 'notes' && !S.active.meta.locked) return S.active;
  let L = [...S.layers].reverse().find(l => l.type === 'notes' && !l.meta.locked);
  if (!L) {
    L = makeLayer(newLayerMeta('Notes', 'notes', NOTE_COLORS[0], 'Notes', 'Notes pinned to the map.'), S.proj);
    L.apply(null);
    L.dirty = true;
    setLayers([...S.layers, L], L, 'new layer Notes');
    renderAll();
    toast('Made the layer “Notes” for the notes', 2000);
  }
  if (!L.meta.visible) { L.meta.visible = true; saveLayerView(); }
  return L;
}

function noteDown(x, z) {
  const hit = pickNote(x, z);
  if (hit) {
    if (S.active !== hit.layer) setActive(hit.layer);
    select(hit.layer, [hit.it.id]);
    openNoteEditor(hit.layer, hit.it);
    return;
  }
  const L = notesLayer();
  if (S.active !== L) setActive(L);
  select(L, []);
  openNoteEditor(L, null, x, z);
}

function openNoteEditor(L, it, x, z) {
  closeNoteEditor(true);
  const ed = $('#note-editor'), ta = ed.querySelector('textarea');
  S.noteEdit = { layer: L, id: it ? it.id : null, x: it ? it.x : x, z: it ? it.z : z, color: it ? it.color || null : S.noteColor || null };
  ta.value = it ? it.text || '' : '';
  ed.querySelector('.delete').textContent = it ? 'Delete' : 'Discard';
  renderNoteColors();
  ed.hidden = false;
  positionNoteEditor();
  ta.focus();
  requestRender();
}

function renderNoteColors() {
  const ne = S.noteEdit, box = $('#note-editor .colors');
  box.innerHTML = '';
  const current = ne.color || ne.layer.meta.color;
  for (const c of NOTE_COLORS) {
    box.append(el('button', {
      class: 'dot' + (c === current ? ' on' : ''), style: `background:${c}`, title: c,
      onmousedown: ev => ev.preventDefault(), // keep the focus in the text
      onclick: () => { ne.color = c === ne.layer.meta.color ? null : c; S.noteColor = ne.color; renderNoteColors(); },
    }));
  }
}

function positionNoteEditor() {
  const ne = S.noteEdit, ed = $('#note-editor');
  if (!ne || !view) return;
  const [sx, sy] = view.toScreen(ne.x, ne.z);
  const ui = ME.UI_SCALE; // the view is in UI pixels, the editor in CSS pixels
  ed.style.left = Math.max(3, Math.min(view.w * ui - ed.offsetWidth - 3, (sx + 12) * ui)) + 'px';
  ed.style.top = Math.max(3, Math.min(view.h * ui - ed.offsetHeight - 3, (sy + 12) * ui)) + 'px';
}

/** Close the note editor; keep: save the text (an empty text deletes the note). */
function closeNoteEditor(keep) {
  const ne = S.noteEdit;
  if (!ne) return;
  S.noteEdit = null;
  const ed = $('#note-editor'), ta = ed.querySelector('textarea'), text = ta.value.trim(), L = ne.layer;
  ed.hidden = true;
  if (document.activeElement === ta) ta.blur();
  requestRender();
  if (!keep || !S.layers.includes(L)) return;
  const it = ne.id != null ? L.items.find(i => i.id === ne.id) : null;
  const setColor = o => { if (ne.color && ne.color !== L.meta.color) o.color = ne.color; else delete o.color; };
  if (!it) {
    if (!text) return;
    const n = { id: L.nextId(), x: +ne.x.toFixed(2), z: +ne.z.toFixed(2), text, date: today() };
    setColor(n);
    editObjects(L, 'add note', () => L.items.push(n));
    select(L, [n.id]);
  } else if (!text) {
    editObjects(L, 'delete note', () => { L.items = L.items.filter(i => i.id !== ne.id); });
    select(L, []);
  } else if (text !== (it.text || '') || (ne.color || null) !== (it.color || null)) {
    editObjects(L, 'edit note', () => { const o = L.items.find(i => i.id === ne.id); o.text = text; setColor(o); });
  }
  renderLayers();
}

function renderNoteProps(box, L, items) {
  box.append(el('div', { class: 'section-head' }, items.length === 1 ? 'Note' : `${items.length} notes`, el('span', { class: 'muted' }, `· ${L.meta.name}`)));
  const edit = (label, fn) => editObjects(L, label, () => { for (const it of selectedItems()) fn(it); });
  if (items.length === 1) {
    const it = items[0];
    const text = el('textarea', { rows: 5, onchange: () => { const t = text.value.trim(); if (t) edit('edit note', o => { o.text = t; }); } });
    text.value = it.text || '';
    box.append(row('Text', text));
    const num = key => {
      const input = el('input', { type: 'number', step: 0.5, value: it[key], style: 'width:54px', onchange: () => edit('move note', o => { o[key] = +(+input.value).toFixed(2); }) });
      return input;
    };
    box.append(row('Position', el('span', { class: 'muted' }, 'x'), num('x'), el('span', { class: 'muted' }, 'z'), num('z')));
    if (it.date) box.append(row('Added', el('span', {}, it.date)));
  }
  const current = items.every(i => (i.color || null) === (items[0].color || null)) ? items[0].color || L.meta.color : null;
  box.append(row('Color', el('div', { class: 'inline' }, ...NOTE_COLORS.map(c => el('button', {
    class: 'dot' + (c === current ? ' on' : ''), style: `background:${c}`, title: c,
    onclick: () => edit('note color', o => { if (c === L.meta.color) delete o.color; else o.color = c; }),
  })))));
  box.append(el('div', { class: 'layer-actions' },
    items.length === 1 ? el('button', { onclick: () => openNoteEditor(L, items[0]) }, 'Edit on the map') : null,
    el('button', { onclick: duplicateSelected }, 'Duplicate'),
    el('button', { class: 'danger', onclick: deleteSelected }, 'Delete'),
    el('button', { onclick: () => select(L, []) }, 'Deselect')));
  box.append(el('div', { class: 'hint' }, 'Double-click a note on the map to edit it. Drag to move (Select, V). Ctrl+C / Ctrl+V copy notes.'));
}

// ------------------------------------------------------------------------------------------------ pointer

let drag = null;
let spaceDown = false;

function effectiveTool(e) {
  if (spaceDown) return 'pan';
  if (e && e.altKey && ['brush', 'eraser', 'fill', 'smooth'].includes(S.tool)) return 'picker';
  return S.tool;
}

function eventPos(e) {
  const r = canvas.getBoundingClientRect(), ui = ME.UI_SCALE; // to UI pixels (js/view.js)
  return [(e.clientX - r.left) / ui, (e.clientY - r.top) / ui];
}

canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('mousedown', e => { if (S.noteEdit) e.preventDefault(); }); // keep the focus in the note

/** Select area: draw a shape to select, click with the magic wand, or drag the selected / floating cells. */
function areaDown(x, z, e, sx, sy) {
  const mode = S.brush.area, op = areaOp(e);
  if (S.draft) { draftDown('area', S.draft.type, x, z, e, sx, sy); return; }
  if (S.float) {
    if (inFloat(x, z)) drag = { mode: 'float', start: toCell(x, z), from: [S.float.x, S.float.y] };
    else { commitFloat(); requestRender(); } // a click outside applies the floating cells
    return;
  }
  if (op === 'replace' && S.area && S.active?.raster && inArea(x, z)) {
    drag = { mode: 'lift', sx, sy, x, z, copy: e.ctrlKey || e.metaKey, start: toCell(x, z) };
    return;
  }
  if (mode === 'wand') { wandAt(x, z, op); return; }
  draftDown('area', mode, x, z, e, sx, sy, { op });
}

function hoverCursor(x, z, e) {
  if (spaceDown || drag) return;
  if (S.tool === 'area') {
    const over = S.float ? inFloat(x, z) : !e.shiftKey && !e.altKey && !S.draft && S.active?.raster && inArea(x, z);
    canvas.style.cursor = over ? 'move' : 'crosshair';
  } else if (S.tool === 'note') {
    canvas.style.cursor = pickNote(x, z) ? 'pointer' : 'crosshair';
  }
}

canvas.addEventListener('pointerdown', e => {
  if (!view || !S.project) return;
  canvas.setPointerCapture(e.pointerId);
  const [sx, sy] = eventPos(e), [x, z] = view.toWorld(sx, sy);
  const tool = e.button === 1 || e.button === 2 ? 'pan' : effectiveTool(e);
  const L = S.active;
  if (tool === 'pan') { drag = { mode: 'pan', sx, sy }; canvas.style.cursor = 'grabbing'; return; }
  if (S.noteEdit) { // a click on the map saves the note being written (a click on that note keeps writing)
    const hit = pickNote(x, z);
    if (!(hit && S.noteEdit.id != null && hit.it.id === S.noteEdit.id && hit.layer === S.noteEdit.layer)) closeNoteEditor(true);
    return;
  }
  if (tool === 'shape') {
    if (!S.draft) {
      if (!L?.raster) { toast('Select a mask, categories or height layer to draw shapes on'); return; }
      if (!canEdit(L)) return;
    }
    draftDown('shape', S.draft ? S.draft.type : S.brush.shape, x, z, e, sx, sy);
    return;
  }
  if (tool === 'area') { areaDown(x, z, e, sx, sy); return; }
  if (tool === 'note') { noteDown(x, z); return; }
  if (tool === 'measure') { S.measure = [[x, z], [x, z]]; drag = { mode: 'measure' }; requestRender(); return; }
  if (tool === 'picker') { pickValue(L, x, z); return; }
  if (['brush', 'eraser', 'smooth'].includes(tool)) {
    if (!L?.raster) { toast('Select a painted layer (mask, categories or height) to paint on'); return; }
    if (!toolFits(tool, L)) { toast(`${toolName(tool)} does not work on ${TYPE_NAMES[L.type]} layers`); return; }
    if (!canEdit(L)) return;
    beginStroke(L, tool, ...toCell(x, z), e.shiftKey);
    drag = { mode: 'stroke' };
    requestRender();
    return;
  }
  if (tool === 'fill') {
    if (!L?.raster || !toolFits('fill', L)) { toast('Fill works on mask and category layers'); return; }
    if (canEdit(L)) floodFill(L, x, z);
    requestRender();
    return;
  }
  if (tool === 'add') {
    if (L?.type !== 'objects') { toast('Select an objects layer to add objects'); return; }
    if (canEdit(L)) addObject(L, x, z);
    return;
  }
  if (tool === 'select') {
    // handles of the single selected object first
    const SL = S.sel.layer;
    if (SL && S.sel.ids.size === 1 && SL.meta.visible && !SL.meta.locked) {
      const it = selectedItems()[0];
      const h = it && rotateHandle(SL, it);
      if (h && Math.hypot(sx - h[0], sy - h[1]) <= 9) {
        drag = { mode: 'rotate', layer: SL, it, before: cloneItems(SL.items), a0: Math.atan2(sy - h[3], sx - h[2]), yaw0: it.yaw || 0 };
        return;
      }
      if (it && it.a && SL.meta.style === 'link') {
        for (const end of ['a', 'b']) {
          const [ex, ey] = view.toScreen(it[end][0], it[end][1]);
          if (Math.hypot(sx - ex, sy - ey) <= Math.max(SL.markerRadius(view) * 0.7, 6) + 3) {
            drag = { mode: 'end', end, layer: SL, it, before: cloneItems(SL.items) };
            return;
          }
        }
      }
    }
    const hit = pickObject(x, z);
    if (hit) {
      if (hit.layer !== S.active) setActive(hit.layer);
      const ids = new Set(S.sel.layer === hit.layer ? S.sel.ids : []);
      if (e.shiftKey) { if (ids.has(hit.it.id)) ids.delete(hit.it.id); else ids.add(hit.it.id); }
      else if (!ids.has(hit.it.id)) { ids.clear(); ids.add(hit.it.id); }
      select(hit.layer, ids);
      if (ids.has(hit.it.id)) {
        drag = {
          mode: 'move', layer: hit.layer, start: [x, z], before: cloneItems(hit.layer.items),
          orig: new Map(selectedItems().map(i => [i.id, { x: i.x, z: i.z, a: i.a && [...i.a], b: i.b && [...i.b] }])),
        };
      }
    } else {
      if (!e.shiftKey) select(S.active?.hasItems ? S.active : null, []);
      drag = { mode: 'box', start: [x, z], add: e.shiftKey };
      S.box = [x, z, x, z];
    }
    requestRender();
  }
});

canvas.addEventListener('pointermove', e => {
  if (!view || !S.project) return;
  const [sx, sy] = eventPos(e), [x, z] = view.toWorld(sx, sy);
  S.cursor = [x, z];
  S.screen = [sx, sy];
  if (S.draft) draftMove(x, z, e, sx, sy);
  if (!drag) hoverCursor(x, z, e);
  if (drag) {
    if (drag.mode === 'pan') { view.pan(sx - drag.sx, sy - drag.sy); drag.sx = sx; drag.sy = sy; }
    else if (drag.mode === 'lift') { // dragging the selected cells: they start floating
      if (Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag = liftArea(drag.copy) ? { mode: 'float', start: drag.start, from: [S.float.x, S.float.y] } : null;
    } else if (drag.mode === 'float' && S.float) {
      const [cx, cy] = toCell(x, z), nx = drag.from[0] + Math.round(cx - drag.start[0]), ny = drag.from[1] + Math.round(cy - drag.start[1]);
      if (nx !== S.float.x || ny !== S.float.y) placeFloat(nx, ny);
    }
    else if (drag.mode === 'measure') S.measure[1] = [x, z];
    else if (drag.mode === 'stroke' && stroke) strokeLine(stroke.last[0], stroke.last[1], ...toCell(x, z));
    else if (drag.mode === 'box') S.box = [Math.min(drag.start[0], x), Math.min(drag.start[1], z), Math.max(drag.start[0], x), Math.max(drag.start[1], z)];
    else if (drag.mode === 'move') {
      const dx = x - drag.start[0], dz = z - drag.start[1];
      for (const it of drag.layer.items) {
        const o = drag.orig.get(it.id);
        if (!o) continue;
        it.x = +(o.x + dx).toFixed(2); it.z = +(o.z + dz).toFixed(2);
        if (o.a) { it.a = [+(o.a[0] + dx).toFixed(2), +(o.a[1] + dz).toFixed(2)]; it.b = [+(o.b[0] + dx).toFixed(2), +(o.b[1] + dz).toFixed(2)]; }
      }
      drag.moved = true;
    } else if (drag.mode === 'rotate') {
      const [cx, cy] = view.toScreen(drag.it.x, drag.it.z);
      let yaw = drag.yaw0 - (Math.atan2(sy - cy, sx - cx) - drag.a0) * 180 / Math.PI;
      if (e.shiftKey) yaw = Math.round(yaw / 15) * 15;
      drag.it.yaw = +(((yaw + 540) % 360) - 180).toFixed(1);
      drag.moved = true;
    } else if (drag.mode === 'end') {
      drag.it[drag.end] = [+x.toFixed(2), +z.toFixed(2)];
      drag.moved = true;
    }
  }
  requestRender();
});

function endDrag() {
  const d = drag;
  if (!d) return;
  drag = null;
  if (d.mode === 'stroke') endStroke();
  else if (d.mode === 'draft') draftUp(d);
  else if (d.mode === 'lift') { // a click inside the selected area
    if (S.brush.area === 'wand') wandAt(d.x, d.z, 'replace');
    else if (S.brush.area === 'polygon') { draftDown('area', 'polygon', d.x, d.z, {}, d.sx, d.sy, { op: 'replace' }); drag = null; }
    else deselectArea();
  } else if (d.mode === 'float') renderOptions();
  else if (d.mode === 'box') {
    const [x0, z0, x1, z1] = S.box;
    const inBox = it => it.x >= x0 && it.x <= x1 && it.z >= z0 && it.z <= z1;
    // the selected objects layer, else the top visible unlocked one with something in the box
    const L = S.active?.hasItems ? S.active : objectLayersTopDown().find(l => l.items.some(inBox));
    if (L && L.meta.visible && (x1 - x0 > 0.1 || z1 - z0 > 0.1)) {
      if (L !== S.active) setActive(L);
      const ids = new Set(d.add && S.sel.layer === L ? S.sel.ids : []);
      for (const it of L.items) if (inBox(it)) ids.add(it.id);
      select(L, ids);
    }
    S.box = null;
  } else if (['move', 'rotate', 'end'].includes(d.mode) && d.moved) {
    const L = d.layer, before = d.before, after = cloneItems(L.items);
    const apply = items => { L.items = cloneItems(items); L.dirty = true; };
    L.dirty = true;
    pushUndo({ label: d.mode === 'rotate' ? 'rotate' : 'move', layer: L, content: true, undo: () => apply(before), redo: () => apply(after) });
    renderProps();
  }
  if (d.mode === 'pan') { canvas.style.cursor = ''; saveUi(); }
  updateCursor();
  requestRender();
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => { S.screen = null; requestRender(); });

canvas.addEventListener('dblclick', e => {
  if (!view || !S.project) return;
  if (S.draft && CLICK_SHAPES.includes(S.draft.type)) { finishDraft(); return; }
  const [sx, sy] = eventPos(e), [x, z] = view.toWorld(sx, sy);
  if (effectiveTool(e) === 'select') {
    const hit = pickNote(x, z);
    if (hit) openNoteEditor(hit.layer, hit.it);
  }
});

canvas.addEventListener('wheel', e => {
  if (!view) return;
  e.preventDefault();
  const [sx, sy] = eventPos(e);
  // wheel, two-finger scroll and pinch (ctrlKey) zoom around the cursor, like map viewers; drag to pan
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  view.zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)), sx, sy);
  clearTimeout(saveUi.timer);
  saveUi.timer = setTimeout(saveUi, 400);
  requestRender();
}, { passive: false });

function updateCursor() {
  const t = effectiveTool();
  canvas.style.cursor = t === 'pan' ? 'grab' : ['brush', 'eraser', 'smooth'].includes(t) && S.active?.raster ? 'none'
    : t === 'picker' ? 'copy' : t === 'select' ? 'default' : 'crosshair';
  if (S.cursor && S.screen) hoverCursor(...S.cursor, {});
}

// ------------------------------------------------------------------------------------------------ keyboard

const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) &&
  !['checkbox', 'range', 'radio', 'button'].includes(document.activeElement.type);

window.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (document.querySelector('dialog[open]')) return;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); pickFolder(); return; }
  if (typing()) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  const k = e.key.toLowerCase();
  if (mod && k === 'a') {
    e.preventDefault();
    if (e.shiftKey) deselectArea();
    else if (S.active?.hasItems) select(S.active, S.active.items.map(i => i.id));
    else if (S.active?.raster) selectAllArea();
    return;
  }
  if (mod && k === 'i') { e.preventDefault(); invertArea(); return; }
  if (mod && (k === 'c' || k === 'x')) { e.preventDefault(); copySelection(k === 'x'); return; }
  if (mod && k === 'v') { e.preventDefault(); pasteClip(); return; }
  if (mod) return;
  if (e.key === ' ') { if (!spaceDown) { spaceDown = true; updateCursor(); } e.preventDefault(); return; }
  if (e.key === 'Escape') {
    if (S.draft) S.draft = null;
    else if (S.float) cancelFloat();
    else if (S.measure || S.sel.ids.size) { S.measure = null; select(S.sel.layer, []); }
    else if (S.area) setArea(null);
    requestRender();
    return;
  }
  if (e.key === 'Enter') {
    if (S.draft) { e.preventDefault(); finishDraft(); } else if (S.float) { e.preventDefault(); commitFloat(); requestRender(); }
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (S.draft && CLICK_SHAPES.includes(S.draft.type)) { // the last point
      e.preventDefault();
      if (S.draft.pts.length > 2) S.draft.pts.splice(-2, 1); else S.draft = null;
      requestRender();
      return;
    }
    if (S.sel.ids.size) { e.preventDefault(); deleteSelected(); return; }
    if (S.float) { e.preventDefault(); deleteFloat(); return; }
    if (S.area && S.active?.raster) { e.preventDefault(); clearArea(); return; }
  }
  if (e.key.startsWith('Arrow')) {
    const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0, dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (S.sel.ids.size) {
      e.preventDefault();
      const d = e.shiftKey ? 2 : 0.25;
      moveSelected(dx * d, dy * d);
      return;
    }
    if (S.float || (S.area && S.tool === 'area' && S.active?.raster)) { // move the cells by one cell (Shift: 2 m)
      e.preventDefault();
      if (!S.float && !liftArea(false)) return;
      const n = e.shiftKey ? Math.round(2 / mpp()) : 1;
      placeFloat(S.float.x + dx * n, S.float.y + dy * n);
      renderOptions();
      return;
    }
  }
  if (k === 'r' && S.float) { transformFloat('cw'); return; }
  if (k === 'r' && S.sel.ids.size) { rotateSelected(e.shiftKey ? -15 : 15); return; }
  if (e.key === 'f' || e.key === 'F') { view.fit(); saveUi(); requestRender(); return; }
  if (e.key === '+' || e.key === '=') { zoomBy(1.4); return; }
  if (e.key === '-' || e.key === '_') { zoomBy(1 / 1.4); return; }
  if (e.key === 'G' && e.shiftKey) { S.grid = !S.grid; $('#grid').checked = S.grid; saveUi(); requestRender(); return; }
  if (e.key === '?') { $('#help-dlg').showModal(); return; }
  if (e.key === '[' || e.key === '{' || e.key === ']' || e.key === '}') {
    const up = e.key === ']' || e.key === '}';
    if (e.shiftKey) S.brush.strength = Math.max(1, Math.min(100, S.brush.strength + (up ? 10 : -10)));
    else S.brush.size = Math.max(0.25, Math.min(80, +(S.brush.size * (up ? 1.25 : 0.8)).toFixed(2)));
    renderOptions(); saveUi(); requestRender();
    return;
  }
  if (/^[0-9]$/.test(e.key) && S.active) {
    const n = +e.key;
    if (S.active.type === 'category' && n < S.active.meta.classes.length) { S.brush.cls = n; renderOptions(); renderProps(); }
    else if (S.active.type === 'mask') { S.brush.value = n === 0 ? 100 : n * 10; renderOptions(); }
    return;
  }
  const unfit = id => { // a tool that is not in the tool bar for this layer
    if (toolFits(id, S.active)) return false;
    toast(S.active ? `${toolName(id)} does not work on ${TYPE_NAMES[S.active.type]} layers` : 'Select a layer first', 1800);
    return true;
  };
  if (k === 'w') { if (unfit('area')) return; S.brush.area = 'wand'; S.draft = null; setTool('area'); return; }
  if (k === 'p') { toggle3d(); return; }
  const t = TOOLS.find(t => t.key === k);
  if (t && !unfit(t.id)) {
    // the key of the current tool again: the next shape / way to select
    const cycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
    if (t.id === S.tool && t.id === 'shape') { S.brush.shape = cycle(Object.keys(SHAPES), S.brush.shape); S.draft = null; }
    if (t.id === S.tool && t.id === 'area') { S.brush.area = cycle(['rect', 'ellipse', 'free', 'polygon'], S.brush.area); S.draft = null; }
    setTool(t.id);
  }
});

window.addEventListener('keyup', e => {
  if (e.key === ' ') { spaceDown = false; updateCursor(); }
});

window.addEventListener('beforeunload', e => {
  if (anyDirty()) { e.preventDefault(); e.returnValue = ''; }
});

window.addEventListener('resize', () => { if (view) { view.resize(); requestRender(); } });

// ------------------------------------------------------------------------------------------------ tools & options UI

function toolFits(tool, layer) {
  const t = TOOLS.find(t => t.id === tool);
  return !t.types || (layer && t.types.includes(layer.type));
}

function toolName(id) { return TOOLS.find(t => t.id === id).name; }

function setTool(id) {
  if (S.float && id !== 'area') commitFloat();
  if (S.draft && id !== S.tool) S.draft = null;
  if (id !== 'note') closeNoteEditor(true);
  S.tool = id;
  if (id !== 'measure') S.measure = null;
  renderTools();
  renderOptions();
  updateCursor();
  saveUi();
  requestRender();
}

function defaultTool(layer) {
  if (!layer) return 'pan';
  if (layer.hasItems) return 'select';
  if (layer.raster) return 'brush';
  return 'pan';
}

function setActive(layer, render = true) {
  if (S.float && S.float.layer !== layer) commitFloat();
  if (S.draft && S.draft.kind === 'shape' && S.draft.layer !== layer) S.draft = null;
  S.active = layer || null;
  if (layer && !toolFits(S.tool, layer) && EDIT_TOOLS.includes(S.tool)) S.tool = defaultTool(layer);
  if (S.sel.layer && S.sel.layer !== layer) S.sel = { layer: null, ids: new Set() };
  if (layer?.type === 'category' && S.brush.cls >= layer.meta.classes.length) S.brush.cls = Math.min(1, layer.meta.classes.length - 1);
  if (render) renderAll();
}

// The tool bar at the top: every shape and every way to select has its own button.
const TOOLBAR = [
  [{ tool: 'select', label: 'Select', icon: 'mouse-pointer-2' }, { tool: 'pan', label: 'Pan', icon: 'hand' }],
  [{ tool: 'brush', label: 'Brush', icon: 'brush' }, { tool: 'eraser', label: 'Eraser', icon: 'eraser' },
    { tool: 'smooth', label: 'Smooth', icon: 'waves' }, { tool: 'fill', label: 'Fill', icon: 'paint-bucket' }],
  [{ tool: 'shape', shape: 'rect', label: 'Rect', icon: 'square' }, { tool: 'shape', shape: 'ellipse', label: 'Ellipse', icon: 'circle' },
    { tool: 'shape', shape: 'polygon', label: 'Polygon', icon: 'pentagon' }, { tool: 'shape', shape: 'line', label: 'Line', icon: 'slash' },
    { tool: 'shape', shape: 'free', label: 'Freehand', icon: 'spline' }],
  [{ tool: 'picker', label: 'Pick', icon: 'pipette' }],
  [{ tool: 'area', area: 'rect', label: 'Rect', icon: 'square-dashed' }, { tool: 'area', area: 'ellipse', label: 'Ellipse', icon: 'circle-dashed' },
    { tool: 'area', area: 'free', label: 'Lasso', icon: 'lasso' }, { tool: 'area', area: 'polygon', label: 'Polygon', icon: 'pentagon', dashed: true },
    { tool: 'area', area: 'wand', label: 'Wand', icon: 'wand-sparkles' }],
  [{ tool: 'add', label: 'Add Object', icon: 'map-pin-plus' }],
  [{ tool: 'note', label: 'Note', icon: 'sticky-note' }],
  [{ tool: 'measure', label: 'Measure', icon: 'ruler' }],
];

/** The tool bar shows the tools for the selected layer only (painting tools for rasters, Add Object for objects); Select, Pan, Note and Measure always. */
function renderTools() {
  const nav = $('#tools');
  nav.innerHTML = '';
  const groups = TOOLBAR.map(group => group.filter(b => toolFits(b.tool, S.active))).filter(group => group.length);
  groups.forEach((group, g) => {
    if (g) nav.append(el('div', { class: 'tsep' }));
    for (const b of group) {
      const t = TOOLS.find(x => x.id === b.tool);
      const on = S.tool === b.tool && (!b.shape || S.brush.shape === b.shape) && (!b.area || S.brush.area === b.area);
      const name = b.shape ? `Shape: ${SHAPES[b.shape]}` : b.area ? `Select area: ${AREA_MODES[b.area]}` : t.name;
      const key = b.area === 'wand' ? 'W' : t.key.toUpperCase();
      nav.append(el('button', {
        class: 'tbtn' + (on ? ' on' : '') + (b.dashed ? ' dashed' : ''),
        title: `${name} (${key})`,
        onclick: () => {
          if (b.shape) S.brush.shape = b.shape;
          if (b.area) S.brush.area = b.area;
          if (b.shape || b.area) S.draft = null;
          setTool(b.tool);
        },
      }, ME.icon(b.icon), el('span', {}, b.label)));
    }
  });
}

function renderOptions() {
  renderTools();
  const box = $('#options');
  box.innerHTML = '';
  const L = S.active, t = S.tool, b = S.brush;
  const head = el('div', { class: 'section-head' }, toolName(t), el('span', { class: 'muted' }, L ? `· ${L.meta.name}` : ''));
  box.append(head);
  const brushRows = () => [
    row('Size', ...slider(0.25, 80, 0.25, b.size, v => { b.size = v; saveUi(); }), el('span', { class: 'muted' }, 'm')),
  ];
  const strengthRows = (label = 'Strength') => [
    row(label, ...slider(1, 100, 1, b.strength, v => { b.strength = v; saveUi(); }), el('span', { class: 'muted' }, '%')),
    row('Hardness', ...slider(0, 100, 1, b.hardness, v => { b.hardness = v; saveUi(); requestRender(); }), el('span', { class: 'muted' }, '%')),
  ];
  if (t === 'note') { renderNoteOptions(box); return; }
  if (!L) { box.append(el('div', { class: 'hint' }, 'Select a layer.')); return; }
  if (t === 'select') {
    box.append(el('div', { class: 'hint' }, 'Click an object or a note (on any visible unlocked layer) or drag a box. Drag to move, drag the orange dot to rotate (Shift: 15° steps). Shift+click adds to the selection. Double-click a note to edit it. Ctrl+C / Ctrl+V copy and paste (at the cursor).'));
    return;
  }
  if (['brush', 'eraser', 'smooth', 'fill', 'shape', 'picker', 'add'].includes(t) && !toolFits(t, L)) {
    box.append(el('div', { class: 'hint' }, `${toolName(t)} does not work on ${TYPE_NAMES[L.type]} layers.`));
    return;
  }
  if (t === 'shape') { renderShapeOptions(box, L); return; }
  if (t === 'area') { renderAreaOptions(box, L); return; }
  if (L.type === 'mask' && ['brush', 'eraser', 'smooth'].includes(t)) {
    box.append(...brushRows(), ...strengthRows());
    if (t === 'brush') box.append(row('Value', ...slider(0, 100, 1, b.value, v => { b.value = v; saveUi(); }), el('span', { class: 'muted' }, '%')));
    box.append(el('div', { class: 'hint' }, t === 'brush' ? 'Paints toward Value (density). Keys 1–9 = 10–90%, 0 = 100%. Alt+click picks.'
      : t === 'eraser' ? 'Paints toward 0.' : 'Blurs the edges under the brush.'));
  } else if (L.type === 'mask' && t === 'fill') {
    box.append(row('Value', ...slider(0, 100, 1, b.value, v => { b.value = v; saveUi(); }), el('span', { class: 'muted' }, '%')));
    box.append(row('Tolerance', ...slider(0, 100, 1, b.tolerance, v => { b.tolerance = v; saveUi(); }), el('span', { class: 'muted' }, '%')));
    box.append(el('div', { class: 'hint' }, 'Fills the connected area of a similar value.'));
  } else if (L.type === 'category' && ['brush', 'eraser', 'fill'].includes(t)) {
    if (t !== 'fill') box.append(...brushRows());
    if (t !== 'eraser') box.append(classPicker(L));
    box.append(el('div', { class: 'hint' }, t === 'eraser' ? 'Paints “none”.' : 'Keys 0–9 pick a class. Alt+click picks from the map.'));
  } else if (L.type === 'height' && ['brush', 'smooth'].includes(t)) {
    if (t === 'brush') {
      box.append(row('Mode', el('div', { class: 'seg' }, ...['raise', 'lower', 'flatten'].map(m => el('button', {
        class: b.mode === m ? 'on' : '', onclick: () => { b.mode = m; saveUi(); renderOptions(); },
      }, m[0].toUpperCase() + m.slice(1))))));
    }
    box.append(...brushRows(), ...strengthRows());
    if (t === 'brush' && b.mode !== 'flatten') box.append(row('Amount', ...slider(0.05, 10, 0.05, b.amount, v => { b.amount = v; saveUi(); }), el('span', { class: 'muted' }, 'm')));
    if (t === 'brush' && b.mode === 'flatten') box.append(row('Target', ...slider(-15, 40, 0.05, b.target, v => { b.target = v; saveUi(); }), el('span', { class: 'muted' }, 'm')));
    box.append(el('div', { class: 'hint' }, t === 'smooth' ? 'Evens out bumps under the brush.'
      : b.mode === 'flatten' ? 'Pulls the ground toward Target. Alt+click picks the height under the cursor.'
        : `${b.mode === 'raise' ? 'Raises' : 'Lowers'} the ground by up to Amount in one stroke.`));
  } else if (t === 'picker') {
    box.append(el('div', { class: 'hint' }, 'Click the map to take the value under the cursor for the brush.'));
  } else if (L.type === 'objects' && t === 'add') {
    const kinds = L.kinds();
    const dl = $('#kinds');
    dl.innerHTML = '';
    kinds.forEach(k => dl.append(el('option', { value: k })));
    const input = el('input', { value: S.addKind || kinds[0] || '', list: 'kinds', placeholder: 'kind', onchange: () => { S.addKind = input.value; saveUi(); } });
    box.append(row('Kind', input));
    box.append(el('div', { class: 'hint' }, 'Click the map to place. The size and properties are copied from the last object of the same kind.'));
  } else if (t === 'measure') {
    box.append(el('div', { class: 'hint' }, 'Drag to measure a distance in meters.'));
  } else if (t === 'pan') {
    box.append(el('div', { class: 'hint' }, 'Drag to pan. Wheel or pinch to zoom; F fits the map.'));
  } else {
    box.append(el('div', { class: 'hint' }, `${TYPE_NAMES[L.type]} layer: nothing to paint with ${toolName(t)}.`));
  }
  if (L.raster && ['brush', 'eraser', 'smooth', 'fill'].includes(t)) box.append(clipOption());
}

/** “Affect only the selected area”: painting tools paint only inside it (off: everywhere). */
function clipOption() {
  const cb = el('input', { type: 'checkbox', checked: S.brush.clip !== false, disabled: !S.area, onchange: () => { S.brush.clip = cb.checked; saveUi(); } });
  return el('label', { class: 'check-row' + (S.area ? '' : ' muted'), title: S.area ? '' : 'Select an area first (Select area tools)' }, cb, 'Affect only the selected area');
}

function seg(options, current, onPick) {
  return el('div', { class: 'seg' }, ...Object.entries(options).map(([k, v]) => el('button', { class: current === k ? 'on' : '', onclick: () => onPick(k) }, v)));
}

const unit = u => el('span', { class: 'muted' }, u);

/** The value shapes and fills paint: the mask density, the class, or the height change. fill: the height is a target. */
function paintValueRows(L, fill = false) {
  const b = S.brush, set = (key, v) => { b[key] = v; saveUi(); }, out = [];
  if (L.type === 'mask') out.push(row('Value', ...slider(0, 100, 1, b.value, v => set('value', v)), unit('%')));
  else if (L.type === 'category') out.push(classPicker(L));
  else if (fill) out.push(row('Height', ...slider(-15, 40, 0.05, b.target, v => set('target', v)), unit('m')));
  else {
    out.push(row('Mode', seg({ raise: 'Raise', lower: 'Lower', flatten: 'Flatten' }, b.mode, m => { b.mode = m; saveUi(); renderOptions(); requestRender(); })));
    if (b.mode === 'flatten') out.push(row('Target', ...slider(-15, 40, 0.05, b.target, v => set('target', v)), unit('m')));
    else out.push(row('Amount', ...slider(0.05, 10, 0.05, b.amount, v => set('amount', v)), unit('m')));
  }
  if (!fill && L.type !== 'category') out.push(row('Strength', ...slider(1, 100, 1, b.strength, v => set('strength', v)), unit('%')));
  return out;
}

const SHAPE_HINTS = {
  rect: 'Drag from corner to corner. Shift: a square, Alt: from the center.',
  ellipse: 'Drag from corner to corner. Shift: a circle, Alt: from the center.',
  polygon: 'Click the corners; click the first corner, double-click or Enter to close. Backspace removes the last corner, Esc cancels. Shift: 15° steps.',
  line: 'Click the points; double-click or Enter to finish (or drag a single segment). Backspace removes the last point. Shift: 15° steps.',
  free: 'Drag the outline: it closes when you let go.',
};

function renderShapeOptions(box, L) {
  const b = S.brush, redo = () => { saveUi(); renderOptions(); requestRender(); };
  box.append(row('Shape', seg(SHAPES, b.shape, k => { b.shape = k; S.draft = null; redo(); })));
  if (b.shape !== 'line') box.append(row('Draw', seg({ fill: 'Filled', outline: 'Outline' }, b.shapeFill, k => { b.shapeFill = k; redo(); })));
  if (b.shape === 'line' || b.shapeFill === 'outline') box.append(row('Width', ...slider(0.25, 80, 0.25, b.size, v => { b.size = v; saveUi(); requestRender(); }), unit('m')));
  if (L.type !== 'category') box.append(row('Soft edge', ...slider(0, 20, 0.25, b.feather, v => { b.feather = v; saveUi(); }), unit('m')));
  box.append(...paintValueRows(L));
  box.append(el('div', { class: 'hint' }, SHAPE_HINTS[b.shape] + ' Key U again: the next shape.'));
  box.append(clipOption());
}

const AREA_HINTS = {
  rect: 'Drag a rectangle.',
  ellipse: 'Drag an ellipse.',
  free: 'Lasso: drag around the area.',
  polygon: 'Click the corners; click the first one, double-click or Enter to close.',
  wand: 'Click a cell: selects the cells of a similar value on the selected layer.',
};

function renderAreaOptions(box, L) {
  const b = S.brush, F = S.float, A = S.area, can = !!L.raster;
  box.append(row('Mode', seg(AREA_MODES, b.area, k => { b.area = k; S.draft = null; saveUi(); renderOptions(); requestRender(); })));
  if (b.area === 'wand') {
    if (L.type === 'height') box.append(row('Tolerance', ...slider(0, 10, 0.05, b.tolH, v => { b.tolH = v; saveUi(); }), unit('m')));
    else if (L.type === 'mask') box.append(row('Tolerance', ...slider(0, 100, 1, b.tolerance, v => { b.tolerance = v; saveUi(); }), unit('%')));
    const cb = el('input', { type: 'checkbox', checked: b.contiguous, onchange: () => { b.contiguous = cb.checked; saveUi(); } });
    box.append(row('', el('label', { class: 'check' }, cb, ' Connected cells only')));
  }
  const btn = (text, title, fn, on = true) => el('button', { title, disabled: !on, onclick: fn }, text);
  if (F) {
    box.append(el('div', { class: 'hint area-hint' }, `Floating (${F.label}) on ${F.layer.meta.name}: drag it into place; arrows move it by a cell (Shift: 2 m). Enter or a click outside applies, Esc cancels, Delete drops it.`));
    box.append(el('div', { class: 'layer-actions wrap' },
      btn('↻ 90°', 'Turn a quarter clockwise (R)', () => transformFloat('cw')),
      btn('⇆ Flip', 'Flip left-right', () => transformFloat('h')),
      btn('⇅ Flip', 'Flip top-bottom', () => transformFloat('v')),
      btn('Apply', 'Enter', () => { commitFloat(); requestRender(); }),
      btn('Cancel', 'Esc', cancelFloat)));
    return;
  }
  if (A) {
    const [x0, y0, x1, y1] = A.bbox;
    box.append(row('Selected', el('span', {}, `${m2(A.count)} (${((x1 - x0) * mpp()).toFixed(1)} × ${((y1 - y0) * mpp()).toFixed(1)} m)`)));
  }
  box.append(el('div', { class: 'layer-actions wrap' },
    btn('Copy', 'Copy the cells of the selected layer (Ctrl+C)', () => copySelection(false), !!A && can),
    btn('Cut', 'Ctrl+X', () => copySelection(true), !!A && can),
    btn('Paste', 'Ctrl+V', pasteClip, S.clip?.kind === 'cells'),
    btn('Fill', 'Fill the area with the value below', fillArea, !!A && can),
    btn('Clear', 'Delete', () => clearArea(), !!A && can)));
  box.append(el('div', { class: 'layer-actions wrap' },
    btn('All', 'Select all (Ctrl+A)', selectAllArea),
    btn('Invert', 'Ctrl+I', invertArea),
    btn('Grow 1 m', 'Make the area 1 m bigger', () => growArea(1), !!A),
    btn('Shrink 1 m', 'Make the area 1 m smaller', () => growArea(-1), !!A),
    btn('Deselect', 'Esc', deselectArea, !!A)));
  if (A && can) box.append(el('h4', {}, 'Fill with'), ...paintValueRows(L, true));
  box.append(el('div', { class: 'hint' }, `${AREA_HINTS[b.area]} Shift adds, Alt subtracts. Drag inside the area to move its cells (Ctrl/Cmd: a copy). Brushes, shapes and fills paint only inside the area. Key L again: the next way to select, W: magic wand.`));
}

function renderNoteOptions(box) {
  box.append(el('div', { class: 'hint' }, 'Click the map to pin a note, click a note to edit it. Ctrl+Enter or a click on the map saves it, Esc cancels; an empty note is deleted. New notes go to the selected notes layer, else to the top one.'));
  const layers = [...S.layers].reverse().filter(l => l.type === 'notes');
  if (layers.length) {
    box.append(row('Notes', el('span', {}, layers.length === 1 ? String(layers[0].items.length) : layers.map(l => `${l.meta.name}: ${l.items.length}`).join(', '))));
  }
}

function classPicker(L) {
  const cls = L.meta.classes, withNone = ['fill', 'shape', 'area'].includes(S.tool);
  const sw = el('span', { class: 'swatch', style: `width:13.5px;height:13.5px;background:${cls[S.brush.cls]?.color || 'transparent'}` });
  const sel = el('select', { onchange: () => { S.brush.cls = +sel.value; saveUi(); renderOptions(); renderProps(); } },
    ...cls.map((c, k) => (k === 0 && !withNone ? null : el('option', { value: String(k), selected: S.brush.cls === k }, `${k}  ${c.name}`))));
  return row('Class', sw, sel);
}

// ------------------------------------------------------------------------------------------------ layers panel

let dragRow = null;

// Small pictures of the layers in the list: redrawn when a layer changes (a moment after painting).
const thumbs = new Map(); // layer -> {canvas, key}
let thumbTimer = null;

function thumbOf(L) {
  let t = thumbs.get(L);
  if (!t) {
    const canvas = el('canvas', { class: 'thumb' });
    canvas.width = 68;
    canvas.height = 48;
    t = { canvas, key: '' };
    thumbs.set(L, t);
  }
  const w = world(), key = `${L.version}|${L.meta.color}|${L.type === 'category' ? JSON.stringify(L.meta.classes) : ''}|${w.width}x${w.height}|${!!L.img}`;
  if (t.key !== key) { t.key = key; drawThumb(L, t.canvas); }
  return t.canvas;
}

function drawThumb(L, cv) {
  const c = cv.getContext('2d'), w = world(), W = cv.width, H = cv.height;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = '#2f2f34';
  c.fillRect(0, 0, W, H);
  const s = Math.min(W / w.width, H / w.height), v = new View(cv, w);
  Object.assign(v, { dpr: 1, w: W, h: H, scale: s, ox: (W - w.width * s) / 2, oy: (H - w.height * s) / 2, texture: true });
  c.save();
  if (L.hasItems && L.meta.style !== 'footprint') { // points
    c.fillStyle = L.meta.color || '#ffd25a';
    for (const it of L.items) { const [x, y] = v.toScreen(it.x, it.z); c.fillRect(x - 1, y - 1, 2.5, 2.5); }
  } else L.draw(c, v, null);
  c.restore();
}

function refreshThumbs() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => { for (const L of S.layers) if (thumbs.has(L)) thumbOf(L); }, 400);
}

function renderLayers() {
  const list = $('#layer-list');
  const scroll = list.scrollTop;
  list.innerHTML = '';
  let prevGroup = null;
  for (const L of [...S.layers].reverse()) {
    const g = L.meta.group || 'Other';
    if (g !== prevGroup) {
      prevGroup = g;
      const members = S.layers.filter(l => (l.meta.group || 'Other') === g);
      const anyVisible = members.some(l => l.meta.visible);
      list.append(el('div', { class: 'group-row', onclick: () => { S.collapsed.has(g) ? S.collapsed.delete(g) : S.collapsed.add(g); saveUi(); renderLayers(); } },
        ME.icon(S.collapsed.has(g) ? 'chevron-right' : 'chevron-down', 'small-icon'),
        ME.icon('folder', 'folder'),
        el('span', {}, g),
        el('span', { class: 'count' }, String(members.length)),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'icon-btn' + (anyVisible ? ' on' : ' off'), title: 'Show / hide the group',
          onclick: ev => { ev.stopPropagation(); members.forEach(l => { l.meta.visible = !anyVisible; }); viewChanged(); },
        }, ME.icon(anyVisible ? 'eye' : 'eye-off'))));
    }
    if (S.collapsed.has(g)) continue;
    const m = L.meta;
    const nameEl = el('span', { class: 'name', title: m.note || '' }, m.name);
    const r = el('div', {
      class: 'layer-row' + (L === S.active ? ' active' : '') + (m.visible ? '' : ' hidden-layer'), draggable: true,
      title: `${TYPE_NAMES[m.type]}${m.note ? ': ' + m.note : ''}`,
      onclick: () => setActive(L),
      ondblclick: () => renameLayer(L, nameEl),
    },
    el('button', {
      class: 'icon-btn' + (m.visible ? ' on' : ' off'), title: 'Show / hide (Alt+click: show only this one)',
      onclick: ev => { ev.stopPropagation(); toggleVisible(L, ev.altKey); },
    }, ME.icon(m.visible ? 'eye' : 'eye-off')),
    thumbOf(L),
    nameEl,
    el('span', { class: 'type' }, L.hasItems ? String(L.items.length) : ''),
    el('button', {
      class: 'icon-btn' + (m.locked ? ' on' : ' off'), title: m.locked ? 'Locked: click to unlock' : 'Lock',
      onclick: ev => { ev.stopPropagation(); m.locked = !m.locked; viewChanged(); renderOptions(); renderProps(); },
    }, ME.icon(m.locked ? 'lock' : 'lock-open')));
    r.addEventListener('dragstart', ev => { dragRow = L; ev.dataTransfer.effectAllowed = 'move'; });
    r.addEventListener('dragover', ev => {
      if (!dragRow || dragRow === L) return;
      ev.preventDefault();
      const above = ev.offsetY < r.offsetHeight / 2;
      r.classList.toggle('drop-above', above);
      r.classList.toggle('drop-below', !above);
    });
    r.addEventListener('dragleave', () => r.classList.remove('drop-above', 'drop-below'));
    r.addEventListener('drop', ev => {
      ev.preventDefault();
      if (!dragRow || dragRow === L) return;
      const above = ev.offsetY < r.offsetHeight / 2;
      moveLayerTo(dragRow, L, above);
      dragRow = null;
    });
    list.append(r);
  }
  list.scrollTop = scroll;
}

function toggleVisible(L, solo) {
  if (solo) {
    if (S.solo && S.solo.layer === L) {
      S.layers.forEach(l => { if (S.solo.vis.has(l)) l.meta.visible = S.solo.vis.get(l); });
      S.solo = null;
    } else {
      S.solo = { layer: L, vis: new Map(S.layers.map(l => [l, l.meta.visible])) };
      S.layers.forEach(l => { l.meta.visible = l === L || l.id === 'background'; });
    }
  } else {
    L.meta.visible = !L.meta.visible;
  }
  viewChanged();
}

/** Show or hide every layer. Hiding keeps the render of the map unless all is set (Alt+click). */
function setAllVisible(visible, all = false) {
  S.solo = null;
  S.layers.forEach(l => { l.meta.visible = visible || (!all && l.id === 'background'); });
  viewChanged();
  toast(visible ? 'All layers shown' : all ? 'All layers hidden' : 'All layers hidden except the map render', 1500);
}

function renameLayer(L, nameEl) {
  const input = el('input', { value: L.meta.name, style: 'width:100%' });
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  const done = ok => {
    if (ok && input.value.trim() && input.value.trim() !== L.meta.name) setMeta(L, 'name', input.value.trim(), 'rename layer');
    renderLayers();
    renderProps();
  };
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); ev.stopPropagation(); });
  input.addEventListener('blur', () => done(true));
}

function moveLayerTo(L, target, above) {
  const list = S.layers.filter(l => l !== L);
  let k = list.indexOf(target);
  if (above) k += 1; // the list is bottom -> top, the panel top -> bottom
  list.splice(k, 0, L);
  const groupBefore = L.meta.group;
  const groupAfter = target.meta.group;
  setLayers(list, L, 'move layer');
  if (groupBefore !== groupAfter) {
    L.meta.group = groupAfter;
    history.undo[history.undo.length - 1] = combine(history.undo[history.undo.length - 1], () => { L.meta.group = groupBefore; }, () => { L.meta.group = groupAfter; });
  }
  renderAll();
}

function combine(entry, undoExtra, redoExtra) {
  return { label: entry.label, undo: () => { undoExtra(); entry.undo(); }, redo: () => { entry.redo(); redoExtra(); } };
}

function moveLayer(dir) {
  const L = S.active;
  if (!L) return;
  const k = S.layers.indexOf(L), j = k + dir;
  if (j < 0 || j >= S.layers.length) return;
  const list = [...S.layers];
  [list[k], list[j]] = [list[j], list[k]];
  const groupBefore = L.meta.group, groupAfter = list[k].meta.group;
  setLayers(list, L, 'move layer');
  if (groupBefore !== groupAfter && list[j + dir]?.meta.group !== groupBefore) {
    L.meta.group = groupAfter;
    history.undo[history.undo.length - 1] = combine(history.undo[history.undo.length - 1], () => { L.meta.group = groupBefore; }, () => { L.meta.group = groupAfter; });
  }
  renderAll();
}

function newLayerMeta(name, type, color, group, note) {
  const meta = { id: slug(name), name, group: group || 'Custom', type, visible: true, opacity: type === 'mask' ? 0.7 : 1, locked: false, custom: true };
  if (note) meta.note = note;
  if (type === 'mask' || type === 'objects' || type === 'notes') meta.color = color;
  if (type === 'category') meta.classes = [{ name: 'none', color: null }, { name: 'class 1', color }, { name: 'class 2', color: '#5a9ae0' }];
  if (type === 'height') meta.contour = 1;
  if (type === 'objects') Object.assign(meta, { style: 'marker', marker: 'circle', size: 2, label: '{kind}' });
  return meta;
}

function insertLayer(layer, label) {
  const list = [...S.layers];
  const k = S.active ? list.indexOf(S.active) + 1 : list.length;
  list.splice(k, 0, layer);
  setLayers(list, layer, label);
  renderAll();
}

/** A dropdown of the groups of the layers (in the order of the list) and “New group…”, which asks for a name in place.
 *  onPick(name) runs when a group is chosen. */
function groupPicker(current, onPick) {
  const groups = [...new Set([...S.layers].reverse().map(l => l.meta.group || 'Other'))];
  if (current && !groups.includes(current)) groups.unshift(current);
  const wrap = el('span', { class: 'group-picker' });
  const sel = el('select', { title: 'The group of the layer in the Layers panel' },
    ...groups.map(g => el('option', { value: g, selected: g === current }, g)), el('option', { value: '' }, 'New group…'));
  sel.onchange = () => {
    if (sel.value) { onPick(sel.value); return; }
    const input = el('input', { placeholder: 'Name of the new group' });
    let finished = false;
    const done = ok => {
      if (finished) return;
      finished = true;
      const v = input.value.trim();
      if (ok && v) onPick(v);
      else { input.replaceWith(sel); sel.value = current; }
    };
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); done(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); done(false); }
    });
    input.addEventListener('blur', () => done(true));
    sel.replaceWith(input);
    input.focus();
  };
  wrap.append(sel);
  return wrap;
}

async function openNewLayer() {
  if (!S.project) return;
  const dlg = $('#new-layer'), form = dlg.querySelector('form'), f = n => form.elements.namedItem(n);
  let group = 'Custom';
  const field = dlg.querySelector('.group-field');
  const pick = g => { group = g; field.replaceChildren(groupPicker(group, pick)); };
  pick('Custom');
  f('name').value = 'New layer';
  f('note').value = '';
  f('file').value = '';
  f('color').value = ['#e05a9a', '#5ae0c8', '#e0d25a', '#9a7ae0', '#5a9ae0'][S.layers.length % 5];
  const sync = () => {
    dlg.querySelector('.for-image').hidden = f('type').value !== 'image';
    dlg.querySelector('.for-color').hidden = !['mask', 'objects', 'notes', 'category'].includes(f('type').value);
  };
  f('type').onchange = sync;
  sync();
  dlg.showModal();
  f('name').select();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const meta = newLayerMeta(f('name').value.trim() || 'New layer', f('type').value, f('color').value, group, f('note').value.trim());
    const layer = makeLayer(meta, S.proj);
    if (meta.type === 'image') {
      const file = f('file').files[0];
      if (!file) { toast('Choose a picture for the layer'); return; }
      await layer.setPicture(file);
      meta.opacity = 0.8;
      meta.blend = 'multiply';
    } else {
      layer.apply(null);
      layer.dirty = true;
    }
    insertLayer(layer, `new layer ${meta.name}`);
    toast(`Layer “${meta.name}” created`);
  };
}

async function duplicateLayer() {
  const src = S.active;
  if (!src) return;
  const meta = structuredClone(src.meta);
  meta.id = slug(src.id + '_copy');
  meta.name = src.meta.name + ' copy';
  meta.custom = true;
  meta.locked = false;
  delete meta.file; // its own file
  const layer = makeLayer(meta, S.proj);
  if (src.raster) { layer.data.set(src.data); layer.refresh(); }
  else if (src.hasItems) layer.items = cloneItems(src.items);
  else if (src.type === 'image') Object.assign(layer, { img: src.img, bytes: src.bytes, mime: src.mime });
  layer.dirty = true;
  insertLayer(layer, `duplicate ${src.meta.name}`);
}

async function deleteLayer() {
  const L = S.active;
  if (!L) return;
  if (!await ask('Undo brings it back.', { title: `Delete the layer “${L.meta.name}”?`, ok: 'Delete', danger: true })) return;
  if (!S.layers.includes(L)) return;
  const list = S.layers.filter(l => l !== L);
  const k = S.layers.indexOf(L);
  setLayers(list, list[Math.min(k, list.length - 1)] || null, `delete layer ${L.meta.name}`);
  renderAll();
}

// ------------------------------------------------------------------------------------------------ properties panel

// The properties panel: tabs Layer (the selected layer), Selection (the selected objects or notes, or the selected
// area), Objects (the list of the objects or notes of the selected layer).
const PROP_TABS = { layer: 'Layer', selection: 'Selection', objects: 'Objects' };
S.propsTab = 'layer';
S.objFilter = '';

function renderProps() {
  const root = $('#props'), old = root.querySelector('.tab-body'), scroll = old && old.dataset.tab === S.propsTab ? old.scrollTop : 0;
  root.innerHTML = '';
  const tabs = el('div', { class: 'tabs' }, ...Object.entries(PROP_TABS).map(([k, v]) => el('button', {
    class: S.propsTab === k ? 'on' : '', onclick: () => { S.propsTab = k; renderProps(); },
  }, v)));
  const box = el('div', { class: 'tab-body' });
  box.dataset.tab = S.propsTab;
  root.append(tabs, box);
  if (S.propsTab === 'selection') renderSelectionProps(box);
  else if (S.propsTab === 'objects') renderObjectList(box);
  else renderLayerProps(box);
  box.scrollTop = scroll;
}

function renderSelectionProps(box) {
  const items = selectedItems();
  if (items.length) {
    if (S.sel.layer.type === 'notes') renderNoteProps(box, S.sel.layer, items);
    else renderObjectProps(box, S.sel.layer, items);
    return;
  }
  if (S.float) {
    box.append(el('div', { class: 'section-head' }, 'Floating cells', el('span', { class: 'muted' }, `· ${S.float.layer.meta.name}`)));
    box.append(el('div', { class: 'hint' }, `${S.float.label}: drag it into place; Enter applies, Esc cancels.`));
    return;
  }
  if (S.area) {
    const [x0, y0, x1, y1] = S.area.bbox, can = !!S.active?.raster;
    box.append(el('div', { class: 'section-head' }, 'Selected area'));
    box.append(row('Area', el('span', {}, m2(S.area.count))));
    box.append(row('Bounds', el('span', {}, `${((x1 - x0) * mpp()).toFixed(1)} × ${((y1 - y0) * mpp()).toFixed(1)} m`)));
    const btn = (text, fn, on = true) => el('button', { disabled: !on, onclick: fn }, text);
    box.append(el('div', { class: 'layer-actions wrap' },
      btn('Copy', () => copySelection(false), can), btn('Cut', () => copySelection(true), can), btn('Fill', fillArea, can),
      btn('Clear', () => clearArea(), can), btn('Invert', invertArea), btn('Deselect', deselectArea)));
    return;
  }
  box.append(el('div', { class: 'hint' }, 'Nothing is selected. Select objects or notes with Move (V), or an area with the selection tools (L, W).'));
}

/** The objects (or notes) of the selected layer, with a filter; a click selects one and shows it on the map. */
function renderObjectList(box) {
  const L = S.active;
  if (!L?.hasItems) { box.append(el('div', { class: 'hint' }, 'Select an objects or notes layer to list what is on it.')); return; }
  const q = el('input', { value: S.objFilter, placeholder: L.type === 'notes' ? 'Filter by text…' : 'Filter by kind, zone, property…', oninput: () => { S.objFilter = q.value; fill(); } });
  const count = el('span', { class: 'muted small' });
  box.append(el('div', { class: 'row' }, el('label', {}, ME.icon('search')), el('div', { class: 'inline' }, q)), count);
  const list = el('div', { class: 'obj-list' });
  box.append(list);
  const labelOf = it => (L.type === 'notes' ? (it.text || '').split('\n')[0] : it.kind + (it.props?.pack_size ? ` ×${it.props.pack_size}` : ''));
  function fill() {
    const f = S.objFilter.trim().toLowerCase();
    const items = L.items.filter(it => !f || JSON.stringify([it.kind, it.zone, it.text, it.props]).toLowerCase().includes(f));
    count.textContent = `${items.length} of ${L.items.length}`;
    list.innerHTML = '';
    list.append(el('div', { class: 'obj-row head' }, el('span', {}, L.type === 'notes' ? 'Text' : 'Kind'), el('span', {}, 'x'), el('span', {}, 'z')));
    for (const it of items.slice(0, 2000)) {
      const on = S.sel.layer === L && S.sel.ids.has(it.id);
      list.append(el('div', {
        class: 'obj-row' + (on ? ' on' : ''), title: it.zone ? `zone ${it.zone}` : '',
        onclick: ev => {
          const ids = new Set(ev.shiftKey && S.sel.layer === L ? S.sel.ids : []);
          if (ids.has(it.id)) ids.delete(it.id); else ids.add(it.id);
          select(L, ids);
          const [sx, sy] = view.toScreen(it.x, it.z); // bring it into the middle of the map view
          view.pan(view.w / 2 - sx, view.h / 2 - sy);
          saveUi();
          requestRender();
        },
      }, el('span', { class: 'kind' }, labelOf(it)), el('span', {}, it.x.toFixed(1)), el('span', {}, it.z.toFixed(1))));
    }
  }
  fill();
}

function renderLayerProps(box) {
  const L = S.active;
  if (!L) { box.append(el('div', { class: 'hint' }, 'Select a layer.')); return; }
  const m = L.meta;
  const name = el('input', { value: m.name, onchange: () => setMeta(L, 'name', name.value.trim() || m.name, 'rename layer') });
  box.append(row('Name', name));
  box.append(row('Type', el('input', { value: `${TYPE_NAMES[m.type]} · ${m.id}`, disabled: true })));
  const vis = el('input', { type: 'checkbox', class: 'switch', checked: !!m.visible, onchange: () => { m.visible = vis.checked; viewChanged(); } });
  box.append(row('Visible', vis));
  const lock = el('input', { type: 'checkbox', class: 'switch', checked: !!m.locked, onchange: () => { m.locked = lock.checked; viewChanged(); renderOptions(); } });
  box.append(row('Locked', lock));
  const [opR, opN] = slider(0, 100, 1, Math.round((m.opacity ?? 1) * 100), v => { m.opacity = v / 100; saveLayerView(); requestRender(); });
  box.append(row('Opacity', opR, opN, el('span', { class: 'muted' }, '%')));
  if (m.type === 'mask' || m.type === 'objects' || m.type === 'notes') {
    const before = m.color;
    const c = el('input', { type: 'color', value: m.color || '#888888' });
    c.addEventListener('input', () => { m.color = c.value; L.metaChanged('color'); requestRender(); });
    c.addEventListener('change', () => { m.color = before; setMeta(L, 'color', c.value, 'layer color'); renderProps(); });
    box.append(row('Color', c));
  }
  const current = m.group || 'Other';
  box.append(row('Group', groupPicker(current, g => {
    if (g !== current) setMeta(L, 'group', g, 'layer group');
    renderLayers();
    renderProps();
  })));
  const note = el('textarea', {
    rows: 2, placeholder: 'What this layer shows, how to paint it…',
    onchange: () => setMeta(L, 'note', note.value.trim(), 'layer description'),
  });
  note.value = m.note || ''; // a textarea has no value attribute
  box.append(row('Description', note));
  if (m.type === 'mask') {
    let sum = 0;
    for (const v of L.data) sum += v;
    box.append(row('Covers', el('span', {}, `${(sum / 255 * mpp() * mpp()).toFixed(0)} m² (full density)`)));
  }
  if (m.type === 'height') {
    const c = el('input', { type: 'number', min: 0, max: 20, step: 0.5, value: m.contour, onchange: () => setMeta(L, 'contour', +c.value, 'contour lines') });
    box.append(row('Contours every', c, el('span', { class: 'muted' }, 'm (0 = off)')));
    const e = m.encoding || { offset: -20, step: 0.001 };
    box.append(row('File', el('span', { class: 'small' }, `16-bit PNG: meters = ${e.offset} + value × ${e.step} (${e.offset} … ${+(e.offset + 65535 * e.step).toFixed(1)} m)`)));
    box.append(row('', el('button', { onclick: show3d }, '3D preview (P)')));
  }
  if (m.type === 'category') box.append(classesEditor(L));
  if (m.type === 'notes') {
    box.append(row('Notes', el('span', {}, String(L.items.length))));
    box.append(el('div', { class: 'hint' }, 'Color: of the notes without their own color. Note tool (N): click the map to pin a note.'));
  }
  if (m.type === 'objects') {
    const style = el('select', { onchange: () => setMeta(L, 'style', style.value, 'objects style') },
      ...Object.entries(STYLES).map(([k, v]) => el('option', { value: k, selected: m.style === k }, v)));
    box.append(row('Draw as', style));
    if (m.style !== 'footprint') {
      const mk = el('select', { onchange: () => setMeta(L, 'marker', mk.value, 'marker') },
        ...MARKERS.map(k => el('option', { value: k, selected: m.marker === k }, k)));
      const size = el('input', { type: 'number', min: 0.2, max: 20, step: 0.1, value: m.size, onchange: () => setMeta(L, 'size', +size.value, 'marker size') });
      box.append(row('Marker', mk, size, el('span', { class: 'muted' }, 'm')));
    }
    const lab = el('input', { value: m.label || '', placeholder: '{kind}', onchange: () => setMeta(L, 'label', lab.value, 'label') });
    box.append(row('Label', lab));
    const counts = {};
    for (const it of L.items) counts[it.kind] = (counts[it.kind] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ');
    box.append(row('Objects', el('span', { class: 'small' }, `${L.items.length}` + (top ? ` — ${top}` : ''))));
    box.append(el('div', { class: 'hint' }, 'Labels show when zoomed in. {field} takes a field or property of the object.'));
  }
  if (m.type === 'image') {
    const blend = el('select', { onchange: () => setMeta(L, 'blend', blend.value, 'blend') },
      ...[['normal', 'Normal'], ['multiply', 'Multiply (white is see-through)'], ['screen', 'Screen (black is see-through)']]
        .map(([k, v]) => el('option', { value: k, selected: (m.blend || 'normal') === k }, v)));
    box.append(row('Blend', blend));
    const f = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    f.addEventListener('change', async () => {
      if (!f.files[0]) return;
      await L.setPicture(f.files[0]);
      markMeta();
      requestRender();
      toast('Picture replaced (not undoable)');
    });
    if (!m.locked) box.append(row('Picture', f));
  }
  if (m.type !== 'image') {
    box.append(el('div', { class: 'layer-actions' }, el('button', { class: 'danger', onclick: () => clearLayer(L) }, 'Clear layer')));
  }
}

async function clearLayer(L) {
  if (!canEdit(L)) return;
  if (!await ask('Everything on it is removed; undo brings it back.', { title: `Clear the layer “${L.meta.name}”?`, ok: 'Clear', danger: true })) return;
  if (!S.layers.includes(L)) return;
  if (L.hasItems) { editObjects(L, `clear ${L.meta.name}`, () => { L.items = []; }); select(L, []); }
  else {
    const before = L.data.slice();
    L.data.fill(0);
    L.refresh();
    L.dirty = true;
    pushRasterUndo(L, `clear ${L.meta.name}`, before, [0, 0, L.cols, L.rows]);
    requestRender();
  }
  renderLayers();
  renderProps();
}

function classesEditor(L) {
  const addClass = () => {
    const cl = structuredClone(L.meta.classes);
    if (cl.length >= 255) return;
    cl.push({ name: `class ${cl.length}`, color: hslToHex(`hsl(${(cl.length * 67) % 360} 55% 55%)`) });
    setMeta(L, 'classes', cl, 'add class');
    renderProps();
  };
  const wrap = el('div', { class: 'box' }, el('div', { class: 'box-head' }, 'Classes', el('span', { class: 'spacer' }),
    el('button', { class: 'hbtn', onclick: addClass }, ME.icon('plus'), 'Add Class')));
  const list = el('div', { class: 'classes' });
  const counts = new Array(L.meta.classes.length).fill(0);
  for (const v of L.data) counts[v]++;
  L.meta.classes.forEach((c, k) => {
    const name = el('input', { value: c.name, onchange: () => { const cl = structuredClone(L.meta.classes); cl[k].name = name.value; setMeta(L, 'classes', cl, 'class name'); renderOptions(); } });
    const color = el('input', { type: 'color', value: c.color || '#000000', disabled: k === 0 });
    color.addEventListener('change', () => { const cl = structuredClone(L.meta.classes); cl[k].color = color.value; setMeta(L, 'classes', cl, 'class color'); renderOptions(); });
    const edit = el('button', { class: 'icon-btn', title: 'Rename', onclick: ev => { ev.stopPropagation(); name.focus(); name.select(); } }, ME.icon('pencil'));
    const del = k === 0 ? el('span') : el('button', { class: 'icon-btn', title: 'Delete the class (its cells become “none”)', onclick: ev => { ev.stopPropagation(); deleteClass(L, k); } }, ME.icon('trash-2'));
    const r = el('div', { class: 'class-row' + (S.brush.cls === k ? ' on' : ''), title: `${(counts[k] * mpp() * mpp()).toFixed(0)} m² — click to paint this class`, onclick: ev => {
      if (ev.target.tagName === 'INPUT') return;
      S.brush.cls = k; saveUi(); renderOptions(); renderProps();
    } }, el('span', { class: 'num' }, String(k)), color, name, k === 0 ? el('span') : edit, del);
    list.append(r);
  });
  wrap.append(list);
  return wrap;
}

function hslToHex(hsl) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = hsl;
  return c.fillStyle;
}

async function deleteClass(L, k) {
  const cls = L.meta.classes[k];
  if (!await ask('Its cells become “none”.', { title: `Delete the class “${cls.name}”?`, ok: 'Delete', danger: true })) return;
  if (!S.layers.includes(L) || L.meta.classes[k] !== cls) return;
  const before = L.data.slice(), cb = structuredClone(L.meta.classes);
  for (let i = 0; i < L.data.length; i++) { const v = L.data[i]; if (v === k) L.data[i] = 0; else if (v > k) L.data[i] = v - 1; }
  const after = L.data.slice(), ca = cb.filter((_, j) => j !== k);
  const apply = (data, classes) => { L.data.set(data); L.meta.classes = structuredClone(classes); L.metaChanged(); L.dirty = true; markMeta(); };
  apply(after, ca);
  pushUndo({ label: 'delete class', layer: L, content: true, undo: () => apply(before, cb), redo: () => apply(after, ca) });
  if (S.brush.cls >= ca.length) S.brush.cls = ca.length - 1;
  renderProps(); renderOptions(); requestRender();
}

function renderObjectProps(box, L, items) {
  const head = el('div', { class: 'section-head' }, items.length === 1 ? 'Object' : `${items.length} objects`, el('span', { class: 'muted' }, `· ${L.meta.name}`));
  box.append(head);
  const edit = (label, fn) => editObjects(L, label, () => { for (const it of selectedItems()) fn(it); });
  const kind = el('input', { value: items.every(i => i.kind === items[0].kind) ? items[0].kind : '', list: 'kinds', placeholder: '(mixed)',
    onchange: () => { if (kind.value.trim()) edit('kind', it => { it.kind = kind.value.trim(); }); renderLayers(); } });
  const dl = $('#kinds');
  dl.innerHTML = '';
  L.kinds().forEach(k => dl.append(el('option', { value: k })));
  box.append(row('Kind', kind));
  if (items.length === 1) {
    const it = items[0];
    const num = (key, step = 0.1) => {
      const input = el('input', { type: 'number', step, value: it[key] ?? 0, style: 'width:54px', onchange: () => edit(key, o => { o[key] = +(+input.value).toFixed(2); }) });
      return input;
    };
    box.append(row('Position', el('span', { class: 'muted' }, 'x'), num('x'), el('span', { class: 'muted' }, 'z'), num('z')));
    box.append(row('Rotation', num('yaw', 5), el('span', { class: 'muted' }, '°')));
    if (L.meta.style === 'footprint' || it.w != null) {
      box.append(row('Size', el('span', { class: 'muted' }, 'w'), num('w'), el('span', { class: 'muted' }, 'd'), num('d')));
    }
    if (it.a && it.b) {
      for (const end of ['a', 'b']) {
        const ex = el('input', { type: 'number', step: 0.1, value: it[end][0], style: 'width:54px' });
        const ez = el('input', { type: 'number', step: 0.1, value: it[end][1], style: 'width:54px' });
        const set = () => edit('end ' + end, o => { o[end] = [+(+ex.value).toFixed(2), +(+ez.value).toFixed(2)]; });
        ex.onchange = set; ez.onchange = set;
        box.append(row(`End ${end.toUpperCase()}`, el('span', { class: 'muted' }, 'x'), ex, el('span', { class: 'muted' }, 'z'), ez));
      }
      box.append(row('Length', el('span', {}, `${Math.hypot(it.b[0] - it.a[0], it.b[1] - it.a[1]).toFixed(1)} m`)));
    }
    const zone = el('input', { value: it.zone || '', onchange: () => edit('zone', o => { if (zone.value.trim()) o.zone = zone.value.trim(); else delete o.zone; }) });
    box.append(row('Zone', zone));
    box.append(el('h4', {}, 'Properties'));
    const table = el('div', { class: 'props-table' });
    for (const [k, v] of Object.entries(it.props || {})) {
      const key = el('input', { value: k });
      const val = el('input', { value: typeof v === 'string' ? v : JSON.stringify(v) });
      const set = () => edit('property', o => {
        const p = { ...(o.props || {}) };
        delete p[k];
        if (key.value.trim()) p[key.value.trim()] = parseValue(val.value);
        o.props = p;
      });
      key.onchange = set; val.onchange = set;
      table.append(key, val, el('button', { class: 'icon-btn', title: 'Remove', onclick: () => edit('remove property', o => { delete o.props[k]; }) }, '✕'));
    }
    box.append(table);
    box.append(el('button', { onclick: () => edit('add property', o => { o.props = { ...(o.props || {}), [`key${Object.keys(o.props || {}).length + 1}`]: '' }; }) }, '＋ Property'));
    box.append(el('div', { class: 'hint' }, `id ${it.id}. Numbers and true/false are stored as such.`));
  }
  box.append(el('div', { class: 'layer-actions' },
    el('button', { onclick: duplicateSelected }, 'Duplicate'),
    el('button', { class: 'danger', onclick: deleteSelected }, 'Delete'),
    el('button', { onclick: () => select(L, []) }, 'Deselect')));
}

function parseValue(s) {
  const t = s.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && !isNaN(+t)) return +t;
  return s;
}

// ------------------------------------------------------------------------------------------------ map size, new map

// The map is a rectangle of square cells: world = {x0, z0 (the north-west corner, m), width, height (m), cols, rows}.
const MAP_PRESETS = {
  small: { label: '128 m', cx: 0, cz: 0, width: 128, height: 128, cell: 0.25, title: '128 × 128 m, cells of 0.25 m' },
  medium: { label: '256 m', cx: 0, cz: 0, width: 256, height: 256, cell: 0.25, title: '256 × 256 m, cells of 0.25 m' },
  large: { label: '512 m', cx: 0, cz: 0, width: 512, height: 512, cell: 0.5, title: '512 × 512 m, cells of 0.5 m' },
  wide: { label: '512 × 256 m', cx: 0, cz: 0, width: 512, height: 256, cell: 0.5, title: '512 × 256 m, cells of 0.5 m' },
  huge: { label: '1 km', cx: 0, cz: 0, width: 1024, height: 1024, cell: 1, title: '1024 × 1024 m, cells of 1 m' },
};
const MAX_PX = 2048;

const fmt = v => String(+(+v).toFixed(3)).replace('-', '−');

function readMapForm(form) {
  const f = n => form.elements.namedItem(n);
  const cell = +f('cell').value, width = +f('width').value, height = +f('height').value, cx = +f('cx').value, cz = +f('cz').value;
  if (!(cell > 0) || !(width > 0) || !(height > 0) || !isFinite(cx) || !isFinite(cz)) return null;
  const cols = Math.round(width / cell), rows = Math.round(height / cell), W = +(cols * cell).toFixed(4), H = +(rows * cell).toFixed(4);
  return { x0: +(cx - W / 2).toFixed(4), z0: +(cz - H / 2).toFixed(4), width: W, height: H, cols, rows };
}

function openMapDialog(mode) {
  if (mode === 'size' && !S.project) return;
  const dlg = $('#map-dlg'), form = dlg.querySelector('form'), f = n => form.elements.namedItem(n);
  const w = S.project ? S.project.world : EMPTY_WORLD, cell = +(w.width / w.cols).toFixed(4);
  dlg.querySelector('h3').textContent = mode === 'new' ? 'New map' : 'Map size';
  dlg.querySelectorAll('.for-new').forEach(e => { e.hidden = mode !== 'new'; });
  dlg.querySelectorAll('.for-size').forEach(e => { e.hidden = mode !== 'size'; });
  const sel = f('cell');
  if (![...sel.options].some(o => +o.value === cell)) sel.append(el('option', { value: String(cell) }, `${cell} m`));
  const set = (cx, cz, width, height, c) => {
    f('cx').value = +(+cx).toFixed(3); f('cz').value = +(+cz).toFixed(3);
    f('width').value = +(+width).toFixed(3); f('height').value = +(+height).toFixed(3);
    sel.value = [...sel.options].find(o => +o.value === c)?.value || sel.value;
    update();
  };
  const presets = dlg.querySelector('.presets');
  presets.innerHTML = '';
  if (S.project) presets.append(el('button', { type: 'button', title: 'The size of the open map', onclick: () => set(w.x0 + w.width / 2, w.z0 + w.height / 2, w.width, w.height, cell) }, 'As now'));
  for (const p of Object.values(MAP_PRESETS)) presets.append(el('button', { type: 'button', title: p.title, onclick: () => set(p.cx, p.cz, p.width, p.height, p.cell) }, p.label));
  const ok = dlg.querySelector('.ok');
  ok.textContent = mode === 'new' ? 'Choose a folder and create' : 'Apply';
  f('title').value = 'New map';
  f('layers').value = S.project ? 'same' : 'basic';
  f('layers').querySelector('[value=same]').disabled = !S.project;
  function update() {
    const nw = readMapForm(form), info = dlg.querySelector('.info');
    ok.disabled = !nw || Math.min(nw.cols, nw.rows) < 16 || Math.max(nw.cols, nw.rows) > MAX_PX;
    if (!nw) { info.textContent = 'Fill in the numbers.'; return; }
    const rasters = mode === 'new' ? 10 : S.layers.filter(l => l.raster).length;
    const mb = Math.round(rasters * nw.cols * nw.rows * 5.5 / 1e6);
    let text = `x ${fmt(nw.x0)} … ${fmt(nw.x0 + nw.width)}, z ${fmt(nw.z0)} … ${fmt(nw.z0 + nw.height)} m: ${fmt(nw.width)} × ${fmt(nw.height)} m, ` +
      `${nw.cols} × ${nw.rows} cells of ${fmt(nw.width / nw.cols)} m (about ${mb} MB in the browser).`;
    if (Math.max(nw.cols, nw.rows) > MAX_PX) text += ` At most ${MAX_PX} cells on a side: take bigger cells.`;
    if (Math.min(nw.cols, nw.rows) < 16) text += ' At least 16 cells on a side.';
    if (mode === 'size') {
      const e = 1e-6, inside = nw.x0 <= w.x0 + e && nw.z0 <= w.z0 + e && nw.x0 + nw.width >= w.x0 + w.width - e && nw.z0 + nw.height >= w.z0 + w.height - e;
      text += inside ? '' : ' Part of the painted map is outside: it is cut off.';
    }
    info.textContent = text;
  }
  form.oninput = update;
  set(w.x0 + w.width / 2, w.z0 + w.height / 2, w.width, w.height, cell);
  ok.onclick = async () => {
    const nw = readMapForm(form);
    if (!nw || ok.disabled) return;
    dlg.close();
    if (mode === 'new') await createMap(nw, f('title').value.trim() || 'New map', f('layers').value);
    else resizeMap(nw);
  };
  dlg.showModal();
}

/** Change the bounds and the cells of the open map. Rasters are cut or extended (new cells are empty: 0, none,
 *  0 m) and resampled to the new cells; objects and notes keep their positions in meters; pictures stay where they
 *  are. The layer files are written again. Not undoable. */
function resizeMap(nw) {
  commitFloat();
  closeNoteEditor(true);
  const ow = S.project.world, oc = ow.width / ow.cols, nc = nw.width / nw.cols;
  const cols = new Int32Array(nw.cols), rows = new Int32Array(nw.rows); // the old cell under every new one (-1: none)
  for (let k = 0; k < nw.cols; k++) {
    const i = Math.floor((nw.x0 + (k + 0.5) * nc - ow.x0) / oc);
    cols[k] = i >= 0 && i < ow.cols ? i : -1;
  }
  for (let k = 0; k < nw.rows; k++) {
    const j = Math.floor((nw.z0 + (k + 0.5) * nc - ow.z0) / oc);
    rows[k] = j >= 0 && j < ow.rows ? j : -1;
  }
  const proj = { world: nw, cols: nw.cols, rows: nw.rows }, activeId = S.active?.id;
  const layers = S.layers.map(l => {
    if (l.type === 'image' && !l.meta.rect) l.meta.rect = { x0: ow.x0, z0: ow.z0, width: ow.width, height: ow.height };
    const nl = makeLayer(l.meta, proj);
    if (l.raster) {
      const d = new l.data.constructor(nw.cols * nw.rows);
      for (let y = 0; y < nw.rows; y++) {
        const j = rows[y];
        if (j < 0) continue;
        for (let x = 0; x < nw.cols; x++) if (cols[x] >= 0) d[y * nw.cols + x] = l.data[j * ow.cols + cols[x]];
      }
      nl.apply(d);
    } else nl.apply(l.snapshot());
    nl.base = nl.snapshot();
    nl.version = l.version;
    nl.savedVersion = l.savedVersion;
    if (l.raster) nl.dirty = true; // its file is written again with the new size
    return nl;
  });
  S.project.world = nw;
  S.cols = nw.cols;
  S.rows = nw.rows;
  S.proj = proj;
  S.layers = layers;
  S.active = layerById(activeId) || null;
  S.sel = { layer: null, ids: new Set() };
  S.area = S.float = S.draft = null;
  history.undo = [];
  history.redo = [];
  view.world = nw;
  view.fit();
  markMeta();
  view3d.reset();
  renderAll();
  toast(`The map is now ${fmt(nw.width)} × ${fmt(nw.height)} m (${nw.cols} × ${nw.rows} cells); the layers are written again`, 4000);
}

/** The layers of a new map. */
function basicLayers() {
  const L = (id, name, group, type, extra = {}) => ({ id, name, group, type, visible: true, opacity: 1, locked: false, ...extra });
  const none = { name: 'none', color: null };
  return [
    L('height', 'Terrain height', 'Terrain', 'height', { contour: 1, encoding: { offset: -20, step: 0.001 }, note: 'Meters.' }),
    L('ground', 'Ground texture', 'Terrain', 'category', { opacity: 0.85, classes: [none, { name: 'grass', color: '#6f9a45' }, { name: 'dirt', color: '#8a6a45' },
      { name: 'rock', color: '#6b6863' }, { name: 'sand', color: '#c8b27a' }, { name: 'mud', color: '#5a4a36' }] }),
    L('zones', 'Zones', 'Terrain', 'category', { opacity: 0.35, classes: [none, { name: 'village', color: '#e0a050' }, { name: 'woods', color: '#4f9a4a' },
      { name: 'river', color: '#4a8ad0' }, { name: 'swamp', color: '#7a8a3a' }, { name: 'quarry', color: '#9a8a7a' }] }),
    L('water', 'Water', 'Terrain', 'mask', { color: '#3d7fb5', opacity: 0.6 }),
    L('roads', 'Roads & paths', 'Terrain', 'mask', { color: '#c8a46a', opacity: 0.8 }),
    L('rocks', 'Rocks & cliffs', 'Rocks', 'mask', { color: '#8f8a84', opacity: 0.75 }),
    L('grass', 'Grass', 'Greenery', 'mask', { color: '#a6cc5c', opacity: 0.55 }),
    L('bushes', 'Bushes', 'Greenery', 'mask', { color: '#5fa63c', opacity: 0.75 }),
    L('trees', 'Trees', 'Greenery', 'mask', { color: '#2c6a2a', opacity: 0.75 }),
    L('buildings', 'Buildings', 'Structures', 'objects', { color: '#e07a4a', style: 'footprint', label: '{kind}' }),
    L('enemies', 'Enemies (mob packs)', 'Gameplay', 'objects', { color: '#ff4a4a', style: 'marker', marker: 'circle', size: 2.4, label: '{kind} ×{pack_size}', note: 'kind = the enemy type, pack_size = how many are in the pack.' }),
    L('chests', 'Chests', 'Gameplay', 'objects', { color: '#ffc83c', style: 'marker', marker: 'square', size: 2, label: '{kind}' }),
    L('hiding_spots', 'Hiding spots', 'Gameplay', 'objects', { color: '#5ee07a', style: 'marker', marker: 'diamond', size: 2.2, label: '{kind}' }),
    L('notes', 'Notes', 'Notes', 'notes', { color: '#ffd25a', note: 'Notes pinned to the map (Note tool, N).' }),
  ];
}

/** A new map in a folder the user picks (an empty one: the picker can make it): metadata.json and empty layer files.
 *  layersMode: 'same' (the layers of the open map, empty), 'basic' or 'notes'. */
async function createMap(nw, title, layersMode) {
  let f;
  try {
    f = new ME.Folder(await window.showDirectoryPicker({ id: 'gwp', mode: 'readwrite' }));
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, 5000);
    return;
  }
  if (await f.exists('metadata.json')) { toast(`${f.name}/ already has a map (metadata.json): choose an empty folder — the folder dialog can make a new one`, 6000); return; }
  if (folder && S.project && anyDirty()) await save(); // the open map keeps its changes
  const proj = { world: nw, cols: nw.cols, rows: nw.rows };
  let metas;
  if (layersMode === 'same' && S.project) {
    metas = S.layers.filter(l => l.type !== 'image').map(l => {
      const m = structuredClone(l.meta);
      delete m.file;
      return m;
    });
  } else metas = layersMode === 'notes' ? basicLayers().filter(m => m.type === 'notes') : basicLayers();
  const layers = metas.map(m => makeLayer(m, proj));
  toast('Writing the new map…', 60000);
  for (const l of layers) {
    l.apply(null);
    const data = await l.fileData();
    if (data) await f.write(l.file, data);
  }
  await f.write('metadata.json', metadataText({ title, created: `Started in GameWorld Painter on ${today()}`, world: nw }, layers));
  await connectFolder(f);
  view.fit();
  saveUi();
  requestRender();
  toast(`New map “${title}” in ${f.name}/: ${layers.length} layers, ${fmt(nw.width)} × ${fmt(nw.height)} m`, 4000);
}

// ------------------------------------------------------------------------------------------------ status

const esc = t => String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

// --- the bar at the bottom: the cursor position and the values of some layers there. Which layers: the selected one,
// and by default every visible categories layer and the height; right-click the bar to add or remove layers.
const STATUS_KEY = 'gwp-status|' + location.pathname;
S.statusCfg = (() => {
  try { return { selected: true, pick: {}, ...JSON.parse(localStorage.getItem(STATUS_KEY) || '{}') }; } catch (err) { return { selected: true, pick: {} }; }
})();

function saveStatusCfg() { localStorage.setItem(STATUS_KEY, JSON.stringify(S.statusCfg)); }

function statusHeight() { return S.layers.find(l => l.type === 'height' && l.meta.visible) || S.layers.find(l => l.type === 'height'); }

/** Is the layer in the bar: the user's choice, else categories when visible and the (first visible) height. */
function inStatus(l) {
  const pick = S.statusCfg.pick[l.id];
  if (pick != null) return pick;
  return (l.type === 'category' && l.meta.visible) || l === statusHeight();
}

/** The width kept for the value of a layer, so the bar does not jump while the cursor moves. */
function valueWidth(l) {
  if (l.type === 'mask') return 4;
  if (l.type === 'height') return 8;
  return Math.min(18, Math.max(4, ...l.meta.classes.map(c => c.name.length)));
}

function renderStatus() {
  const st = $('#status');
  if (!S.project || !view) { st.textContent = ''; return; }
  const parts = [];
  const item = (label, value, opts = {}) => parts.push(`<span${opts.cls ? ` class="${opts.cls}"` : ''}${opts.id ? ` data-layer="${esc(opts.id)}"` : ''}>${esc(label)} ` +
    `<b${opts.w ? ` style="min-width:${opts.w}ch"` : ''}${opts.num ? ' class="num"' : ''}>${esc(value)}</b></span>`);
  if (S.cursor) {
    const [x, z] = S.cursor, i = cellAt(x, z);
    parts.push(`<span class="xy">x <b class="num">${x.toFixed(1)}</b> z <b class="num">${z.toFixed(1)}</b></span>`);
    if (i >= 0) {
      const A = S.active, list = [...S.layers].reverse().filter(l => l.raster && inStatus(l));
      if (S.statusCfg.selected && A?.raster && !list.includes(A)) list.unshift(A);
      for (const l of list) {
        const v = l.type === 'category' && !l.data[i] ? '—' : l.describe(i);
        item(l.meta.name, v, { cls: l === A ? 'active' : '', id: l.id, w: valueWidth(l), num: l.type !== 'category' });
      }
      if (A?.type === 'objects') {
        const hit = A.meta.visible ? A.hit(x, z, view) : null;
        if (hit) item(`${A.meta.name}:`, `${hit.kind}${hit.props ? ' ' + Object.entries(hit.props).map(([k, v]) => `${k}=${v}`).join(' ') : ''}`, { cls: 'active' });
      }
      if (S.draft && S.draft.kind === 'shape' && CLICK_SHAPES.includes(S.draft.type)) item('points', S.draft.pts.length - 1);
    }
  }
  if (S.sel.ids.size) item('selected', S.sel.ids.size);
  if (S.area) item('area', m2(S.area.count));
  if (S.float) item('floating', S.float.label);
  st.innerHTML = parts.join('');
  $('#zoom-label').textContent = `${view.scale.toFixed(1)} px/m`;
}

function closeMenu() { $('#ctx-menu')?.remove(); }

/** Right-click on the bar: which layers it shows (a click toggles one; the menu stays open). */
function openStatusMenu(x, y, layerId) {
  closeMenu();
  if (!S.project) return;
  const m = el('div', { id: 'ctx-menu' });
  const redo = () => { saveStatusCfg(); renderStatus(); openStatusMenu(x, y, null); };
  const entry = (label, on, fn, note) => m.append(el('button', { class: 'menu-item', onclick: ev => { ev.stopPropagation(); fn(); } },
    el('span', { class: 'tick' }, on ? '✓' : ''), el('span', { class: 'label' }, label), note ? el('span', { class: 'note' }, note) : null));
  const named = layerId && layerById(layerId);
  if (named) {
    entry(`Hide “${named.meta.name}” here`, false, () => { S.statusCfg.pick[named.id] = false; if (named === S.active) S.statusCfg.selected = false; redo(); });
    m.append(el('div', { class: 'menu-sep' }));
  }
  m.append(el('div', { class: 'menu-head' }, 'Show in the bar'));
  entry('The selected layer', S.statusCfg.selected, () => { S.statusCfg.selected = !S.statusCfg.selected; redo(); });
  m.append(el('div', { class: 'menu-sep' }));
  for (const l of [...S.layers].reverse().filter(l => l.raster)) {
    const own = S.statusCfg.pick[l.id] != null;
    entry(l.meta.name, inStatus(l), () => { S.statusCfg.pick[l.id] = !inStatus(l); redo(); }, TYPE_NAMES[l.type] + (own ? '' : ' · auto'));
  }
  m.append(el('div', { class: 'menu-sep' }));
  entry('Automatic (visible categories and the height)', false, () => { S.statusCfg = { selected: true, pick: {} }; redo(); });
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(innerWidth - r.width - 4, x)) + 'px';
  m.style.top = Math.max(4, Math.min(innerHeight - r.height - 4, y - r.height)) + 'px';
}

$('#status').addEventListener('contextmenu', e => {
  e.preventDefault();
  openStatusMenu(e.clientX, e.clientY, e.target.closest('[data-layer]')?.dataset.layer || null);
});
window.addEventListener('pointerdown', e => { if (!e.target.closest('#ctx-menu, #zoom')) closeMenu(); }, true);
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); }, true);

function renderSaveState() {
  const s = $('#save-state'), t = $('#target');
  const dirty = S.layers.filter(l => l.dirty).length;
  const pending = dirty || metaDirty();
  const state = (cls, icon, text, title = '') => {
    s.className = cls;
    s.title = title;
    s.innerHTML = '';
    if (icon) s.append(ME.icon(icon));
    s.append(text);
  };
  if (S.saveError) state('error', 'circle-alert', 'Save failed: ' + S.saveError);
  else if (busy && pending) state('muted', null, 'Saving…');
  else if (pending) {
    state('dirty', 'circle-alert', (dirty ? `Unsaved: ${dirty} layer(s)` : 'Unsaved layer settings') +
      (S.lock ? ` — ${LOCK}: waiting for the agent` : S.access !== 'granted' && folder ? ' — no access to the folder' : ''));
  } else if (S.project) state('ok', 'circle-check', 'All changes saved', S.savedAt ? `Saved ${S.savedAt.toLocaleTimeString()}` : '');
  else state('muted', null, '');
  t.innerHTML = '';
  if (folder) { // the project folder: bottom right
    const ok = S.access === 'granted';
    t.title = ok ? 'The project folder: the tool reads and writes it and checks it for changes every second' : 'No access to the folder';
    t.append(ME.icon('folder-open'), el('b', {}, `${folder.name}/`), ok ? (S.lock ? '· locked (edit.lock)' : '· watching') : '· no access');
    if (!ok) t.append(el('button', { onclick: reconnect }, 'Reconnect'));
  }
  $('#autosave').checked = S.autosave;
  $('#undo').disabled = !history.undo.length;
  $('#redo').disabled = !history.redo.length;
}

function renderSizeLabel() {
  const w = S.project && S.project.world;
  $('#size-label').textContent = w ? `${fmt(w.width)} × ${fmt(w.height)} m` : '—';
}

/** Zoom presets under the zoom button. */
function openZoomMenu() {
  closeMenu();
  if (!view) return;
  const b = $('#zoom').getBoundingClientRect(), m = el('div', { id: 'ctx-menu' });
  const go = s => { closeMenu(); if (s) view.zoomAt(s / view.scale, view.w / 2, view.h / 2); else view.fit(); saveUi(); requestRender(); };
  m.append(el('button', { class: 'menu-item', onclick: () => go(0) }, el('span', { class: 'tick' }), el('span', { class: 'label' }, 'Fit the map'), el('span', { class: 'note' }, 'F')));
  m.append(el('div', { class: 'menu-sep' }));
  for (const s of [0.5, 1, 2, 4, 8, 16, 32, 64]) {
    m.append(el('button', { class: 'menu-item', onclick: () => go(s) }, el('span', { class: 'tick' }, Math.abs(view.scale - s) < 0.05 ? '✓' : ''), el('span', { class: 'label' }, `${s} px/m`), el('span', { class: 'note' }, `${(100 / s).toFixed(s >= 4 ? 1 : 0)} m per 100 px`)));
  }
  document.body.append(m);
  m.style.left = Math.min(innerWidth - m.offsetWidth - 4, b.left) + 'px';
  m.style.top = Math.max(4, b.top - m.offsetHeight - 4) + 'px'; // the button is in the bottom bar: the menu opens above it
}

function renderAll() {
  renderSizeLabel();
  renderTools();
  renderOptions();
  renderLayers();
  renderProps();
  renderSaveState();
  updateCursor();
  $('#grid').checked = S.grid;
  saveUi();
  requestRender();
}

// ------------------------------------------------------------------------------------------------ wiring

document.querySelectorAll('[data-icon]').forEach(e => e.prepend(ME.icon(e.dataset.icon)));

$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#save').onclick = () => save();
$('#open').onclick = pickFolder;
$('#autosave').onchange = () => {
  S.autosave = $('#autosave').checked;
  localStorage.setItem('gwp-autosave', S.autosave ? 'on' : 'off');
  if (S.autosave && anyDirty()) scheduleSave();
  renderSaveState();
};
ME.onLayerChange = () => { scheduleSave(); refreshThumbs(); };
ME.onMetaChange = () => { S.metaVersion++; }; // a height layer widened its encoding while saving: metadata.json too
/** Zoom around the middle of the map view (the buttons at its bottom left, + and − keys). */
function zoomBy(f) {
  if (!view) return;
  view.zoomAt(f, view.w / 2, view.h / 2);
  saveUi();
  requestRender();
}
$('#zoom-in').onclick = () => zoomBy(1.4);
$('#zoom-out').onclick = () => zoomBy(1 / 1.4);
$('#zoom-fit').onclick = () => { if (view) { view.fit(); saveUi(); requestRender(); } };
$('#zoom').onclick = ev => { ev.stopPropagation(); if ($('#ctx-menu')) closeMenu(); else openZoomMenu(); };
$('#grid').onchange = () => { S.grid = $('#grid').checked; saveUi(); requestRender(); };
$('#help').onclick = () => $('#help-dlg').showModal();
$('#layer-add').onclick = openNewLayer;
$('#layers-show').onclick = () => setAllVisible(true);
$('#layers-hide').onclick = e => setAllVisible(false, e.altKey);
$('#layer-up').onclick = () => moveLayer(1);
$('#layer-down').onclick = () => moveLayer(-1);
$('#layer-dup').onclick = duplicateLayer;
$('#layer-del').onclick = deleteLayer;
$('#new').onclick = () => openMapDialog('new');
$('#size').onclick = () => openMapDialog('size');

const view3d = new ME.View3D($('#view3d'), {
  world: () => (S.project ? S.project.world : null),
  heightLayer: () => (S.active?.type === 'height' ? S.active
    : S.layers.find(l => l.type === 'height' && l.meta.visible) || S.layers.find(l => l.type === 'height') || null),
  layers: () => S.layers,
  metaVersion: () => S.metaVersion,
  cursor: () => (S.screen && S.cursor ? S.cursor : null),
  viewCenter: () => { const [x, z] = view.toWorld(view.w / 2, view.h / 2); return [x, z, view.w / view.scale]; },
});
{
  const p3 = $('#view3d'), exag = p3.querySelector('.v3-exag');
  view3d.onToggle = on => { $('#btn3d').checked = on; };
  $('#btn3d').onchange = () => { if ($('#btn3d').checked) show3d(); else hide3d(); };
  p3.querySelector('.v3-close').onclick = () => hide3d();
  p3.querySelector('.v3-max').onclick = () => { dock.toggleMaximize('view3d'); view3d.requestDraw(); };
  p3.querySelectorAll('[data-preset]').forEach(b => { b.onclick = () => view3d.preset(b.dataset.preset); });
  p3.querySelector('.v3-tex').onchange = e => { view3d.texMode = e.target.value; view3d.seen.map = null; view3d.tick(); };
  exag.oninput = () => {
    view3d.setExag(+exag.value);
    p3.querySelector('.v3-exag-v').textContent = `${(+exag.value).toFixed(1)}×`;
  };
}

// the panels: map, tool, layers, properties, 3D (js/dock.js)
const dock = new ME.Dock($('#dock'), {
  storageKey: 'gwp-dock3|' + location.pathname,
  onRemove: id => { if (id === 'view3d') view3d.close(); },
});
function show3d() { dock.show('view3d'); view3d.open(); }
function hide3d() { view3d.close(); dock.close('view3d'); }
function toggle3d() { if (dock.isOpen('view3d')) hide3d(); else show3d(); }
if (dock.isOpen('view3d')) view3d.open(); // the layout kept it open
new ResizeObserver(() => { if (view) { view.resize(); requestRender(); positionNoteEditor(); } }).observe($('#stage'));

const noteEd = $('#note-editor');
noteEd.querySelector('.done').onclick = () => closeNoteEditor(true);
noteEd.querySelector('.delete').onclick = () => { noteEd.querySelector('textarea').value = ''; closeNoteEditor(true); };
noteEd.querySelector('textarea').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNoteEditor(false); }
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); closeNoteEditor(true); }
});

window.gwp = { // for the console and tests
  S, save, undo, redo, setTool, setActive, layerById, poll, store, history, commitFloat, setArea, view3d, resizeMap, createMap, dock,
  connect: handle => connectFolder(new ME.Folder(handle)),
  get view() { return view; }, get folder() { return folder; }, get busy() { return busy; },
};

load().catch(err => {
  console.error(err);
  $('#banner').textContent = 'Could not load the map: ' + err.message;
  $('#banner').hidden = false;
});
})(window.ME);
