# Contributing

Thanks for helping! Issues and pull requests are welcome.

- **Run it**: open `index.html` in Chrome or Edge, or serve the folder (`python3 -m http.server 8000`). There is no
  build and nothing to install.
- **Code**: plain classic scripts sharing the `ME` namespace (module scripts would not load from `file://`). Keep the
  app dependency-free; a library goes into `vendor/` as a single script with its license (see `vendor/README.md`).
- **Check** before a pull request: `node tests/smoke.mjs` (Node 22+ and Chrome) — it opens the demo map in headless
  Chrome and exercises painting, saving, selection, objects, resizing and the 3D preview. CI runs it too.
- **The file format** is a contract with other programs: change [docs/project-format.md](docs/project-format.md)
  together with the code, and keep old files readable.
- **The demo**: `python3 examples/make_demo.py` (numpy, Pillow) rebuilds `examples/demo-island`.
