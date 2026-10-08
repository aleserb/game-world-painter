# Vendored libraries

| File | Library | Version | License |
|------|---------|---------|---------|
| `lucide-icons.js` | [Lucide](https://lucide.dev) — the icons the tool uses (from lucide-static), as SVG markup in `ME.ICONS` | 1.53.0 | ISC (license in the file) |
| `dockview-core.min.js` | [dockview-core](https://github.com/dockview/dockview) — dockable panels, tabs, splits, floating groups (UMD build: `window['dockview-core']`, styles included) | 8.4.1 | MIT, `dockview-LICENSE.md` |

The app has no build step and also opens from the disk, so libraries are plain scripts here. To update:
`npm pack dockview-core@<version>` and copy `package/dist/dockview-core.min.js`.
