// The AI agent in the interface: the header control (a LED, the name, an on / off switch) and the dialog with the
// state, how to connect agents (commands per agent), the skill, the activity, the settings and troubleshooting.
(function (ME) {
'use strict';

const agent = ME.agent, S = agent.settings;
const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
};

const STATES = {
  off: ['off', 'AI Agent is off', 'Turn it on to let an AI agent work on this map through the local MCP server.'],
  connecting: ['wait', 'Connecting…', ''],
  offline: ['wait', 'Waiting for the MCP server', 'Add the server to your agent (Agents tab): the agent starts it. Or run it yourself (Get started).'],
  ready: ['ready', 'Connected to the MCP server', 'No agent yet: add the server to your agent and ask it something.'],
  agent: ['on', 'Connected', ''],
  replaced: ['off', 'Another tab is connected', 'Only one tab works with the agent at a time.'],
};

// ------------------------------------------------------------------------------------------------ header

const btn = $('#agent-btn'), sw = $('#agent-on');
sw.checked = S.enabled;
sw.onchange = () => agent.setEnabled(sw.checked);
btn.onclick = () => openDialog();

function header() {
  const [led] = STATES[agent.state] || STATES.off, review = ME.agentReview?.active?.status === 'pending';
  btn.querySelector('.led').className = `led ${led}${review ? ' review' : agent.busy ? ' busy' : ''}`;
  const who = agent.server?.agents?.map(a => a.name) || [];
  btn.title = review ? 'An AI proposal is waiting for your review (on the map)' : agent.busy ? `${who[0] || 'The agent'} is working on the map` : `${STATES[agent.state]?.[1] || ''}${who.length ? ': ' + who.join(', ') : ''} — click for details`;
  sw.checked = S.enabled;
}

// ------------------------------------------------------------------------------------------------ dialog

const dlg = $('#agent-dlg');
let tab = 'start', client = localStorage.getItem('gwp-agent-client') || 'claude';

function openDialog() {
  render();
  if (!dlg.open) dlg.showModal();
}

const port = () => { try { return +new URL(S.url).port || 80; } catch { return 38765; } };
const script = () => agent.server?.command?.script || '/path/to/game-world-painter/mcp/server.mjs';
const q = s => (/[\s"'$]/.test(s) ? JSON.stringify(s) : s);

function commands() {
  const p = port(), extra = p !== 38765 ? ['--port', String(p)] : [], cmd = `node ${q(script())}${extra.length ? ' ' + extra.join(' ') : ''}`;
  const args = [script(), ...extra];
  const json = (key, more = {}) => JSON.stringify({ [key]: { 'game-world-painter': { ...more, command: 'node', args } } }, null, 2);
  return {
    claude: { name: 'Claude Code', how: 'Run once in a terminal:', code: `claude mcp add --scope user game-world-painter -- ${cmd}` },
    codex: { name: 'Codex', how: 'Run once in a terminal (or add it to ~/.codex/config.toml):', code: `codex mcp add game-world-painter -- ${cmd}\n\n# ~/.codex/config.toml\n[mcp_servers.game-world-painter]\ncommand = "node"\nargs = ${JSON.stringify(args)}` },
    copilot: { name: 'GitHub Copilot CLI', how: 'Run once in a terminal (or /mcp add inside Copilot CLI):', code: `copilot mcp add game-world-painter -- ${cmd}` },
    vscode: { name: 'VS Code (Copilot Chat)', how: 'Add to .vscode/mcp.json (or run "MCP: Add Server"):', code: json('servers', { type: 'stdio' }) },
    cursor: { name: 'Cursor', how: 'Add to ~/.cursor/mcp.json:', code: json('mcpServers') },
    desktop: { name: 'Claude Desktop', how: 'Add to claude_desktop_config.json (Settings → Developer → Edit Config):', code: json('mcpServers') },
    gemini: { name: 'Gemini CLI', how: 'Run once in a terminal:', code: `gemini mcp add --scope user game-world-painter node ${q(script())}${extra.length ? ' ' + extra.join(' ') : ''}` },
    http: { name: 'By URL (any client)', how: `Run the server yourself, then add the URL to the client (e.g. claude mcp add --transport http, copilot mcp add --transport http):`, code: `${cmd} --http\n\nhttp://127.0.0.1:${p}/mcp` },
  };
}

function codeBlock(text) {
  const copy = el('button', { type: 'button', class: 'ibtn copy', title: 'Copy', onclick: () => { navigator.clipboard.writeText(text.split('\n\n# ')[0].split('\n\nhttp')[0]); copy.replaceChildren(ME.icon('check')); setTimeout(() => copy.replaceChildren(ME.icon('copy')), 1200); } }, ME.icon('copy'));
  return el('div', { class: 'code' }, el('pre', {}, text), copy);
}

function statusCard() {
  const [led, title, hint] = STATES[agent.state] || STATES.off, sv = agent.server;
  const who = sv?.agents?.length ? sv.agents.map(a => `${a.name}${a.version ? ' ' + a.version : ''}`).join(', ') : '';
  const detail = agent.state === 'agent' ? `${who} · MCP server ${sv.version} at ${S.url.replace(/^https?:\/\//, '')}`
    : agent.state === 'ready' ? `MCP server ${sv.version} at ${S.url.replace(/^https?:\/\//, '')}. ${hint}`
      : agent.error && agent.state !== 'off' ? `${agent.error}. ${hint}` : hint;
  const on = el('input', { type: 'checkbox', class: 'switch', checked: S.enabled, onchange: e => agent.setEnabled(e.target.checked) });
  return el('div', { class: `agent-status ${led}` },
    el('span', { class: `led big ${led}${agent.busy ? ' busy' : ''}` }),
    el('div', { class: 'what' }, el('b', {}, agent.busy ? `${title} — working…` : title), el('div', { class: 'muted small' }, detail)),
    agent.state === 'replaced' ? el('button', { type: 'button', onclick: () => agent.reconnect() }, 'Use this tab') : null,
    agent.state === 'offline' ? el('button', { type: 'button', onclick: () => agent.reconnect(), title: 'Try again now' }, ME.icon('refresh-cw')) : null,
    el('label', { class: 'switch-label', title: 'Let agents connect' }, on, S.enabled ? 'On' : 'Off'));
}

const step = (n, title, ...body) => el('div', { class: 'step' }, el('span', { class: 'num' }, String(n)), el('div', {}, el('h4', {}, title), ...body));

const TABS = {
  start: ['Get started', () => [
    step(1, 'Add the MCP server to your agent', el('p', { class: 'muted' }, 'Once per agent: the agent then starts the server by itself. The server is in the repository (mcp/server.mjs, Node.js 18+): clone it with ',
      el('code', {}, 'git clone https://github.com/aleserb/game-world-painter'), '. The commands for each agent are in the Agents tab; ', el('code', {}, 'node mcp/server.mjs setup'), ' prints them too.'),
      codeBlock(commands()[client].code.split('\n\n')[0])),
    step(2, 'Turn on AI Agent here', el('p', { class: 'muted' }, `The app connects to the server at ${S.url} (Settings) and waits for it. The first time Chrome may ask to let the page reach this device: allow it.`)),
    step(3, 'Install the skill (recommended)', el('p', { class: 'muted' }, 'It teaches the agent how to plan and check its work on the map. See the Skill tab.')),
    step(4, 'Ask', el('ul', { class: 'examples' }, ...[
      'Plant trees nicely in the selected area, avoiding roads and rocks.',
      'Put monster packs of 3–5 in the Village zone, stronger ones closer to the center.',
      'Make a smooth slope from the village down to the river.',
      'Place chests along the trails, at least 20 m apart.',
      'Find spots where the player can get stuck and fix them.',
      'Check that every building is connected to a road.',
    ].map(t => el('li', {}, t)))),
  ]],
  agents: ['Agents', () => {
    const cmds = commands();
    const pick = el('select', { onchange: e => { client = e.target.value; localStorage.setItem('gwp-agent-client', client); render(); } },
      ...Object.entries(cmds).map(([k, c]) => el('option', { value: k, selected: k === client }, c.name)));
    return [
      el('div', { class: 'row' }, el('label', {}, 'Agent'), pick),
      el('p', { class: 'muted' }, cmds[client].how),
      codeBlock(cmds[client].code),
      el('p', { class: 'muted small' }, agent.server ? `The path is where your server runs (${agent.server.command?.script}).` : 'Replace the path with where you cloned the repository; once the server is connected, the right path shows here.'),
      el('p', { class: 'muted small' }, 'Several agents can use the map at once: the first one\'s server owns the port, the others relay through it.'),
    ];
  }],
  skill: ['Skill', () => [
    el('p', {}, 'The GameWorld Painter skill teaches agents the workflow: look at the map, measure, change in batches, check, show the result. It works with Claude Code, GitHub Copilot, Codex, Cursor, Gemini CLI and other agents that read Agent Skills.'),
    el('div', { class: 'layer-actions' },
      el('button', { type: 'button', class: 'primary', onclick: async e => { try { await agent.downloadSkill(); } catch (err) { ME.app.toast(`Could not download the skill: ${err.message}`, 5000); } } }, ME.icon('download'), ' Download the skill (.zip)'),
      el('a', { class: 'button', href: 'https://github.com/aleserb/game-world-painter/tree/main/skills/game-world-painter', target: '_blank', rel: 'noopener' }, ME.icon('external-link'), ' On GitHub')),
    el('p', { class: 'muted' }, 'With the GitHub CLI:'),
    codeBlock('gh skill install aleserb/game-world-painter game-world-painter'),
    el('p', { class: 'muted' }, 'Or unzip it into the skills folder of your agent:'),
    el('table', { class: 'keys' }, ...[['Claude Code', '~/.claude/skills/'], ['GitHub Copilot CLI', '~/.copilot/skills/'], ['Codex', '~/.codex/skills/'], ['VS Code, one repository', '.github/skills/']]
      .map(([a, b]) => el('tr', {}, el('th', {}, a), el('td', {}, el('code', {}, b))))),
  ]],
  activity: ['Activity', () => {
    if (!agent.log.length) return [el('p', { class: 'muted' }, 'What the agent asks the app shows here.')];
    return [
      el('div', { class: 'activity' }, ...agent.log.map(e => el('div', { class: `act ${e.status}` },
        el('span', { class: 'time' }, e.time.toLocaleTimeString()),
        el('span', { class: 'tool' }, e.tool),
        el('span', { class: 'who muted' }, e.client),
        el('span', { class: 'ms muted' }, e.ms != null ? `${e.ms} ms` : '…'),
        el('div', { class: 'args muted small' }, e.args),
        e.comment ? el('div', { class: 'comment small' }, e.comment) : null,
        e.result ? el('div', { class: 'res small' }, e.result) : null))),
      el('div', { class: 'layer-actions' }, el('button', { type: 'button', onclick: () => { agent.log.length = 0; render(); } }, 'Clear')),
    ];
  }],
  settings: ['Settings', () => {
    const url = el('input', { value: S.url, spellcheck: false });
    const flag = (key, title, hint) => el('label', { class: 'check-row' }, el('input', { type: 'checkbox', class: 'switch', checked: S[key], onchange: e => { S[key] = e.target.checked; agent.saveSettings(); render(); } }), el('span', {}, el('b', {}, title), el('span', { class: 'muted small' }, hint)));
    const folder = ME.app.folder, fp = el('input', { value: ME.app.S.projectPath || '', spellcheck: false, disabled: !folder,
      placeholder: folder ? `The full path of "${folder.name}" — found by the agent, or paste it` : 'No map is open',
      onchange: e => agent.setProjectPath(e.target.value) });
    return [
      el('div', { class: 'row' }, el('label', {}, 'Server URL'), url, el('button', { type: 'button', onclick: () => { agent.setUrl(url.value); render(); } }, 'Connect')),
      el('div', { class: 'row' }, el('label', {}, 'Map folder'), fp),
      el('p', { class: 'muted small' }, 'Where this map is on the disk: the browser does not tell, so the MCP server finds it when an agent asks (get_project_path) and the app remembers it.'),
      el('p', { class: 'muted small' }, `Another port: start the server with --port <n> (or GWP_MCP_PORT) and put the same port here.`),
      flag('canWrite', 'Let the agent change the map', 'Off: it can only look, measure and point at things.'),
      flag('review', 'Review the agent\'s changes', 'On by default. Each change becomes a proposal on the map: accept it, ask for changes (with a comment) or reject it. Until then it is not saved. Off: changes apply at once, and the agent\'s notes on them show on a card.'),
      flag('confirmDeletes', 'Ask before the agent deletes', 'A dialog here before items are deleted (in review mode the proposal covers it).'),
      flag('highlight', 'Show the agent\'s changes', 'Outline what it changed or points at, for a moment.'),
      el('p', { class: 'muted small' }, 'Every change of the agent is one step of Undo (Ctrl+Z), named “AI: …” (a group of changes too). Locked layers stay as they are.'),
    ];
  }],
  help: ['Troubleshooting', () => [el('ul', { class: 'trouble' }, ...[
    ['The LED stays amber', 'No server at the URL. Agents start it when they start (after you add it); or run node mcp/server.mjs in a terminal. Check the port in Settings.'],
    ['Chrome asked to “access other apps and services on this device”', 'Allow it: the page talks to the server on this computer. If you denied it, allow it again in the site settings (the icon left of the address).'],
    ['The page is opened from the disk (file://)', 'Start the server with --allow-origin null, or open the app from a local web server or the hosted site.'],
    ['Port in use', 'Another program uses 38765: start the server with --port 38766 and set http://127.0.0.1:38766 here.'],
    ['The agent says the app is not connected', 'Turn on AI Agent, keep this tab open; only one tab is connected (the latest).'],
    ['Tools fail with “locked”', 'Unlock the layer, or ask the agent to use another one.'],
    ['Logs', 'The server writes its log to stderr: in Claude Code /mcp, in VS Code the MCP output channel, in a terminal on screen.'],
  ].map(([a, b]) => el('li', {}, el('b', {}, a), el('div', { class: 'muted' }, b))))]],
};

function render() {
  header();
  const body = dlg.querySelector('.agent');
  body.replaceChildren(
    el('div', { class: 'agent-head' }, el('span', { class: 'bot' }, ME.icon('bot')),
      el('div', {}, el('h3', {}, 'AI Agent (MCP)'), el('p', { class: 'muted' }, 'Let AI agents such as Claude Code, Codex, GitHub Copilot or Cursor read and change this map through a local MCP server.')),
      el('button', { type: 'button', class: 'ibtn close', title: 'Close', onclick: () => dlg.close() }, ME.icon('x'))),
    statusCard(),
    el('div', { class: 'tabs' }, ...Object.entries(TABS).map(([k, [name]]) => el('button', { type: 'button', class: k === tab ? 'on' : '', onclick: () => { tab = k; render(); } }, name, k === 'activity' && agent.log.length ? el('span', { class: 'badge' }, String(agent.log.length)) : null))),
    el('div', { class: 'tab-body' }, ...TABS[tab][1]()));
}

agent.onChange(() => { header(); if (dlg.open && (tab !== 'settings' || !dlg.contains(document.activeElement) || document.activeElement.tagName !== 'INPUT')) render(); });
header();
ME.agentUi = { open: openDialog };
})(window.ME);
