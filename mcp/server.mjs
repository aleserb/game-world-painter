#!/usr/bin/env node
// GameWorld Painter MCP server: lets AI agents (Claude Code, Codex, GitHub Copilot, VS Code, Cursor, Gemini CLI...)
// read and edit the map open in GameWorld Painter. See README.md. No dependencies: Node.js 18 or newer.
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { McpEndpoint, toolResult, toolError, error as rpcError, ERR } from './lib/protocol.mjs';
import { locateProject } from './lib/locate.mjs';
import { TOOLS, INSTRUCTIONS, API_VERSION, SLOW_TOOLS } from './lib/tools.mjs';
import { Hub, AppNotConnected, DEFAULT_PORT, DEFAULT_ORIGINS } from './lib/hub.mjs';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const pkg = JSON.parse(readFileSync(here('./package.json'), 'utf8'));
const SCRIPT = fileURLToPath(import.meta.url);

const HELP = `GameWorld Painter MCP server ${pkg.version}

Agents start it themselves (stdio): add it to your agent once, then turn on AI Agent in the app.
  node ${SCRIPT}                 run for an agent (stdio), or alone in a terminal (HTTP)
  node ${SCRIPT} setup           print the commands to add it to Claude Code, Codex, Copilot, VS Code...

Options:
  --port <n>            the port the app and other agents meet at (default ${DEFAULT_PORT}, env GWP_MCP_PORT)
  --http                run alone: Streamable HTTP MCP at http://127.0.0.1:<port>/mcp (default in a terminal)
  --stdio               MCP over stdin/stdout (default when started by an agent)
  --allow-origin <o>    also let this web origin connect as the app (repeat; "null" for a page opened from disk)
  --timeout <s>         how long a tool call may take in the app (default 120)
  --quiet               no log on stderr
  -v, --version         -h, --help`;

function parseArgs(argv) {
  const o = { port: +process.env.GWP_MCP_PORT || DEFAULT_PORT, host: '127.0.0.1', origins: [], timeout: 120, mode: null, quiet: false, command: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    if (a === '--port') o.port = +next();
    else if (a === '--host') o.host = next();
    else if (a === '--allow-origin') o.origins.push(next());
    else if (a === '--timeout') o.timeout = +next();
    else if (a === '--http') o.mode = 'http';
    else if (a === '--stdio') o.mode = 'stdio';
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-v' || a === '--version') { console.log(pkg.version); process.exit(0); }
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === 'setup' && !o.command) o.command = 'setup';
    else fail(`Unknown option: ${a}\n\n${HELP}`);
  }
  if (!(o.port > 0 && o.port < 65536)) fail('--port must be a port number');
  if (!['127.0.0.1', 'localhost', '::1'].includes(o.host)) process.stderr.write(`[gwp-mcp] warning: listening on ${o.host}, not only this computer\n`);
  return o;
}

function fail(msg) { process.stderr.write(msg + '\n'); process.exit(2); }

const opts = parseArgs(process.argv.slice(2));
const log = (...a) => { if (!opts.quiet) process.stderr.write(`[gwp-mcp] ${a.join(' ')}\n`); };

if (opts.command === 'setup') { printSetup(); process.exit(0); }

// ------------------------------------------------------------------------------------------------ resources

const SKILL = [here('../skills/game-world-painter/SKILL.md'), here('./skill/SKILL.md')].find(existsSync);
const FORMAT = [here('../docs/project-format.md'), here('./docs/project-format.md')].find(existsSync);
const resources = [
  SKILL && { uri: 'gwp://skill', name: 'game-world-painter-skill', title: 'How to work with GameWorld Painter', mimeType: 'text/markdown', read: () => readFile(SKILL, 'utf8') },
  FORMAT && { uri: 'gwp://project-format', name: 'project-format', title: 'The project folder format', mimeType: 'text/markdown', read: () => readFile(FORMAT, 'utf8') },
].filter(Boolean);

const mcpOptions = { serverInfo: { name: 'game-world-painter', title: 'GameWorld Painter', version: pkg.version }, instructions: INSTRUCTIONS, tools: TOOLS, resources };

// ------------------------------------------------------------------------------------------------ hub or relay

