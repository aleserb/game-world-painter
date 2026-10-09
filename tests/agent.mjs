// End-to-end test of the AI agent integration: the app in headless Chrome with the demo map connects to the MCP server
// (mcp/server.mjs, started as an agent would start it: stdio), and an MCP client calls every tool.
//
//   node tests/agent.mjs        (CHROME=/path/to/chrome to choose the browser)
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { openBrowser, sleep, DEMO } from './browser.mjs';
import { SERVER_TOOLS } from '../mcp/lib/tools.mjs';
import { startStdio, initialize, freePort } from '../mcp/test/helpers.mjs';

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
  if (!ok) failures++;
};

const port = await freePort();
const mcp = startStdio(port, [], { GWP_MCP_WAIT_APP_MS: '3000' });
const b = await openBrowser({ localStorage: { 'gwp-agent': JSON.stringify({ v: 2, enabled: true, url: `http://127.0.0.1:${port}`, confirmDeletes: true, review: false }) } });
const { ev, until } = b;

/** Calls a tool; returns {data, text, images, error}. */
async function call(name, args = {}) {
  const r = await mcp.request('tools/call', { name, arguments: args });
  if (r.error) return { error: r.error.message };
  const res = r.result, texts = res.content.filter(c => c.type === 'text').map(c => c.text);
  let data = null;
  for (const t of texts) { try { data = JSON.parse(t); } catch { /* text */ } }
  return { data, text: texts.join('\n'), images: res.content.filter(c => c.type === 'image'), error: res.isError ? texts.join('\n') : null };
}

