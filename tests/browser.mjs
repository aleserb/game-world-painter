// A browser harness for tests, no dependencies (Node 22+: fetch, WebSocket): serves the repository, starts headless
// Chrome with the DevTools protocol and opens the app, optionally with examples/demo-island in the page's private
// file system (OPFS). CHROME=/path/to/chrome chooses the browser.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO = path.join(ROOT, 'examples', 'demo-island');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.md': 'text/markdown' };

export async function openBrowser({ localStorage = {}, width = 1500, height = 950 } = {}) {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chromes = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean);
  const chromePath = chromes.find(p => fs.existsSync(p));
  if (!chromePath) throw new Error('Chrome not found: set CHROME=/path/to/chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gwp-test-'));
  const dport = 9100 + Math.floor(Math.random() * 800);
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 80 && !ws; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find(t => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    if (!ws) await sleep(250);
  }
  if (!ws) { chrome.kill(); throw new Error('Chrome did not start'); }
  await new Promise(r => { ws.onopen = r; });
  let id = 0;
  const pending = new Map(), errors = [];
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value || a.description).join(' '));
  };
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const until = async (expr, ms = 15000) => {
    let v;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
      try { v = typeof expr === 'function' ? await expr() : await ev(expr); } catch { v = undefined; }
      if (v) break;
    }
    return v;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  // localStorage of the app's origin, before the app starts
  await send('Page.navigate', { url: `${origin}/README.md` });
  await sleep(300);
  await ev(`(${JSON.stringify(localStorage)} && Object.entries(${JSON.stringify(localStorage)}).forEach(([k, v]) => window.localStorage.setItem(k, v)), true)`);
  await send('Page.navigate', { url: `${origin}/index.html` });
  await until('!!window.gwp && !!window.ME && !!ME.app');

  const opfsWrite = (p, bytes) => ev(`(async () => { const parts = ${JSON.stringify(p)}.split('/'); let d = await navigator.storage.getDirectory();
    for (const q of parts.slice(0, -1)) d = await d.getDirectoryHandle(q, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    const s = atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}); const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); await w.write(u); await w.close(); })()`);

  return {
    origin, send, ev, until, errors,
    async openDemo() {
      // named like the folder in the repository, so the MCP server can find it there (get_project_path)
      for (const f of ['metadata.json', ...fs.readdirSync(path.join(DEMO, 'layers')).map(f => 'layers/' + f)]) await opfsWrite('demo-island/' + f, fs.readFileSync(path.join(DEMO, f)));
      await ev(`(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('demo-island'); await gwp.connect(d); })()`);
      await until('gwp.S.layers.length > 0 && !gwp.busy');
    },
    async close() {
      ws.close();
      chrome.kill();
      server.close();
      await sleep(300);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may hold it */ }
    },
  };
}
