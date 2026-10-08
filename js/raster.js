// Raster helpers of GameWorld Painter: shapes drawn into cells, selection masks, outlines, the magic wand.
// Everything works in cell coordinates of the layer grid: cols x rows cells, x to the right, y down; masks and layer data
// are row by row (index y * cols + x).
(function (ME) {
  'use strict';

  let scratch = null;

  function scratchCtx(w, h) {
    if (!scratch) scratch = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const c = scratch.canvas;
    if (c.width < w || c.height < h) { c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); }
    scratch.setTransform(1, 0, 0, 1, 0, 0);
    scratch.filter = 'none';
    scratch.clearRect(0, 0, c.width, c.height);
    return scratch;
  }

  /** Two corners -> [x0, y0, x1, y1] with x0 <= x1, y0 <= y1. */
  function corners([a, b]) {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }

  /**
   * Coverage 0..255 of a shape over the cells, antialiased.
   * shape: {type: 'rect' | 'ellipse' (pts: two corners) | 'polygon' | 'free' (closed) | 'line' (open), pts: [[x, y]],
   *         fill: bool (else the outline), width: outline width, feather: soft edge} — all in cells.
   * Returns {cov: Uint8Array(w * h), x0, y0, x1, y1} (clipped to the grid) or null.
   */
  ME.shapeCoverage = function (cols, rows, shape) {
    const pts = shape.pts;
    if (!pts || pts.length < 2) return null;
    const stroke = !shape.fill || shape.type === 'line';
    const width = Math.max(shape.width || 1, 1), feather = Math.max(shape.feather || 0, 0);
    const pad = (stroke ? width / 2 : 0) + feather * 1.5 + 2;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const [x, y] of pts) { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
    const x0 = Math.max(0, Math.floor(minx - pad)), y0 = Math.max(0, Math.floor(miny - pad));
    const x1 = Math.min(cols, Math.ceil(maxx + pad)), y1 = Math.min(rows, Math.ceil(maxy + pad));
    if (x1 <= x0 || y1 <= y0) return null;
    const w = x1 - x0, h = y1 - y0, ctx = scratchCtx(w, h);
    ctx.setTransform(1, 0, 0, 1, -x0, -y0);
    if (feather > 0) ctx.filter = `blur(${feather / 2}px)`;
    ctx.beginPath();
    if (shape.type === 'rect') {
      const [ax, ay, bx, by] = corners(pts);
      ctx.rect(ax, ay, bx - ax, by - ay);
    } else if (shape.type === 'ellipse') {
      const [ax, ay, bx, by] = corners(pts);
      ctx.ellipse((ax + bx) / 2, (ay + by) / 2, (bx - ax) / 2, (by - ay) / 2, 0, 0, Math.PI * 2);
    } else {
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (shape.type !== 'line') ctx.closePath();
    }
    if (stroke) {
      ctx.lineWidth = width;
      ctx.lineJoin = ctx.lineCap = 'round';
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    } else {
      ctx.fillStyle = '#fff';
      ctx.fill('nonzero');
    }
    const px = ctx.getImageData(0, 0, w, h).data, cov = new Uint8Array(w * h);
    for (let k = 0; k < cov.length; k++) cov[k] = px[k * 4 + 3];
    return { cov, x0, y0, x1, y1 };
  };

  /** A ribbon along points [x, y, width] as one Path2D: a quad per segment and a disc per point, all wound the same
   *  way, so a nonzero fill is their union (round joins and ends; the width may change along it). closed: the last
   *  point joins the first. minWidth: the thinnest ribbon drawn. */
  ME.ribbonPath = function (pts, closed = false, minWidth = 0) {
    const path = new Path2D(), n = pts.length, r = p => Math.max(p[2] || 0, minWidth) / 2;
    const quad = q => {
      let area = 0;
      for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; }
      if (area < 0) q.reverse(); // the same way round as the discs (arc: increasing angles)
      path.moveTo(q[0][0], q[0][1]);
      for (let k = 1; k < 4; k++) path.lineTo(q[k][0], q[k][1]);
      path.closePath();
    };
    for (let k = 0; k < (closed ? n : n - 1); k++) {
      const a = pts[k], b = pts[(k + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
      if (!l) continue;
      const nx = -dy / l, ny = dx / l, ra = r(a), rb = r(b);
      quad([[a[0] + nx * ra, a[1] + ny * ra], [b[0] + nx * rb, b[1] + ny * rb], [b[0] - nx * rb, b[1] - ny * rb], [a[0] - nx * ra, a[1] - ny * ra]]);
    }
    for (const p of pts) {
      const rr = r(p);
      if (rr > 0) { path.moveTo(p[0] + rr, p[1]); path.arc(p[0], p[1], rr, 0, Math.PI * 2); }
    }
    return path;
  };

  /** Cell coverage (like shapeCoverage) of a ribbon along points [x, y, width] in cells; fill: also the inside of a
   *  closed one. Lines thinner than a cell still cover one. */
  ME.ribbonCoverage = function (cols, rows, { pts, closed = false, fill = false, feather = 0 }) {
    if (!pts || pts.length < 2) return null;
    const pad = Math.max(...pts.map(p => p[2] || 1)) / 2 + feather * 1.5 + 2;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const [x, y] of pts) { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); }
    const x0 = Math.max(0, Math.floor(minx - pad)), y0 = Math.max(0, Math.floor(miny - pad));
    const x1 = Math.min(cols, Math.ceil(maxx + pad)), y1 = Math.min(rows, Math.ceil(maxy + pad));
    if (x1 <= x0 || y1 <= y0) return null;
    const w = x1 - x0, h = y1 - y0, ctx = scratchCtx(w, h);
    ctx.setTransform(1, 0, 0, 1, -x0, -y0);
    if (feather > 0) ctx.filter = `blur(${feather / 2}px)`;
    ctx.fillStyle = '#fff';
    if (fill && closed && pts.length > 2) {
      ctx.beginPath();
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill('nonzero');
    }
    ctx.fill(ME.ribbonPath(pts, closed, 1), 'nonzero');
    const px = ctx.getImageData(0, 0, w, h).data, cov = new Uint8Array(w * h);
    for (let k = 0; k < cov.length; k++) cov[k] = px[k * 4 + 3];
    return { cov, x0, y0, x1, y1 };
  };

  /** The union (maximum) of two coverages; either may be null. */
  ME.mergeCoverage = function (a, b) {
    if (!a || !b) return a || b;
    const x0 = Math.min(a.x0, b.x0), y0 = Math.min(a.y0, b.y0), x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1), w = x1 - x0;
    const cov = new Uint8Array(w * (y1 - y0));
    for (const c of [a, b]) {
      const cw = c.x1 - c.x0;
      for (let y = c.y0; y < c.y1; y++) {
        for (let x = c.x0; x < c.x1; x++) {
          const v = c.cov[(y - c.y0) * cw + x - c.x0], k = (y - y0) * w + x - x0;
          if (v > cov[k]) cov[k] = v;
        }
      }
    }
    return { cov, x0, y0, x1, y1 };
  };

  /** Bounding box [x0, y0, x1, y1] and the count of the set cells of a 0/1 mask (row stride N), or null if empty. */
  ME.maskBounds = function (mask, N, H = N) {
    let x0 = N, y0 = H, x1 = 0, y1 = 0, count = 0;
    for (let y = 0; y < H; y++) {
      const r = y * N;
      for (let x = 0; x < N; x++) {
        if (!mask[r + x]) continue;
        count++;
        if (x < x0) x0 = x;
        if (x >= x1) x1 = x + 1;
        if (y < y0) y0 = y;
        y1 = y + 1;
      }
    }
    return count ? { bbox: [x0, y0, x1, y1], count } : null;
  };

  /** The outline of a 0/1 mask (row stride N, H rows) inside bbox, as a Path2D of cell edges. */
  ME.maskOutline = function (mask, N, bbox, H = N) {
    const [x0, y0, x1, y1] = bbox, p = new Path2D();
    const at = (x, y) => (x >= x0 && x < x1 && y >= y0 && y < y1 && y < H ? mask[y * N + x] : 0);
    for (let y = y0; y <= y1; y++) { // horizontal edges between rows y - 1 and y
      let run = -1;
      for (let x = x0; x <= x1; x++) {
        const edge = x < x1 && at(x, y - 1) !== at(x, y);
        if (edge && run < 0) run = x;
        else if (!edge && run >= 0) { p.moveTo(run, y); p.lineTo(x, y); run = -1; }
      }
    }
    for (let x = x0; x <= x1; x++) { // vertical edges between columns x - 1 and x
      let run = -1;
      for (let y = y0; y <= y1; y++) {
        const edge = y < y1 && at(x - 1, y) !== at(x, y);
        if (edge && run < 0) run = y;
        else if (!edge && run >= 0) { p.moveTo(x, run); p.lineTo(x, y); run = -1; }
      }
    }
    return p;
  };

  /**
   * Magic wand: the cells whose value is within tol of the value at start — connected to it (4 neighbors) when
   * contiguous, else anywhere. clip (0/1 mask) limits the region. Returns a 0/1 mask like data (rows of N cells).
   */
  ME.regionOf = function (data, N, start, tol, contiguous, clip) {
    const L = data.length, out = new Uint8Array(L), seed = data[start];
    const ok = i => Math.abs(data[i] - seed) <= tol && (!clip || clip[i]);
    if (!contiguous) {
      for (let i = 0; i < out.length; i++) if (ok(i)) out[i] = 1;
      return out;
    }
    if (!ok(start)) return out;
    const stack = [start];
    out[start] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % N;
      const next = [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, i >= N ? i - N : -1, i + N < L ? i + N : -1];
      for (const j of next) if (j >= 0 && !out[j] && ok(j)) { out[j] = 1; stack.push(j); }
    }
    return out;
  };

  /** Grow (r > 0) or shrink (r < 0) a 0/1 mask of N x R cells by |r| cells (octagon steps: 4 and 8 neighbors in turn). */
  ME.growMask = function (mask, N, R, r) {
    let cur = mask.slice();
    const grow = r > 0, n = Math.abs(r), b = ME.maskBounds(mask, N, R);
    if (!b) return cur;
    const [bx0, by0, bx1, by1] = b.bbox;
    const X0 = Math.max(0, bx0 - n), Y0 = Math.max(0, by0 - n), X1 = Math.min(N, bx1 + n), Y1 = Math.min(R, by1 + n);
    for (let k = 0; k < n; k++) {
      const next = cur.slice(), diag = k % 2 === 1;
      for (let y = Y0; y < Y1; y++) {
        for (let x = X0; x < X1; x++) {
          const i = y * N + x;
          if (!!cur[i] === grow) continue; // grow: look at empty cells; shrink: at set cells
          let hit = false;
          for (let dy = -1; dy <= 1 && !hit; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if ((!dx && !dy) || (!diag && dx && dy)) continue;
              const u = x + dx, v = y + dy;
              const val = u >= 0 && v >= 0 && u < N && v < R ? cur[v * N + u] : 0;
              if (!!val === grow) { hit = true; break; }
            }
          }
          if (hit) next[i] = grow ? 1 : 0;
        }
      }
      cur = next;
    }
    return cur;
  };

  /** Turn a w x h block (and its mask) a quarter clockwise, or flip it: 'cw' | 'h' | 'v'. Returns {data, mask, w, h}. */
  ME.transformBlock = function (data, mask, w, h, op) {
    const W = op === 'cw' ? h : w, H = op === 'cw' ? w : h;
    const d = new data.constructor(W * H), m = new Uint8Array(W * H);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = y * w + x;
        const [X, Y] = op === 'cw' ? [h - 1 - y, x] : op === 'h' ? [w - 1 - x, y] : [x, h - 1 - y];
        d[Y * W + X] = data[s];
        m[Y * W + X] = mask[s];
      }
    }
    return { data: d, mask: m, w: W, h: H };
  };
})(window.ME = window.ME || {});