const hubOptions = {
  port: opts.port, host: opts.host, version: pkg.version, api: API_VERSION, log, slowTools: SLOW_TOOLS,
  allowOrigins: [...DEFAULT_ORIGINS, ...opts.origins], timeoutMs: opts.timeout * 1000,
  waitAppMs: process.env.GWP_MCP_WAIT_APP_MS != null ? +process.env.GWP_MCP_WAIT_APP_MS : 4000, // a reloading page reconnects
  command: { node: process.execPath, script: SCRIPT },
  mcp: { ...mcpOptions, callTool: (name, args, ctx) => callTool(name, args, ctx) },
};

let role = 'none'; // hub: owns the port; relay: forwards to the hub of another process
let hub = null;
const agentId = randomUUID();
let localClient = null;
let helloTimer = null;

/** Owns the port, or relays to the process that does; with takeover when that one exits. One attempt at a time
 *  (a tool call and the hello timer may both try to take over). */
let starting = null;
function startRole() {
  if (role === 'hub') return Promise.resolve(true);
  return (starting ||= startRoleOnce().finally(() => { starting = null; }));
}

async function startRoleOnce() {
  const h = new Hub(hubOptions);
  try {
    await h.listen();
    hub = h;
    role = 'hub';
    clearInterval(helloTimer);
    if (localClient) hub.touchAgent(localClient, 'stdio', 'local');
    log(`listening on http://127.0.0.1:${opts.port} (the app connects here${opts.mode === 'http' ? `; MCP endpoint /mcp` : ''})`);
    return true;
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    const st = await getJson('/status').catch(() => null);
    if (st?.name === 'game-world-painter-mcp') {
      role = 'relay';
      log(`another server already runs on port ${opts.port}: relaying through it`);
      startHello();
      return false;
    }
    role = 'none';
    log(`port ${opts.port} is used by another program: start with --port <n> and set the same port in the app`);
    return false;
  }
}

function startHello() {
  clearInterval(helloTimer);
  const hello = () => postJson('/relay/hello', localClient ? { id: agentId, client: localClient } : { id: agentId }).catch(async () => {
    if (role === 'relay') await startRole().catch(e => log(`takeover failed: ${e.message}`)); // the hub went away
  });
  hello();
  helloTimer = setInterval(hello, 10000);
  helloTimer.unref();
}

/** Runs a tool in the app (through the hub here, or the one of another process); returns its raw result or throws. */
async function appCall(name, args, ctx) {
  if (role === 'none') await startRole();
  if (role === 'hub') return hub.callApp(name, args, ctx.client || localClient, ctx.signal);
  if (role === 'relay') {
    let r;
    try {
      r = await postJson('/relay/call', { tool: name, args, client: ctx.client || localClient, agent: agentId }, ctx.signal);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      await startRole(); // the hub is gone: take over and run it here
      if (role !== 'hub') throw e;
      return hub.callApp(name, args, ctx.client || localClient, ctx.signal);
    }
    if (!r.ok) throw Object.assign(new Error(r.error), { plain: true });
    return r.result;
  }
  throw Object.assign(new Error(`The port ${opts.port} is used by another program, so GameWorld Painter cannot connect. Start the MCP server with --port <another port> and set that port in the app (AI Agent → Settings).`), { plain: true });
}

async function callTool(name, args, ctx) {
  try {
    if (name === 'get_project_path') return toolResult(await projectPath(args, ctx));
    return toolResult(await appCall(name, args, ctx));
  } catch (e) {
    return toolError(e instanceof AppNotConnected || e.fromApp || e.plain ? e.message : `Error: ${e.message}`);
  }
}

