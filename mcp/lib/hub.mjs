// The hub: one HTTP server on 127.0.0.1 that the app (the browser page) and the agents meet at.
//   GET  /app/events   the app's Server-Sent Events stream: tool calls to run ("call"), status updates ("status")
//   POST /app/result   the app's answer to a call
//   POST /app/state    the app tells what is open (the map title)
//   GET  /status       what is connected (the app shows it)
//   POST /relay/call   another server process (started by another agent) forwards a tool call
//   POST /relay/hello  ... and says it is alive (its agent shows in the app)
//   POST /mcp          Streamable HTTP MCP for clients configured by URL
//   /fs/stat, /fs/read, /fs/write, /fs/remove   the files of a map the agent opened or created (open_map, create_map),
//                      for the connected app only (X-GWP-Session) and only inside the folders granted by the agent
// Browsers may reach it only from allowed origins (the app); the Host header must be a loopback name (no DNS rebinding).
import http from 'node:http';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { McpEndpoint, RpcError, ERR, error as rpcError, SUPPORTED_VERSIONS, MODERN_VERSIONS } from './protocol.mjs';

export const DEFAULT_PORT = 38765;
export const DEFAULT_ORIGINS = ['https://aleserb.github.io', 'http://localhost:*', 'http://127.0.0.1:*', 'http://[::1]:*'];
const MAX_BODY = 64 * 1024 * 1024;

export class AppNotConnected extends Error {}

export class Hub {
  /** o: {port, host, allowOrigins, version, api, log, timeoutMs, slowTools, waitAppMs, sessionIdleMs, maxSessions, mcp: endpoint options} */
  constructor(o) {
    this.o = o;
    this.app = null; // {session, res, origin, since, title, api, version}
    this.calls = new Map(); // id -> {resolve, reject, timer, tool}
    this.agents = new Map(); // key -> {name, version, transport, since, seen}
    this.httpSessions = new Map(); // legacy Streamable HTTP sessions: id -> {ep, used}; idle ones expire, at most maxSessions
    this.stateless = null;
    this.total = 0;
    this.appWaiters = [];
    this.grants = new Set(); // map folders the app may read and write through /fs (granted by the agent's tools)
    this.appUrl = null; // where the app was opened last (to open it again for the agent)
  }

