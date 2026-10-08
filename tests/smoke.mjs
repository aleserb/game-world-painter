// Smoke test of GameWorld Painter in headless Chrome, no dependencies (Node 22+: fetch, WebSocket).
//
//   node tests/smoke.mjs                 (CHROME=/path/to/chrome to choose the browser)
//
// It serves the repository on a local port, opens the app, copies examples/demo-island into the browser's private
// file system (OPFS: the real folder picker cannot be automated) and checks: the project loads, a brush stroke
// paints and autosave writes the layer file, undo, a shape, the selected area, objects and notes, a new map size,
// the 3D preview (WebGL2 or the software view). Exit code 1 on a failure.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, 'examples', 'demo-island');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// --- a static server for the repository
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_APP = `http://127.0.0.1:${server.address().port}/index.html`;

// --- Chrome through the DevTools protocol
const CHROMES = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean);
const chromePath = CHROMES.find(p => fs.existsSync(p));
if (!chromePath) { console.error('Chrome not found: set CHROME=/path/to/chrome'); process.exit(2); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gwp-smoke-'));
const port = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1500,950',
  '--no-first-run', '--no-default-browser-check', ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch (err) { /* not up yet */ }
  if (!ws) await sleep(250);
}
if (!ws) { console.error('Chrome did not start'); chrome.kill(); process.exit(2); }
await new Promise(r => { ws.onopen = r; });
let id = 0;
const pending = new Map(), errors = [];
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value || a.description).join(' '));
  if (d.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
};
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
/** Polls a page expression (or an async function) until it is truthy or the time is up; returns its last value. */
const until = async (expr, ms = 15000) => {
  let v;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    try { v = typeof expr === 'function' ? await expr() : await ev(expr); } catch (e) { v = undefined; }
    if (v) break;
  }
  return v;
};
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const opfsWrite = (p, bytes) => ev(`(async () => { const parts = ${JSON.stringify(p)}.split('/'); let d = await navigator.storage.getDirectory();
  for (const q of parts.slice(0, -1)) d = await d.getDirectoryHandle(q, { create: true });
  const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
  const s = atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); await w.write(u); await w.close(); })()`);
