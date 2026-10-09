// The MCP server without the app: protocol (legacy and modern), the bridge to a fake app, origins, relays, HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStdio, initialize, freePort, fakeApp, req, makeProject, listening } from './helpers.mjs';
import { TOOLS } from '../lib/tools.mjs';

const META = v => ({ 'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientInfo': { name: 'modern-client', version: '2.0' }, 'io.modelcontextprotocol/clientCapabilities': {} });

test('legacy handshake, tools, resources, errors', async () => {
  const port = await freePort();
  const c = startStdio(port);
  try {
    const init = await initialize(c, '2025-06-18');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'game-world-painter');
    assert.match(init.result.instructions, /get_map_info/);
    assert.ok(init.result.capabilities.tools);
    const old = await startStdioInit(port, '2024-11-05');
    assert.equal(old, '2024-11-05');
    const future = await startStdioInit(port, '2099-01-01');
    assert.equal(future, '2025-11-25', 'an unknown legacy version gets the newest legacy one');

    const list = await c.request('tools/list', {});
    assert.equal(list.result.tools.length, TOOLS.length);
    for (const t of list.result.tools) {
      assert.match(t.name, /^[a-z_]+$/);
      assert.equal(t.inputSchema.type, 'object');
      assert.ok(t.description.length > 20, t.name);
    }
    assert.equal((await c.request('ping', {})).result && true, true);
    const res = await c.request('resources/list', {});
    assert.ok(res.result.resources.some(r => r.uri === 'gwp://project-format'));
    const doc = await c.request('resources/read', { uri: 'gwp://project-format' });
    assert.match(doc.result.contents[0].text, /metadata\.json/);
    assert.equal((await c.request('no/such', {})).error.code, -32601);
    assert.equal((await c.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
    c.raw('{not json');
    const notConnected = await c.request('tools/call', { name: 'get_map_info', arguments: {} });
    assert.equal(notConnected.result.isError, true);
    assert.match(notConnected.result.content[0].text, /not connected/);
  } finally { await c.kill(); }
});

async function startStdioInit(port, version) {
  const c = startStdio(port);
  try { return (await initialize(c, version)).result.protocolVersion; } finally { await c.kill(); }
}

test('modern requests: server/discover, per-request _meta, unsupported versions', async () => {
  const port = await freePort();
  const c = startStdio(port);
  try {
    const d = await c.request('server/discover', { _meta: META('2026-07-28') });
    assert.equal(d.result.resultType, 'complete');
    assert.ok(d.result.supportedVersions.includes('2026-07-28') && d.result.supportedVersions.includes('2025-06-18'));
    assert.equal(d.result._meta['io.modelcontextprotocol/serverInfo'].name, 'game-world-painter');
    const list = await c.request('tools/list', { _meta: META('2026-07-28') });
    assert.equal(list.result.resultType, 'complete');
    assert.equal(list.result.tools.length, TOOLS.length);
    const bad = await c.request('tools/list', { _meta: META('1900-01-01') });
    assert.equal(bad.error.code, -32022);
    assert.deepEqual(bad.error.data.requested, '1900-01-01');
  } finally { await c.kill(); }
});

test('tool calls run in the app; images and errors come back', async () => {
  const port = await freePort();
  const c = startStdio(port);
  try {
    await initialize(c);
    await listening(port);
    const app = fakeApp(port, (tool, args) => {
      if (tool === 'render_map') return { text: 'a map', images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }] };
      if (tool === 'paint_layer') throw new Error('The layer "trees" is locked');
      return { data: { tool, args } };
    });
    const hello = await app.ready;
    assert.equal(hello.name, 'game-world-painter-mcp');
    const r = await c.request('tools/call', { name: 'find_items', arguments: { layer: 'enemies', limit: 3 } });
    assert.equal(r.result.isError, false);
    assert.deepEqual(JSON.parse(r.result.content[0].text), { tool: 'find_items', args: { layer: 'enemies', limit: 3 } });
    const img = await c.request('tools/call', { name: 'render_map', arguments: {} });
    assert.deepEqual(img.result.content.map(x => x.type), ['text', 'image']);
    const err = await c.request('tools/call', { name: 'paint_layer', arguments: { layer: 'trees', region: {}, value: 50 } });
    assert.equal(err.result.isError, true);
    assert.match(err.result.content[0].text, /locked/);
    const st = (await req(port, 'GET', '/status')).json;
    assert.equal(st.app.connected, true);
    assert.equal(st.app.title, 'Test');
    assert.ok(st.agents.some(a => a.name === 'test-agent'));
    app.close();
    // an app of another API version: the agent is told which side to update
    const newer = fakeApp(port, () => ({ data: {} }), 'http://localhost:8000', 99);
    await newer.ready;
    const mismatch = await c.request('tools/call', { name: 'find_items', arguments: {} });
    assert.equal(mismatch.result.isError, true);
    assert.match(mismatch.result.content[0].text, /newer \(API 99\).*Update the server/);
    newer.close();
  } finally { await c.kill(); }
});

