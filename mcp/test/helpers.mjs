// Test helpers: a JSON-lines MCP client over a child process, a fake app on the SSE bridge, HTTP requests.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));

export function freePort() {
  return new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

/** Starts the server for an agent (stdio); returns {request(method, params), notify, kill, stderr}.
 *  o.onRequest(method, params): answers the server's requests (roots/list); o.cwd: its working directory. */
export function startStdio(port, extra = [], env = {}, o = {}) {
  const p = spawn(process.execPath, [SERVER, '--stdio', '--port', String(port), ...extra], { cwd: o.cwd, env: { ...process.env, GWP_MCP_WAIT_APP_MS: '300', GWP_SEARCH_HOME: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', next = 1, stderr = '';
  const waiting = new Map();
  p.stdout.on('data', d => {
    buf += d;
    let k;
    while ((k = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, k);
      buf = buf.slice(k + 1);
      const msg = JSON.parse(line);
      if (msg.method && msg.id != null) { // a request of the server
        Promise.resolve(o.onRequest ? o.onRequest(msg.method, msg.params) : undefined).then(result => {
          p.stdin.write(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } } : { jsonrpc: '2.0', id: msg.id, result }) + '\n');
        });
        continue;
      }
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  p.stderr.on('data', d => { stderr += d; });
  return {
    proc: p,
    get stderr() { return stderr; },
    request(method, params) {
      const id = next++;
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout: ${method}\n${stderr}`)), 15000);
        waiting.set(id, m => { clearTimeout(t); resolve(m); });
      });
    },
    raw(line) { p.stdin.write(line + '\n'); },
    notify(method, params) { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); },
    kill() {
      if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
      const done = new Promise(r => p.once('exit', r));
      p.stdin.end();
      setTimeout(() => p.kill(), 3000).unref();
      return done;
    },
  };
}

export async function initialize(c, version = '2025-06-18', name = 'test-agent', capabilities = {}) {
  const r = await c.request('initialize', { protocolVersion: version, capabilities, clientInfo: { name, version: '1.0' } });
  c.notify('notifications/initialized');
  return r;
}

export function req(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** A fake app: connects to the SSE bridge and answers calls with handler(tool, args). */
export function fakeApp(port, handler, origin = 'http://localhost:8000') {
  const session = 'test-' + Math.random().toString(36).slice(2);
  const events = [];
  let res;
  const ready = new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: `/app/events?session=${session}&api=1&title=Test`, headers: { Host: `127.0.0.1:${port}`, Origin: origin, Accept: 'text/event-stream' } }, response => {
      res = response;
      let buf = '';
      response.on('data', async d => {
        buf += d;
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, k);
          buf = buf.slice(k + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (!ev) continue;
          const payload = JSON.parse(data);
          events.push({ ev, payload });
          if (ev === 'hello') resolve(payload);
          if (ev === 'call') {
            let out;
            try { out = { ok: true, result: await handler(payload.tool, payload.args, payload.client) }; } catch (e) { out = { ok: false, error: { message: e.message } }; }
            await req(port, 'POST', '/app/result', { body: { session, id: payload.id, ...out }, headers: { Origin: origin } });
          }
        }
      });
    });
    r.on('error', reject);
  });
  ready.catch(() => {});
  return { ready, events, session, close: () => res?.destroy() };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A project folder: metadata.json and a layer file; returns what the app would send about it. */
export function makeProject(dir, meta = '{"version":3,"title":"Test"}', layer = 'abc') {
  fs.mkdirSync(path.join(dir, 'layers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'metadata.json'), meta);
  fs.writeFileSync(path.join(dir, 'layers', 'trees.png'), layer);
  return info(dir);
}
export function info(dir) {
  const buf = fs.readFileSync(path.join(dir, 'metadata.json')), st = fs.statSync(path.join(dir, 'layers', 'trees.png'));
  return {
    name: path.basename(dir), title: 'Test',
    metadata: { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') },
    files: [{ path: 'layers/trees.png', size: st.size, mtime: st.mtimeMs }],
    hints: [], layers: [{ id: 'trees', type: 'mask', file: 'layers/trees.png' }], unsaved: { layers: [], settings: false }, autosave: true, edit_lock: false,
  };
}
