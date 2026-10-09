# Regions

Most tools take a `region`: where to look, paint or place. A region is a JSON object; combine them freely.

| Region | Means |
|--------|-------|
| `{"area": "map"}` | The whole map |
| `{"area": "selection"}` | The area the user selected in the app (else the shapes of their selected items) |
| `{"area": "view"}` | What the user sees now |
| `{"rect": [x0, z0, x1, z1]}` | A rectangle |
| `{"circle": [x, z, r]}` | A circle |
| `{"polygon": [[x, z], ...]}` | A polygon |
| `{"zone": "village"}` | A class of the zones layer (case does not matter) |
| `{"layer": "ground", "class": "rock"}` | Cells of a categories class (`"class": ["rock", "sand"]` for several) |
| `{"layer": "trees", "min": 50}` | Cells where a mask is at least 50 % (`"max": 20`: at most) |
| `{"layer": "buildings"}` | Where a layer has something: a mask ≥ 50 %, any class, the shapes of its items |
| `{"height": {"min": 0, "max": 12}}` | Terrain between heights |
| `{"slope": {"max": 25}}` | Terrain not steeper than 25° |
| `{"near": "roads", "distance": 8}` | Within 8 units of a layer |
| `{"near": [x, z], "distance": 30}` | Within 30 units of a point |
| `{"near": {"zone": "village"}, "distance": 20}` | Within 20 units of another region |
| `{"items": {"layer": "buildings", "ids": [3, 4]}}` | The shapes of these items (footprints, closed paths with their inside) |
| `{"items": "selection"}` | The shapes of the items the user selected in the app |
| `{"all": [A, B, ...]}` | In every one (intersection) |
| `{"any": [A, B, ...]}` | In any one (union) |
| `{"not": A}` | Everywhere but A |

## Examples

Forest floor in the selection, away from roads and rocks:

```json
{"all": [{"area": "selection"},
         {"not": {"near": "roads", "distance": 3}},
         {"not": {"layer": "ground", "class": "rock"}},
         {"slope": {"max": 30}}]}
```

The ring around the village, not the village itself:

```json
{"all": [{"near": {"zone": "village"}, "distance": 40}, {"not": {"zone": "village"}}]}
```

Along the trails, 4–15 units off them:

```json
{"all": [{"near": "trails", "distance": 15}, {"not": {"near": "trails", "distance": 4}}]}
```

The middle of a zone (for "stronger closer to the center"): find its center with `describe_region`, then use
`{"all": [{"zone": "village"}, {"circle": [cx, cz, r]}]}` for the inner part and `{"not": {"circle": [...]}}` for the outer.

## Tips

- Check a region before using it: `describe_region` gives its area and contents, and `render_map` with
  `"highlight": region` shows it.
- Regions use the cells of the map (`get_map_info` → `cell`): shapes smaller than a cell may vanish.
- `near` works with masks (≥ 50 % unless `min` is given), categories (with `class`), objects, notes and paths.
