# Recipes

Each recipe follows the same loop: orient (`get_map_info`, `get_user_context`), look and measure, change in a few
calls, check, show (`show_on_map`) and explain. Adapt the layer ids, kinds and numbers to the map (and its unit).

## Placing things

**Trees in the selected area, avoiding roads and rocks**

1. `describe_region` of `{"area":"selection"}` → find the tree layer and its kinds (`get_map_info`).
2. If trees are objects: use `scatter_items` with:
   - a region of the selection minus roads, rocks and water (see regions.md);
   - `kinds` weighted from the existing tree kinds and `"spacing"` of about 4–6 m;
   - `"density":{"layer":"forest"}` if there is a forest mask;
   - `"keep_away":[{"layer":"buildings","distance":4}]`.

   If trees are a mask: `paint_layer` with `"value":80`, `"noise":{"amount":30,"scale":15}` and `"feather":3`.
3. `analyze_items` (spacing) or `describe_region` (coverage), then `show_on_map`.

**Monster packs of 3–5 in a zone, stronger ones closer to the center**

1. `describe_region` `{"zone":"village"}` → its center and size; `find_items` on the enemies layer → kinds, props (`pack_size`, `level`…).
2. Split the zone into an inner circle and the rest (regions.md).
3. Place each part with `scatter_items`:
   - the inner part with strong kinds, the outer part with weak ones;
   - `"spacing"` of 25–40 m between packs, and `"keep_away"` from the start area and roads if needed;
   - if the map stores one object per pack, use `"random_props":{"pack_size":[3,5]}`;
   - if each monster is an object, use `"groups":{"size":[3,5],"radius":5}`.
4. `analyze_items` to check spacing.

**Chests along trails, at least 20 m apart**

1. Use the region `{"all":[{"near":"trails","distance":10}, {"not":{"near":"trails","distance":3}}]}`.
2. Call `scatter_items` with `"spacing":20` (existing chests keep the spacing too) and a `count`.
3. Run `analyze_items` with `"min_distance":20` to confirm there are no pairs.

**Shelter in open areas**

1. Run `find_spots` with `"metric":"open"` and `layers` = cover layers. It gives the largest open spots; the value is the distance to cover.
2. In each big spot, add cover with `scatter_items`: rocks, bushes, ruins, or `kind` from the map's props; use small counts and a `circle` region around the spot.
3. Run `find_spots` again: the open distances shrink.

## Painting and terrain

**Grass about 70 % in the forest zone**: `paint_layer` with:
- `layer` grass, `region` `{"zone":"woods"}`;
- `"value":70`, `"noise":{"amount":20,"scale":10}`, `"feather":4`, `"mode":"set"`;
- or `"mode":"max"` to only add.

**A smooth slope from the village to the river**: `edit_terrain` with `"op":"slope"`, `"from":{"zone":"village"}` and `"to":{"near":"rivers","distance":6}`.
- Give `height` for either end to set it.
- The corridor between them is shaped; `feather` blends the edges.
- Check the result with `describe_region` (`slope_mean_deg`).

**Flatten for a camp or building**: use `edit_terrain` `"op":"flatten"` on a circle; find the place first with `find_spots` `"metric":"flat"`.

## Checking and fixing

**Where the player can get stuck**: `analyze_walkability`, optionally with `start` at the player start. It reports:
- **pockets**: walkable ground cut off from the rest;
- **narrow passages**;
- **unreachable items**.

Fix them by connecting pockets (`edit_terrain` to lower or smooth a slope, `paint_layer` to clear a blocking mask) or by moving items (`update_items` `move`). Run it again to confirm.

**Are all buildings connected by roads**:
1. Run `find_items` on buildings with `"measure":["roads"]` to get the distance to the nearest road.
2. For the far ones, `find_route` from the building to the nearest road point with `"prefer":["roads"]` and `"add_to":{"layer":"road_lines","kind":"road"}`.
3. Or paint a road mask along the route.

**Safe routes from A to B**: `find_route` with:
- `"avoid":[{"layer":"enemies","distance":30}]` and `"prefer":["roads","trails"]`;
- different `avoid` distances, or `via` points as separate legs, for several alternatives;
- add each route to a vector layer.

**Even out enemies but keep groups**:
1. Run `analyze_items` with `cluster_distance` = the pack radius. It gives the groups and the largest gaps.
2. Move whole groups (every id of the group, the same `move`) from crowded places towards the gaps with `update_items`.

