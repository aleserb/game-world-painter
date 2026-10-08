// Units of length. A map keeps plain numbers in its own unit (metadata.json "unit", meters by default): coordinates,
// sizes and heights are written as they are, so they match the game engine one to one. The unit names the numbers and
// sets the defaults of the tool (brush sizes, steps, the 3D camera) through k, about how many units make a meter.
// perMeter: the exact factor, to convert a map from one unit to another (pixels and plain units have none).
// presets: [width, height, cell] of the map size dialog; cells: the cell sizes it offers.
(function (ME) {
  'use strict';

  const METRIC = { presets: [[128, 128, 0.25], [256, 256, 0.25], [512, 512, 0.5], [512, 256, 0.5], [1024, 1024, 1]], cells: [0.25, 0.4, 0.5, 1, 2] };

  ME.UNITS = {
    m: { label: 'm', name: 'Meters', note: 'Godot, Unity, Blender', k: 1, perMeter: 1, ...METRIC },
    cm: {
      label: 'cm', name: 'Centimeters', note: 'Unreal Engine', k: 100, perMeter: 100,
      presets: [[12800, 12800, 25], [25600, 25600, 25], [51200, 51200, 50], [51200, 25600, 50], [102400, 102400, 100]], cells: [10, 25, 40, 50, 100, 200],
    },
    ft: {
      label: 'ft', name: 'Feet', note: 'tabletop maps', k: 4, perMeter: 1 / 0.3048,
      presets: [[400, 400, 0.5], [800, 800, 1], [1600, 1600, 2], [1600, 800, 2], [3200, 3200, 2]], cells: [0.5, 1, 2, 2.5, 5],
    },
    in: {
      label: 'in', name: 'Inches', note: 'Source engine (Hammer units)', k: 40, perMeter: 1 / 0.0254,
      presets: [[4096, 4096, 4], [8192, 8192, 8], [16384, 16384, 16], [16384, 8192, 16], [32768, 32768, 32]], cells: [1, 2, 4, 8, 16, 32, 64],
    },
    px: {
      label: 'px', name: 'Pixels', note: '2D games and tile maps', k: 32, perMeter: null, pow2: true,
      presets: [[512, 512, 1], [1024, 1024, 1], [2048, 2048, 2], [2048, 1024, 2], [4096, 4096, 4]], cells: [1, 2, 4, 8, 16, 32],
    },
    u: { label: 'u', name: 'Units', note: 'any other scale', k: 1, perMeter: null, ...METRIC },
  };

  /** The unit of a map by its id ("m" when there is none); an unknown id is a plain unit with that name. */
  ME.unitOf = id => (id == null || id === '' ? ME.UNITS.m : ME.UNITS[id] || { ...ME.UNITS.u, label: String(id), name: String(id), note: '' });

  /** The factor that converts numbers from one unit to another, or null when there is none (pixels, plain units). */
  ME.unitFactor = (from, to) => {
    const a = ME.unitOf(from).perMeter, b = ME.unitOf(to).perMeter;
    return from === to ? 1 : a && b ? b / a : null;
  };

  /** x rounded to 1, 2, 2.5 or 5 times a power of ten: a tidy default (0.25 m, 25 cm, 10 in, 8 px...). */
  ME.nice = x => {
    if (!(x > 0)) return x;
    const p = 10 ** Math.floor(Math.log10(x)), f = x / p;
    const m = [1, 2, 2.5, 5, 10].reduce((a, b) => (Math.abs(Math.log(b / f)) < Math.abs(Math.log(a / f)) ? b : a));
    return +(m * p).toPrecision(6);
  };

  /** The smallest step of 1, 2 or 5 times a power of ten (a power of two for pow2 units) that is at least x. */
  ME.stepAtLeast = (x, pow2 = false) => {
    if (!(x > 0)) return 1;
    if (pow2) return 2 ** Math.ceil(Math.log2(x) - 1e-9);
    const p = 10 ** Math.floor(Math.log10(x)), f = x / p;
    return +([1, 2, 5, 10].find(m => m >= f - 1e-9) * p).toPrecision(6);
  };

  /** Decimals for showing lengths: `base` for meters, fewer for small units (none for cm, in, px). */
  ME.unitDigits = (unit, base) => Math.max(0, base - Math.round(Math.log10(unit.k)));
})(window.ME = window.ME || {});
