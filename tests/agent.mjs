// End-to-end test of the AI agent integration: the app in headless Chrome with the demo map connects to the MCP server
// (mcp/server.mjs, started as an agent would start it: stdio), and an MCP client calls every tool.
//
//   node tests/agent.mjs        (CHROME=/path/to/chrome to choose the browser)
import path from 'node:path';
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
const b = await openBrowser({ localStorage: { 'gwp-agent': JSON.stringify({ enabled: true, url: `http://127.0.0.1:${port}`, confirmDeletes: true }) } });
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
  check(missing.length === 0 && tools.length === 24, 'every MCP tool runs in the app (or the server)', missing.join(', '));

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
  const undo0 = await ev('gwp.history.undo.length');
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
  const card = `(c => c && { status: c.className, title: c.querySelector('.title')?.textContent, changes: c.querySelectorAll('.changes li').length })(document.getElementById('ai-proposal'))`;
  const click = (text, sel = '#ai-proposal button') => ev(`(b => (b.click(), true))([...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.trim() === ${JSON.stringify(text)}))`);
  const chests = `gwp.layerById('chests').items.length`, stamp = f => ev(`(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('demo-island');
    const f = await (await (await d.getDirectoryHandle('layers')).getFileHandle(${JSON.stringify(f)})).getFile(); return f.lastModified + ':' + f.size; })()`);
  await until(`!gwp.S.layers.some(l => l.dirty)`, 8000);
  const n0 = await ev(chests), st0 = await stamp('chests.json');
  const p1 = call('add_items', { layer: 'chests', items: [{ kind: 'iron_chest', x: 5, z: 5 }] });
  const c1 = await until(`(${card})?.status === 'pending' && ${card}`, 8000);
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
  const begin = await call('begin_proposal', { title: 'A camp', description: 'Crates and bushes around a fire' });
  const part = await call('add_items', { layer: 'chests', items: [{ kind: 'crate', x: 12, z: 8 }, { kind: 'crate', x: 14, z: 9 }] });
  await call('paint_layer', { layer: 'bushes', region: { circle: [12, 10, 6] }, value: 90 });
  const openState = await ev(`(${card})?.status`);
  const p2 = call('submit_proposal', { summary: 'Two crates and bushes' });
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
  await call('begin_proposal', { title: 'Later' });
  await call('add_items', { layer: 'notes', items: [{ x: 1, z: 1, text: 'later' }] });
  const r4 = await call('submit_proposal', { wait: 1 });
  const blocked = await call('add_items', { layer: 'notes', items: [{ x: 2, z: 2, text: 'more' }] });
  const p5 = call('wait_for_review', { id: r4.data?.proposal?.id, wait: 30 });
  await sleep(300);
  await click('Accept');
  const r5 = await p5;
  check(r4.data?.proposal?.status === 'pending' && /waiting for the user's review/.test(blocked.error || '') && r5.data?.proposal?.status === 'accepted',
    'review: pending, then wait_for_review; no new changes meanwhile', `${r4.data?.proposal?.status} | ${blocked.error} | ${r5.data?.proposal?.status}`);
  // the agent withdraws its open proposal
  await call('begin_proposal', { title: 'Oops' });
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
  const snippet = await ev(`document.querySelector('#agent-dlg .code pre').textContent`);
  check(snippet.includes('mcp/server.mjs') && snippet.includes(`--port ${port}`), 'the agent commands use the real server path and port', snippet);
  const skill = await ev(`Promise.all(['SKILL.md', 'references/regions.md', 'references/recipes.md'].map(f => fetch('skills/game-world-painter/' + f).then(r => r.ok)))`);
  check(skill.every(Boolean), 'the skill files are served for the download');
  const log = await ev('ME.agent.log.length');
  check(log >= 25, 'the activity log', log);
  await ev(`gwp.layerById('water').meta.locked = false; true`);
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
