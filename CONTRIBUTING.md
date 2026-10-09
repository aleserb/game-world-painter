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

## Releasing

1. Move the "Unreleased" notes in `CHANGELOG.md` under the new version, and set the same version in
   `mcp/package.json`.
2. Commit, then tag and push: `git tag v0.2.1 && git push origin v0.2.1`.
3. The `npm` workflow runs the MCP tests and publishes `mcp/` to npm as `game-world-painter-mcp` with provenance
   (npm trusted publishing: no token; on npmjs.com the package trusts this repository's `npm.yml`). The site deploys
   from `main` as usual.
