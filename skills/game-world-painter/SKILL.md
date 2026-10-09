---
name: game-world-painter
description: Plan and edit a game world map in GameWorld Painter through its MCP server (tools such as get_map_info, render_map, scatter_items, paint_layer, edit_terrain). Use when the user asks to place, paint, shape, check or improve things on their map — trees, enemies, chests, roads, rivers, terrain, zones, notes — or to analyze the map for gameplay (open areas, cover, reachability, routes, spacing, points of interest).
license: MIT
---

# Working on a GameWorld Painter map

GameWorld Painter is a layered map of a game world seen from above, open in the user's browser. The MCP server
`game-world-painter` forwards your tool calls to that page: you read the layers and change them, the user sees every
change at once and can undo it (Ctrl+Z; each tool call is one step named "AI: …").

## The map

- **Layers** (from `get_map_info`):
  - **mask**: 0–100 % per cell (density: trees, grass, water);
  - **category**: a class per cell (ground, zones);
  - **height**: the terrain;
  - **objects**: placed things with `kind`, `x`, `z`, `yaw`, `props`; markers or footprints (`w`, `d`);
  - **notes**: pinned text;
  - **vector**: paths (roads, rivers, borders) as `points` `[x, z]` or `[x, z, width]`, smooth or straight, `closed` paths are areas.
- **Coordinates**: x grows east, z grows south (north is up). Lengths are in the map's unit (meters unless `get_map_info` says otherwise): scale your numbers to it.
- **Placing an object**, three ways — pick the one that fits, do not compute angles by hand:
  - its center `x`, `z` and `yaw` (degrees, counter-clockwise seen from above: its length `w` points along
    (cos yaw, −sin yaw) — 0 east, 90 north, −90 south);
  - its two ends `a` and `b` — center, yaw and (footprints) length follow; `d` is its width. For bridges, walls,
    fences, docks: anything that goes from one point to another;
  - `x`, `z` and `towards` a point — its length points there.
  Use the usual size of the kind (`get_map_info` → `kind_sizes`): a new house as big as the houses already there.
- **Zones** are classes of a categories layer named zones. **The selected area** is what the user selected in the app.
- **The user's selection** shows what they mean: they select objects with a click, a box, or the Select area tools
  (rectangle, ellipse, lasso, polygon, same kind). `get_user_context` gives the selected items (layer, kinds, ids) and
  the selected area; use `{"items": "selection"}` and `{"area": "selection"}` as regions.
- **Locked layers** cannot be changed: ask the user to unlock them.

## How to work

0. **The right map.** If the user names a map folder that is not the one open (`get_map_info` → `folder`), open it with
   `open_map {"path": …}`; for a new world use `create_map` (path, title, unit, size, cell, layers). The server opens the
   app in the browser when it is not open.
1. **Orient.** Call `get_map_info` (layers, kinds, property keys, zones, unit) and `get_user_context` when the request says
   "this", "here", "these", "selected". Learn the conventions of *this* map — the kinds and property keys already used
   (e.g. enemies as one object per pack with `props.pack_size`) — and follow them.
2. **Look and measure before changing.** `render_map` the area (with `highlight` for the region you mean),
   `describe_region` for its facts, `find_items` / `analyze_items` for what is placed, `find_spots`,
   `analyze_walkability`, `find_route` for gameplay questions.
3. **Plan in regions.** Express *where* as a region object (zones, masks, distances to layers, rects, polygons,
   intersections and exclusions): see [references/regions.md](references/regions.md). One good region replaces many
   coordinates.
4. **Change in batches.** Prefer one call for a whole job: `scatter_items` for many objects (spacing, densities,
   groups, keep-away distances), `paint_layer` with `feather` and `noise` for natural masks, `edit_terrain` for heights,
   `add_items` / `update_items` / `delete_items` for exact edits, `create_layer` when a new kind of data needs its own layer.
   Use `dry_run` on `scatter_items` when you are unsure.
   Give every changing call a `comment` for the user — what it does and why, in a sentence or two; the app shows it with
   the change. When one idea takes several calls, wrap them: `begin_change` (a clear title and description) → the calls
   → `end_change` (a short summary). The user sees one change (one undo step, or one proposal in review mode).
5. **See and check before the user does.** Every changing call returns `checks` when something looks wrong with the
   objects it placed. Before `end_change`, call `check_change`: two images of the place, BEFORE and AFTER, with your
   objects outlined and labeled (problems in red; bridges with a line from end a to b), what changed per layer, and the
   checks — overlaps, objects in water or on roads, uneven ground (with the flatten call), bridges (both ends on dry
   land, crossing the water, about 90° to the flow). **Look at the images** and ask: is it what the user asked for, where
   they asked? Fix what is off (`update_items` with `move` or new `a`/`b`, `delete_items`), then check again.
   `end_change` runs the same checks and does not finish while problems are left; give `ignore_problems` with the
   reason only when the "problem" is intended (the user sees it). For counts, spacing and coverage use
   `describe_region` / `analyze_items`.
6. **Files on disk, when tools are not enough.** `get_project_path` gives the folder of the map on this computer and
   every layer file (PNG, JSON) — for scripts, image tools, converting or exporting. Check `unsaved_in_app` first
   (ask the user to save, or wait for autosave); to write files, create `edit.lock`, write whole files, then delete it:
   the app reloads them. If the folder is not found, ask the user for its path and pass it as `path`.
7. **Report and show.** `show_on_map` what you changed or found (with a short message); for findings or design
   reasons, add notes with `add_items` on the notes layer. Tell the user what you did in numbers (how many, where, why).

## Review mode

Review mode is on by default. When `get_map_info` says `review_mode: on`, every change is a **proposal** the user
reviews on the map:
- A changing call applies at once (the user sees it) but waits for the decision, up to 45 s: `accepted` (kept and
  saved), `changes_requested` (undone; read `feedback` and make a new proposal that follows it), `rejected` (undone;
  do not repeat it), or `pending` (call `wait_for_review` until decided).
- Group the steps of one idea into one proposal: `begin_change` (a clear title and why) → the changes (each with a
  `comment`) → `check_change` → `end_change` (a short summary; it waits for the decision). Keep proposals small enough
  to judge at a glance.
- A single changing call whose objects have problems is not shown for review: it stays open as a change for you to fix,
  then `end_change`.
- When the user asks for changes, read the feedback literally and fix exactly that; check again before you submit.
- Titles, descriptions, summaries and comments are shown as written: lines, `- ` lists, `**bold**` and `` `code` ``.
- While a proposal waits, make no other changes; reading and looking are fine. `undo` withdraws your proposal.
- `get_user_context` → `your_recent_changes` tells what became of your latest changes (e.g. the user undid one).

## Principles

- **Keep the user's work.** Do not delete or move existing items unless asked; when making room, prefer moving.
- **Stay consistent.** Reuse existing kinds, properties, layers and zone names; ask before inventing a new layer for
  something that has one.
- **Think in gameplay.** Spacing, readability, paths, sight lines, safe and dangerous areas, progression from the start.
- **Natural look.** Use noise, varied spacing and mixed kinds; avoid grids and perfect circles.
- **Small, reversible steps** for big transformations: one layer at a time, check after each.

Common requests and how to do them: [references/recipes.md](references/recipes.md).
