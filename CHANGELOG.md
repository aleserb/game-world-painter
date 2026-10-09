# Changelog

## Unreleased

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
- Review mode for AI agents (AI Agent → Settings): the agent's changes become proposals on the map — Accept, Change…
  (with a comment for the agent) or Reject, with Before / After; held (not saved, locked) until decided. Tools
  `begin_proposal`, `submit_proposal`, `wait_for_review`.
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
