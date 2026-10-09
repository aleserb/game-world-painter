// The AI agent connection: the app connects to the local MCP server (mcp/server.mjs) with Server-Sent Events, runs
// the tool calls it forwards (js/agent-*.js) one at a time and posts the results back. The header shows a LED and an
// on / off switch; the dialog (js/agent-ui.js) shows how to connect agents. Settings are kept in this browser.
(function (ME) {
'use strict';

const API = 1;
const VERSION = '0.2.0';
const KEY = 'gwp-agent';
const WRITE = new Set(['add_items', 'update_items', 'delete_items', 'scatter_items', 'paint_layer', 'edit_terrain', 'create_layer', 'update_layer', 'undo']);
const DEFAULTS = { enabled: false, url: 'http://127.0.0.1:38765', canWrite: true, confirmDeletes: true, highlight: true, review: false };

const settings = (() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; } })();
const saveSettings = () => localStorage.setItem(KEY, JSON.stringify(settings));

// state: off | connecting | offline | ready (server, no agent) | agent (an agent is connected) | replaced (another tab)
const agent = ME.agent = {
  API, VERSION, settings, saveSettings, WRITE,
  state: 'off', server: null, error: '', busy: 0, log: [], listeners: new Set(),
  session: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2),
  onChange(fn) { this.listeners.add(fn); },
  changed() { for (const fn of this.listeners) fn(); },
};

let es = null, retry = null, queue = Promise.resolve(), generation = 0, delay = 2000; // delay: grows while no server answers
const cancelled = new Set();
const base = () => settings.url.replace(/\/+$/, '');

function setState(s, error = '') {
  agent.state = s;
  agent.error = error;
  agent.changed();
}

/** Why the server cannot be reached: Chrome's permission for this site to reach this device, a refused origin... */
async function offlineReason(err, status) {
  if (status === 403) return `The MCP server refused this page (${location.origin}): start it with --allow-origin ${location.origin}`;
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    for (const name of ['loopback-network', 'local-network-access']) {
      try {
        const p = await navigator.permissions.query({ name });
        if (p.state === 'denied') return 'Chrome does not let this site reach apps on this device. Allow it: the icon left of the address → Site settings → "Apps on this device" (local network access) → Allow';
        if (p.state === 'prompt') return 'Chrome asks to let this site reach apps on this device: allow it (or no MCP server is running)';
        break;
      } catch { /* not this name */ }
    }
  }
  return `No MCP server at ${base()}`;
}

async function connect() {
  disconnect(true);
  if (!settings.enabled) { setState('off'); return; }
  const gen = ++generation;
  if (agent.state !== 'offline') setState('connecting');
  let url;
  try { url = new URL(`${base()}/app/events`); } catch { setState('offline', 'The server URL is not valid'); return; }
  // a plain request first: it brings up Chrome's permission prompt for reaching this device, and tells why it fails
  let status = 0;
  try {
    const r = await fetch(`${base()}/status`, { cache: 'no-store', targetAddressSpace: 'loopback' });
    status = r.status;
    if (!r.ok || (await r.json()).name !== 'game-world-painter-mcp') throw new Error(`status ${r.status}`);
  } catch (e) {
    if (gen !== generation || !settings.enabled) return;
    setState('offline', await offlineReason(e, status));
    retry = setTimeout(connect, delay);
    delay = Math.min(delay * 1.5, 6000); // the server waits a few seconds for the app on a call
    return;
  }
  delay = 2000;
  if (gen !== generation || !settings.enabled) return;
  const title = ME.app?.S.project?.title || '';
  url.search = new URLSearchParams({ session: agent.session, api: API, version: VERSION, title }).toString();
  es = new EventSource(url);
  es.addEventListener('hello', e => { agent.server = JSON.parse(e.data); setState(agent.server.agents.length ? 'agent' : 'ready'); });
  es.addEventListener('status', e => { agent.server = JSON.parse(e.data); if (agent.state !== 'replaced') setState(agent.server.agents.length ? 'agent' : 'ready'); });
  es.addEventListener('call', e => { const call = JSON.parse(e.data); queue = queue.then(() => run(call)); });
  es.addEventListener('cancel', e => cancelled.add(JSON.parse(e.data).id));
  es.addEventListener('replaced', () => { disconnect(true); setState('replaced', 'Another tab or window connected to the MCP server'); });
  es.onerror = () => {
    if (!es) return;
    if (es.readyState === EventSource.CLOSED) { // the browser gave up: try again (and find out why) later
      es.close(); es = null;
      retry = setTimeout(connect, 3000);
    }
    agent.server = null;
    setState('offline', `The MCP server at ${base()} went away (it stops with its agent; another agent or a restart brings it back)`);
  };
}