test('only allowed origins and loopback hosts', async () => {
  const port = await freePort();
  const c = startStdio(port);
  try {
    await listening(port);
    assert.equal((await req(port, 'GET', '/status', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await req(port, 'GET', '/status', { headers: { Host: 'evil.example' } })).status, 403);
    const ok = await req(port, 'GET', '/status', { headers: { Origin: 'https://aleserb.github.io' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], 'https://aleserb.github.io');
    const pre = await req(port, 'OPTIONS', '/app/result', { headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-private-network'], 'true');
    assert.equal((await req(port, 'GET', '/status', { headers: { Origin: 'null' } })).status, 403);
    assert.equal((await req(port, 'POST', '/relay/call', { body: { tool: 'get_map_info' }, headers: { Origin: 'http://localhost:8000', 'X-GWP-Relay': '1' } })).status, 403, 'no relay from browsers');
  } finally { await c.kill(); }
});

test('a second agent relays through the first; it takes over when the first exits', async () => {
  const port = await freePort();
  const a = startStdio(port), b = startStdio(port);
  try {
    await initialize(a, '2025-06-18', 'agent-a');
    await initialize(b, '2025-06-18', 'agent-b');
    await listening(port);
    const app = fakeApp(port, tool => ({ data: { ran: tool } }));
    await app.ready;
    const r = await b.request('tools/call', { name: 'get_user_context', arguments: {} });
    assert.equal(JSON.parse(r.result.content[0].text).ran, 'get_user_context');
    const st = (await req(port, 'GET', '/status')).json;
    assert.deepEqual(st.agents.map(x => x.name).sort(), ['agent-a', 'agent-b']);
    app.close();
    await a.kill(); // the hub goes away: b takes the port (at its next hello or call); the app reconnects there
    const first = await b.request('tools/call', { name: 'get_map_info', arguments: {} });
    assert.match(first.result.content[0].text, /not connected/, 'b runs the hub now, without an app yet');
    await listening(port);
    const app2 = fakeApp(port, tool => ({ data: { ran: tool, again: true } }));
    await app2.ready;
    const r2 = await b.request('tools/call', { name: 'get_map_info', arguments: {} });
    assert.equal(JSON.parse(r2.result.content[0].text).again, true);
    app2.close();
  } finally { await b.kill(); await a.kill().catch(() => {}); }
});

test('Streamable HTTP: legacy sessions and modern stateless requests', async () => {
  const port = await freePort();
  const c = startStdio(port);
  try {
    await listening(port);
    const accept = { Accept: 'application/json, text/event-stream' };
    const init = await req(port, 'POST', '/mcp', { headers: accept, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'http-client', version: '1' } } } });
    assert.equal(init.status, 200);
    const sid = init.headers['mcp-session-id'];
    assert.ok(sid);
    assert.equal((await req(port, 'POST', '/mcp', { headers: { ...accept, 'Mcp-Session-Id': sid }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
    const list = await req(port, 'POST', '/mcp', { headers: { ...accept, 'Mcp-Session-Id': sid }, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    assert.equal(list.json.result.tools.length, TOOLS.length);
    assert.equal((await req(port, 'GET', '/mcp')).status, 405);
    // sessions left without DELETE do not pile up: at most 200, the least recently used goes first
    const initBody = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'many', version: '1' } } };
    const first = (await req(port, 'POST', '/mcp', { headers: accept, body: initBody })).headers['mcp-session-id'];
    const ping = s => req(port, 'POST', '/mcp', { headers: { ...accept, 'Mcp-Session-Id': s }, body: { jsonrpc: '2.0', id: 9, method: 'ping' } });
    assert.equal((await ping(sid)).status, 200); // used after the first: the first is the least recently used now
    for (let k = 0; k < 199; k++) await req(port, 'POST', '/mcp', { headers: accept, body: initBody });
    assert.equal((await ping(sid)).status, 200, 'the session in use is kept');
    assert.equal((await ping(first)).status, 404, 'the oldest unused session is gone: initialize again');
    assert.equal((await req(port, 'DELETE', '/mcp', { headers: { 'Mcp-Session-Id': sid } })).status, 200);
    assert.equal((await ping(sid)).status, 404, 'a deleted session is gone');
    const modern = { ...accept, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' };
    const m = await req(port, 'POST', '/mcp', { headers: modern, body: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: META('2026-07-28') } } });
    assert.equal(m.status, 200);
    assert.equal(m.json.result.resultType, 'complete');
    const mismatch = await req(port, 'POST', '/mcp', { headers: { ...modern, 'Mcp-Method': 'tools/call' }, body: { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: META('2026-07-28') } } });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.json.error.code, -32020);
    const unknown = await req(port, 'POST', '/mcp', { headers: { ...modern, 'Mcp-Method': 'nope/nope' }, body: { jsonrpc: '2.0', id: 5, method: 'nope/nope', params: { _meta: META('2026-07-28') } } });
    assert.equal(unknown.status, 404);
    const old = await req(port, 'POST', '/mcp', { headers: { ...accept, 'MCP-Protocol-Version': '2027-01-01' }, body: { jsonrpc: '2.0', id: 6, method: 'tools/list', params: { _meta: META('2027-01-01') } } });
    assert.equal(old.status, 400);
    assert.equal(old.json.error.code, -32022);
    assert.equal((await req(port, 'POST', '/mcp', { headers: { ...accept, Origin: 'https://evil.example' }, body: { jsonrpc: '2.0', id: 7, method: 'tools/list' } })).status, 403);
  } finally { await c.kill(); }
});

test('get_project_path: the folder found through the client\'s roots, its working directory; remembered in the app', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwp-path-')));
  const ws = tmp(), proj = path.join(ws, 'levels', 'island');
  const info = makeProject(proj);
  const empty = tmp();
  const port = await freePort();
  let asked = 0;
  const c = startStdio(port, [], {}, { cwd: empty, onRequest: m => (m === 'roots/list' ? (asked++, { roots: [{ uri: `file://${ws}`, name: 'game' }] }) : undefined) });
  try {
    await initialize(c, '2025-06-18', 'roots-agent', { roots: { listChanged: true } });
    await listening(port);
    let remembered = null, hints = [];
    const app = fakeApp(port, (tool, args) => {
      if (tool === '_project_folder') return { data: { ...info, hints } };
      if (tool === '_set_project_path') { remembered = args.path; return { data: { ok: true } }; }
      return { data: {} };
    });
    await app.ready;
    const r = await c.request('tools/call', { name: 'get_project_path', arguments: {} });
    const d = JSON.parse(r.result.content[0].text);
    assert.equal(d.path, proj);
    assert.match(d.found_by, /workspace/);
    assert.equal(d.layer_files[0].file, path.join(proj, 'layers', 'trees.png'));
    assert.equal(d.metadata, path.join(proj, 'metadata.json'));
    assert.equal(remembered, proj, 'the app remembers it');
    assert.equal(asked, 1);
    hints = [proj];
    const again = JSON.parse((await c.request('tools/call', { name: 'get_project_path', arguments: {} })).result.content[0].text);
    assert.equal(again.found_by, 'remembered by the app');
    const wrong = JSON.parse((await c.request('tools/call', { name: 'get_project_path', arguments: { path: empty } })).result.content[0].text);
    assert.equal(wrong.path, null);
    assert.match(wrong.ask_user, /full path of the folder "island"/);
    app.close();
  } finally { await c.kill(); }
  // no roots: the working directory
  const port2 = await freePort();
  const c2 = startStdio(port2, [], {}, { cwd: ws });
  try {
    await initialize(c2);
    await listening(port2);
    const app = fakeApp(port2, tool => (tool === '_project_folder' ? { data: info } : { data: { ok: true } }));
    await app.ready;
    const d = JSON.parse((await c2.request('tools/call', { name: 'get_project_path', arguments: {} })).result.content[0].text);
    assert.equal(d.path, proj);
    assert.match(d.found_by, /working directory/);
    app.close();
  } finally { await c2.kill(); }
});

