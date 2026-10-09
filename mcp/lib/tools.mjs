// The tools of the GameWorld Painter MCP server: names, descriptions and argument schemas. They run in the app (the
// browser page with the map, js/agent-tools.js); the server forwards the calls. The schemas use plain JSON Schema
// (objects, arrays, strings, numbers, enums) so every client can read them.

export const API_VERSION = 1; // the app checks it: the same tools on both sides

const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, z]' };

export const REGION_DOC = `A region (where) is an object, one of:
{"area":"map"|"selection"|"view"} — selection: the area the user selected in the app (else their selected objects);
{"items":"selection"} — the shapes of the items the user selected;
{"rect":[x0,z0,x1,z1]}; {"circle":[x,z,r]}; {"polygon":[[x,z],...]};
{"zone":"village"} — a class of the zones layer (a categories layer named zones);
{"layer":"ground","class":"rock"} (or "class":["rock","sand"]) — cells of categories classes;
{"layer":"trees","min":50,"max":100} — cells where a mask is in a range (percent);
{"height":{"min":0,"max":12}} and {"slope":{"max":25}} (degrees) — from the height layer;
{"near":"roads","distance":8} — within a distance of a layer (a mask ≥ 50 %, objects, paths), of a point [x,z] or of another region;
{"items":{"layer":"buildings","ids":[3,4]}} — the shapes of items (footprints and closed paths with their inside);
{"all":[...]} (intersection), {"any":[...]} (union), {"not":{...}}.
Lengths are in the unit of the map (get_map_info).`;

const PLACE_DOC = 'Place an object one of three ways: its center x, z and yaw (degrees counter-clockwise seen from above: its length w points along (cos yaw, −sin yaw) — 0 east, 90 north, −90 south); its two ends "a": [x,z] and "b": [x,z] (center, yaw and, for footprints, the length w follow; d is its width, default 3 m) — use it for bridges, walls, fences, anything from one point to another; or x, z and "towards": [x,z] (its length points there).';

