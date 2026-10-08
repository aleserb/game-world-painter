// The map view: world meters <-> screen pixels (x to the right, z down: north is up).
// The screen pixels of the view are "UI pixels": UI_SCALE of a CSS pixel, so texts, markers and handles drawn on the
// map have the size of the rest of the interface (style.css uses the same factor), as the page at 75 % zoom.
(function (ME) {
  'use strict';

  ME.UI_SCALE = 0.75;

  class View {
    constructor(canvas, world) {
      this.canvas = canvas;
      this.world = world;
      this.scale = 4; // screen px per meter
      this.ox = 0; // screen position of the map corner (x0, z0)
      this.oy = 0;
      this.dpr = 1;
      this.w = 1;
      this.h = 1;
    }

    resize() {
      const r = this.canvas.getBoundingClientRect(), ui = ME.UI_SCALE, device = window.devicePixelRatio || 1;
      this.dpr = device * ui; // device pixels per UI pixel
      this.w = Math.max(1, r.width / ui);
      this.h = Math.max(1, r.height / ui);
      this.canvas.width = Math.round(r.width * device);
      this.canvas.height = Math.round(r.height * device);
    }

    toScreen(x, z) {
      return [(x - this.world.x0) * this.scale + this.ox, (z - this.world.z0) * this.scale + this.oy];
    }

    toWorld(sx, sy) {
      return [(sx - this.ox) / this.scale + this.world.x0, (sy - this.oy) / this.scale + this.world.z0];
    }

    /** Screen px per raster cell. */
    cellPx() { return this.scale * this.world.width / this.world.cols; }

    setScreenTransform(ctx) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }

    setWorldTransform(ctx) {
      const s = this.scale * this.dpr;
      ctx.setTransform(s, 0, 0, s, this.dpr * (this.ox - this.world.x0 * this.scale), this.dpr * (this.oy - this.world.z0 * this.scale));
    }

    setCellTransform(ctx) {
      const c = this.cellPx() * this.dpr;
      ctx.setTransform(c, 0, 0, c, this.dpr * this.ox, this.dpr * this.oy);
    }

    fit() {
      const m = 16, W = this.world.width, H = this.world.height;
      this.scale = Math.max(0.2, Math.min((this.w - 2 * m) / W, (this.h - 2 * m) / H));
      this.ox = (this.w - W * this.scale) / 2;
      this.oy = (this.h - H * this.scale) / 2;
    }

    zoomAt(factor, sx, sy) {
      const s = Math.max(0.5, Math.min(120, this.scale * factor));
      const [x, z] = this.toWorld(sx, sy);
      this.scale = s;
      this.ox = sx - (x - this.world.x0) * s;
      this.oy = sy - (z - this.world.z0) * s;
    }

    pan(dx, dy) {
      this.ox += dx;
      this.oy += dy;
    }
  }

  ME.View = View;
})(window.ME = window.ME || {});