function disconnect(quiet) {
  clearTimeout(retry);
  if (!quiet) generation++;
  if (es) { es.close(); es = null; }
  agent.server = null;
  if (!quiet) setState('off');
}

agent.setEnabled = on => { settings.enabled = !!on; saveSettings(); if (on) connect(); else disconnect(); };
agent.reconnect = () => { delay = 2000; if (settings.enabled) connect(); };
agent.setUrl = url => { settings.url = url.trim() || DEFAULTS.url; saveSettings(); agent.reconnect(); };

// The full path of the project folder on disk is known only when the MCP server found it (get_project_path) or the
// user typed it (Settings): kept per project in this browser.
const pathKey = () => { const { S, folder } = ME.app; return folder && S.project ? `gwp-folder-path|${folder.name}|${S.project.created || S.project.title}` : null; };
agent.setProjectPath = p => {
  const k = pathKey();
  if (!k) return;
  p = (p || '').trim();
  if (p) localStorage.setItem(k, p); else localStorage.removeItem(k);
  ME.app.S.projectPath = p || null;
  ME.app.renderSaveState();
  agent.changed();
};

/** The map title for the status in the server (the agent's view of what is open). */
ME.onProjectOpen = () => {
  ME.agentReview?.drop('the map was opened again');
  const k = pathKey();
  ME.app.S.projectPath = (k && localStorage.getItem(k)) || null;
  ME.app.renderSaveState();
  if (!es || !agent.server) return;
  fetch(`${base()}/app/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: agent.session, title: ME.app.S.project?.title || '', api: API, version: VERSION }) }).catch(() => {});
};

// ------------------------------------------------------------------------------------------------ calls

async function run(call) {
  const entry = { id: call.id, time: new Date(), tool: call.tool, client: call.client?.name || 'agent', args: summarize(call.args), status: 'running' };
  agent.log.unshift(entry);
  if (agent.log.length > 200) agent.log.length = 200;
  agent.busy++;
  agent.changed();
  const t0 = performance.now();
  let body, later = null;
  try {
    const fn = ME.agentTools[call.tool], { ToolError } = ME.agentInternals, args = call.args || {};
    if (!fn) throw new ToolError(`This version of GameWorld Painter has no tool "${call.tool}". Ask the user to reload the page (the app may be older than the MCP server).`);
    const writes = WRITE.has(call.tool) || (call.tool === 'find_route' && !!args.add_to);
    if (writes && !settings.canWrite) throw new ToolError('The user lets the agent only read the map (AI Agent → Settings in the app). Ask them to allow changes.');
    const review = settings.review && settings.canWrite;
    const ctx = { canWrite: settings.canWrite, confirmDeletes: settings.confirmDeletes && !review, review, client: call.client, clientName: call.client?.name };
    let result;
    if (review && call.tool === 'undo') result = ME.agentReview.withdraw();
    else if (review && writes) ({ result, later } = await ME.agentReview.run(call, () => fn(args, ctx)));
    else result = await fn(args, ctx);
    if (result?.deferred) { later = result.deferred; result = null; } // waits for the user's decision
    body = { ok: true, result };
    entry.status = later ? 'review' : 'ok';
    entry.result = later ? 'waiting for the user\'s review…' : result.images ? 'an image' : summarize(result.data ?? result.text);
  } catch (e) {
    const message = e instanceof ME.agentInternals.ToolError ? e.message : `Error in GameWorld Painter: ${e.message}`;
    if (!(e instanceof ME.agentInternals.ToolError)) console.error(e);
    body = { ok: false, error: { message } };
    entry.status = 'error';
    entry.result = message;
  }
  entry.ms = Math.round(performance.now() - t0);
  agent.busy--;
  agent.changed();
  if (later) { // the next calls run meanwhile; the answer goes when the user has decided (or the wait is over)
    later.then(result => {
      const p = result?.data?.proposal;
      entry.status = p?.status === 'accepted' ? 'ok' : p?.status === 'pending' ? 'review' : p ? 'rejected' : 'ok';
      entry.result = summarize(p ? `${p.status}${p.feedback ? ': ' + p.feedback : ''}` : result.data);
      agent.changed();
      post(call, entry, { ok: true, result });
    });
    return;
  }
  await post(call, entry, body);
}

async function post(call, entry, body) {
  if (cancelled.delete(call.id)) { entry.status = 'cancelled'; agent.changed(); return; }
  try {
    await fetch(`${base()}/app/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: agent.session, id: call.id, ...body }) });
  } catch (e) {
    entry.status = 'error';
    entry.result = `Could not send the result to the MCP server: ${e.message}`;
    agent.changed();
  }
}