const REGION_SHORT = 'A region object, e.g. {"area":"selection"}, {"zone":"village"}, {"layer":"trees","min":50}, {"near":"roads","distance":5}, {"rect":[x0,z0,x1,z1]}, {"all":[...]}; the full syntax is in describe_region';
const region = (what = 'Where') => ({ type: 'object', description: `${what}. ${REGION_SHORT}.`, additionalProperties: true });
const layerArg = desc => ({ type: 'string', description: desc });
const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const edit = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export const TOOLS = [
  {
    name: 'get_map_info',
    title: 'Map overview',
    description: 'Start here. The open map: title, unit, bounds, cell size, every layer with what it holds (mask coverage, categories classes and their shares, height range, object kinds and property keys, notes, vector paths), the zones, conventions, and what the user is looking at. Coordinates: x grows east, z grows south, north is up.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: ro,
  },
  {
    name: 'open_map',
    title: 'Open a map by its path',
    description: 'Opens the map in the folder at "path" (the folder with metadata.json) in GameWorld Painter. The app then reads and writes that folder through this MCP server, without the user picking it. When no app is connected, the server opens it in the default browser with a link that connects it and opens the map (the user may have to allow Chrome to reach this device). The map open before is saved first.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'The folder of the map (or its metadata.json); ~ is the home folder' }, browser: { type: 'boolean', description: 'Open a browser when no app is connected (default true)' } }, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_map',
    title: 'Create a new map',
    description: 'Creates a new map in the folder at "path" (made if missing; it must not have a map yet) and opens it in the app: the bounds and cell size in the unit of the map, and a set of layers — "basic" (terrain height, ground, zones, water, roads, rivers, borders, rocks, grass, bushes, trees, buildings, enemies, chests, hiding spots, notes), "notes" (only notes), or "same" (the layers of the map open now, empty). Then shape it with the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The folder for the map; ~ is the home folder' },
        title: { type: 'string', description: 'The name of the map' },
        unit: { type: 'string', enum: ['m', 'cm', 'ft', 'in', 'px', 'u'], description: 'The unit of every number (default m): cm for Unreal, in for Source, px for 2D' },
        width: { type: 'number', description: 'Along x (default 256 m or the same in the unit)' },
        height: { type: 'number', description: 'Along z (default: as width)' },
        cell: { type: 'number', description: 'The cell size (default about 0.25–0.5 m); at most 2048 cells on a side' },
        center: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, z] of the middle (default [0, 0])' },
        layers: { type: 'string', enum: ['basic', 'notes', 'same'], description: 'Default basic' },
        browser: { type: 'boolean', description: 'Open a browser when no app is connected (default true)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'get_user_context',
    title: 'What the user selected',
    description: 'What the user is pointing at now: the selected area (its bounds and size), the selected items (their layer, kinds, ids), the selected layers, the active layer and tool, the view, the cursor, and what became of your latest changes. The user selects objects with Select (click, box) or the Select area tools (rectangle, ellipse, lasso, polygon, same kind) to show you what they mean. Use it for requests like "this area", "here", "these", "the selected ones".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: ro,
  },
  {
    name: 'get_project_path',
    title: 'Project folder on disk',
    description: 'The full path of the project folder open in the app on this computer (the folder with metadata.json and layers/), the path of every layer file, and what the app has not saved yet. Use it to read or change the files with other tools (scripts, image tools, exporters). The browser does not reveal paths, so the server finds the folder — in your workspace, your working directory, then the home folder — and checks it is the same one (its metadata.json). If it is not found, ask the user for the path and pass it as "path".',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'A folder to check (e.g. a path the user told you); it is remembered when it is the right one' } }, additionalProperties: false },
    annotations: ro,
  },
  {
    name: 'render_map',
    title: 'Look at the map',
    description: 'An image of the map from above (north up) with a coordinate grid: the whole map, the view, or a region. Look before and after changes. Optional highlight of a region.',
    inputSchema: {
      type: 'object',
      properties: {
        region: region('What to show (default: the user\'s view)'),
        layers: { type: 'array', items: { type: 'string' }, description: 'Layer ids to draw (default: the visible layers)' },
        size: { type: 'integer', minimum: 128, maximum: 1600, description: 'The long side in pixels (default 768)' },
        grid: { type: 'boolean', description: 'Coordinate grid with labels (default true)' },
        labels: { type: 'boolean', description: 'Labels of objects and paths (default true)' },
        highlight: region('A region to outline in red'),
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'Default jpeg' },
      },
      additionalProperties: false,
    },
    annotations: ro,
  },
  {
    name: 'describe_region',
    title: 'Describe a region',
    description: 'Everything in a region: its size and bounds, mask coverage, categories shares (zones, ground), heights and slopes, and the items of every layer by kind. Use it to check an area before and after changing it.',
    inputSchema: { type: 'object', properties: { region: { type: 'object', description: `The region. ${REGION_DOC}`, additionalProperties: true }, list_items: { type: 'integer', minimum: 0, maximum: 200, description: 'Also list up to this many items per layer (default 20)' } }, required: ['region'], additionalProperties: false },
    annotations: ro,
  },
  {
    name: 'read_layer',
    title: 'Read raster values',
    description: 'The values of a mask (0–100 %), categories (class names) or height layer as a coarse grid over a region, row by row from north to south. For exact work use describe_region, find_spots or the edit tools instead of reading every cell.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: layerArg('A mask, categories or height layer id'),
        region: region('Where (default: the whole map)'),
        resolution: { type: 'integer', minimum: 4, maximum: 128, description: 'Cells per side of the grid at most (default 40)' },
      },
      required: ['layer'],
      additionalProperties: false,
    },
    annotations: ro,
  },
  {
    name: 'find_items',
    title: 'Find objects, notes, paths',
    description: 'Items of objects, notes and vector layers with filters: region, kind, properties, distance to a point. measure adds facts per item: the distance to the nearest feature of other layers (e.g. roads, water), the height, the slope, the zone.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: layerArg('An item layer id (default: every objects, notes and vector layer)'),
        region: region('Only items inside it'),
        kind: { type: 'array', items: { type: 'string' }, description: 'Only these kinds' },
        props: { type: 'object', description: 'Only items whose properties have these values', additionalProperties: true },
        near: point,
        max_distance: { type: 'number', description: 'With near: only items closer than this; sorted by distance' },
        measure: { type: 'array', items: { type: 'string' }, description: 'Layer ids to measure the distance to, and/or "height", "slope", "zone"' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Default 200' },
        offset: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    annotations: ro,
  },
  {
    name: 'analyze_items',
    title: 'Analyze spacing and groups',
    description: 'How items are spread in a region: nearest-neighbor distances, pairs closer than min_distance, groups (items within cluster_distance of each other) and the largest empty gaps. Use it to check or even out placements while keeping groups.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: layerArg('An objects, notes or vector layer'),
        region: region('Where (default: the whole map)'),
        kind: { type: 'array', items: { type: 'string' } },
        min_distance: { type: 'number', description: 'Report pairs closer than this' },
        cluster_distance: { type: 'number', description: 'Items closer than this are one group (default: twice the median neighbor distance)' },
        gaps: { type: 'integer', minimum: 0, maximum: 30, description: 'How many of the largest empty spots to report (default 5)' },
      },
      required: ['layer'],
      additionalProperties: false,
    },
    annotations: ro,
  },
  {
    name: 'find_spots',
    title: 'Find spots by a measure',
    description: 'Finds the best spots in a region by a measure of the terrain and the layers, as ranked areas with a center point. open: far from cover (open, exposed ground); enclosed: much cover around (poor view, hidden); high / low: above / below the surroundings (viewpoints, hollows); flat / steep: slope; empty: far from any item and cover (looks empty); far_from / near_to: distance to given layers.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['open', 'enclosed', 'high', 'low', 'flat', 'steep', 'empty', 'far_from', 'near_to'] },
        region: region('Where to look (default: the whole map)'),
        layers: { type: 'array', items: { type: 'string' }, description: 'Cover layers for open / enclosed / empty (default: masks and objects that look like cover: trees, bushes, rocks, buildings...); the layers to measure to for far_from / near_to' },
        radius: { type: 'number', description: 'The neighborhood for enclosed, high, low (default: about 15 m)' },
        min_area: { type: 'number', description: 'The smallest spot (area, default: 4 cells)' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10' },
        min_separation: { type: 'number', description: 'Spot centers at least this far apart (default: 2 × radius)' },
      },
      required: ['metric'],
      additionalProperties: false,
    },
    annotations: ro,
  },
  {
    name: 'analyze_walkability',
    title: 'Where can the player walk',
    description: 'Walkable ground in a region (slope below max_slope, outside blocking layers such as water, cliffs, buildings) split into connected parts: the main part (from start, else the largest), isolated pockets where a player could get stuck or never get to, narrow passages, and items standing on blocked or isolated ground.',
    inputSchema: {
      type: 'object',
      properties: {
        region: region('Where (default: the whole map)'),
        max_slope: { type: 'number', description: 'Degrees (default 35)' },
        blocking: { type: 'array', items: { type: 'string' }, description: 'Blocking layers (default: water, cliffs, walls and footprint objects such as buildings)' },
        start: point,
        check: { type: 'array', items: { type: 'string' }, description: 'Item layers whose items must be reachable (default: every objects layer)' },
        narrow_width: { type: 'number', description: 'Report passages narrower than this (default 2 m)' },
      },
      additionalProperties: false,
    },
    annotations: ro,
  },
  {
    name: 'find_route',
    title: 'Find a route',
    description: 'The best walking route between two places on the terrain: not steeper than max_slope, around blocking layers, preferring some layers (roads) and keeping away from others (enemies, danger zones). Returns the route as points; add_to adds it as a path to a vector layer.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'object', description: 'Where from: {"point":[x,z]}, {"item":{"layer":"buildings","id":3}} or a region (its middle)', additionalProperties: true },
        to: { type: 'object', description: 'Where to (as from)', additionalProperties: true },
        max_slope: { type: 'number', description: 'Degrees (default 35)' },
        blocking: { type: 'array', items: { type: 'string' }, description: 'Layers that cannot be crossed (default: water, cliffs, walls, buildings)' },
        prefer: { type: 'array', items: { type: 'string' }, description: 'Layers that are cheaper to walk on (roads, trails)' },
        avoid: { type: 'array', description: 'Keep away: [{"layer":"enemies","distance":25}] or [{"region":{...}}]', items: { type: 'object', additionalProperties: true } },
        add_to: { type: 'object', description: 'Add the route to a vector layer: {"layer":"road_lines","kind":"safe path","width":3}', additionalProperties: true },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    annotations: { ...ro, readOnlyHint: false },
  },
  {
    name: 'add_items',
    title: 'Add objects, notes, paths',
    description: `Adds items to an objects, notes or vector layer. Objects: {kind, x, z, yaw?, w?, d?, props?} (zone is filled from the zones layer). ${PLACE_DOC} Notes: {x, z, text, color?}. Paths: {kind, points: [[x,z] or [x,z,width]...], closed?, width?, smooth?, props?}. Match the usual size of the kind (get_map_info → kind_sizes). The result has "checks" when something looks wrong (overlaps, water, a bridge along the river…). One undo step for the user.`,
    inputSchema: {
      type: 'object',
      properties: {
        layer: layerArg('The layer id'),
        items: { type: 'array', items: { type: 'object', additionalProperties: true }, minItems: 1, maxItems: 5000 },
      },
      required: ['layer', 'items'],
      additionalProperties: false,
    },
    annotations: edit,
  },
  {
    name: 'update_items',
    title: 'Change items',
    description: 'Changes items by id: set fields ({"id":3,"kind":"ruin"}), merge properties ({"id":3,"props":{"level":5}}, null removes one), move by an offset ({"id":3,"move":[dx,dz]}), turn ({"id":3,"turn":90}, degrees counter-clockwise), place anew by its ends ({"id":3,"a":[x,z],"b":[x,z]}) or point it ({"id":3,"towards":[x,z]}). One undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: layerArg('The layer id'),
        items: { type: 'array', items: { type: 'object', additionalProperties: true }, minItems: 1, maxItems: 5000 },
      },
      required: ['layer', 'items'],
      additionalProperties: false,
    },
    annotations: { ...edit, idempotentHint: true },
  },
  {
    name: 'delete_items',
    title: 'Delete items',
    description: 'Deletes items of a layer by ids, or all items matching region and kind. The app may ask the user to confirm. One undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: layerArg('The layer id'),
        ids: { type: 'array', items: { type: 'integer' } },
        region: region('Delete the items inside it'),
        kind: { type: 'array', items: { type: 'string' } },
      },
      required: ['layer'],
      additionalProperties: false,
    },
    annotations: { ...edit, destructiveHint: true },
  },
  {
    name: 'scatter_items',
    title: 'Scatter objects naturally',
    description: 'Places many objects naturally (blue-noise spacing) in a region: weighted kinds, a minimum spacing, an optional count, a density layer, distances to keep from other layers, groups (packs of 3–5 around a center), random rotation and properties. Existing items of the layer keep the spacing too. dry_run returns the positions without adding. One undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: layerArg('An objects (or notes) layer'),
        region: region('Where to place'),
        kind: { type: 'string', description: 'One kind for all' },
        kinds: { type: 'array', description: 'Or a mix: [{"kind":"oak","weight":3,"props":{...},"w":4,"d":4}]', items: { type: 'object', additionalProperties: true } },
        spacing: { type: 'number', description: 'The least distance between items (default: about 4 m)' },
        count: { type: 'integer', minimum: 1, maximum: 5000, description: 'How many at most (default: fill the region at that spacing, up to 2000)' },
        density: { type: 'object', description: 'Weight by a mask: {"layer":"forest","invert":false}: more where it is higher', additionalProperties: true },
        keep_away: { type: 'array', description: 'Distances to keep: [{"layer":"roads","distance":3},{"layer":"buildings","distance":5}]', items: { type: 'object', additionalProperties: true } },
        groups: { type: 'object', description: 'Groups instead of single items: {"size":[3,5],"radius":6}; spacing then applies between the groups', additionalProperties: true },
        yaw: { description: '"random" (default) or degrees', anyOf: [{ type: 'number' }, { type: 'string' }] },
        props: { type: 'object', description: 'Properties for every item', additionalProperties: true },
        random_props: { type: 'object', description: 'Random integer properties per item or group: {"pack_size":[3,5]}', additionalProperties: true },
        seed: { type: 'integer', description: 'For a repeatable result' },
        dry_run: { type: 'boolean' },
      },
      required: ['layer', 'region'],
      additionalProperties: false,
    },
    annotations: edit,
  },
  {
    name: 'paint_layer',
    title: 'Paint a mask or categories',
    description: 'Paints a mask (value in percent) or a categories layer (value: a class name) over a region, with a soft edge (feather) and natural variation (noise). Modes: set, max (only raise), min (only lower), add, subtract, erase. One undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: layerArg('A mask or categories layer'),
        region: region('Where to paint'),
        value: { description: 'Mask: 0–100 (percent). Categories: the class name ("none" erases)', anyOf: [{ type: 'number' }, { type: 'string' }] },
        mode: { type: 'string', enum: ['set', 'max', 'min', 'add', 'subtract', 'erase'], description: 'Default set' },
        feather: { type: 'number', description: 'Soft edge width (default 0)' },
        noise: { type: 'object', description: 'Natural variation: {"amount":20,"scale":12,"seed":1} — amount in percent of the value, scale: the size of the blotches', additionalProperties: true },
        strength: { type: 'number', minimum: 0, maximum: 100, description: 'Percent (default 100)' },
      },
      required: ['layer', 'region', 'value'],
      additionalProperties: false,
    },
    annotations: edit,
  },
  {
    name: 'edit_terrain',
    title: 'Shape the terrain',
    description: 'Changes the height layer in a region with a soft edge. raise / lower by amount; flatten to height (default: the mean height there); smooth with radius; slope: an even ramp from one place to another (the heights there, or given ones); noise: natural bumps of amount with scale. One undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['raise', 'lower', 'flatten', 'smooth', 'slope', 'noise'] },
        region: region('Where (slope: default the area between from and to)'),
        layer: layerArg('The height layer (default: the first one)'),
        amount: { type: 'number', description: 'raise / lower / noise: how much (in the unit of the map)' },
        height: { type: 'number', description: 'flatten: the target height' },
        radius: { type: 'number', description: 'smooth: how far (default 3 m)' },
        scale: { type: 'number', description: 'noise: the size of the bumps (default 20 m)' },
        from: { type: 'object', description: 'slope: {"point":[x,z]} or a region, optional "height"', additionalProperties: true },
        to: { type: 'object', description: 'slope: as from', additionalProperties: true },
        feather: { type: 'number', description: 'Soft edge width (default: a tenth of the region size)' },
        strength: { type: 'number', minimum: 0, maximum: 100, description: 'Percent (default 100)' },
        seed: { type: 'integer' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    annotations: edit,
  },
  {
    name: 'create_layer',
    title: 'Create a layer',
    description: 'Creates a layer: mask, category (classes), height, objects (style marker or footprint), notes or vector (paths). It goes on top of its group. One undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['mask', 'category', 'height', 'objects', 'notes', 'vector'] },
        group: { type: 'string', description: 'Default "AI"' },
        note: { type: 'string', description: 'What the layer is for' },
        color: { type: 'string', description: '#rrggbb' },
        classes: { type: 'array', description: 'category: [{"name":"ruins","color":"#8a7a6a"}] ("none" is added first)', items: { type: 'object', additionalProperties: true } },
        style: { type: 'string', enum: ['marker', 'footprint', 'link'], description: 'objects' },
        marker: { type: 'string', enum: ['circle', 'square', 'diamond', 'triangle', 'cross'] },
        size: { type: 'number', description: 'objects: marker size' },
        label: { type: 'string', description: 'Label template, e.g. "{kind}"' },
        width: { type: 'number', description: 'vector: path width' },
        dash: { type: 'boolean', description: 'vector: dashed (borders)' },
      },
      required: ['name', 'type'],
      additionalProperties: false,
    },
    annotations: edit,
  },
  {
    name: 'update_layer',
    title: 'Change a layer',
    description: 'Changes the settings of a layer: name, note, group, color, visible, opacity, label, width, add or rename categories classes. The agent cannot unlock layers. One undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: layerArg('The layer id'),
        name: { type: 'string' }, note: { type: 'string' }, group: { type: 'string' }, color: { type: 'string' },
        visible: { type: 'boolean' }, opacity: { type: 'number', minimum: 0, maximum: 1 }, label: { type: 'string' }, width: { type: 'number' },
        add_classes: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '[{"name":"ruins","color":"#8a7a6a"}]' },
        rename_classes: { type: 'object', description: '{"old name":"new name"}', additionalProperties: true },
      },
      required: ['layer'],
      additionalProperties: false,
    },
    annotations: edit,
  },
  {
    name: 'show_on_map',
    title: 'Show the user',
    description: 'Moves the user\'s view to a region, items or a point and outlines it for a few seconds, with an optional message. select: also make it the selected area. Use it to point at what you changed or found.',
    inputSchema: {
      type: 'object',
      properties: {
        region: region('What to show'),
        items: { type: 'object', description: '{"layer":"enemies","ids":[1,2]}', additionalProperties: true },
        point: point,
        message: { type: 'string', description: 'A short message shown to the user' },
        select: { type: 'boolean', description: 'Make the region the selected area' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'check_change',
    title: 'See and check your change',
    description: 'Shows you your open change (between begin_change and end_change, or a proposal waiting for review) before the user judges it: two images of the place — BEFORE and AFTER, with your objects outlined and labeled (#id kind; bridges with a line from end a to b; problems in red) — what changed per layer, and checks of every object placed or moved: overlaps with other objects, standing in water or on a road, uneven ground (with the flatten call), bridges (both ends on dry land, crossing the water, the angle to the flow: 90° is straight across). end_change runs the same checks and does not finish while problems are left. With "items" it checks objects already on the map. Look at the images: do they match what the user asked?',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'The change (default: the open one)' },
        items: { type: 'object', description: 'Instead: check objects on the map, {"layer":"buildings","ids":[3,4]} (no ids: all of the layer)', additionalProperties: true },
        images: { type: 'boolean', description: 'Default true' },
        size: { type: 'integer', minimum: 256, maximum: 1200, description: 'Image size in pixels (default 640)' },
        layers: { type: 'array', items: { type: 'string' }, description: 'Layers to draw (default: the visible ones)' },
      },
      additionalProperties: false,
    },
    annotations: ro,
  },
  {
    name: 'find_crossing',
    title: 'Where to cross water',
    description: 'Finds the narrowest places to cross a river or other water in a region (default: the user\'s selected area, else the view): for each, the two points on the banks — a and b, on dry land — for a bridge straight across the flow, its length, the width of the water, the yaw, the angle to the flow, the heights and slopes at both ends, and objects in the way. Then add_items {"kind": "<bridge>", "a": a, "b": b, "d": <width>}. Also lists the crossings already on the map (kinds and sizes).',
    inputSchema: {
      type: 'object',
      properties: {
        region: region('Where to cross (the middle of the crossing is in it)'),
        water: { type: 'array', items: { type: 'string' }, description: 'The water layers (default: masks and classes named water, river, lake…, vector rivers)' },
        bank: { type: 'number', description: 'How far each end reaches onto dry land (default 1.5 m)' },
        width: { type: 'number', description: 'The width of the bridge, to find objects in the way (default 3 m)' },
        max_length: { type: 'number', description: 'The widest water to cross (default 40 m)' },
        near: { ...point, description: 'Prefer crossings near this point [x, z] (e.g. where a road meets the river)' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Default 3' },
      },
      additionalProperties: false,
    },
    annotations: ro,
  },
  {
    name: 'begin_change',
    title: 'Start a change of several steps',
    description: 'Groups the next changing calls into one change the user sees on a card over the map with your title and description, until end_change. In review mode (get_map_info → review_mode on, the default) it is one proposal: the steps apply at once but are held until the user accepts, asks for changes or rejects it all. Without review mode it becomes one undo step. Use it whenever one idea takes more than one call (e.g. ruins + rubble + overgrowth). Without it each changing call is its own change (in review mode: its own proposal, which waits for the decision).',
    inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'What the change is, e.g. "Abandoned village: ruins, rubble, overgrowth"' }, description: { type: 'string', description: 'For the user: what and why, briefly. Lines, "- " lists, **bold** and `code` show as such' } }, required: ['title'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'end_change',
    title: 'Finish the change (review mode: submit it)',
    description: 'Ends the change opened with begin_change. First it checks the objects of the change (as check_change): while problems are left (overlaps, objects in the water, a bridge along the river or with an end in the water…) the change stays open and you get the problems — fix them and call end_change again, or give "ignore_problems" with the reason. In review mode it then shows the proposal to the user and waits for the decision (up to "wait" seconds): accepted (kept and saved), changes_requested (undone; "feedback" says what the user wants instead: make a new change), rejected (undone), or pending (call wait_for_review). Without review mode the change is applied as one undo step (status done).',
    inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'For the user: what you did and why (replaces the description). Lines, "- " lists, **bold** and `code` show as such' }, title: { type: 'string', description: 'A better title, if the change turned out different' }, ignore_problems: { type: 'string', description: 'Finish although the checks found problems: why they are fine (the user sees it)' }, wait: { type: 'integer', minimum: 0, maximum: 110, description: 'Review mode: seconds to wait for the decision (default 45)' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'wait_for_review',
    title: 'Wait for the user\'s decision',
    description: 'Waits for the user to decide on a proposal (up to "wait" seconds) and returns the decision: accepted, changes_requested (with "feedback"), rejected, or pending (still waiting: call again).',
    inputSchema: { type: 'object', properties: { id: { type: 'integer', description: 'The proposal (default: the latest)' }, wait: { type: 'integer', minimum: 0, maximum: 110, description: 'Seconds (default 45)' } }, additionalProperties: false },
    annotations: ro,
  },
  {
    name: 'undo',
    title: 'Undo agent changes',
    description: 'Undoes the latest changes made by the agent (only while they are the latest changes in the app). In review mode: withdraws your proposal that waits for review.',
    inputSchema: { type: 'object', properties: { steps: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 1' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

/** Changing tools take "comment": the agent's words on the change, shown to the user with it. */
const COMMENT = { type: 'string', maxLength: 4000, description: 'For the user: what this change does and why, in a sentence or two. Shown with the change in the app (the proposal card in review mode, a card otherwise, the Activity)' };
for (const t of TOOLS) {
  if (['add_items', 'update_items', 'delete_items', 'scatter_items', 'paint_layer', 'edit_terrain', 'create_layer', 'update_layer', 'find_route'].includes(t.name)) t.inputSchema.properties.comment = COMMENT;
}

/** Tools that the server runs itself (with help from the app), not the page. */
export const SERVER_TOOLS = new Set(['get_project_path', 'open_map', 'create_map']);


/** Tool calls that may wait for the user (a confirmation, a proposal under review): a longer timeout. */
export const SLOW_TOOLS = new Set(['open_map', 'create_map', 'delete_items', 'end_change', 'wait_for_review', 'check_change', 'find_crossing', 'add_items', 'update_items', 'scatter_items', 'paint_layer', 'edit_terrain', 'create_layer', 'update_layer', 'find_route', 'undo']);

export const INSTRUCTIONS = `GameWorld Painter: a layered map of a game world seen from above, open in the user's browser. You read it and change it through these tools; every change appears at once in the app, and the user can undo it (Ctrl+Z).

- Start with get_map_info (layers, unit, zones) and get_user_context ("this area" means the user's selected area: {"area":"selection"}; "these" the selected items: {"items":"selection"} or their ids).
- get_project_path gives the folder of the map on disk (metadata.json, the layer PNG and JSON files) for work with files and scripts.
- open_map opens a map by its folder path, create_map makes a new one; when the app is not open, the server opens it in the browser.
- Look with render_map; measure with describe_region, find_items, find_spots, analyze_items, analyze_walkability, find_route.
- Change with scatter_items (many objects), add_items / update_items / delete_items, paint_layer (masks, categories), edit_terrain (heights), create_layer / update_layer. Prefer one call for a whole batch. Give each change a "comment" for the user (what and why); the app shows it with the change.
- Place objects by their center (x, z, yaw), by their two ends "a" and "b" (bridges, walls: from one point to another), or "towards" a point; match the usual size of the kind (get_map_info → kind_sizes). For a bridge use find_crossing: it gives the bank points a and b straight across the flow.
- Several calls for one idea: begin_change (title, description) → the calls → check_change (look at the BEFORE / AFTER images and the checks; fix what is wrong) → end_change (summary). The user sees it as one change (one undo step, or one proposal in review mode). end_change does not finish while the checks find problems (overlaps, objects in water, a bridge along the river…) unless you give "ignore_problems" with the reason.
- ${REGION_DOC.replace(/\n/g, '\n  ')}
- x grows east, z grows south (north is up); lengths are in the unit of the map. Keep what the user made unless asked; respect locked layers.
- Review mode (get_map_info → review_mode, on by default): your changes are proposals. A changing call (or end_change) waits for the user's decision (up to 45 s; then wait_for_review): accepted — keep going; changes_requested — it was undone, redo it following "feedback"; rejected — it was undone, do not repeat it.
- After changing, check the result (describe_region or render_map), then show_on_map what you did and leave notes (add_items on a notes layer) to explain choices when useful.`;