  /** Lets the app use a map folder through /fs (only the agent's open_map and create_map grant). */
  grant(root) { this.grants.add(path.resolve(root)); }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.route(req, res).catch(e => {
        this.o.log?.(`request failed: ${e.stack || e}`);
        if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
      }));
      this.server.on('error', reject);
      this.server.listen(this.o.port, this.o.host, () => {
        this.server.off('error', reject);
        this.prune = setInterval(() => this.pruneAgents(), 10000);
        this.prune.unref();
        resolve();
      });
    });
  }

  close() {
    clearInterval(this.prune);
    for (const c of this.calls.values()) { clearTimeout(c.timer); c.reject(new Error('The MCP server stopped')); }
    this.calls.clear();
    try { this.app?.res.end(); } catch { /* gone */ }
    this.server?.close();
    this.server?.closeAllConnections?.();
  }

  // ------------------------------------------------------------------------------------------------ HTTP

  originAllowed(origin) {
    if (!origin) return true; // not a browser
    return (this.o.allowOrigins || DEFAULT_ORIGINS).some(p => {
      if (p === '*') return true;
      if (p.endsWith(':*')) { // any port
        const base = p.slice(0, -2);
        return origin === base || (origin.startsWith(base + ':') && /^\d+$/.test(origin.slice(base.length + 1)));
      }
      return origin === p;
    });
  }

  hostAllowed(host) {
    if (!host) return false;
    const h = host.replace(/:\d+$/, '').toLowerCase();
    return ['127.0.0.1', 'localhost', '[::1]', String(this.o.host || '').toLowerCase()].includes(h);
  }

  cors(req, res) {
    const origin = req.headers.origin;
    if (origin && this.originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  }

  async route(req, res) {
    const url = new URL(req.url, 'http://x'), origin = req.headers.origin;
    if (!this.hostAllowed(req.headers.host)) return send(res, 403, { error: 'Forbidden host' });
    if (origin && !this.originAllowed(origin)) {
      this.o.log?.(`refused a request from the origin ${origin} (add it with --allow-origin)`);
      return send(res, 403, { error: `Origin not allowed: ${origin}. Start the server with --allow-origin ${origin}` });
    }
    this.cors(req, res);
    if (req.method === 'OPTIONS') { // CORS preflight from the app (and Private Network Access)
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, x-gwp-session',
        'Access-Control-Expose-Headers': 'x-gwp-mtime, x-gwp-size',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
    const path = url.pathname;
    if (path === '/status' && req.method === 'GET') return send(res, 200, this.status());
    if (path === '/app/events' && req.method === 'GET') return this.appEvents(req, res, url);
    if (path === '/app/result' && req.method === 'POST') return this.appResult(req, res);
    if (path === '/app/state' && req.method === 'POST') return this.appState(req, res);
    if (path.startsWith('/relay/')) {
      if (origin || req.headers['x-gwp-relay'] !== '1') return send(res, 403, { error: 'Relay only' });
      if (path === '/relay/hello' && req.method === 'POST') return this.relayHello(req, res);
      if (path === '/relay/call' && req.method === 'POST') return this.relayCall(req, res);
    }
    if (path === '/mcp') return this.mcpHttp(req, res);
    if (path.startsWith('/fs/')) return this.fs(req, res, url);
    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`GameWorld Painter MCP server ${this.o.version}\nMCP endpoint: http://127.0.0.1:${this.o.port}/mcp\nApp: ${this.app ? 'connected' : 'not connected'}\n`);
    }
    send(res, 404, { error: 'Not found' });
  }

  // ------------------------------------------------------------------------------------------------ the app

  appEvents(req, res, url) {
    const session = url.searchParams.get('session') || randomUUID();
    if (this.app) { // one app at a time: the newest tab wins
      sse(this.app.res, 'replaced', { reason: 'Another tab connected to the MCP server' });
      this.dropApp('replaced by another tab');
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    req.socket.setKeepAlive(true);
    req.socket.setTimeout(0);
    const app = {
      session, res, origin: req.headers.origin || '', since: new Date().toISOString(),
      title: url.searchParams.get('title') || '', api: +url.searchParams.get('api') || 0, version: url.searchParams.get('version') || '',
    };
    this.app = app;
    const page = url.searchParams.get('page');
    try { if (page && /^https?:\/\//.test(page) && this.originAllowed(new URL(page).origin)) this.appUrl = page; } catch { /* not a URL */ }
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => { clearInterval(beat); if (this.app === app) this.dropApp('the page closed'); });
    this.o.log?.(`app connected (${app.origin || 'no origin'}${app.title ? ', ' + app.title : ''})`);
    sse(res, 'hello', this.status());
    for (const w of this.appWaiters.splice(0)) w();
  }

  dropApp(why) {
    const app = this.app;
    if (!app) return;
    this.app = null;
    try { app.res.end(); } catch { /* gone */ }
    for (const [id, c] of this.calls) {
      if (c.session !== app.session) continue;
      clearTimeout(c.timer);
      this.calls.delete(id);
      c.reject(Object.assign(new Error(`GameWorld Painter disconnected during the call (${why}). If the user turned AI Agent off, ask them to turn it on; then try again.`), { fromApp: true }));
    }
    this.o.log?.(`app disconnected (${why})`);
  }

  async appResult(req, res) {
    const body = await readJson(req);
    const c = this.calls.get(body?.id);
    if (!c || !this.app || body.session !== c.session) return send(res, 404, { error: 'Unknown call' });
    this.calls.delete(body.id);
    clearTimeout(c.timer);
    if (body.ok) c.resolve(body.result || {});
    else c.reject(Object.assign(new Error(body.error?.message || 'The app could not do it'), { fromApp: true }));
    send(res, 200, { ok: true });
  }

  async appState(req, res) {
    const body = await readJson(req);
    if (!this.app || body?.session !== this.app.session) return send(res, 404, { error: 'Not the connected app' });
    Object.assign(this.app, { title: String(body.title || ''), api: +body.api || this.app.api, version: String(body.version || this.app.version) });
    send(res, 200, this.status());
  }

  /** Waits a little for the app (it may be reloading), then runs the tool there. */
  async callApp(tool, args, client, signal, waitMs) {
    if (!this.app) {
      await new Promise(resolve => {
        const w = () => { clearTimeout(t); resolve(); };
        const t = setTimeout(() => { this.appWaiters = this.appWaiters.filter(x => x !== w); resolve(); }, waitMs ?? this.o.waitAppMs ?? 4000);
        this.appWaiters.push(w);
      });
    }
    const app = this.app;
    if (!app) {
      throw new AppNotConnected('GameWorld Painter is not connected to this MCP server. Ask the user to open the app '
        + `(https://aleserb.github.io/game-world-painter/ or a local copy), open their map, and turn on AI Agent in the header `
        + `(server http://127.0.0.1:${this.o.port}). Then try again.`);
    }
    const id = randomUUID();
    this.total++;
    return new Promise((resolve, reject) => {
      const ms = (this.o.slowTools?.has(tool) ? 10 : 1) * (this.o.timeoutMs || 120000);
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`GameWorld Painter did not answer within ${Math.round(ms / 1000)} s (${tool}). The page may be busy or waiting for the user.`));
      }, ms);
      this.calls.set(id, { resolve, reject, timer, tool, session: app.session });
      signal?.addEventListener('abort', () => {
        if (!this.calls.has(id)) return;
        this.calls.delete(id);
        clearTimeout(timer);
        sse(app.res, 'cancel', { id });
        reject(new Error('Cancelled'));
      }, { once: true });
      sse(app.res, 'call', { id, tool, args, client: client ? { name: client.name, version: client.version } : null });
    });
  }

  // ------------------------------------------------------------------------------------------------ agents

  touchAgent(info, transport = 'stdio', key) {
    if (!info) return;
    const k = key || `${transport}:${info.name}`;
    const a = this.agents.get(k), name = info.title || info.name || 'agent', version = info.version || '';
    if (a) {
      a.seen = Date.now();
      if (a.name !== name || a.version !== version) { Object.assign(a, { name, version }); this.pushStatus(); }
      return;
    }
    this.agents.set(k, { name, version, transport, since: new Date().toISOString(), seen: Date.now() });
    this.o.log?.(`agent: ${info.name} (${transport})`);
    this.pushStatus();
  }

  pruneAgents() {
    const now = Date.now();
    let changed = false;
    // Streamable HTTP sessions the client left without DELETE: a client that comes back gets 404 and initializes again
    const idle = this.o.sessionIdleMs ?? 3600000;
    for (const [sid, s] of this.httpSessions) if (now - s.used > idle) this.httpSessions.delete(sid);
    for (const [k, a] of this.agents) {
      const ttl = a.transport === 'relay' ? 35000 : a.transport === 'http' ? 600000 : Infinity;
      if (now - a.seen > ttl) { this.agents.delete(k); changed = true; }
    }
    if (changed) this.pushStatus();
  }

  dropAgent(key) { if (this.agents.delete(key)) this.pushStatus(); }

  pushStatus() { if (this.app) sse(this.app.res, 'status', this.status()); }

  status() {
    return {
      name: 'game-world-painter-mcp', version: this.o.version, api: this.o.api, port: this.o.port,
      app: this.app ? { connected: true, origin: this.app.origin, title: this.app.title, since: this.app.since } : { connected: false },
      app_url: this.appUrl,
      agents: [...this.agents.values()].map(({ seen, ...a }) => a),
      calls: { active: this.calls.size, total: this.total },
      command: this.o.command,
    };
  }

  async relayHello(req, res) {
    const b = await readJson(req);
    if (b?.bye) this.dropAgent(`relay:${b.id}`);
    else if (b?.client) this.touchAgent(b.client, 'relay', `relay:${b.id}`);
    send(res, 200, this.status());
  }

  async relayCall(req, res) {
    const b = await readJson(req);
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    if (b?.client) this.touchAgent(b.client, 'relay', `relay:${b.agent}`);
    try {
      if (b.grant) this.grant(b.grant);
      const result = await this.callApp(b.tool, b.args || {}, b.client, ac.signal, b.waitMs);
      send(res, 200, { ok: true, result });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message, notConnected: e instanceof AppNotConnected });
    }
  }

  // ------------------------------------------------------------------------------------------------ map files for the app

  /** The files of a granted map folder, for the connected app: stat, read, write (atomic), remove. */
  async fs(req, res, url) {
    if (!this.app || req.headers['x-gwp-session'] !== this.app.session) return send(res, 403, { error: 'Only the app connected to this server' });
    const root = path.resolve(url.searchParams.get('root') || '');
    if (!this.grants.has(root)) return send(res, 403, { error: 'This folder was not opened by the agent (open_map, create_map)' });
    const rel = url.searchParams.get('path') || '';
    const file = path.resolve(root, rel);
    if (!rel || path.isAbsolute(rel) || !file.startsWith(root + path.sep)) return send(res, 400, { error: 'Bad path' });
    try { // no way out of the folder through a link
      const realRoot = await fsp.realpath(root), realDir = await fsp.realpath(path.dirname(file)).catch(() => null);
      if (realDir && realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) return send(res, 400, { error: 'Bad path' });
    } catch { return send(res, 404, { error: 'The folder is gone' }); }
    const op = url.pathname.slice(4), stamp = st => ({ size: st.size, mtime: Math.floor(st.mtimeMs) });
    try {
      if (op === 'stat' && req.method === 'GET') {
        const st = await fsp.stat(file);
        if (!st.isFile()) return send(res, 404, { error: 'Not a file' });
        return send(res, 200, stamp(st));
      }
      if (op === 'read' && req.method === 'GET') {
        const fh = await fsp.open(file, 'r');
        try {
          const st = await fh.stat();
          if (!st.isFile()) return send(res, 404, { error: 'Not a file' });
          const data = await fh.readFile();
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-GWP-Mtime': String(Math.floor(st.mtimeMs)), 'X-GWP-Size': String(data.length) });
          return res.end(data);
        } finally { await fh.close(); }
      }
      if (op === 'write' && req.method === 'PUT') {
        const data = await readBody(req);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.gwp-${randomUUID().slice(0, 8)}.tmp`;
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, file); // atomic: other programs see the old file or the new one
        return send(res, 200, stamp(await fsp.stat(file)));
      }
      if (op === 'remove' && req.method === 'DELETE') {
        await fsp.rm(file, { force: true });
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'Not allowed' });
    } catch (e) {
      if (e.code === 'ENOENT') return send(res, 404, { error: 'Not found' });
      this.o.log?.(`file ${op} ${file}: ${e.message}`);
      return send(res, 500, { error: e.message });
    }
  }

  // ------------------------------------------------------------------------------------------------ Streamable HTTP MCP

  endpoint(onClient) { return new McpEndpoint({ ...this.o.mcp, onClient }); }

  async mcpHttp(req, res) {
    if (req.method === 'GET' || req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'];
      if (req.method === 'DELETE' && sid && this.httpSessions.delete(sid)) { this.dropAgent(`http:${sid}`); res.writeHead(200); return res.end(); }
      res.writeHead(405, { Allow: 'POST' });
      return res.end();
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    let msg;
    try { msg = await readJson(req); } catch { return send(res, 400, rpcError(null, ERR.PARSE, 'Parse error')); }
    const one = Array.isArray(msg) ? null : msg;
    const metaVersion = one?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
    const headerVersion = req.headers['mcp-protocol-version'];
    let ep;
    if (metaVersion != null) { // modern: stateless, with the request metadata headers checked against the body
      if (headerVersion && headerVersion !== metaVersion) return send(res, 400, rpcError(one.id ?? null, ERR.HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version ${headerVersion} vs ${metaVersion}`));
      const hm = req.headers['mcp-method'];
      if (hm && hm !== one.method) return send(res, 400, rpcError(one.id ?? null, ERR.HEADER_MISMATCH, `Header mismatch: Mcp-Method ${hm} vs ${one.method}`));
      const hn = req.headers['mcp-name'], name = one.params?.name ?? one.params?.uri;
      if (hn && name != null && decodeHeader(hn) !== String(name)) return send(res, 400, rpcError(one.id ?? null, ERR.HEADER_MISMATCH, `Header mismatch: Mcp-Name ${hn} vs ${name}`));
      if (!MODERN_VERSIONS.includes(metaVersion)) {
        return send(res, 400, rpcError(one.id ?? null, ERR.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: metaVersion }));
      }
      ep = this.endpoint(info => this.touchAgent(info, 'http'));
    } else if (one?.method === 'initialize') {
      const sid = randomUUID();
      ep = this.endpoint(info => this.touchAgent(info, 'http', `http:${sid}`));
      const max = this.o.maxSessions ?? 200;
      while (this.httpSessions.size >= max) { // the least recently used goes (a Map keeps the order of use, see below)
        const [old] = this.httpSessions.keys();
        this.httpSessions.delete(old);
        this.dropAgent(`http:${old}`);
      }
      this.httpSessions.set(sid, { ep, used: Date.now() });
      res.setHeader('Mcp-Session-Id', sid);
    } else {
      const sid = req.headers['mcp-session-id'], s = sid ? this.httpSessions.get(sid) : null;
      if (sid && !s) return send(res, 404, rpcError(one?.id ?? null, -32001, 'Session not found: initialize again'));
      if (s) { s.used = Date.now(); this.httpSessions.delete(sid); this.httpSessions.set(sid, s); } // the most recently used last
      ep = s?.ep;
      if (!ep) { // no session (a client that does not keep one): serve statelessly
        this.stateless ||= this.endpoint(info => this.touchAgent(info, 'http'));
        ep = this.stateless;
      }
    }
    if (ep.clientInfo) this.touchAgent(ep.clientInfo, 'http');
    const out = await ep.handle(msg);
    if (!out) { res.writeHead(202); return res.end(); }
    const status = !Array.isArray(out) && out.error && [ERR.METHOD_NOT_FOUND].includes(out.error.code) && metaVersion ? 404
      : !Array.isArray(out) && out.error && out.error.code === ERR.UNSUPPORTED_VERSION ? 400 : 200;
    send(res, status, out);
  }
}

function decodeHeader(v) {
  const m = /^=\?base64\?(.*)\?=$/i.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

function sse(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
}

function send(res, status, body) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('Too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new RpcError(ERR.INVALID_REQUEST, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