try {
  const init = await initialize(mcp, '2025-06-18', 'e2e-agent');
  check(init.result?.serverInfo?.name === 'game-world-painter', 'the MCP server answers');
  await b.openDemo();
  check(await until(`['ready', 'agent'].includes(ME.agent.state)`), 'the app connects to the MCP server', await ev('ME.agent.state + " " + ME.agent.error'));
  check(await until(`ME.agent.server?.agents?.some(a => a.name === 'e2e-agent')`), 'the app sees the agent', await ev('JSON.stringify(ME.agent.server?.agents)'));
  const led = await ev(`document.querySelector('#agent-btn .led').className`);
  check(led.includes('on'), 'the LED is green', led);

  const tools = (await mcp.request('tools/list', {})).result.tools.map(t => t.name);
  const inApp = tools.filter(t => !SERVER_TOOLS.has(t));
  const missing = await ev(`${JSON.stringify(inApp)}.filter(t => typeof ME.agentTools[t] !== 'function')`);
  check(missing.length === 0 && tools.length === 28, 'every MCP tool runs in the app (or the server)', missing.join(', '));

  // looking
  const info = await call('get_map_info');
  check(info.data?.layers_top_to_bottom?.length === 14 && info.data.zones?.names.includes('village') && info.data.unit.label === 'm', 'get_map_info', info.error || JSON.stringify(info.data?.zones));
  // the folder on disk: the OPFS copy has the same metadata.json as examples/demo-island, found from the working directory
  const where = await call('get_project_path');
  check(where.data?.path === DEMO && /working directory/.test(where.data.found_by) && where.data.layer_files.length === 14
    && where.data.layer_files.some(l => l.file === path.join(DEMO, 'layers', 'trees.png')) && where.data.unsaved_in_app.layers.length === 0,
  'get_project_path finds the folder on disk', where.error || JSON.stringify(where.data).slice(0, 300));
  check(await until(`ME.app.S.projectPath === ${JSON.stringify(DEMO)} && document.getElementById('target').title.includes(${JSON.stringify(DEMO)})`, 3000), 'the app remembers the path and shows it');
  const where2 = await call('get_project_path');
  check(where2.data?.found_by === 'remembered by the app', 'the next time it is remembered', where2.data?.found_by);
  const info2 = await call('get_map_info');
  check(info2.data?.folder?.path === DEMO && info2.data.folder.name === 'demo-island', 'get_map_info tells the folder', JSON.stringify(info2.data?.folder));
  const ctx0 = await call('get_user_context');
  check(ctx0.data && ctx0.data.selected_area === null && ctx0.data.active_layer, 'get_user_context', ctx0.error);
  const img = await call('render_map', { region: { zone: 'village' }, highlight: { zone: 'village' }, size: 512 });
  check(img.images.length === 1 && img.images[0].data.length > 5000 && /north up/.test(img.text), 'render_map: an image with a grid', img.error || img.text);
  const vill = await call('describe_region', { region: { zone: 'village' } });
  check(vill.data?.items?.buildings?.count >= 5 && vill.data.layers.height?.mean != null && vill.data.layers.zones?.classes?.village === 100, 'describe_region of the village', vill.error || JSON.stringify(vill.data?.items));
  const grid = await call('read_layer', { layer: 'trees', resolution: 16 });
  check(grid.data?.grid?.length === 16 && grid.data.grid[0].split(' ').length === 16, 'read_layer: a 16 × 16 grid', grid.error);
  const enemies = await call('find_items', { layer: 'enemies', measure: ['roads', 'height', 'zone'] });
  check(enemies.data?.total === 8 && enemies.data.items.every(i => typeof i.distance_to_roads === 'number' && i.zone_here), 'find_items with measures', enemies.error || JSON.stringify(enemies.data?.items?.[0]));
  const spacing = await call('analyze_items', { layer: 'enemies', min_distance: 30, cluster_distance: 25, gaps: 3 });
  check(spacing.data?.count === 8 && spacing.data.groups.count >= 6 && spacing.data.gaps.length === 3, 'analyze_items: spacing, groups, gaps', spacing.error || JSON.stringify(spacing.data?.nearest_neighbor));
  const open = await call('find_spots', { metric: 'open', layers: ['trees', 'bushes', 'buildings'], region: { not: { layer: 'water' } }, limit: 5 });
  check(open.data?.spots?.length >= 1 && open.data.spots[0].value > 5, 'find_spots: open areas', open.error || JSON.stringify(open.data?.spots?.[0]));
  const high = await call('find_spots', { metric: 'high', limit: 3 });
  check(high.data?.spots?.length >= 1, 'find_spots: viewpoints', high.error);
  const walk = await call('analyze_walkability', { start: [0, 25] });
  check(walk.data?.walkable_pct > 20 && walk.data.blocking_layers.includes('water') && walk.data.main_part, 'analyze_walkability', walk.error || JSON.stringify(walk.data?.main_part));

  // changing (each one undo step)
  const route = await call('find_route', { from: { zone: 'village' }, to: { item: { layer: 'buildings', id: 9 } }, prefer: ['roads'], avoid: [{ layer: 'enemies', distance: 15 }], add_to: { layer: 'trails', kind: 'route' } });
  check(route.data?.found && route.data.points.length >= 2 && route.data.added_to?.layer === 'trails', 'find_route, added as a path', route.error || JSON.stringify(route.data));
  const before = await ev(`gwp.layerById('enemies').items.length`);
  const sc = await call('scatter_items', { layer: 'enemies', region: { all: [{ zone: 'woods' }, { not: { near: 'roads', distance: 5 } }] }, kinds: [{ kind: 'wolf', weight: 2 }, { kind: 'boar' }], count: 5, spacing: 30, random_props: { pack_size: [3, 5] }, seed: 4 });
  const after = await ev(`gwp.layerById('enemies').items.slice(-5)`);
  check(sc.data?.placed === 5 && (await ev(`gwp.layerById('enemies').items.length`)) === before + 5 && after.every(i => i.props.pack_size >= 3 && i.props.pack_size <= 5 && i.zone === 'woods'), 'scatter_items: 5 packs in the woods', sc.error || JSON.stringify(sc.data));
  const groups = await call('scatter_items', { layer: 'chests', region: { circle: [-60, -20, 25] }, kind: 'crate', groups: { size: [3, 3], radius: 4 }, count: 2, spacing: 20, dry_run: true, seed: 2 });
  check(groups.data?.dry_run && groups.data.placed === 6 && groups.data.groups === 2, 'scatter_items: groups (dry run)', groups.error || JSON.stringify(groups.data));
  const paint = await call('paint_layer', { layer: 'bushes', region: { all: [{ zone: 'woods' }, { circle: [-60, -40, 20] }] }, value: 70, noise: { amount: 20, scale: 8 }, feather: 3 });
  check(paint.data?.changed_cells > 100 && Math.abs(paint.data.mean_pct_in_region - 70) < 15, 'paint_layer: bushes about 70 %', paint.error || JSON.stringify(paint.data));
  const slope = await call('edit_terrain', { op: 'slope', from: { zone: 'village' }, to: { point: [-55, 5] } });
  check(slope.data?.changed_area > 100 && slope.data.from.height != null, 'edit_terrain: a slope from the village to the lake', slope.error || JSON.stringify(slope.data));
  const flat = await call('edit_terrain', { op: 'flatten', region: { circle: [42, -40, 8] }, height: 20 });
  check(flat.data && Math.abs(flat.data.after.mean - 20) < 1.5, 'edit_terrain: flatten', flat.error || JSON.stringify(flat.data?.after));
  const layer = await call('create_layer', { name: 'Ruins', type: 'objects', style: 'footprint', group: 'Structures', color: '#8a7a6a' });
  check(layer.data?.id === 'ruins' && (await ev(`gwp.layerById('ruins')?.meta.group`)) === 'Structures', 'create_layer', layer.error);
  const add = await call('add_items', { layer: 'ruins', items: [{ kind: 'ruined house', x: 10, z: 20, w: 6, d: 5 }, { kind: 'wall', x: 14, z: 26, yaw: 30 }] });
  check(add.data?.added === 2 && (await ev(`gwp.layerById('ruins').items[0].zone`)) === 'village', 'add_items (zone filled in)', add.error);
  const notes = await call('add_items', { layer: 'notes', items: [{ x: 42, z: -40, text: 'Viewpoint: the whole island is visible from here.' }] });
  check(notes.data?.added === 1, 'add_items: a note', notes.error);
  const upd = await call('update_items', { layer: 'ruins', items: [{ id: add.data.ids[0], move: [2, -1], props: { era: 'old' } }, { id: add.data.ids[1], turn: 90 }] });
  const ru = await ev(`gwp.layerById('ruins').items`);
  check(upd.data?.changed === 2 && ru[0].x === 12 && ru[0].z === 19 && ru[0].props.era === 'old' && ru[1].yaw === 120, 'update_items: move, props, turn', upd.error || JSON.stringify(ru));
  const cls = await call('update_layer', { layer: 'zones', add_classes: [{ name: 'ruins', color: '#8a7a6a' }] });
  check(cls.data?.classes?.includes('ruins'), 'update_layer: a new class', cls.error);
  // deleting asks the user: answer in the page
  const del = call('delete_items', { layer: 'ruins', ids: [add.data.ids[1]] });
  check(await until(`document.getElementById('confirm-dlg').open && /delete 1 item/.test(document.querySelector('#confirm-dlg p').textContent)`, 5000), 'delete_items asks the user first');
  await ev(`document.querySelector('#confirm-dlg .ok').click(); true`);
  const delr = await del;
  check(delr.data?.deleted === 1 && (await ev(`gwp.layerById('ruins').items.length`)) === 1, 'delete_items after the user agreed', delr.error);
  const show = await call('show_on_map', { region: { zone: 'village' }, message: 'The village', select: true });
  check(show.data?.selected && (await ev('!!gwp.S.area')), 'show_on_map selects the area');
  const ctx1 = await call('get_user_context');
  check(ctx1.data?.selected_area?.area > 1000, 'the selection reaches the agent', JSON.stringify(ctx1.data?.selected_area));
  const sel = await call('describe_region', { region: { area: 'selection' } });
  check(sel.data?.items?.buildings?.count >= 5, 'region {"area":"selection"}', sel.error);
  const steps = await ev('gwp.history.undo.slice(-13).filter(e => e.label.startsWith("AI:")).length');
  check(steps >= 11, 'every change is an "AI:" undo step', `${steps} of the last 13`);
  const und = await call('undo', { steps: 2 });
  check(und.data?.undone?.[0]?.startsWith('AI: delete') && und.data.undone[1]?.startsWith('AI: change layer') && (await ev(`gwp.layerById('ruins').items.length`)) === 2
    && !(await ev(`gwp.layerById('zones').meta.classes.some(c => c.name === 'ruins')`)), 'undo the last agent changes', und.error || JSON.stringify(und.data));

  // selection tools on a layer of objects: a lasso selects the objects in it (and is the selected area); the agent sees both
  const ui = await ev('ME.UI_SCALE'), vr = await ev(`(r => [r.left, r.top])(document.getElementById('view').getBoundingClientRect())`);
  const mouse = (type, x, y, modifiers = 0) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, modifiers });
  const screen = async (x, z) => { const [sx, sy] = await ev(`gwp.view.toScreen(${x}, ${z})`); return [sx * ui + vr[0], sy * ui + vr[1]]; };
  const dragPath = async (pts, modifiers = 0) => {
    const sp = [];
    for (const p of pts) sp.push(await screen(...p));
    await mouse('mouseMoved', ...sp[0], modifiers); await mouse('mousePressed', ...sp[0], modifiers);
    for (const p of sp.slice(1)) await mouse('mouseMoved', ...p, modifiers);
    await mouse('mouseReleased', ...sp.at(-1), modifiers); await sleep(150);
  };
  const houses = await ev(`gwp.layerById('buildings').items.map(i => [i.id, i.x, i.z, i.kind])`);
  const [cx, cz] = [houses[0][1], houses[0][2]], lasso = Array.from({ length: 24 }, (_, k) => [cx + 22 * Math.cos(k / 24 * 2 * Math.PI), cz + 14 * Math.sin(k / 24 * 2 * Math.PI)]);
  const inLasso = (x, z) => { let c = false; for (let i = 0, j = lasso.length - 1; i < lasso.length; j = i++) { const [xi, zi] = lasso[i], [xj, zj] = lasso[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
  const want = houses.filter(h => inLasso(h[1], h[2])).map(h => h[0]).sort((a, b) => a - b);
  await call('show_on_map', { region: { circle: [cx, cz, 30] } });
  await ev(`gwp.setActive(gwp.layerById('buildings')); gwp.S.brush.area = 'free'; gwp.setTool('area'); ME.app.select(null, []); gwp.setArea(null); true`);
  const tb = await ev(`[...document.querySelectorAll('#tools .tbtn span')].map(s => s.textContent)`);
  await dragPath([...lasso, lasso[0]]);
  const got = await ev(`[...gwp.S.sel.ids].sort((a, b) => a - b)`), hasArea = await ev('!!gwp.S.area');
  check(tb.includes('Lasso') && want.length >= 2 && JSON.stringify(got) === JSON.stringify(want) && hasArea, 'Select area on objects: the lasso selects the objects in it', `${JSON.stringify(got)} want ${JSON.stringify(want)} area ${hasArea} tools ${tb.join(',')}`);
  const opts = await ev(`document.getElementById('options').textContent`);
  check(opts.includes(`${want.length} of ${houses.length}`), 'the options count the selected objects', opts.slice(0, 160));
  const uc = await call('get_user_context');
  const kinds = Object.values(uc.data?.selected_items?.kinds || {}).reduce((a, n) => a + n, 0);
  check(uc.data?.selected_items?.layer === 'buildings' && uc.data.selected_items.count === want.length && kinds === want.length && uc.data.selected_area?.area > 100,
    'the agent gets the selected objects (kinds) and the area', JSON.stringify(uc.data?.selected_items).slice(0, 200));
  const its = await call('describe_region', { region: { items: 'selection' } });
  check(its.data?.items?.buildings?.count === want.length, 'region {"items":"selection"}', its.error || JSON.stringify(its.data?.items?.buildings));
  // Alt subtracts; the magic wand selects the same kind; a click on nothing deselects
  const one = houses.find(h => h[0] === want[0]);
  await dragPath([[one[1] - 3, one[2] - 3], [one[1] + 3, one[2] - 3], [one[1] + 3, one[2] + 3], [one[1] - 3, one[2] + 3], [one[1] - 3, one[2] - 3]], 1); // Alt
  const less = await ev(`gwp.S.sel.ids.size`);
  await ev(`gwp.S.brush.area = 'wand'; gwp.setTool('area'); true`);
  const p0 = await screen(one[1], one[2]);
  await mouse('mouseMoved', ...p0); await mouse('mousePressed', ...p0); await mouse('mouseReleased', ...p0); await sleep(150);
  const same = await ev(`gwp.S.sel.ids.size`), sameWant = houses.filter(h => h[3] === one[3]).length;
  check(less === want.length - 1 && same === sameWant && !(await ev('!!gwp.S.area')), 'Alt subtracts; the magic wand selects the objects of the same kind', `${less} / ${same} of ${sameWant}`);
  await ev(`gwp.S.brush.area = 'rect'; gwp.setTool('area'); true`);
  const empty0 = await ev(`(() => { for (let k = 0; k < 40; k++) { const p = gwp.view.toWorld(40 + k * 12, 60); if (!gwp.layerById('buildings').hit(p[0], p[1], gwp.view)) return p; } return null; })()`);
  const far = await screen(...empty0);
  await mouse('mouseMoved', ...far); await mouse('mousePressed', ...far); await mouse('mouseReleased', ...far); await sleep(150);
  check((await ev('gwp.S.sel.ids.size')) === 0, 'a click on nothing deselects');
  await ev(`gwp.setTool('select'); true`);

  // the agent's words on a change: on a card at the top right of the map (review mode off) and in the Activity
  const cardEl = `document.getElementById('ai-proposal')`;
  const cardBtn = text => ev(`(b => (b.click(), true))([...document.querySelectorAll('#ai-proposal button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}))`);
  const nNotes = `gwp.layerById('notes').items.length`, notes0 = await ev(nNotes);
  const cmt = await call('add_items', { layer: 'notes', items: [{ x: 5, z: 5, text: 'c' }], comment: 'A note for **you**:\n- one\n- two' });
  const done = await until(`(c => c && c.classList.contains('done') && { desc: c.querySelector('.desc')?.textContent, li: c.querySelectorAll('.desc li').length, bold: !!c.querySelector('.desc b') })(${cardEl})`, 5000);
  check(cmt.data?.added === 1 && done?.li === 2 && done.bold && /A note for you/.test(done.desc) && /A note for/.test(await ev('ME.agent.log[0].comment')), 'a comment shows on a card and in the Activity', JSON.stringify(done));
  const pos = await ev(`(c => { const a = c.getBoundingClientRect(), s = document.getElementById('stage').getBoundingClientRect(); return [s.right - a.right, a.left - s.left, s.width, a.top - s.top]; })(${cardEl})`);
  check(pos[0] < 24 && pos[1] > pos[2] / 2 && pos[3] < 64, 'the card is at the top right of the map', JSON.stringify(pos));
  // the card can be dragged by its head to another place; the place is kept
  const cardXY = `(r => [r.left, r.top])(${cardEl}.getBoundingClientRect())`, xy0 = await ev(cardXY);
  const grab = await ev(`(r => [r.left + 50, r.top + r.height / 2])(document.querySelector('#ai-proposal .head').getBoundingClientRect())`);
  const view0 = await ev('[gwp.view.ox, gwp.view.oy]');
  await mouse('mouseMoved', ...grab); await mouse('mousePressed', ...grab);
  for (let k = 1; k <= 6; k++) await mouse('mouseMoved', grab[0] - 50 * k, grab[1] + 30 * k);
  await mouse('mouseReleased', grab[0] - 300, grab[1] + 180); await sleep(150);
  const xy1 = await ev(cardXY), kept = await ev(`JSON.parse(localStorage.getItem('gwp-ai-card') || 'null')`);
  check(Math.abs(xy1[0] - (xy0[0] - 300)) < 2 && Math.abs(xy1[1] - (xy0[1] + 180)) < 2 && kept?.x > 0 && JSON.stringify(await ev('[gwp.view.ox, gwp.view.oy]')) === JSON.stringify(view0),
    'the card can be dragged to another place (the map does not move)', `${JSON.stringify(xy0)} -> ${JSON.stringify(xy1)} kept ${JSON.stringify(kept)}`);
  await cardBtn('Undo');
  check((await ev(nNotes)) === notes0 && !(await ev(`!!${cardEl}`)), 'Undo on the card undoes the change');
  // several calls as one change: begin_change … end_change is one undo step
  const sumB = `gwp.layerById('bushes').data.reduce((a, v) => a + v, 0)`, bushes0 = await ev(sumB), u0 = await ev('gwp.history.undo.length');
  const g1 = await call('begin_change', { title: 'A note and bushes', description: 'Two steps' });
  const g2 = await call('add_items', { layer: 'notes', items: [{ x: 6, z: 6, text: 'g' }], comment: 'first' });
  await call('paint_layer', { layer: 'bushes', region: { circle: [6, 6, 4] }, value: 80 });
  const openCls = await ev(`${cardEl}?.className`), openLis = await ev(`${cardEl}?.querySelectorAll('.changes > li').length`);
  const xy2 = await ev(cardXY);
  check(Math.abs(xy2[0] - xy1[0]) < 2 && Math.abs(xy2[1] - xy1[1]) < 2, 'the next card comes where the user put it', `${JSON.stringify(xy2)} vs ${JSON.stringify(xy1)}`);
  await ev(`document.querySelector('#ai-proposal .head').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  const xy3 = await ev(`(c => { const a = c.getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect(); return [st.right - a.right, a.top - st.top]; })(${cardEl})`);
  check(xy3[0] < 24 && xy3[1] < 64 && (await ev(`localStorage.getItem('gwp-ai-card')`)) === null, 'a double-click on its head puts it back in the corner', JSON.stringify(xy3));
  const g4 = await call('end_change', { summary: 'Done: a note and bushes' });
  const top = await ev('gwp.history.undo.at(-1).label'), u1 = await ev('gwp.history.undo.length'), doneDesc = await ev(`${cardEl}?.querySelector('.desc')?.textContent`);
  check(g1.data?.status === 'open' && g1.data.review_mode === false && g2.data?.change?.status === 'open' && openCls === 'open' && openLis === 2
    && g4.data?.change?.status === 'done' && top === 'AI: A note and bushes' && u1 === u0 + 1 && doneDesc === 'Done: a note and bushes',
  'begin_change … end_change: one undo step with the agent\'s title and summary', `${JSON.stringify(g4.data || g4.error)} ${top} ${u0}->${u1} ${openCls} ${openLis}`);
  await ev('gwp.undo(); true');
  check((await ev(nNotes)) === notes0 && (await ev(sumB)) === bushes0, 'it is undone in one step');
  const empty = await call('begin_change', { title: 'Nothing' });
  const e2 = await call('end_change', {});
  check(empty.data?.status === 'open' && e2.data?.change?.status === 'empty', 'a change with nothing in it closes', JSON.stringify(e2.data || e2.error));

  // a bridge and a hut: find_crossing gives the bank points, objects go by their ends, the agent sees and checks its change
  const fc = await call('find_crossing', { region: { circle: [-84, 21, 10] } });
  const cr = fc.data?.crossings?.[0];
  check(cr && cr.angle_to_flow_deg >= 80 && cr.ends.a.dry && cr.ends.b.dry && cr.water_width >= 2 && cr.water_width <= 8 && fc.data.water_layers.includes('rivers'),
    'find_crossing: bank points straight across the river', fc.error || JSON.stringify(cr));
  const has = (r, c) => (r.data?.checks?.problems || r.data?.problems || []).some(p => p.check === c);
  await call('begin_change', { title: 'A bridge and a hut' });
  const wrong = await call('add_items', { layer: 'buildings', items: [{ kind: 'stone_bridge', x: cr.center[0], z: cr.center[1], yaw: cr.yaw + 90, w: 10, d: 3 }] });
  const hut = await call('add_items', { layer: 'buildings', items: [{ kind: 'hut', x: cr.center[0] + 2, z: cr.center[1] + 1, w: 8, d: 6 }] });
  check(has(wrong, 'along_the_water') && has(wrong, 'end_in_water') && has(hut, 'overlap') && has(hut, 'in_water'), 'a call reports what is wrong with its objects (a bridge along the river, a hut on it and in the water)',
    JSON.stringify([wrong.data?.checks, hut.data?.checks]).slice(0, 300));
  const seen = await call('check_change');
  check(seen.images.length === 2 && seen.images.every(i => i.data.length > 3000) && seen.data?.problems?.length >= 3 && seen.data.layers.buildings?.added_count === 2 && /BEFORE.*AFTER/.test(seen.text),
    'check_change: BEFORE and AFTER images, what changed, the problems', seen.error || JSON.stringify(seen.data?.layers));
  const notDone = await call('end_change', { summary: 'x' });
  check(notDone.data?.change?.status === 'open' && notDone.data.problems.length >= 3 && (await ev(`!!document.querySelector('#ai-proposal .check.bad')`)), 'end_change does not finish while problems are left (the card says so)', JSON.stringify(notDone.data?.change));
  const bridgeId = wrong.data.ids[0], hutId = hut.data.ids[0];
  await call('update_items', { layer: 'buildings', items: [{ id: bridgeId, a: cr.a, b: cr.b, d: 3 }, { id: hutId, move: [0, -14] }] });
  const placed = await ev(`gwp.layerById('buildings').items.find(i => i.id === ${bridgeId})`);
  const expYaw = Math.atan2(-(cr.b[1] - cr.a[1]), cr.b[0] - cr.a[0]) * 180 / Math.PI, expLen = Math.hypot(cr.b[0] - cr.a[0], cr.b[1] - cr.a[1]);
  check(Math.abs(placed.x - (cr.a[0] + cr.b[0]) / 2) < 0.02 && Math.abs(placed.z - (cr.a[1] + cr.b[1]) / 2) < 0.02 && Math.abs(placed.w - expLen) < 0.05 && Math.abs(placed.yaw - expYaw) < 0.1 && placed.d === 3,
    'an object placed by its ends a and b: center, yaw and length follow', JSON.stringify(placed));
  const fixed = await call('end_change', { summary: 'A bridge straight across, the hut north of it' });
  check(fixed.data?.change?.status === 'done' && fixed.data.checks?.problems === 0 && (await ev(`!!document.querySelector('#ai-proposal .check.ok, #ai-proposal .check.warn')`)),
    'fixed: end_change finishes, the card shows the self-check', JSON.stringify(fixed.data || fixed.error).slice(0, 200));
  const over = await call('find_route', { from: { point: cr.a }, to: { point: cr.b } });
  check(over.data?.found && over.data.length <= 1.5 * cr.length + 1, 'a route crosses the river over the bridge', JSON.stringify(over.data || over.error).slice(0, 200));
  const placedNow = await call('check_change', { items: { layer: 'buildings', ids: [bridgeId, hutId] } });
  check(placedNow.data?.checked_objects?.length === 2 && placedNow.data.ok && placedNow.images.length === 1, 'check_change of objects on the map', JSON.stringify(placedNow.data?.problems));
  const sizes = (await call('get_map_info')).data?.layers_top_to_bottom?.find(l => l.id === 'buildings')?.kind_sizes;
  check(sizes?.house === '8 × 6', 'get_map_info: the usual size of each kind', JSON.stringify(sizes));
  await ev('gwp.undo(); true'); // the bridge and the hut, one step
  // a problem the agent means: ignore_problems with a reason (the user sees it)
  await call('begin_change', { title: 'A shed in the yard' });
  await call('add_items', { layer: 'buildings', items: [{ kind: 'shed', x: -2, z: 10, w: 3, d: 3 }] });
  const ign = await call('end_change', { ignore_problems: 'The shed stands inside the house on purpose: a cellar entrance' });
  check(ign.data?.change?.status === 'done' && ign.data.checks?.ignored && /cellar/.test(await ev(`document.querySelector('#ai-proposal .check')?.textContent || ''`)), 'ignore_problems: finished, the reason on the card', JSON.stringify(ign.data || ign.error).slice(0, 200));
  await ev('gwp.undo(); true');
  // towards: the length points at a point (north: yaw 90)
  const tw = await call('add_items', { layer: 'chests', items: [{ kind: 'crate', x: 0, z: 0, towards: [0, -10] }] });
  check((await ev(`gwp.layerById('chests').items.find(i => i.id === ${tw.data?.ids?.[0]})?.yaw`)) === 90, 'an object pointed "towards" a point');
  await ev('gwp.undo(); true');
  // the zones are areas, not obstacles: a class "river_valley" does not block walking
  await call('update_layer', { layer: 'zones', add_classes: [{ name: 'river_valley', color: '#3a6a8a' }] });
  const wk = await call('analyze_walkability', { region: { circle: [0, 25, 10] } });
  check(wk.data && !wk.data.blocking_layers.some(l => l.startsWith('zones')), 'the zones do not block walking', JSON.stringify(wk.data?.blocking_layers));
  await call('undo');

  // errors are explained to the agent
  const locked = await ev(`(gwp.layerById('water').meta.locked = true, true)`);
  const lk = await call('paint_layer', { layer: 'water', region: { circle: [0, 0, 5] }, value: 100 });
  check(locked && /locked/.test(lk.error || ''), 'a locked layer is refused', lk.error);
  const bad = await call('describe_region', { region: { zone: 'castle' } });
  check(/no class "castle".*village/.test(bad.error || ''), 'an unknown zone lists the zones', bad.error);
  await ev(`ME.agent.settings.canWrite = false; true`);
  const ro = await call('add_items', { layer: 'notes', items: [{ x: 0, z: 0, text: 'x' }] });
  check(/only read/.test(ro.error || ''), 'read-only mode', ro.error);
  await ev(`ME.agent.settings.canWrite = true; true`);
  // review mode: the agent's changes are proposals the user accepts, sends back with a comment, or rejects
  await ev(`ME.agent.settings.review = true; true`);
  const rv = await call('get_map_info');
  check(/^on/.test(rv.data?.review_mode || ''), 'get_map_info says review mode is on', rv.data?.review_mode);
  const card = `(c => c && { status: c.className.split(' ')[0], title: c.querySelector('.title')?.textContent, changes: c.querySelectorAll('.changes li').length })(document.getElementById('ai-proposal'))`;
  const click = (text, sel = '#ai-proposal button') => ev(`(b => (b.click(), true))([...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.trim() === ${JSON.stringify(text)}))`);
  const chests = `gwp.layerById('chests').items.length`, stamp = f => ev(`(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('demo-island');
    const f = await (await (await d.getDirectoryHandle('layers')).getFileHandle(${JSON.stringify(f)})).getFile(); return f.lastModified + ':' + f.size; })()`);
  await until(`!gwp.S.layers.some(l => l.dirty)`, 8000);
  const n0 = await ev(chests), st0 = await stamp('chests.json');
  const p1 = call('add_items', { layer: 'chests', items: [{ kind: 'iron_chest', x: 5, z: 5 }], comment: 'A chest by the road' });
  const c1 = await until(`(${card})?.status === 'pending' && ${card}`, 8000);
  check((await ev(`document.querySelector('#ai-proposal .desc')?.textContent`)) === 'A chest by the road', 'review: the agent\'s comment is on the proposal');
  const held = await ev(`ME.agentReview.holds(gwp.layerById('chests')) && ${chests} === ${n0 + 1}`);
  await sleep(1500);
  const unsaved = (await stamp('chests.json')) === st0;
  await ev(`gwp.undo(); true`);
  const noUndo = (await ev(chests)) === n0 + 1;
  await click('Before');
  const beforeN = await ev(chests);
  await click('After');
  const afterN = await ev(chests);
  await click('Accept');
  const r1 = await p1;
  check(c1 && held && unsaved && noUndo && beforeN === n0 && afterN === n0 + 1 && r1.data?.proposal?.status === 'accepted' && r1.data.ids?.length === 1,
    'review: a change is held (not saved, no undo), Before / After, Accept', `${JSON.stringify(c1)} held ${held} unsaved ${unsaved} undo ${noUndo} ${beforeN}/${afterN} ${JSON.stringify(r1.data?.proposal || r1.error)}`);
  check(await until(async () => (await stamp('chests.json')) !== st0, 8000), 'review: saved after Accept');
  const chestId = r1.data.ids[0];
  // a proposal of several changes, sent back with a comment
  const sumBushes = `gwp.layerById('bushes').data.reduce((a, v) => a + v, 0)`, b0 = await ev(sumBushes);
  const begin = await call('begin_change', { title: 'A camp', description: 'Crates and bushes around a fire' });
  const part = await call('add_items', { layer: 'chests', items: [{ kind: 'crate', x: 12, z: 8 }, { kind: 'crate', x: 14, z: 9 }] });
  await call('paint_layer', { layer: 'bushes', region: { circle: [12, 10, 6] }, value: 90 });
  const openState = await ev(`(${card})?.status`);
  const p2 = call('end_change', { summary: 'Two crates and bushes' });
  const c2 = await until(`(${card})?.status === 'pending' && (${card}).changes === 2 && ${card}`, 8000);
  await click('Change…');
  await ev(`(t => { t.value = 'Only one crate, no bushes'; t.dispatchEvent(new Event('input')); return true; })(document.querySelector('#ai-proposal textarea'))`);
  await click('Send to the agent');
  const r2 = await p2;
  check(begin.data?.status === 'open' && part.data?.proposal?.status === 'open' && openState === 'open' && c2?.title === 'A camp'
    && r2.data?.proposal?.status === 'changes_requested' && r2.data.proposal.feedback === 'Only one crate, no bushes'
    && (await ev(chests)) === n0 + 1 && (await ev(sumBushes)) === b0,
  'review: a proposal of several changes, sent back with a comment (undone)', JSON.stringify(r2.data?.proposal || r2.error));
  // rejected
  const p3 = call('update_items', { layer: 'chests', items: [{ id: chestId, kind: 'gold_chest' }] });
  await until(`(${card})?.status === 'pending'`, 8000);
  await click('Reject');
  const r3 = await p3;
  check(r3.data?.proposal?.status === 'rejected' && (await ev(`gwp.layerById('chests').items.find(i => i.id === ${chestId}).kind`)) === 'iron_chest', 'review: rejected (undone)', JSON.stringify(r3.data?.proposal));
  // the user decides later: wait_for_review; meanwhile more changes wait
  await call('begin_change', { title: 'Later' });
  await call('add_items', { layer: 'notes', items: [{ x: 1, z: 1, text: 'later' }] });
  await call('add_items', { layer: 'notes', items: [{ x: 1.5, z: 1, text: 'later too' }] });
  const r4 = await call('end_change', { wait: 1 });
  const blocked = await call('add_items', { layer: 'notes', items: [{ x: 2, z: 2, text: 'more' }] });
  const p5 = call('wait_for_review', { id: r4.data?.proposal?.id, wait: 30 });
  await sleep(300);
  await click('Accept');
  const r5 = await p5;
  check(r4.data?.proposal?.status === 'pending' && /waiting for the user's review/.test(blocked.error || '') && r5.data?.proposal?.status === 'accepted',
    'review: pending, then wait_for_review; no new changes meanwhile', `${r4.data?.proposal?.status} | ${blocked.error} | ${r5.data?.proposal?.status}`);
  const released = await ev(`ME.agentReview.list.filter(p => !['open', 'pending'].includes(p.status) && p !== ME.agentReview.shown).map(p => p.entries.length + p.marks.length + p.results.length)`);
  check(released.length >= 3 && released.every(n => n === 0), 'decided changes let go of their undo steps, marks and results (memory)', JSON.stringify(released));
  check((await ev('gwp.history.undo.at(-1).label')) === 'AI: Later', 'review: an accepted proposal is one undo step', await ev('gwp.history.undo.at(-1).label'));
  // a single change with problems is not shown for review: it stays open for the agent to fix
  const bad1 = await call('add_items', { layer: 'buildings', items: [{ kind: 'shed', x: -2, z: 10, w: 3, d: 3 }] });
  check(bad1.data?.proposal?.status === 'open' && has(bad1, 'overlap') && (await ev(`(${card})?.status`)) === 'open', 'review: a change with problems stays open (not shown for review)', JSON.stringify(bad1.data?.proposal || bad1.error));
  await call('undo');
  // the agent withdraws its open proposal
  await call('begin_change', { title: 'Oops' });
  await call('add_items', { layer: 'notes', items: [{ x: 3, z: 3, text: 'oops' }] });
  const notesN = await ev(`gwp.layerById('notes').items.length`);
  const wd = await call('undo');
  check(wd.data?.withdrawn && (await ev(`gwp.layerById('notes').items.length`)) === notesN - 1 && !(await ev(`!!document.getElementById('ai-proposal')`)), 'review: the agent withdraws its proposal', JSON.stringify(wd.data || wd.error));
  await ev(`ME.agent.settings.review = false; true`);

  // the dialog
  await ev(`ME.agentUi.open(); true`);
  const dlg = await ev(`(d => [d.open, d.querySelector('.agent-status b').textContent, [...d.querySelectorAll('.tabs button')].map(b => b.textContent)])(document.getElementById('agent-dlg'))`);
  check(dlg[0] && dlg[1] === 'Connected' && dlg[2].length === 6, 'the AI Agent dialog', JSON.stringify(dlg));
  await ev(`[...document.querySelectorAll('#agent-dlg .tabs button')].find(b => b.textContent.startsWith('Agents')).click(); true`);
  const snippet = await ev(`document.querySelector('#agent-dlg .code pre').textContent`), clone = await ev(`document.getElementById('agent-dlg').textContent.includes('mcp/server.mjs')`);
  check(snippet.includes('npx -y game-world-painter-mcp') && snippet.includes(`--port ${port}`) && clone, 'the agent commands: npx with the port (and the clone\'s path, as it runs from one)', snippet);
  const skill = await ev(`Promise.all(['SKILL.md', 'references/regions.md', 'references/recipes.md'].map(f => fetch('skills/game-world-painter/' + f).then(r => r.ok)))`);
  check(skill.every(Boolean), 'the skill files are served for the download');
  const log = await ev('ME.agent.log.length');
  check(log >= 25, 'the activity log', log);
  // a long session: the Activity keeps the latest LOG_MAX calls and draws them a page at a time
  const max = await ev('ME.agent.LOG_MAX');
  await ev(`ME.agent.log.push(...Array.from({ length: ${max} }, (_, k) => ({ id: 'old' + k, time: new Date(), tool: 'describe_region', client: 'old', args: '{}', status: 'ok', result: 'x' }))); true`);
  await call('get_user_context');
  const capped = await ev(`[ME.agent.log.length, ME.agent.log[0].tool, ME.agent.pending()]`);
  check(capped[0] === max && max === 1000 && capped[1] === 'get_user_context' && capped[2] === 0, 'the Activity keeps at most 1000 calls, the newest first; no call left pending', JSON.stringify(capped));
  await ev(`[...document.querySelectorAll('#agent-dlg .tabs button')].find(b => b.textContent.startsWith('Activity')).click(); true`);
  const rows0 = await ev(`document.querySelectorAll('#agent-dlg .act').length`);
  await ev(`[...document.querySelectorAll('#agent-dlg button')].find(b => b.textContent.startsWith('Show older')).click(); true`);
  const rows1 = await ev(`document.querySelectorAll('#agent-dlg .act').length`);
  check(rows0 === 200 && rows1 === 400, 'the Activity draws 200 rows, "Show older" 200 more', `${rows0} → ${rows1}`);
  await ev(`ME.agent.log.length = 0; document.getElementById('agent-dlg').close(); true`);
  await ev(`gwp.layerById('water').meta.locked = false; true`);
  // maps by path: the agent creates and opens maps; the app reads and writes them through the MCP server
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwp-e2e-')));
  const newMap = path.join(tmpRoot, 'new-world');
  // a proposal still waiting when the agent opens another map: undone, not saved into the old map
  await ev(`ME.agent.settings.review = true; true`);
  const pd = call('add_items', { layer: 'notes', items: [{ x: 7, z: 7, text: 'never accepted' }] });
  await until(`(${card})?.status === 'pending'`, 8000);
  await ev(`ME.agent.settings.review = false; true`);
  const cm = await call('create_map', { path: newMap, title: 'New world', width: 200, cell: 0.5 });
  const pdr = await pd, oldNotes = await ev(`(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('demo-island');
    return (await (await (await d.getDirectoryHandle('layers')).getFileHandle('notes.json')).getFile()).text(); })()`);
  check(pdr.data?.proposal?.status === 'dropped' && !oldNotes.includes('never accepted') && oldNotes.includes('Village square'), 'a waiting proposal is undone (not saved) when the agent opens another map', JSON.stringify(pdr.data?.proposal || pdr.error));
  check(cm.data?.created === newMap && fs.existsSync(path.join(newMap, 'metadata.json')) && (await ev('gwp.S.project?.title')) === 'New world'
    && (await ev('gwp.folder instanceof ME.RemoteFolder')) && (await ev('gwp.S.layers.length')) === cm.data.layers.length && cm.data.cells[0] === 400,
  'create_map: a new map on the disk, open in the app', cm.error || JSON.stringify(cm.data).slice(0, 200));
  await call('add_items', { layer: 'enemies', items: [{ kind: 'wolf', x: 10, z: 10, props: { pack_size: 3 } }] });
  const enemiesFile = path.join(newMap, 'layers', 'enemies.json');
  check(await until(async () => fs.existsSync(enemiesFile) && JSON.parse(fs.readFileSync(enemiesFile, 'utf8')).items.length === 1, 8000), 'its changes are saved into the folder');
  fs.writeFileSync(path.join(newMap, 'layers', 'notes.json'), '{"items": [\n{"id":1,"x":0,"z":0,"text":"written by a script"}\n]}\n');
  check(await until(`gwp.layerById('notes').items[0]?.text === 'written by a script'`, 8000), 'a change made on the disk shows up (watching through the server)');
  // a map without layers: the app works with an empty list, and the agent adds its own
  const bare = await call('create_map', { path: path.join(tmpRoot, 'bare'), title: 'Bare', width: 100, layers: 'none' });
  const bareState = await ev(`({ n: gwp.S.layers.length, title: gwp.S.project?.title, rows: document.querySelectorAll('#layer-list .layer-row').length })`);
  const made = await call('create_layer', { name: 'Ideas', type: 'notes' });
  const info0 = await call('get_map_info');
  check(bare.data?.layers?.length === 0 && bareState.n === 0 && bareState.rows === 0 && bareState.title === 'Bare' && made.data?.id === 'ideas'
    && info0.data?.layers_top_to_bottom?.length === 1, 'create_map with no layers; a layer added to it', JSON.stringify({ bare: bare.error || bare.data?.layers, bareState, made: made.error }));
  const copy = path.join(tmpRoot, 'island');
  fs.cpSync(DEMO, copy, { recursive: true });
  const om = await call('open_map', { path: copy });
  check(om.data?.opened === copy && (await ev('gwp.S.project?.title')) === 'Demo island' && (await ev('ME.app.S.projectPath')) === copy, 'open_map: a map by its path', om.error || JSON.stringify(om.data));
  const gp = await call('get_project_path');
  check(gp.data?.path === copy && gp.data.found_by === 'remembered by the app', 'get_project_path knows it', JSON.stringify(gp.data?.found_by));
  await b.send('Page.reload');
  check(await until(`!!window.gwp && gwp.S.project?.title === 'Demo island' && gwp.folder instanceof ME.RemoteFolder && gwp.folder.path === ${JSON.stringify(copy)}`, 20000),
    'after a reload the map opens again through the server');
  // a link of the server turns AI Agent on and says which map comes
  await ev(`localStorage.setItem('gwp-agent', JSON.stringify({ enabled: false, review: false })); true`); // saved by an older version
  await b.send('Page.navigate', { url: `${b.origin}/index.html?mcp=${port}&map=${encodeURIComponent(newMap)}` });
  const linked = await until(`!!window.ME?.agent && ME.agent.settings.enabled && ['ready', 'agent'].includes(ME.agent.state) && location.search === '' && document.getElementById('banner').textContent.includes(${JSON.stringify(newMap)})`, 20000);
  check(await ev('ME.agent.settings.review === true && ME.agent.settings.v === 2'), 'review mode is on by default (also for settings saved before)');
  const om2 = await call('open_map', { path: newMap });
  check(linked && om2.data?.opened === newMap && (await ev('gwp.S.project?.title')) === 'New world', 'a link with ?mcp= connects the app; then open_map opens the map', om2.error || '');

  // switching off
  await ev(`document.getElementById('agent-on').click(); true`);
  await until(async () => (await (await fetch(`http://127.0.0.1:${port}/status`)).json()).app.connected === false, 5000);
  const offR = await call('get_map_info');
  check(/not connected/.test(offR.error || ''), 'switched off: the agent is told to turn it on', offR.error);
  check(b.errors.length === 0, 'no errors in the page', b.errors.slice(0, 3).join(' | '));
} catch (e) {
  check(false, 'the test ran', e.stack || e.message);
} finally {
  await mcp.kill();
  await b.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
