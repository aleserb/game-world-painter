# Changelog

## 0.3.1 — 2026-10-09

- New map starts from the basic set of layers, not from a copy of the open map's layers; a new choice "No layers"
  makes a map with an empty list, and the dialog remembers the set chosen last. The agent's create_map takes
  `"layers": "none"` too.

## 0.3.0 — 2026-10-09

Fixes found in a review of the whole code:

- Undoing a layer delete after it was saved brings the layer's file back (saving had removed it; the layer reopened
  empty).
- The objects of a locked layer, or of a layer held by an AI proposal, are no longer changed with the keys (Delete,
  arrows, R, Ctrl+D), the Properties panel, notes or drags.
- Opening a folder without a map (or with a broken metadata.json) closes the map open before, so nothing of it is
  written into that folder; "New map here" makes the basic layers.
- Saving and the folder: another folder waits for a running save; what is on the disk is what was written (edits made
  while writing are saved next time); Ctrl+S during a save runs after it with Autosave off too; the folder is not
  checked in the middle of a stroke or a drag; a size or unit changed here (not saved yet) survives a change of
  metadata.json on the disk, and the disk's layer order is taken unless the layer list was changed here; a layer
  deleted on the disk but changed here is listed in metadata.json again.
- Each map keeps its own view, folded groups and layer visibility in the browser (before, a map opened with the
  zoom of the previous one).
- Reset the layout shows the 3D preview again; opening the 3D preview twice no longer leaks a timer; layer thumbnails
  no longer keep closed maps in memory.
- "Hide all" keeps the reference pictures (was: one layer named "background", a leftover of the game the tool was
  made for); a picked folder is used as it is (no more looking into a map/ subfolder).
- Smaller: the area fill of paths is one undo step; the object list uses the layer's label; pasting objects and the
  rotate handle follow the unit of the map; areas are rounded, not cut; notes get the local date.
- MCP server: an app and a server of different API versions tell the agent which one to update; one agent entry per
  HTTP session; the undocumented --host option is gone (the server listens on 127.0.0.1 only).
- Code: unused code, exports and styles removed, the agent dialog's styles scoped to it, one shared element helper;
  ESLint in CI (`eslint.config.mjs`); regression checks for the fixes above in the smoke test.

- The 3D preview panel looks cleaner: the camera presets (Overview, Top, Close-up, with icons) are one segmented
  control that shows which one is in use until the camera moves; what covers the ground and the height scale float
  over the view; a narrow panel shows icons only. The "2D view" preset and the panel's close buttons are gone — the 3D
  switch in the header (P) opens and closes it.
- The outline of an AI proposal on the map encloses the footprints of its objects (not only their centers).
- New screenshots in the README, made by `node tests/screenshots.mjs`.

## 0.2.2 — 2026-10-09

- Long sessions with an AI agent no longer grow memory: the Activity keeps the latest 1000 calls and draws them 200
  at a time ("Show older"); decided proposals and finished changes let go of their undo snapshots, map marks and
  results; a proposal keeps outlines, not full-map masks; a late cancel of a finished call is ignored.
- MCP server: Streamable HTTP sessions left without DELETE expire after an hour idle, at most 200 are kept (the least
  recently used goes; its client gets 404 and initializes again); waits for the app that timed out are let go.

## 0.2.1 — 2026-10-09

- The MCP server package is published from GitHub Actions with npm trusted publishing and provenance (the first
  release made this way): npmjs.com shows where and how it was built.
- The package page on npmjs.com shows the diagram of how the agent, the server and the app talk as text (npm does
  not draw Mermaid).

## 0.2.0 — 2026-10-09

