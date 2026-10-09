# Contributing

Thanks for helping! Issues and pull requests are welcome.

- **Run it**: open `index.html` in Chrome or Edge, or serve the folder (`python3 -m http.server 8000`). There is no
  build and nothing to install.
- **Code**: plain classic scripts sharing the `ME` namespace (module scripts would not load from `file://`). Keep the
  app dependency-free; a library goes into `vendor/` as a single script with its license (see `vendor/README.md`).
- **Check** before a pull request (Node 22+ and Chrome), CI runs them too:
  - `node tests/smoke.mjs` opens the demo map in headless Chrome and exercises painting, saving, selection, objects,
    resizing and the 3D preview;
  - `node --test mcp/test/*.test.mjs` checks the MCP server: the protocol, the bridge, origins, relays, HTTP;
  - `node tests/agent.mjs` connects the app to the MCP server and calls every agent tool.
- **Agent tools**: a tool is declared in `mcp/lib/tools.mjs` (name, description, JSON Schema) and implemented in
  `js/agent-*.js` (`ME.agentTools.<name>`); keep both in step, change the skill (`skills/game-world-painter`) when the
  workflow changes, and raise `API_VERSION` for incompatible changes.
- **The file format** is a contract with other programs: change [docs/project-format.md](docs/project-format.md)
  together with the code, and keep old files readable.
- **The demo**: `python3 examples/make_demo.py` (numpy, Pillow) rebuilds `examples/demo-island`.

## Screenshots

`node tests/screenshots.mjs` remakes the README's screenshots (`docs/screenshot.jpg`, `docs/screenshot-agent.jpg`)
from the demo island in headless Chrome, with an AI agent connected through the MCP server. Run it after visible
changes to the interface.

## Releasing

1. Write the notes in `CHANGELOG.md` under `## <version> — <date>`, and set the same version in `mcp/package.json`.
2. Push to `main` (or merge the pull request). Nothing else: the `npm` workflow sees a version that is not on npm yet,
   runs the MCP tests, publishes `mcp/` as `game-world-painter-mcp` with provenance, tags the commit `v<version>`
   and makes a GitHub release with those notes. The site deploys from `main` as usual.

The package is published only from GitHub: npm trusted publishing (OIDC), no token on any computer or in the
repository. On npmjs.com the package trusts this repository's `npm.yml` (`npm trust list game-world-painter-mcp`).
