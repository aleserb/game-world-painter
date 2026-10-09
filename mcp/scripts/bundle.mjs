// npm pack / publish: copies into the package what lives elsewhere in the repository — the agent skill (offered as
// the MCP resource gwp://skill), the project format (gwp://project-format) and the license — and removes the copies
// afterwards.  node scripts/bundle.mjs add | clean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), repo = path.resolve(pkg, '..');
const COPIES = [['skills/game-world-painter', 'skill'], ['docs/project-format.md', 'docs/project-format.md'], ['LICENSE', 'LICENSE']];

const clean = () => { for (const p of ['skill', 'docs', 'LICENSE']) fs.rmSync(path.join(pkg, p), { recursive: true, force: true }); };
if (process.argv[2] === 'clean') clean();
else if (process.argv[2] === 'add') {
  clean();
  for (const [from, to] of COPIES) {
    const src = path.join(repo, from);
    if (!fs.existsSync(src)) { console.error(`bundle: ${from} is missing (run it in the repository)`); process.exit(1); }
    fs.mkdirSync(path.dirname(path.join(pkg, to)), { recursive: true });
    fs.cpSync(src, path.join(pkg, to), { recursive: true });
  }
} else { console.error('usage: node scripts/bundle.mjs add | clean'); process.exit(2); }
