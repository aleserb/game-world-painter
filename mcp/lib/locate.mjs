// Finds the project folder open in GameWorld Painter on this computer. The browser only tells its name, so the folder
// is searched (in the agent's workspace roots and working directory, folders named in GWP_PROJECT_DIRS, then the home
// folder) and checked: its metadata.json must be byte for byte the one the app has; the layer files (sizes and dates)
// pick the right one among copies.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

// Not searched: tools, caches, system folders (a project is not there; some are large or ask for permission)
const SKIP = new Set(['node_modules', 'bower_components', '.git', '.hg', '.svn', 'Library', 'Applications', 'System', 'Music',
  'Movies', 'Pictures', 'Photos', '__pycache__', 'venv', 'AppData', 'Windows', 'Program Files', 'Program Files (x86)',
  'ProgramData', '$Recycle.Bin', 'target', 'Pods', 'DerivedData', 'snap', 'go', 'miniconda3', 'anaconda3']);
// macOS asks the user before a program reads these: searched last
const PROTECTED = ['Desktop', 'Documents', 'Downloads'];

/** Is dir the folder the app has open? {ok, score (matching layer files), why}. */
export async function verify(dir, info) {
  let buf;
  try {
    const st = await fsp.stat(path.join(dir, 'metadata.json'));
    if (!st.isFile()) return { ok: false, why: 'no metadata.json' };
    if (info.metadata.size != null && st.size !== info.metadata.size) return { ok: false, why: 'another map (its metadata.json differs)' };
    buf = await fsp.readFile(path.join(dir, 'metadata.json'));
  } catch {
    return { ok: false, why: 'no metadata.json in it' };
  }
  const same = info.metadata.sha256
    ? createHash('sha256').update(buf).digest('hex') === info.metadata.sha256
    : buf.toString('utf8') === info.metadata.text;
  if (!same) return { ok: false, why: 'another map (its metadata.json differs)' };
  let score = 0;
  for (const f of (info.files || []).slice(0, 60)) {
    try {
      const st = await fsp.stat(path.join(dir, f.path));
      if (st.size === f.size && Math.abs(st.mtimeMs - f.mtime) < 2000) score++;
    } catch { /* missing here */ }
  }
  return { ok: true, score };
}

/**
 * info: {name, metadata: {size, sha256 | text}, files: [{path, size, mtime}]} from the app.
 * o: {explicit (a path to check), hints (paths the app remembers), roots, cwd, extraDirs, home, searchHome, budgetMs, maxDepth}
 * Returns {path, found_by, others} or {path: null, why, searched, incomplete}.
 */
export async function locateProject(info, o = {}) {
  const t0 = Date.now(), budget = o.budgetMs ?? 8000, maxDepth = o.maxDepth ?? 6, home = o.home ?? os.homedir();
  const tried = new Map(), searched = [];
  let timedOut = false;
  const check = async dir => {
    dir = path.resolve(dir);
    if (!tried.has(dir)) tried.set(dir, await verify(dir, info));
    return tried.get(dir);
  };

  if (o.explicit) {
    const v = await check(o.explicit);
    return v.ok ? { path: path.resolve(o.explicit), found_by: 'the path given' } : { path: null, why: `${path.resolve(o.explicit)}: ${v.why}` };
  }
  for (const h of o.hints || []) {
    if (h && (await check(h)).ok) return { path: path.resolve(h), found_by: 'remembered by the app' };
  }

  const tiers = [];
  for (const r of o.roots || []) tiers.push({ dir: r, how: 'the agent\'s workspace' });
  if (o.cwd) tiers.push({ dir: o.cwd, how: 'the agent\'s working directory' });
  for (const d of o.extraDirs || []) tiers.push({ dir: d, how: 'GWP_PROJECT_DIRS' });
  if (o.searchHome !== false && home) {
    tiers.push({ dir: home, how: 'the home folder', skip: new Set(PROTECTED) });
    for (const p of PROTECTED) tiers.push({ dir: path.join(home, p), how: 'the home folder' });
  }

  const seen = new Set();
  for (const tier of tiers) {
    const root = path.resolve(tier.dir);
    if (seen.has(root)) continue;
    seen.add(root);
    if (Date.now() - t0 > budget) { timedOut = true; break; }
    searched.push(root);
    const matches = [];
    // the folder itself and the folders above it (an agent started inside the project)
    for (let d = root, k = 0; k < 4; k++, d = path.dirname(d)) {
      if (nameMatches(path.basename(d), info.name)) { const v = await check(d); if (v.ok) matches.push({ path: d, score: v.score }); }
      if (path.dirname(d) === d) break;
    }
    if (!matches.length) {
      const r = await walk(root, info, { maxDepth, deadline: t0 + budget, skip: tier.skip, check, perfect: (info.files || []).slice(0, 60).length });
      matches.push(...r.matches);
      if (r.timedOut) timedOut = true;
    }
    if (matches.length) {
      matches.sort((a, b) => b.score - a.score);
      return { path: matches[0].path, found_by: tier.how, ...(matches.length > 1 ? { others: matches.slice(1).map(m => m.path) } : {}) };
    }
  }
  return {
    path: null, searched, incomplete: timedOut,
    why: `No folder named "${info.name}" with the same metadata.json was found${timedOut ? ' (the search stopped after ' + Math.round(budget / 1000) + ' s)' : ''}`,
  };
}

const nameMatches = (a, b) => a === b || a.toLowerCase() === String(b).toLowerCase();

/** Breadth-first search under root for folders named like the project; checks each one. */
async function walk(root, info, { maxDepth, deadline, skip, check, perfect }) {
  const matches = [];
  let level = [root], timedOut = false;
  for (let depth = 0; depth < maxDepth && level.length; depth++) {
    const next = [];
    for (let i = 0; i < level.length; i += 24) {
      if (Date.now() > deadline) return { matches, timedOut: true };
      const batch = await Promise.all(level.slice(i, i + 24).map(async dir => {
        try { return [dir, await fsp.readdir(dir, { withFileTypes: true })]; } catch { return [dir, []]; }
      }));
      for (const [dir, entries] of batch) {
        for (const e of entries) {
          if (!e.isDirectory()) continue; // symbolic links are not followed
          const full = path.join(dir, e.name);
          if (nameMatches(e.name, info.name)) {
            const v = await check(full);
            if (v.ok) {
              matches.push({ path: full, score: v.score });
              if (v.score >= perfect) return { matches, timedOut };
            }
          }
          if (e.name.startsWith('.') || SKIP.has(e.name) || (depth === 0 && skip?.has(e.name))) continue;
          next.push(full);
        }
      }
    }
    level = next;
    if (matches.length) break; // the nearest ones
  }
  return { matches, timedOut };
}