test('open_map, create_map: the folder is granted to the connected app only, inside the folder only', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwp-open-')));
  const map = path.join(tmp, 'island');
  makeProject(map);
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'no');
  const port = await freePort();
  const c = startStdio(port);
  try {
    await initialize(c);
    // no app: a link to open it (the browser is not opened in tests)
    const none = await c.request('tools/call', { name: 'open_map', arguments: { path: map } });
    assert.equal(none.result.isError, true);
    assert.match(none.result.content[0].text, /mcp=\d+&map=/);
    await listening(port);
    const calls = [];
    const app = fakeApp(port, (tool, args) => { calls.push([tool, args]); return { data: { ok: tool } }; });
    await app.ready;
    const fsReq = (method, op, p, { root = map, session = app.session, body } = {}) =>
      req(port, method, `/fs/${op}?root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}`, { body, headers: { Origin: 'http://localhost:8000', 'X-GWP-Session': session } });
    assert.equal((await fsReq('GET', 'stat', 'metadata.json')).status, 403, 'not granted before open_map');
    const r = await c.request('tools/call', { name: 'open_map', arguments: { path: path.join(map, 'metadata.json') } });
    assert.equal(r.result.isError, false, r.result.content[0].text);
    assert.deepEqual(calls.at(-1), ['_open_map', { root: map, name: 'island' }]);
    const st = await fsReq('GET', 'stat', 'metadata.json');
    assert.equal(st.status, 200);
    assert.equal(st.json.size, fs.statSync(path.join(map, 'metadata.json')).size);
    const rd = await fsReq('GET', 'read', 'layers/trees.png');
    assert.equal(rd.text, 'abc');
    assert.ok(+rd.headers['x-gwp-mtime'] > 0);
    const wr = await fsReq('PUT', 'write', 'layers/new.json', { body: '{"items":[]}' });
    assert.equal(wr.status, 200);
    assert.equal(fs.readFileSync(path.join(map, 'layers', 'new.json'), 'utf8'), '{"items":[]}');
    assert.equal((await fsReq('DELETE', 'remove', 'layers/new.json')).status, 200);
    assert.equal(fs.existsSync(path.join(map, 'layers', 'new.json')), false);
    assert.equal((await fsReq('GET', 'stat', 'nope.png')).status, 404);
    assert.equal((await fsReq('GET', 'read', '../secret.txt')).status, 400, 'no way out of the folder');
    assert.equal((await fsReq('GET', 'read', '/etc/passwd')).status, 400);
    assert.equal((await fsReq('GET', 'read', 'metadata.json', { root: tmp })).status, 403, 'only the granted folder');
    assert.equal((await fsReq('GET', 'read', 'metadata.json', { session: 'someone-else' })).status, 403, 'only the connected app');
    fs.symlinkSync(tmp, path.join(map, 'up'));
    assert.equal((await fsReq('GET', 'read', 'up/secret.txt')).status, 400, 'no way out through a link');
    assert.equal((await req(port, 'GET', `/fs/read?root=${encodeURIComponent(map)}&path=metadata.json`, { headers: { Origin: 'https://evil.example', 'X-GWP-Session': app.session } })).status, 403);
    // create_map: makes the folder, refuses a folder with a map
    const fresh = path.join(tmp, 'new', 'world');
    const cr = await c.request('tools/call', { name: 'create_map', arguments: { path: fresh, title: 'World', unit: 'cm', width: 10000 } });
    assert.equal(cr.result.isError, false, cr.result.content[0].text);
    assert.equal(fs.statSync(fresh).isDirectory(), true);
    assert.deepEqual(calls.at(-1), ['_create_map', { root: fresh, name: 'world', title: 'World', unit: 'cm', width: 10000 }]);
    const again = await c.request('tools/call', { name: 'create_map', arguments: { path: map } });
    assert.match(again.result.content[0].text, /already has a map/);
    const notMap = await c.request('tools/call', { name: 'open_map', arguments: { path: tmp } });
    assert.match(notMap.result.content[0].text, /not a map/);
    app.close();
  } finally { await c.kill(); }
});