function summarize(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

// ------------------------------------------------------------------------------------------------ highlights on the map

const flashes = [];
let flashTimer = null;
ME.agentFeedback = {
  /** Outlines a box [x0, z0, x1, z1], a cell mask or a point for a moment; msg: a toast. */
  flash(what, msg, ms = 2600) {
    const P = ME.agentReview?.collecting;
    if (P && what) { // the places of a proposal stay outlined until the user decides
      const m = { ...what };
      if (what.mask) {
        const g = ME.agentInternals.G(), b = ME.agentInternals.bounds(g, what.mask);
        if (b.count) m.path = ME.maskOutline(what.mask, g.N, [b.x0, b.y0, b.x1, b.y1], g.R);
      }
      P.marks.push(m);
      return;
    }
    if (msg) ME.app.toast(`AI: ${msg}`, Math.min(ms + 400, 6000));
    if (!settings.highlight || !what) return;
    const f = { ...what, until: performance.now() + ms, ms };
    if (what.mask) {
      const g = ME.agentInternals.G(), b = ME.agentInternals.bounds(g, what.mask);
      if (!b.count) return;
      f.path = ME.maskOutline(what.mask, g.N, [b.x0, b.y0, b.x1, b.y1], g.R);
    }
    flashes.push(f);
    tick();
  },
};

function tick() {
  clearTimeout(flashTimer);
  const now = performance.now();
  for (let k = flashes.length - 1; k >= 0; k--) if (flashes[k].until < now) flashes.splice(k, 1);
  ME.app.requestRender();
  if (flashes.length) flashTimer = setTimeout(tick, 80);
}

ME.drawAgentOverlay = (ctx, view) => {
  ME.agentReview?.drawMarks(ctx, view);
  const now = performance.now();
  for (const f of flashes) {
    const a = Math.max(0, Math.min(1, (f.until - now) / 600)), pulse = 0.82 + 0.18 * Math.sin(now / 160); // fades out at the end
    ctx.save();
    ctx.globalAlpha = a;
    if (f.path) {
      const c = view.cellPx();
      view.setCellTransform(ctx);
      ctx.lineWidth = 6 / c; ctx.strokeStyle = 'rgba(16,13,20,0.7)'; ctx.stroke(f.path);
      ctx.lineWidth = 3.5 / c; ctx.strokeStyle = `rgba(205,165,255,${pulse})`; ctx.stroke(f.path);
    } else if (f.box) {
      view.setScreenTransform(ctx);
      const [x0, y0] = view.toScreen(f.box[0], f.box[1]), [x1, y1] = view.toScreen(f.box[2], f.box[3]);
      const pad = f.point ? 14 : 6;
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(16,13,20,0.8)';
      const draw = () => (f.point ? (ctx.beginPath(), ctx.arc(x0, y0, pad, 0, Math.PI * 2)) : (ctx.beginPath(), ctx.roundRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad, 6)));
      draw(); ctx.stroke();
      ctx.fillStyle = 'rgba(190,140,255,0.1)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = `rgba(205,165,255,${pulse})`; draw(); ctx.stroke();
    }
    ctx.restore();
  }
};

// ------------------------------------------------------------------------------------------------ the skill as a zip

const SKILL_FILES = ['SKILL.md', 'references/regions.md', 'references/recipes.md'];

/** game-world-painter-skill.zip: the agent skill folder (skills/game-world-painter in the repository). */
agent.downloadSkill = async () => {
  const files = [];
  for (const f of SKILL_FILES) {
    const res = await fetch(`skills/game-world-painter/${f}`);
    if (!res.ok) throw new Error(`skills/game-world-painter/${f}: ${res.status}`);
    files.push({ name: `game-world-painter/${f}`, data: new Uint8Array(await res.arrayBuffer()) });
  }
  const blob = new Blob([zip(files)], { type: 'application/zip' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'game-world-painter-skill.zip' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

let crcTable = null;
function crc32(b) {
  if (!crcTable) crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** A zip of stored (not compressed) files. */
function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, f.data.length, 4], [22, f.data.length, 4], [26, name.length, 2], [28, 0, 2]]
      .forEach(([o, v, n]) => (n === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true)));
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, f.data.length, 4], [24, f.data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
      .forEach(([o, v, n]) => (n === 4 ? c.setUint32(o, v, true) : c.setUint16(o, v, true)));
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((s, p) => s + p.length, 0), end = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, offset, 4], [20, 0, 2]]
    .forEach(([o, v, n]) => (n === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
}

// start: the header switch and LED are set up by js/agent-ui.js
setTimeout(() => { if (settings.enabled) connect(); else setState('off'); }, 0);
})(window.ME);
