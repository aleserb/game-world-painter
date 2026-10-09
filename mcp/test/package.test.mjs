// The npm package: what `npm pack` puts in it, and the installed command working as an agent starts it (from the
// tarball, as `npx -y game-world-painter-mcp` would). Needs npm; no network (the package has no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startStdio, initialize, freePort } from './helpers.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const npm = (args, cwd) => execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });

test('the npm package: its files, and the installed command serves MCP', { timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwp-pack-'));
  try {
    const out = JSON.parse(npm(['pack', '--json', '--pack-destination', tmp], PKG));
    const info = Array.isArray(out) ? out[0] : out['game-world-painter-mcp'] ?? Object.values(out)[0]; // npm 11: a list; npm 12: by name
    const files = info.files.map(f => f.path).sort();
    for (const f of ['LICENSE', 'README.md', 'package.json', 'server.mjs', 'lib/hub.mjs', 'lib/locate.mjs', 'lib/protocol.mjs', 'lib/tools.mjs',
      'skill/SKILL.md', 'skill/references/regions.md', 'skill/references/recipes.md', 'docs/project-format.md']) assert.ok(files.includes(f), `the package has ${f}`);
    assert.ok(!files.some(f => f.startsWith('test/') || f.startsWith('scripts/')), `no tests or scripts in the package: ${files.join(', ')}`);
    for (const f of ['skill', 'docs', 'LICENSE']) assert.ok(!fs.existsSync(path.join(PKG, f)), `the bundled copy ${f} is removed after packing`);
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    assert.equal(info.name, 'game-world-painter-mcp');
    assert.equal(info.version, pkg.version);

    // installed as npx installs it: node_modules/.bin/game-world-painter-mcp
    const prefix = path.join(tmp, 'app');
    fs.mkdirSync(prefix);
    npm(['install', '--no-audit', '--no-fund', '--offline', path.join(tmp, info.filename)], prefix);
    const installed = path.join(prefix, 'node_modules', 'game-world-painter-mcp', 'server.mjs');
    assert.ok(fs.existsSync(path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'game-world-painter-mcp.cmd' : 'game-world-painter-mcp')), 'the command is installed');
    assert.equal(execFileSync(process.execPath, [installed, '--version'], { encoding: 'utf8' }).trim(), pkg.version);
    const setup = execFileSync(process.execPath, [installed, 'setup'], { encoding: 'utf8' });
    assert.match(setup, /claude mcp add --scope user game-world-painter -- npx -y game-world-painter-mcp/);
    assert.doesNotMatch(setup, /node_modules/, 'the setup shows npx, not the path in the npx cache');

    const c = startStdio(await freePort(), [], {}, { server: installed });
    try {
      const init = await initialize(c);
      assert.equal(init.result.serverInfo.version, pkg.version);
      const tools = (await c.request('tools/list', {})).result.tools;
      assert.ok(tools.some(t => t.name === 'check_change') && tools.length >= 28, `${tools.length} tools`);
      const skill = await c.request('resources/read', { uri: 'gwp://skill' });
      assert.match(skill.result.contents[0].text, /^---\nname: game-world-painter/);
      const format = await c.request('resources/read', { uri: 'gwp://project-format' });
      assert.match(format.result.contents[0].text, /metadata\.json/);
    } finally { await c.kill(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