/** get_project_path: the app describes its folder, this process finds it on the disk, the app remembers the path. */
async function projectPath(args, ctx) {
  const info = (await appCall('_project_folder', {}, ctx)).data;
  const roots = ctx.roots ? await ctx.roots().catch(() => []) : [];
  const extraDirs = (process.env.GWP_PROJECT_DIRS || '').split(path.delimiter).filter(Boolean);
  const r = await locateProject(info, {
    explicit: args.path, hints: info.hints, roots, cwd: process.cwd(), extraDirs,
    searchHome: process.env.GWP_SEARCH_HOME !== '0',
  });
  if (!r.path) {
    log(`project folder "${info.name}" not found (${r.why})`);
    return {
      data: {
        path: null, folder_name: info.name, why: r.why, ...(r.searched ? { searched: r.searched } : {}),
        ask_user: `Ask the user for the full path of the folder "${info.name}" (the one with metadata.json) and call get_project_path with {"path": "..."}. They can also paste it in the app: AI Agent → Settings.`,
      },
    };
  }
  if (!info.hints?.includes(r.path)) await appCall('_set_project_path', { path: r.path }, ctx).catch(() => {});
  log(`project folder: ${r.path} (${r.found_by})`);
  const abs = f => path.join(r.path, ...f.split('/'));
  return {
    data: {
      path: r.path, found_by: r.found_by, ...(r.others ? { other_copies: r.others } : {}),
      title: info.title, metadata: abs('metadata.json'), edit_lock: abs('edit.lock'),
      layer_files: info.layers.map(l => ({ id: l.id, type: l.type, file: abs(l.file) })),
      unsaved_in_app: info.unsaved, autosave: info.autosave, ...(info.edit_lock ? { edit_lock_present: true } : {}),
      editing_files: 'The app watches the folder. To change files directly: create edit.lock (the app stops writing), write each file whole (name.tmp, then rename), delete edit.lock; the app loads the changes within a second and merges them with its unsaved edits. File formats: the resource gwp://project-format.',
    },
  };
}

function request(method, path, body, signal) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: opts.port, path, method, signal,
      headers: { 'Content-Type': 'application/json', 'X-GWP-Relay': '1', Host: `127.0.0.1:${opts.port}`, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const getJson = path => request('GET', path);
const postJson = (path, body, signal) => request('POST', path, body, signal);

// ------------------------------------------------------------------------------------------------ run

const mode = opts.mode || (process.stdin.isTTY ? 'http' : 'stdio');

if (mode === 'http') {
  const ok = await startRole();
  if (!ok) {
    log(role === 'relay' ? 'a server is already running on this port (an agent started it): nothing to do' : 'could not start');
    process.exit(role === 'relay' ? 0 : 1);
  }
  log(`MCP endpoint for clients configured by URL: http://127.0.0.1:${opts.port}/mcp. Press Ctrl+C to stop.`);
  const stop = () => { hub.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  const out = msg => process.stdout.write(JSON.stringify(msg) + '\n');
  const endpoint = new McpEndpoint({
    ...mcpOptions,
    callTool,
    send: out, // requests to the agent: roots/list
    onClient: info => {
      localClient = info;
      if (role === 'hub') hub.touchAgent(info, 'stdio', 'local');
      if (role === 'relay') startHello();
    },
  });
  await startRole().catch(e => log(`could not start the hub: ${e.message}`));
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { out(rpcError(null, ERR.PARSE, 'Parse error')); return; }
    const res = await endpoint.handle(msg);
    if (res) out(res);
  });
  rl.on('close', async () => {
    clearInterval(helloTimer);
    if (role === 'relay') await postJson('/relay/hello', { id: agentId, bye: true }).catch(() => {});
    hub?.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => { hub?.close(); process.exit(0); });
}

// ------------------------------------------------------------------------------------------------ setup

function printSetup() {
  const q = s => (/[\s"']/.test(s) ? JSON.stringify(s) : s);
  const cmd = `node ${q(SCRIPT)}`;
  const json = (key, extra = {}) => JSON.stringify({ [key]: { 'game-world-painter': { ...extra, command: 'node', args: [SCRIPT] } } }, null, 2);
  console.log(`GameWorld Painter MCP server ${pkg.version}: add it to your agent (it starts the server by itself).

Claude Code:      claude mcp add --scope user game-world-painter -- ${cmd}
Codex:            codex mcp add game-world-painter -- ${cmd}
GitHub Copilot CLI: copilot mcp add game-world-painter -- ${cmd}
Gemini CLI:       gemini mcp add --scope user game-world-painter node ${q(SCRIPT)}

VS Code (.vscode/mcp.json, or "MCP: Add Server"):
${json('servers', { type: 'stdio' })}

Cursor (~/.cursor/mcp.json), Claude Desktop, Windsurf and others ("mcpServers"):
${json('mcpServers')}

Clients configured by URL: run "${cmd} --http" and use http://127.0.0.1:${opts.port}/mcp

Then open GameWorld Painter, open your map and turn on AI Agent in the header.
The agent skill (how to use the tools well): gh skill install aleserb/game-world-painter game-world-painter
(or copy skills/game-world-painter to ~/.claude/skills, ~/.copilot/skills, ~/.codex/skills or .github/skills).`);
}
