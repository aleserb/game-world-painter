// 3D preview of the terrain (WebGL2, no libraries): the height layer as a lit mesh with the visible layers (or the
// height colors) draped over it and a pin under the 2D cursor. It follows the layers while they are
// painted. Orbit camera: drag to turn, right drag or Shift+drag to move, wheel to zoom.
// Without WebGL2 (the GPU is off in the browser) a software view draws the same terrain column by column on a 2D
// canvas, with a parallel (orthographic) projection.
(function (ME) {
  'use strict';

  const TERRAIN_VS = `#version 300 es
precision highp float;
precision highp int;
in vec2 a_grid;                    // mesh vertex (i, j)
uniform highp sampler2D u_height;  // R32F, cols x rows: the height of every cell, m
uniform ivec2 u_cells;             // cols, rows
uniform float u_step;              // cells per mesh step
uniform vec4 u_world;              // x0, z0, width, height (m)
uniform float u_exag;              // height scale
uniform mat4 u_mvp;
out vec2 v_uv;
out vec3 v_normal;
out vec3 v_pos;
float H(ivec2 c) { return texelFetch(u_height, clamp(c, ivec2(0), u_cells - 1), 0).r; }
void main() {
  ivec2 c = ivec2(min(a_grid * u_step, vec2(u_cells - 1)));
  float cell = u_world.z / float(u_cells.x);
  float h = H(c);
  float hx = H(c + ivec2(1, 0)) - H(c - ivec2(1, 0));
  float hz = H(c + ivec2(0, 1)) - H(c - ivec2(0, 1));
  v_normal = vec3(-hx * u_exag, 2.0 * cell, -hz * u_exag);
  v_uv = (vec2(c) + 0.5) / vec2(u_cells);
  v_pos = vec3(u_world.x + v_uv.x * u_world.z, h * u_exag, u_world.y + v_uv.y * u_world.w);
  gl_Position = u_mvp * vec4(v_pos, 1.0);
}`;

  const TERRAIN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_normal;
in vec3 v_pos;
uniform sampler2D u_map;
uniform vec3 u_light;
uniform vec3 u_eye;
uniform float u_fog;
out vec4 o;
void main() {
  vec3 n = normalize(v_normal);
  float lambert = max(dot(n, u_light), 0.0);
  vec3 col = texture(u_map, v_uv).rgb * (0.40 + 0.78 * lambert);
  float d = length(v_pos - u_eye);
  col = mix(col, vec3(0.07, 0.065, 0.09), clamp((d - u_fog) / (u_fog * 2.5), 0.0, 0.55));
  o = vec4(col, 1.0);
}`;

  const FLAT_VS = `#version 300 es
in vec3 a_pos;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); }`;

  const FLAT_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 o;
void main() { o = u_color; }`;

  const CLOSE = { pitch: 45, dist: 20, fov: 40 }; // a close view, as a game camera above a character (dist: m)
  const TEX = 2048; // px of the draped map
  const LIGHT = (() => { const L = [-0.5, 0.78, -0.38], l = Math.hypot(...L); return L.map(v => v / l); })();

  function program(gl, vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let k = 0; k < n; k++) { const name = gl.getActiveUniform(p, k).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }

  // column-major 4x4 matrices
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }

  function lookAt(e, t, up) {
    let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1];
  }

  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }

  class View3D {
    /** panel: the element with a canvas; app: {world(), heightLayer(), layers(), metaVersion(), cursor(), viewCenter(),
     *  unitK() (units per meter)}. */
    constructor(panel, app) {
      this.panel = panel;
      this.canvas = panel.querySelector('canvas');
      this.app = app;
      this.isOpen = false;
      this.exag = 1;
      this.texMode = 'map';
      this.cam = { yaw: 0, pitch: 0.7, dist: 300, target: [0, 0, 0], fov: CLOSE.fov };
      this.seen = {}; // what is on the GPU: height layer + version, map signature, cursor
      this.composite = document.createElement('canvas');
      this.composite.width = this.composite.height = TEX;
      this.drawQueued = false;
      this.mapTimer = null;
      this.lastMap = 0;
      this.gl = null;
      this.events();
    }

    init() {
      if (this.gl || this.soft) return true;
      let reason = '', gl = null;
      const onError = e => { reason = e.statusMessage || reason; };
      this.canvas.addEventListener('webglcontextcreationerror', onError);
      try { gl = this.canvas.getContext('webgl2', { antialias: true }); } catch (err) { reason = err.message; }
      this.canvas.removeEventListener('webglcontextcreationerror', onError);
      if (gl) {
        try {
          this.terrain = program(gl, TERRAIN_VS, TERRAIN_FS);
          this.flat = program(gl, FLAT_VS, FLAT_FS);
          this.gl = gl;
        } catch (err) { reason = err.message; }
      }
      if (!this.gl) return this.useSoftware(reason);
      this.heightTex = gl.createTexture();
      this.mapTex = gl.createTexture();
      this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      this.flatBuf = gl.createBuffer();
      this.meshKey = '';
      this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.useSoftware('the GPU context was lost'); this.tick(); });
      new ResizeObserver(() => this.requestDraw()).observe(this.canvas);
      return true;
    }

    /** No WebGL2: draw on a 2D canvas (a new one: a canvas that tried WebGL keeps no 2D context). */
    useSoftware(reason) {
      this.gl = null;
      this.soft = true;
      const cv = document.createElement('canvas');
      this.canvas.replaceWith(cv);
      this.canvas = cv;
      this.ctx2d = cv.getContext('2d');
      this.events();
      new ResizeObserver(() => this.requestDraw()).observe(cv);
      this.seen = {};
      const why = reason ? ` (${reason.replace(/\s+/g, ' ').slice(0, 120)})` : '';
      this.panel.querySelector('.v3-note').textContent = `WebGL2 is off in this browser${why}: a simpler software view, without perspective. ` +
        'Chrome turns WebGL off after its GPU process crashes, until it is restarted (chrome://restart); also check that ' +
        '“Use graphics acceleration” is on in chrome://settings/system.';
      this.panel.querySelector('.v3-note').hidden = false;
      return true;
    }

    // --- open / close

    toggle() { if (this.isOpen) this.close(); else this.open(); }

    open() {
      this.isOpen = true;
      this.panel.hidden = false;
      this.init();
      if (!this.placed) { this.preset('overview'); this.placed = true; }
      this.seen = {};
      this.tick();
      this.timer = setInterval(() => this.tick(), 200);
      this.onToggle?.(true);
    }

    close() {
      this.isOpen = false;
      this.panel.hidden = true;
      clearInterval(this.timer);
      this.onToggle?.(false);
    }

    /** The project changed (another map, another size): upload everything again and look at the whole map. */
    reset() {
      this.seen = {};
      this.placed = false;
      if (this.isOpen) { this.preset('overview'); this.placed = true; this.tick(); }
    }

    // --- following the layers

    tick() {
      if (!this.isOpen || (!this.gl && !this.soft)) return;
      const world = this.app.world(), H = this.app.heightLayer();
      const msg = this.panel.querySelector('.v3-msg');
      msg.textContent = !world ? 'No map open' : H ? '' : 'No height layer: the ground is flat';
      if (!world) return;
      const hKey = H ? `${H.id}:${H.version}:${world.cols}x${world.rows}` : `flat:${world.cols}x${world.rows}`;
      if (hKey !== this.seen.height) { this.uploadHeight(H, world); this.seen.height = hKey; this.requestDraw(); }
      const mKey = this.mapSignature(H);
      if (mKey !== this.seen.map) {
        const wait = 400 - (performance.now() - this.lastMap);
        clearTimeout(this.mapTimer);
        if (wait <= 0 || !this.seen.map) this.uploadMap(mKey, H);
        else this.mapTimer = setTimeout(() => this.uploadMap(this.mapSignature(this.app.heightLayer()), this.app.heightLayer()), wait);
      }
      this.cursorTick();
    }

    /** The 2D cursor moved: move the pin. */
    cursorTick() {
      if (!this.isOpen) return;
      const c = this.app.cursor(), key = c ? c.map(v => v.toFixed(2)).join() : '';
      if (key !== this.seen.cursor) { this.seen.cursor = key; this.requestDraw(); }
    }

    mapSignature(H) {
      if (this.texMode === 'height') return `h:${H ? H.id + ':' + H.version + ':' + H.meta.contour : ''}`;
      return `m:${this.app.metaVersion()}:` + this.app.layers().map(l => `${l.id}.${l.version}.${l.meta.visible ? 1 : 0}.${l.meta.opacity}.${l.meta.color || ''}`).join('|');
    }

    uploadHeight(H, world) {
      const gl = this.gl, N = world.cols, R = world.rows;
      const data = H && H.data.length === N * R ? H.data : new Float32Array(N * R);
      const heightOf = (x, z) => { // meters at a world point (for the camera target and the cursor pin)
        const i = Math.floor((x - world.x0) / world.width * N), j = Math.floor((z - world.z0) / world.height * R);
        return i >= 0 && j >= 0 && i < N && j < R ? data[j * N + i] : 0;
      };
      if (this.soft) {
        this.sd = { ...this.sd, data, N, R, world };
        this.heightOf = heightOf;
        this.softShade();
        return;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, N, R, 0, gl.RED, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.heightOf = heightOf;
      this.ensureMesh(N, R);
    }

    ensureMesh(N, R) {
      const step = Math.max(1, Math.ceil(Math.max(N, R) / 1024)), MX = Math.ceil((N - 1) / step), MY = Math.ceil((R - 1) / step);
      const key = `${N}x${R}:${step}`;
      if (key === this.meshKey) return;
      const gl = this.gl, V = MX + 1, grid = new Float32Array(V * (MY + 1) * 2), idx = new Uint32Array(MX * MY * 6);
      for (let j = 0, k = 0; j <= MY; j++) for (let i = 0; i < V; i++) { grid[k++] = i; grid[k++] = j; }
      for (let j = 0, k = 0; j < MY; j++) {
        for (let i = 0; i < MX; i++) {
          const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
          idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
        }
      }
      if (!this.vao) { this.vao = gl.createVertexArray(); this.gridBuf = gl.createBuffer(); this.idxBuf = gl.createBuffer(); }
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
      gl.bufferData(gl.ARRAY_BUFFER, grid, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(this.terrain.p, 'a_grid');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.mesh = { N, R, step, count: idx.length };
      this.meshKey = key;
    }

    /** Draw the visible layers seen from above (as in the 2D view, without notes and labels) into the map texture. */
    uploadMap(key, H) {
      const world = this.app.world();
      if (!world || (!this.gl && !this.soft)) return;
      const gl = this.gl, big = Math.max(world.width, world.height); // the texture keeps the shape of the map
      const TW = Math.max(1, Math.round(TEX * world.width / big)), TH = Math.max(1, Math.round(TEX * world.height / big));
      let src;
      if (this.texMode === 'height' && H) src = H.canvas;
      else {
        if (this.composite.width !== TW || this.composite.height !== TH) { this.composite.width = TW; this.composite.height = TH; }
        const ctx = this.composite.getContext('2d', { willReadFrequently: this.soft }), v = new ME.View(this.composite, world);
        Object.assign(v, { dpr: 1, w: TW, h: TH, scale: TW / world.width, ox: 0, oy: 0, texture: true });
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#8a8478';
        ctx.fillRect(0, 0, TW, TH);
        for (const l of this.app.layers()) {
          if (!l.meta.visible || l.type === 'notes') continue;
          ctx.save();
          ctx.globalAlpha = l.meta.opacity ?? 1;
          l.draw(ctx, v, null);
          ctx.restore();
        }
        src = this.composite;
      }
      if (this.soft) {
        const c = src === this.composite ? this.composite.getContext('2d') : src.getContext('2d');
        this.sd = { ...this.sd, tex: c.getImageData(0, 0, src.width, src.height).data, TW: src.width, TH: src.height };
        this.seen.map = key;
        this.lastMap = performance.now();
        this.requestDraw();
        return;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      this.seen.map = key;
      this.lastMap = performance.now();
      this.requestDraw();
    }

    // --- camera

    groundAt(x, z) { return (this.heightOf ? this.heightOf(x, z) : 0) * this.exag; }

    setExag(v) {
      this.exag = v;
      if (this.soft) this.softShade();
      const t = this.cam.target;
      t[1] = this.groundAt(t[0], t[2]);
      this.requestDraw();
    }

    /** Units of the map per meter (1 for meters, 100 for centimeters...). */
    k() { return (this.app.unitK && this.app.unitK()) || 1; }

    /** 'overview' (the whole map), 'top' (straight down), 'close' (a close view at the middle of the 2D view). */
    preset(name) {
      const world = this.app.world();
      if (!world) return;
      const c = this.cam, [vx, vz] = this.app.viewCenter(), big = Math.max(world.width, world.height);
      const mid = [world.x0 + world.width / 2, 0, world.z0 + world.height / 2];
      c.yaw = 0;
      c.fov = CLOSE.fov;
      if (name === 'close') {
        c.pitch = CLOSE.pitch * Math.PI / 180; c.dist = CLOSE.dist * this.k(); c.target = [vx, 0, vz];
      } else if (name === 'top') {
        c.pitch = 89.5 * Math.PI / 180; c.dist = big / (2 * Math.tan(c.fov * Math.PI / 360)) * 1.05;
        c.target = mid;
      } else {
        c.pitch = 0.72; c.dist = big * 1.35; c.target = mid;
      }
      c.target[1] = name === 'overview' || name === 'top' ? 0 : this.groundAt(c.target[0], c.target[2]);
      this.camMoved(name === 'close' ? 'close' : name === 'top' ? 'top' : 'overview');
      this.requestDraw();
    }

    /** The camera is at a preset (its name) or was moved by hand (null): the buttons show it. */
    camMoved(name = null) {
      if (this.camName === name) return;
      this.camName = name;
      this.onCamera?.(name);
    }

    eye() {
      const c = this.cam, cp = Math.cos(c.pitch);
      return [c.target[0] + c.dist * Math.sin(c.yaw) * cp, c.target[1] + c.dist * Math.sin(c.pitch), c.target[2] + c.dist * Math.cos(c.yaw) * cp];
    }

    events() {
      const cv = this.canvas;
      let drag = null;
      cv.addEventListener('contextmenu', e => e.preventDefault());
      cv.addEventListener('pointerdown', e => {
        cv.setPointerCapture(e.pointerId);
        drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey };
        this.dragging = true;
      });
      cv.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y, c = this.cam;
        drag.x = e.clientX; drag.y = e.clientY;
        if (dx || dy) this.camMoved();
        if (drag.pan) {
          const k = c.dist * Math.tan(c.fov * Math.PI / 360) * 2 / Math.max(cv.clientHeight, 1);
          const right = [Math.cos(c.yaw), -Math.sin(c.yaw)], fwd = [-Math.sin(c.yaw), -Math.cos(c.yaw)];
          c.target[0] += (-right[0] * dx + fwd[0] * dy / Math.max(Math.sin(c.pitch), 0.3)) * k;
          c.target[2] += (-right[1] * dx + fwd[1] * dy / Math.max(Math.sin(c.pitch), 0.3)) * k;
          c.target[1] = this.groundAt(c.target[0], c.target[2]);
        } else {
          c.yaw -= dx * 0.006;
          c.pitch = Math.max(0.04, Math.min(1.56, c.pitch + dy * 0.006));
        }
        this.requestDraw();
      });
      const end = () => { drag = null; this.dragging = false; this.requestDraw(); };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        clearTimeout(this.wheelTimer);
        this.dragging = true;
        this.wheelTimer = setTimeout(() => { this.dragging = false; this.requestDraw(); }, 200);
        const world = this.app.world(), dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        this.camMoved();
        this.cam.dist = Math.max(3 * this.k(), Math.min((world ? Math.max(world.width, world.height) : 500) * 4, this.cam.dist * Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015))));
        this.requestDraw();
      }, { passive: false });
      cv.addEventListener('dblclick', () => this.preset('overview'));
    }

    // --- drawing

    requestDraw() {
      if (this.drawQueued || !this.isOpen) return;
      this.drawQueued = true;
      requestAnimationFrame(() => { this.drawQueued = false; this.draw(); });
    }

    draw() {
      if (this.soft) { this.drawSoft(); return; }
      const gl = this.gl, world = this.app.world();
      if (!gl || !world || !this.mesh) return;
      const cv = this.canvas, dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0.06, 0.05, 0.075, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      const c = this.cam, eye = this.eye();
      const near = Math.max(0.05 * this.k(), c.dist * 0.01), far = c.dist * 4 + Math.max(world.width, world.height) * 3;
      const mvp = mul(perspective(c.fov * Math.PI / 180, w / h, near, far), lookAt(eye, c.target, [0, 1, 0]));
      // terrain
      const T = this.terrain;
      gl.useProgram(T.p);
      gl.uniformMatrix4fv(T.u.u_mvp, false, mvp);
      gl.uniform2i(T.u.u_cells, this.mesh.N, this.mesh.R);
      gl.uniform1f(T.u.u_step, this.mesh.step);
      gl.uniform4f(T.u.u_world, world.x0, world.z0, world.width, world.height);
      gl.uniform1f(T.u.u_exag, this.exag);
      const L = [-0.5, 0.78, -0.38], ll = Math.hypot(...L);
      gl.uniform3f(T.u.u_light, L[0] / ll, L[1] / ll, L[2] / ll);
      gl.uniform3f(T.u.u_eye, ...eye);
      gl.uniform1f(T.u.u_fog, c.dist * 1.6);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
      gl.uniform1i(T.u.u_height, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
      gl.uniform1i(T.u.u_map, 1);
      gl.bindVertexArray(this.vao);
      gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
      // the cursor pin
      const F = this.flat, pos = gl.getAttribLocation(F.p, 'a_pos');
      gl.useProgram(F.p);
      gl.uniformMatrix4fv(F.u.u_mvp, false, mvp);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuf);
      gl.enableVertexAttribArray(pos);
      gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 0, 0);
      const cur = this.app.cursor();
      if (cur) {
        const g = this.groundAt(cur[0], cur[1]), top = g + Math.max(1.5 * this.k(), c.dist * 0.06), r = Math.max(0.4 * this.k(), c.dist * 0.012);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
          cur[0], g, cur[1], cur[0], top, cur[1],
          cur[0] - r, g, cur[1], cur[0] + r, g, cur[1], cur[0], g, cur[1] - r, cur[0], g, cur[1] + r,
        ]), gl.DYNAMIC_DRAW);
        gl.disable(gl.DEPTH_TEST);
        gl.uniform4f(F.u.u_color, 0.94, 0.64, 0.37, 1);
        gl.drawArrays(gl.LINES, 0, 6);
        gl.enable(gl.DEPTH_TEST);
      }
    }
  }

  // --- the software view: a parallel projection drawn column by column, front to back (each screen column is a
  // vertical plane of the world, so a column only fills what is above what it already drew)
  Object.assign(View3D.prototype, {
    /** The light on every cell and the height range, for the heights and the height scale. */
    softShade() {
      const sd = this.sd;
      if (!sd || !sd.data) return;
      const { data, N, R, world } = sd, cell = world.width / N, k = this.exag / (2 * cell);
      const shade = sd.shade && sd.shade.length === N * R ? sd.shade : new Float32Array(N * R);
      let lo = Infinity, hi = -Infinity;
      for (let j = 0; j < R; j++) {
        for (let i = 0; i < N; i++) {
          const p = j * N + i, h = data[p];
          if (h < lo) lo = h;
          if (h > hi) hi = h;
          const hx = (data[i < N - 1 ? p + 1 : p] - data[i > 0 ? p - 1 : p]) * k;
          const hz = (data[j < R - 1 ? p + N : p] - data[j > 0 ? p - N : p]) * k;
          const lam = (-hx * LIGHT[0] + LIGHT[1] - hz * LIGHT[2]) / Math.hypot(hx, 1, hz);
          shade[p] = 0.4 + 0.78 * Math.max(lam, 0);
        }
      }
      sd.shade = shade;
      sd.lo = lo * this.exag;
      sd.hi = hi * this.exag;
      this.requestDraw();
    },

    drawSoft() {
      const world = this.app.world(), sd = this.sd, cv = this.canvas, ctx = this.ctx2d;
      if (!world || !sd || !sd.shade || !sd.tex) return;
      const q = this.dragging ? 0.5 : 1, W = Math.max(1, Math.round(cv.clientWidth * q)), H = Math.max(1, Math.round(cv.clientHeight * q));
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      if (!this.img || this.img.width !== W || this.img.height !== H) this.img = ctx.createImageData(W, H);
      const px = new Uint32Array(this.img.data.buffer);
      px.fill(0xff130d0f);
      const { data, shade, tex, TW, TH, N, R } = sd, c = this.cam, ex = this.exag;
      const sp = Math.max(Math.sin(c.pitch), 0.03), cp = Math.cos(c.pitch);
      const s = H / (2 * c.dist * Math.tan(c.fov * Math.PI / 360)), cx = W / 2, cy = H / 2, [tx, ty, tz] = c.target;
      const Rx = Math.cos(c.yaw), Rz = -Math.sin(c.yaw), Fx = -Math.sin(c.yaw), Fz = -Math.cos(c.yaw);
      const x0 = world.x0, z0 = world.z0, WX = world.width, WZ = world.height, cell = WX / N, base = sd.lo - 3 * ex;
      const tLo = ((cy - H) / s - (sd.hi - ty) * cp) / sp, tHi = (cy / s - (sd.lo - ty) * cp) / sp;
      const step = Math.max(cell * 0.35, Math.min(cell, 0.8 / (s * sp)));
      const smooth = s > TW / WX; // closer than a texel per pixel: blend the texels
      for (let sx = 0; sx < W; sx++) {
        const u = (sx + 0.5 - cx) / s, ax = tx + u * Rx, az = tz + u * Rz;
        let ta = tLo, tb = tHi; // the part of the column's line on the map
        if (Math.abs(Fx) > 1e-9) { const t1 = (x0 - ax) / Fx, t2 = (x0 + WX - ax) / Fx; ta = Math.max(ta, Math.min(t1, t2)); tb = Math.min(tb, Math.max(t1, t2)); } else if (ax < x0 || ax >= x0 + WX) continue;
        if (Math.abs(Fz) > 1e-9) { const t1 = (z0 - az) / Fz, t2 = (z0 + WZ - az) / Fz; ta = Math.max(ta, Math.min(t1, t2)); tb = Math.min(tb, Math.max(t1, t2)); } else if (az < z0 || az >= z0 + WZ) continue;
        if (ta >= tb) continue;
        let ybuf = H, first = true;
        for (let t = ta + 1e-6; t < tb; t += step) {
          const wx = ax + t * Fx, wz = az + t * Fz;
          const fi = Math.min(Math.max((wx - x0) / cell - 0.5, 0), N - 1.001), fj = Math.min(Math.max((wz - z0) / cell - 0.5, 0), R - 1.001);
          const i = fi | 0, j = fj | 0, di = fi - i, dj = fj - j, p = j * N + i;
          const i1 = i < N - 1 ? 1 : 0, j1 = j < R - 1 ? N : 0;
          const h = ((data[p] * (1 - di) + data[p + i1] * di) * (1 - dj) + (data[p + j1] * (1 - di) + data[p + j1 + i1] * di) * dj) * ex;
          const y = Math.ceil(cy - (t * sp + (h - ty) * cp) * s);
          if (first) { // the side of the map block, under its near edge
            first = false;
            const yb = Math.min(ybuf, Math.ceil(cy - (t * sp + (base - ty) * cp) * s));
            for (let yy = Math.max(y, 0); yy < yb; yy++) px[yy * W + sx] = 0xff2a313a;
            ybuf = Math.min(ybuf, Math.max(y, 0));
            if (ybuf <= 0) break;
            continue;
          }
          if (y >= ybuf) continue;
          const l = shade[(Math.round(fj) * N + Math.round(fi))];
          let r, g, b;
          if (smooth) {
            const fu = Math.min(Math.max((wx - x0) / WX * TW - 0.5, 0), TW - 1.001), fv = Math.min(Math.max((wz - z0) / WZ * TH - 0.5, 0), TH - 1.001);
            const iu = fu | 0, iv = fv | 0, du = fu - iu, dv = fv - iv, o = (iv * TW + iu) * 4, o2 = o + TW * 4;
            const w00 = (1 - du) * (1 - dv), w10 = du * (1 - dv), w01 = (1 - du) * dv, w11 = du * dv;
            r = (tex[o] * w00 + tex[o + 4] * w10 + tex[o2] * w01 + tex[o2 + 4] * w11) * l;
            g = (tex[o + 1] * w00 + tex[o + 5] * w10 + tex[o2 + 1] * w01 + tex[o2 + 5] * w11) * l;
            b = (tex[o + 2] * w00 + tex[o + 6] * w10 + tex[o2 + 2] * w01 + tex[o2 + 6] * w11) * l;
          } else {
            const o = (Math.min(TW - 1, ((wx - x0) / WX * TW) | 0) + Math.min(TH - 1, ((wz - z0) / WZ * TH) | 0) * TW) * 4;
            r = tex[o] * l; g = tex[o + 1] * l; b = tex[o + 2] * l;
          }
          const col = 0xff000000 | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r);
          for (let yy = Math.max(y, 0); yy < ybuf; yy++) px[yy * W + sx] = col;
          ybuf = Math.max(y, 0);
          if (ybuf <= 0) break;
        }
      }
      ctx.putImageData(this.img, 0, 0);
      const cur = this.app.cursor();
      if (cur) { // the pin under the 2D cursor
        const dx = cur[0] - tx, dz = cur[1] - tz, g = this.groundAt(cur[0], cur[1]);
        const X = cx + (dx * Rx + dz * Rz) * s, Y = cy - ((dx * Fx + dz * Fz) * sp + (g - ty) * cp) * s;
        ctx.strokeStyle = '#f0a35e'; ctx.lineWidth = 2 * q;
        ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X, Y - 26 * q); ctx.moveTo(X - 6 * q, Y); ctx.lineTo(X + 6 * q, Y); ctx.stroke();
      }
    },
  });

  ME.View3D = View3D;
})(window.ME = window.ME || {});
