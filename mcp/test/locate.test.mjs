// Finding the project folder on disk (lib/locate.mjs) from what the app knows of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locateProject, verify } from '../lib/locate.mjs';
import { makeProject, info } from './helpers.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwp-locate-')));

test('finds the folder under a root, not a same-named one with another map', async () => {
  const root = tmp();
  makeProject(path.join(root, 'a', 'map'), '{"other":1}');
  const want = makeProject(path.join(root, 'b', 'c', 'map'));
  const r = await locateProject(want, { roots: [root], searchHome: false });
  assert.equal(r.path, path.join(root, 'b', 'c', 'map'));
  assert.match(r.found_by, /workspace/);
});

test('the working directory, a folder above it, hints, an explicit path', async () => {
  const root = tmp(), proj = path.join(root, 'game', 'world');
  const i = makeProject(proj);
  assert.equal((await locateProject(i, { cwd: path.join(root, 'game'), searchHome: false })).path, proj);
  fs.mkdirSync(path.join(proj, 'layers', 'deep'), { recursive: true });
  assert.equal((await locateProject(i, { cwd: path.join(proj, 'layers', 'deep'), searchHome: false })).path, proj, 'started inside the project');
  const hinted = await locateProject(i, { hints: [proj], searchHome: false });
  assert.equal(hinted.found_by, 'remembered by the app');
  assert.equal((await locateProject(i, { explicit: proj })).path, proj);
  const wrong = await locateProject(i, { explicit: root });
  assert.equal(wrong.path, null);
  assert.match(wrong.why, /no metadata\.json/);
});

test('copies: the one with the same layer files wins; others are listed', async () => {
  const root = tmp();
  const a = path.join(root, 'x', 'proj'), b = path.join(root, 'y', 'proj');
  makeProject(a);
  makeProject(b);
  const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(path.join(a, 'layers', 'trees.png'), old, old);
  const r = await locateProject(info(b), { roots: [root], searchHome: false });
  assert.equal(r.path, b);
  assert.deepEqual(r.others, [a]);
});

test('not found: says where it looked', async () => {
  const root = tmp(), i = makeProject(path.join(root, 'elsewhere', 'proj'));
  const r = await locateProject({ ...i, name: 'missing' }, { roots: [path.join(root, 'elsewhere')], searchHome: false });
  assert.equal(r.path, null);
  assert.deepEqual(r.searched, [path.join(root, 'elsewhere')]);
  assert.equal((await verify(path.join(root, 'elsewhere', 'proj'), { ...i, metadata: { size: 1, sha256: 'x' } })).ok, false);
});

test('skips tool folders and hidden ones', async () => {
  const root = tmp();
  makeProject(path.join(root, 'node_modules', 'proj'));
  const i = info(path.join(root, 'node_modules', 'proj'));
  assert.equal((await locateProject(i, { roots: [root], searchHome: false })).path, null);
});