## Bridges, buildings and other placed things

**A bridge across a river** (in the selected area or near a road):
1. `find_crossing` (region: the selection; `near` the road's end if the bridge should continue a road). Each result
   has the bank points `a` and `b` on dry land, straight across the flow, the length, the water width and the heights.
2. Look at `existing_crossings` (and `get_map_info` → `kind_sizes`) for the kind, layer and width bridges have here.
3. `add_items` {"kind": "stone_bridge", "a": a, "b": b, "d": 3} — no yaw to compute.
4. `check_change`: in AFTER the line a→b crosses the river, both ends on land, nothing overlaps it. A path to it:
   `find_route` from a to the road (or `add_items` on the roads layer).
5. "A crossing on foot" without a bridge (a ford): `edit_terrain` flatten just above the water along the same a→b strip,
   then `paint_layer` erase on the water there; check with `find_route` from a to b.

**A house with a yard** ("one house in the north part with props"):
1. Where: `describe_region` of the part asked for; a flat, dry, open place away from roads, water and other objects
   (`find_spots` "flat" or "empty" with the water, trees and buildings layers, in that part only). Keep 5 m or more
   from a bridge or a road end so paths stay free.
2. `add_items` with the usual size of the kind (`kind_sizes`), `towards` the road or the bridge (its long side faces
   the way people come).
3. `check_change` → uneven ground: `edit_terrain` flatten over `{"items": {"layer": …, "ids": [id]}}`.
4. Props around it: `scatter_items` in a ring around the house (`{"all": [{"near": [x, z], "distance": 8}, {"not":
   {"items": {"layer": "buildings", "ids": [id]}}}]}`), `keep_away` from the buildings 1 m and the water 2 m, a few kinds.
5. `check_change` again: nothing inside the house, nothing in the water, the bridge free.

## World building

**Check a zone and add what is missing (buildings, roads, lamps)**:
1. Run `describe_region` on the zone and `render_map` with the zone highlighted.
2. Compare with similar zones (`describe_region` on them): count kinds per area.
3. Add what is missing:
   - buildings with `add_items` at flat spots (`find_spots` `flat`), not on roads;
   - roads with `find_route` between buildings;
   - lamps with `scatter_items` along roads (region near roads, spacing 15–25).

**An abandoned village** (several steps: one change):
1. Run `find_items` on the village buildings (or the ones the user selected: `get_user_context`).
2. `begin_change` with a title ("Abandoned village: ruins, rubble, overgrowth") and why.
3. Delete a part with `delete_items`, chosen by the user's wish or randomly. Or change some to ruins with `update_items` (kind, props).
4. Add `scatter_items` of rocks and debris near the ruins.
5. Overgrow with `paint_layer` (bushes and grass `"mode":"max"` with noise, also on roads).
6. `end_change` with a summary in numbers; each step above with a `comment`. Explain lasting reasons with notes.

**Do something with the objects the user selected** ("make these birches", "move these to the river"):
1. `get_user_context` → `selected_items` (layer, kinds, ids; all ids when there are many).
2. Change them by id (`update_items`, `delete_items`), or use `{"items": "selection"}` / `{"area": "selection"}` as a region.

**Points of interest worth showing**:
- `find_spots` `high` gives viewpoints, `enclosed` gives hidden places, `open` gives clearings, and `far_from` the roads gives remote places.
- Combine these with the items: chests, ruins, water.
- Add notes (`add_items` on the notes layer) with a short reason each.

**A starting area for the player**:
- Use flat, open, safe ground (`find_spots` `flat`, `analyze_walkability`).
- Put no strong enemies within 60–80 m (`find_items` `near`, then `update_items` to move them).
- Make a road out and a landmark in view.
- Add a note for the start.

**More danger in the north than in the south**:
1. Split the map with rects: north is small z.
2. Raise enemy counts and levels (`props`) in the north with `scatter_items` and `update_items`, and lower them in the south.
3. Check the result with `analyze_items` per half.

**Level 5–10 area**:
1. Set `props.level` on enemies in the region with `update_items`, using random values in the range.
2. Adjust the pack sizes, and add chests of matching kinds.
3. Note the level range.

**More variety without changing the zones**: make changes inside each zone only:
- mix kinds;
- vary densities with noise;
- add small clearings (`paint_layer` `erase` with a small `circle`) and groves (`scatter_items` with `groups`).