const opfsStamp = p => ev(`(async () => { const parts = ${JSON.stringify(p)}.split('/'); let d = await navigator.storage.getDirectory();
  for (const q of parts.slice(0, -1)) d = await d.getDirectoryHandle(q);
  const f = await (await d.getFileHandle(parts.at(-1))).getFile(); return f.lastModified + ':' + f.size; })()`);

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_APP });
  check(await until(`!!window.gwp && !document.getElementById('banner').hidden && document.getElementById('banner').textContent.includes('Open folder')`), 'the welcome banner');

  // the demo project, in the private file system of the page
  const files = ['metadata.json', ...fs.readdirSync(path.join(DEMO, 'layers')).map(f => 'layers/' + f)];
  for (const f of files) await opfsWrite('demo/' + f, fs.readFileSync(path.join(DEMO, f)));
  await ev(`(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('demo'); await gwp.connect(d); })()`);
  await until(`gwp.S.layers.length === 11`, 5000);
  const layers = await ev(`gwp.S.layers.length`);
  check(layers === 11, 'the demo opens', `${layers} layers, ${await ev(`document.title`)}`);

  // a brush stroke on Trees; autosave writes trees.png
  const sum = lid => ev(`gwp.layerById('${lid}').data.reduce((a, v) => a + v, 0)`);
  const rect = await ev(`(r => [r.left, r.top])(document.getElementById('view').getBoundingClientRect())`);
  const ui = await ev(`ME.UI_SCALE`);
  const screen = async (x, z) => { const [sx, sy] = await ev(`gwp.view.toScreen(${x}, ${z})`); return [sx * ui + rect[0], sy * ui + rect[1]]; };
  const drag = async pts => {
    const s = [];
    for (const p of pts) s.push(await screen(...p));
    await mouse('mouseMoved', ...s[0]); await mouse('mousePressed', ...s[0]);
    for (const p of s.slice(1)) await mouse('mouseMoved', ...p);
    await mouse('mouseReleased', ...s.at(-1)); await sleep(150);
  };
  await ev(`gwp.setActive(gwp.layerById('trees')); gwp.setTool('brush'); gwp.S.brush.size = 6; gwp.S.brush.value = 100; gwp.S.autosave = true; true`);
  const before = await sum('trees'), stamp0 = await opfsStamp('demo/layers/trees.png');
  await drag([[-20, 40], [0, 40], [20, 40]]);
  const after = await sum('trees');
  check(after > before, 'a brush stroke paints', `${before} -> ${after}`);
  check(await until(async () => (await opfsStamp('demo/layers/trees.png')) !== stamp0), 'autosave writes layers/trees.png', await ev(`document.getElementById('save-state').textContent`));
  await ev(`gwp.undo(); true`);
  check((await sum('trees')) === before, 'undo');

  // a rectangle shape on Roads
  await ev(`gwp.setActive(gwp.layerById('roads')); gwp.setTool('shape'); gwp.S.brush.shape = 'rect'; gwp.S.brush.shapeFill = 'fill'; gwp.S.brush.feather = 0; gwp.S.brush.strength = 100; gwp.S.brush.value = 100; true`);
  const r0 = await sum('roads');
  await drag([[-60, -60], [-55, -55], [-50, -50]]);
  const cells = ((await sum('roads')) - r0) / 255;
  check(cells > 300 && cells <= 400, 'a 10 x 10 m rectangle', `${cells.toFixed(0)} cells of 0.5 m (up to 400)`);

  // the selected area limits the brush
  await ev(`gwp.setActive(gwp.layerById('bushes')); gwp.setTool('area'); gwp.S.brush.area = 'rect'; true`);
  await drag([[-80, -10], [-75, -5], [-70, 0]]);
  check((await ev(`gwp.S.area && gwp.S.area.count`)) === 400, 'select a 10 x 10 m area');
  await ev(`gwp.setTool('brush'); gwp.S.brush.size = 30; gwp.S.brush.clip = true; true`);
  const b0 = await sum('bushes');
  await drag([[-90, -5], [-60, -5]]);
  check((await sum('bushes')) - b0 <= 400 * 255, 'painting stays inside the area');

  // objects and notes
  await ev(`gwp.setArea(null); gwp.setActive(gwp.layerById('enemies')); gwp.setTool('add'); true`);
  const n0 = await ev(`gwp.layerById('enemies').items.length`);
  const [ax, ay] = await screen(10, -10);
  await mouse('mouseMoved', ax, ay); await mouse('mousePressed', ax, ay); await mouse('mouseReleased', ax, ay); await sleep(150);
  check((await ev(`gwp.layerById('enemies').items.length`)) === n0 + 1, 'add an object');
  check(await ev(`gwp.layerById('notes').items.length === 3 && gwp.layerById('notes').type === 'notes'`), 'notes');

  // the tool bar follows the layer
  check(await ev(`(b => b.some(t => t.includes('Add Object')) && !b.some(t => t.includes('Brush')))([...document.querySelectorAll('#tools .tbtn')].map(t => t.textContent))`),
    'the tool bar shows the tools of the layer');
  await ev(`gwp.setActive(gwp.layerById('trees')); true`);
  const bar = await ev(`[...document.querySelectorAll('#tools .tbtn')].map(t => t.textContent.trim())`);
  check(bar[0] === 'Select' && bar[1] === 'Pan' && bar.includes('Brush') && !bar.includes('Add Object'), 'Select comes first, before Pan, on any layer', bar.slice(0, 4).join(', '));

  // deleting a layer asks in the page (not the browser's confirm())
  await ev(`gwp.setActive(gwp.layerById('bushes')); document.getElementById('layer-del').click(); true`);
  const asked = await until(`document.getElementById('confirm-dlg').open && document.querySelector('#confirm-dlg h3').textContent`, 3000);
  await ev(`document.querySelector('#confirm-dlg button[value=cancel]').click(); true`);
  const kept = await until(`!document.getElementById('confirm-dlg').open && !!gwp.layerById('bushes')`, 3000);
  await ev(`document.getElementById('layer-del').click(); true`);
  await until(`document.getElementById('confirm-dlg').open`, 3000);
  await ev(`document.querySelector('#confirm-dlg .ok').click(); true`);
  const gone = await until(`!gwp.layerById('bushes')`, 3000);
  await ev(`gwp.undo(); true`);
  const back = await ev(`!!gwp.layerById('bushes')`);
  check(asked && kept && gone && back, 'delete a layer: asks in the page, Cancel keeps it, undo brings it back', `${asked} kept ${kept}, deleted ${gone}, back ${back}`);

  // several layers: Shift+click selects the rows between, Ctrl+click removes one; Space hides / shows them; Delete
  const clickRow = async (name, modifiers = 0) => {
    const [x, y] = await ev(`(r => [r.left + r.width / 2, r.top + r.height / 2])([...document.querySelectorAll('#layer-list .layer-row')].find(r => r.querySelector('.name').textContent === ${JSON.stringify(name)}).getBoundingClientRect())`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers });
  };
  const space = async () => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: type === 'keyDown' ? ' ' : undefined }); };
  const selIds = () => ev(`[...gwp.S.layerSel].sort().join(',')`);
  await clickRow('Trees'); await clickRow('Water', 8); // Shift
  const range = await selIds();
  await clickRow('Bushes', process.platform === 'darwin' ? 4 : 2); // Cmd / Ctrl
  const three = await selIds();
  await space();
  const hidden = await ev(`['trees', 'roads', 'water'].every(id => !gwp.layerById(id).meta.visible) && gwp.layerById('bushes').meta.visible`);
  await space();
  const shown = await ev(`['trees', 'roads', 'water'].every(id => gwp.layerById(id).meta.visible)`);
  await ev(`document.getElementById('layer-del').click(); true`);
  const title = await until(`document.getElementById('confirm-dlg').open && document.querySelector('#confirm-dlg h3').textContent`, 3000);
  await ev(`document.querySelector('#confirm-dlg .ok').click(); true`);
  const gone3 = await until(`!gwp.layerById('trees') && !gwp.layerById('roads') && !gwp.layerById('water') && !!gwp.layerById('bushes')`, 3000);
  await ev(`gwp.undo(); true`);
  const back3 = await ev(`!!(gwp.layerById('trees') && gwp.layerById('roads') && gwp.layerById('water'))`);
  check(range === 'bushes,roads,trees,water' && three === 'roads,trees,water' && hidden && shown && title === 'Delete 3 layers?' && gone3 && back3,
    'select several layers: Shift / Ctrl+click, Space hides and shows them, delete and undo', `${range} | ${three} | hidden ${hidden}, shown ${shown}, ${title}, deleted ${gone3}, back ${back3}`);

  // a wider map
  await ev(`gwp.resizeMap({ x0: -160, z0: -128, width: 320, height: 256, cols: 640, rows: 512 }); true`);
  check(await ev(`gwp.layerById('trees').cols === 640 && gwp.layerById('trees').rows === 512`), 'resize the map to 320 x 256 m');

  // 3D
  await ev(`gwp.dock.isOpen('view3d') || document.getElementById('btn3d').click(); true`);
  check(await until(`gwp.view3d.isOpen && (!!gwp.view3d.gl || !!gwp.view3d.soft)`), '3D preview', await ev(`gwp.view3d.soft ? 'software view' : 'WebGL2'`));

  // units: the map in centimeters (converted through the Map size dialog), then renamed to plain units
  const pre = await ev(`(() => { const e = gwp.layerById('enemies').items[0], h = gwp.layerById('height'), i = (h.rows >> 1) * h.cols + (h.cols >> 1);
    return { x: e.x, z: e.z, h: h.data[i], i, brush: gwp.S.brush.size }; })()`);
  const dlgSet = async (unit, convert) => ev(`(() => { const f = document.querySelector('#map-dlg form'), u = f.elements.namedItem('unit');
    u.value = ${JSON.stringify(unit)}; u.dispatchEvent(new Event('change'));
    ${convert ? `f.elements.namedItem('convert').value = ${JSON.stringify(convert)}; f.elements.namedItem('convert').dispatchEvent(new Event('change'));` : ''}
    return document.querySelector('#map-dlg .info').textContent; })()`);
  await ev(`gwp.openMapDialog('size'); true`);
  const info = await dlgSet('cm', 'convert');
  await ev(`document.querySelector('#map-dlg .ok').click(); true`);
  const cm = await ev(`(() => { const w = gwp.S.project.world, e = gwp.layerById('enemies').items[0], h = gwp.layerById('height');
    return { unit: gwp.S.project.unit, w: w.width, cols: w.cols, x: e.x, z: e.z, h: h.data[${pre.i}], brush: gwp.S.brush.size, label: document.getElementById('size-label').textContent, cell: h.describe(${pre.i}) }; })()`);
  const near = (a, b) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-4) + 0.002;
  check(cm.unit === 'cm' && cm.w === 32000 && cm.cols === 640 && near(cm.x, pre.x * 100) && near(cm.z, pre.z * 100) && near(cm.h, pre.h * 100)
    && near(cm.brush, pre.brush * 100) && cm.label.endsWith('cm') && cm.cell.endsWith(' cm') && info.includes('multiplied by 100'),
    'convert the map to centimeters', `${cm.label}, enemy x ${pre.x} -> ${cm.x}, height ${cm.cell}`);
  check(await until(async () => (await ev(`(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('demo');
    return (await (await d.getFileHandle('metadata.json')).getFile()).text(); })()`)).includes('"unit":"cm"')), 'metadata.json says "unit":"cm"');
  await ev(`gwp.openMapDialog('size'); true`);
  await dlgSet('u');
  await ev(`document.querySelector('#map-dlg .ok').click(); true`);
  const u = await ev(`({ unit: gwp.S.project.unit, w: gwp.S.project.world.width, x: gwp.layerById('enemies').items[0].x, label: document.getElementById('size-label').textContent })`);
  check(u.unit === 'u' && u.w === 32000 && near(u.x, cm.x) && u.label.endsWith(' u'), 'rename the unit: the numbers stay', u.label);

  check(errors.length === 0, 'no errors in the page', errors.slice(0, 3).join(' | '));
} catch (err) {
  check(false, 'the test ran', err.message);
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* Chrome may still hold it */ }
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
