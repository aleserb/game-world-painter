// Remakes the screenshots in the README (docs/*.jpg) from the demo island, in headless Chrome with an AI agent connected
// through the MCP server:   node tests/screenshots.mjs
//   docs/screenshot.jpg         the app: layers, the map, the 3D preview, the properties
//   docs/screenshot-agent.jpg   an AI agent's change waiting for review: a bridge across the river and a hut
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, sleep, ROOT } from './browser.mjs';
import { startStdio, initialize, freePort } from '../mcp/test/helpers.mjs';

const W = 1600, H = 1000;
const port = await freePort();
const mcp = startStdio(port, [], { GWP_MCP_WAIT_APP_MS: '3000' });
const b = await openBrowser({ width: W, height: H, localStorage: { 'gwp-agent': JSON.stringify({ v: 2, enabled: true, url: `http://127.0.0.1:${port}`, review: true }) } });
const { ev, until } = b;

async function call(name, args = {}) {
  const r = await mcp.request('tools/call', { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  const text = r.result.content.filter(c => c.type === 'text').map(c => c.text);
  if (r.result.isError) throw new Error(`${name}: ${text.join(' ')}`);
  let data = null;
  for (const t of text) { try { data = JSON.parse(t); } catch { /* text */ } }
  return data;
}
async function shot(file) {
  const r = await b.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.writeFileSync(path.join(ROOT, 'docs', file), Buffer.from(r.result.data, 'base64'));
  console.log(`docs/${file}`);
}
async function hover(x, z) { // the pointer over a place on the map (the brush outline)
  const [ui, rect] = await ev(`[ME.UI_SCALE, (r => [r.left, r.top])(document.getElementById('view').getBoundingClientRect())]`);
  const [sx, sy] = await ev(`gwp.view.toScreen(${x}, ${z})`);
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx * ui + rect[0], y: sy * ui + rect[1] });
}

try {
  await initialize(mcp, '2025-06-18', 'Claude Code');
  await b.openDemo();
  await until(`ME.agent.state === 'agent'`, 20000);
  await ev(`document.getElementById('btn3d').checked || document.getElementById('btn3d').click(); true`);
  await sleep(500);

  // 1. the app
  await ev(`gwp.view.fit(); gwp.setActive(gwp.layerById('trees')); gwp.setTool('brush'); gwp.S.brush.size = 8; gwp.S.brush.value = 100; true`);
  await hover(-30, -20);
  await sleep(1500); // the 3D preview follows
  await shot('screenshot.jpg');

  // 2. an AI agent's change waiting for review
  await ev(`gwp.setActive(gwp.layerById('buildings')); gwp.setTool('select'); true`);
  const crossing = (await call('find_crossing', { region: { circle: [-84, 21, 10] } })).crossings[0];
  const spot = (await call('find_spots', { // flat ground by the bridge, off the water and the bridge ends
    metric: 'flat', limit: 1, min_area: 30,
    region: { all: [{ near: crossing.center, distance: 18 }, { not: { near: 'water', distance: 4 } }, { not: { near: 'rivers', distance: 4 } }, { not: { near: crossing.center, distance: 7 } }] },
  })).spots[0];
  if (!spot) throw new Error('no flat ground by the bridge');
  const dist = p => Math.hypot(p[0] - spot.center[0], p[1] - spot.center[1]), end = dist(crossing.a) < dist(crossing.b) ? crossing.a : crossing.b;
  // the place left of the middle: the card is on the right
  await call('show_on_map', { region: { circle: [(crossing.center[0] + spot.center[0]) / 2 + 14, (crossing.center[1] + spot.center[1]) / 2 - 4, 40] } });
  await sleep(3500); // the outline of show_on_map fades
  await call('begin_change', { title: 'A bridge over Lake Run and a fisher\'s hut', description: 'The river cut the west of the island off the village: a stone bridge **straight across** it where it is narrowest, and a hut by it.' });
  await call('add_items', { layer: 'buildings', items: [{ kind: 'stone_bridge', a: crossing.a, b: crossing.b, d: 3 }], comment: `Bank to bank, ${crossing.length} m across the flow; both ends on dry land.` });
  await call('add_items', { layer: 'buildings', items: [{ kind: 'hut', x: spot.center[0], z: spot.center[1], w: 6, d: 5, towards: end }], comment: 'On flat ground by the bank, its door towards the bridge.' });
  await call('add_items', { layer: 'chests', items: [{ kind: 'fisher_crate', x: spot.center[0] + 4.5, z: spot.center[1] + 1 }], comment: 'A small reward for finding the way across.' });
  const checked = await call('check_change', { images: false });
  if (!checked.ok) throw new Error(`the change has problems: ${JSON.stringify(checked.problems)}`);
  const decision = call('end_change', { summary: 'A stone bridge straight across Lake Run:\n- both ends on dry land, the path continues on both banks\n- a fisher\'s hut on flat ground by it, with a crate', wait: 60 });
  await until(`document.querySelector('#ai-proposal.pending')`, 8000);
  await ev(`document.activeElement?.blur(); true`);
  await hover(80, 80);
  await sleep(1500);
  await shot('screenshot-agent.jpg');
  await ev(`[...document.querySelectorAll('#ai-proposal button')].find(x => x.textContent.trim() === 'Reject').click(); true`);
  await decision;
  if (b.errors.length) throw new Error(b.errors.join('\n'));
} finally {
  await mcp.kill();
  await b.close();
}