- The MCP server is on npm: [`game-world-painter-mcp`](https://www.npmjs.com/package/game-world-painter-mcp) —
  agents start it with `npx -y game-world-painter-mcp` (`setup` prints the command for each agent; the app's AI Agent
  dialog shows them). The package bundles the skill and the project format (MCP resources); it is published
  only from GitHub Actions — automatically when the version in `mcp/package.json` changes on `main` — with
  provenance, a tag and a GitHub release.
- AI agents through MCP: a local server (`mcp/`, no dependencies, MCP 2024-11-05 … 2026-07-28 over stdio and
  Streamable HTTP) that Claude Code, Codex, GitHub Copilot, VS Code, Cursor, Gemini CLI and other agents start; the app
  connects to it (AI Agent switch and LED in the header, a dialog with the setup per agent, the skill, the activity
  and the settings). 20 tools run in the page: overview, user context, images, region facts, raster reads, items with
  measures, spacing and groups, spots (open, enclosed, high, flat, empty…), walkability, routes; scatter, add, update,
  delete items, paint masks and categories, shape the terrain, create and change layers, show on the map, undo.
  Regions: zones, classes, mask ranges, heights, slopes, distances to layers, shapes, all / any / not. Every change
  is one undo step; read-only mode and confirmation of deletions.
- The agent skill (`skills/game-world-painter`): the workflow, regions and recipes for common requests.
- `open_map` and `create_map`: the agent opens a map by its folder path or makes a new one; the app reads and writes
  it through the local MCP server (only folders the agent opened, only for the connected tab), and the server opens the
  app in the browser (`?mcp=<port>&map=<path>`) when none is connected. Such a map opens again after a reload.
- Review mode for AI agents (AI Agent → Settings, on by default): the agent's changes become proposals on the map —
  Accept, Change… (with a comment for the agent) or Reject, with Before / After; held (not saved, locked) until
  decided; an accepted proposal is one undo step. Tool `wait_for_review`.
- `begin_change` … `end_change`: the agent groups several calls into one change with a title, a description and a
  summary — one proposal in review mode, else one undo step. The changing tools take a `comment` (what and why). The
  card at the top right of the map shows the agent's text (lines, lists, bold, code); without review mode it shows a
  finished change for a while, with Undo. Drag the card by its head to another place over the map (kept;
  double-click the head: back to the corner). The Activity shows the comments.
- Opening another map while a proposal waits undoes it (it is not saved into the old map); `open_map` and
  `create_map` wait for a running autosave before saving the open map.
- The agent checks its changes before the user sees them: `check_change` gives BEFORE / AFTER images of the place
  (its objects outlined and labeled, problems in red), what changed per layer, and checks of every placed object —
  overlaps, water, roads, uneven ground, bridges (ends on dry land, over the water, the angle to the flow). Changing
  calls return the checks; `end_change` stays open while problems are left (`ignore_problems` with a reason); in review
  mode a single call with problems is not shown for review. The card shows the self-check.
- `find_crossing`: the narrowest places to cross water, with the bank points for a bridge straight across the flow.
- Objects can be placed by their two ends (`a`, `b`: center, yaw and length follow) or `towards` a point; the yaw rule
  is spelled out; `get_map_info` gives the usual size of each kind.
- Walking: bridges and other crossings are walkable; the zones layer no longer blocks (a zone named `river_valley`
  was taken for water).
- Help: the two columns are balanced.
- Select area on layers of objects, notes and paths: rectangle, ellipse, lasso and polygon select the items in the
  shape (and the area), the magic wand selects the same kind; Shift adds, Alt subtracts, Ctrl+I inverts. The agent
  gets the selection (`get_user_context`: kinds and ids; the region `{"items":"selection"}`).
- `get_project_path`: the full path of the map's folder on disk and of its layer files. The server finds the folder
  (workspace roots, working directory, home) by the app's fingerprint of it; the app remembers and shows the path.
- Vector layers: roads, rivers, borders as smooth or straight lines through points (a width per point, closed
  paths as areas, dashed borders). Path tool (D) draws them, Select edits their points; Paint into a layer turns
  them into mask, categories or height pixels. The demo has a river, a trail and a border.
- Units: a map can be in meters, centimeters, feet, inches, pixels or plain units (`unit` in `metadata.json`); the
  Map size dialog converts a map to another unit or only renames it.
- Select tool first in the tool bar, on every layer; in-app confirmation dialogs; a two-column Help.
- Layers: the eye and the lock appear on hover; select several layers (Shift+click: the rows between, Ctrl/Cmd+click:
  one more), Space shows / hides them, Delete layer deletes them.
- The layers of a group are always together: a map whose metadata.json splits a group (or a change on the disk that
  does) opens with the group joined where its topmost layer is, and is saved so.
- Layers move up and down inside their group only (another group: change Group; the layer goes to the top of it);
  a click on a group header selects the group and ▲▼ move it; ↑↓ select the layer above / below.
- The published site loads the scripts of its own commit (no mix of old and new files from the browser cache).
- The scale bar follows the grid.

## 0.1.0 — 2026-10-08

The first public version.

- Layers: masks, categories, height, objects, notes and pictures, in groups; show, hide, lock, fade, reorder.
- Painting: brush, eraser, smooth, fill, pick; shapes (rectangle, ellipse, polygon, line, freehand).
- Selection: rectangle, ellipse, lasso, polygon, magic wand; copy, cut, paste and move cells.
- Objects and notes: place, move, rotate, copy and paste, properties, a filterable list.
- 3D preview of the terrain (WebGL2 or a software view).
- Maps of any width and height; new maps; resizing.
- Project folders of PNG and JSON files with autosave, watching and merging of changes made by other programs.
- Dockable panels, undo and redo, keyboard shortcuts.
