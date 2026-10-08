// PNG encoding and decoding with exact values: 8-bit grayscale (masks), 8-bit palette (categories: the index is the
// class, the palette shows the class colors in any image viewer), 16-bit grayscale (heights), RGB / RGBA.
// The browser's own decoding is not used for layers: it may convert colors and has no 16 bits.
// Classic script (index.html opens from the disk, where module scripts are blocked): everything goes into window.ME.
(function (ME) {
  'use strict';

  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function pipe(data, stream) {
    const s = new Blob([data]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  /**
   * Encode a PNG. samples: width * height * channels values (Uint8Array, or Uint16Array for depth 16).
   * opts.depth: 8 or 16. opts.palette: [[r, g, b, a?], ...] makes an indexed PNG (channels must be 1).
   */
  ME.encodePNG = async function (width, height, channels, samples, opts = {}) {
    const depth = opts.depth || 8;
    const palette = opts.palette;
    const bytesPerSample = depth === 16 ? 2 : 1;
    const stride = width * channels * bytesPerSample;
    const raw = new Uint8Array((stride + 1) * height);
    const row = new Uint8Array(stride), prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      const base = y * width * channels;
      if (depth === 16) {
        for (let i = 0; i < width * channels; i++) { const v = samples[base + i]; row[2 * i] = v >> 8; row[2 * i + 1] = v & 255; }
      } else {
        row.set(samples.subarray(base, base + width * channels));
      }
      const o = y * (stride + 1);
      raw[o] = 2; // "Up": smooth masks and heights compress well
      for (let i = 0; i < stride; i++) raw[o + 1 + i] = (row[i] - prev[i]) & 255;
      prev.set(row);
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = depth;
    ihdr[9] = palette ? 3 : { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
    const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', ihdr)];
    if (palette) {
      const plte = new Uint8Array(palette.length * 3), trns = new Uint8Array(palette.length);
      palette.forEach((c, k) => { plte.set(c.slice(0, 3), k * 3); trns[k] = c.length > 3 ? c[3] : 255; });
      parts.push(chunk('PLTE', plte));
      if (trns.some(a => a !== 255)) parts.push(chunk('tRNS', trns));
    }
    parts.push(chunk('IDAT', await pipe(raw, new CompressionStream('deflate'))), chunk('IEND', new Uint8Array(0)));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }

  /**
   * Decode a PNG into {width, height, channels, depth, colorType, samples, palette}. samples has width * height *
   * channels values (Uint16Array for 16 bits, else Uint8Array; 1, 2 and 4-bit values are unpacked). palette:
   * [[r, g, b, a], ...] for indexed PNGs. Throws on a truncated or broken file (e.g. one that is still being written).
   */
  ME.decodePNG = async function (bytes) {
    if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) throw new Error('not a PNG');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 8, ihdr = null, plte = null, trns = null, ended = false;
    const idat = [];
    while (pos + 8 <= bytes.length) {
      const len = dv.getUint32(pos);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      if (pos + 12 + len > bytes.length) throw new Error('truncated PNG');
      const data = bytes.subarray(pos + 8, pos + 8 + len);
      if (type === 'IHDR') ihdr = data;
      else if (type === 'PLTE') plte = data;
      else if (type === 'tRNS') trns = data;
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') { ended = true; break; }
      pos += 12 + len;
    }
    if (!ihdr || !ended || !idat.length) throw new Error('truncated PNG');
    const hv = new DataView(ihdr.buffer, ihdr.byteOffset, 13);
    const width = hv.getUint32(0), height = hv.getUint32(4), depth = ihdr[8], colorType = ihdr[9];
    if (ihdr[12]) throw new Error('interlaced PNGs are not supported');
    const channels = CHANNELS[colorType];
    if (!channels) throw new Error('unknown PNG color type ' + colorType);
    const z = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
    let o = 0;
    for (const d of idat) { z.set(d, o); o += d.length; }
    const raw = await pipe(z, new DecompressionStream('deflate'));
    const bitsPP = channels * depth;
    const bpp = Math.max(1, bitsPP >> 3);
    const stride = Math.ceil(width * bitsPP / 8);
    if (raw.length < (stride + 1) * height) throw new Error('truncated PNG data');
    const img = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)];
      const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      const cur = img.subarray(y * stride, (y + 1) * stride);
      const up = y ? img.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = up[i], c = i >= bpp ? up[i - bpp] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : -1;
        if (pred < 0) throw new Error('bad PNG filter');
        cur[i] = (src[i] + pred) & 255;
      }
    }
    const n = width * height * channels;
    let samples;
    if (depth === 16) {
      samples = new Uint16Array(n);
      for (let i = 0; i < n; i++) samples[i] = (img[2 * i] << 8) | img[2 * i + 1];
    } else if (depth === 8) {
      samples = img;
    } else {
      samples = new Uint8Array(n);
      const per = 8 / depth, mask = (1 << depth) - 1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width * channels; x++) {
          const byte = img[y * stride + Math.floor(x / per)];
          samples[y * width * channels + x] = (byte >> (8 - depth * (x % per + 1))) & mask;
        }
      }
    }
    let palette = null;
    if (plte) {
      palette = [];
      for (let k = 0; k * 3 + 2 < plte.length; k++) palette.push([plte[3 * k], plte[3 * k + 1], plte[3 * k + 2], trns && k < trns.length ? trns[k] : 255]);
    }
    return { width, height, channels, depth, colorType, samples, palette };
  };

  /**
   * One value per pixel from a decoded PNG, resized (nearest) to cols x rows:
   * 'gray'  0..255 (grayscale or luminance; 16-bit scaled down)
   * 'index' the palette index or the gray value (RGB: the nearest of colors, given as [[r, g, b]])
   * 'u16'   0..65535 (16-bit gray; 8-bit gray scaled up; 8-bit RGB read as R high byte, G low byte)
   */
  ME.pngChannel = function (png, mode, cols, rows, colors) {
    const { width, height, channels, depth, colorType, samples, palette } = png;
    const out = mode === 'u16' ? new Uint16Array(cols * rows) : new Uint8Array(cols * rows);
    const max = (1 << depth) - 1;
    const cache = new Map();
    for (let y = 0; y < rows; y++) {
      const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / rows));
      for (let x = 0; x < cols; x++) {
        const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / cols));
        const s = (sy * width + sx) * channels;
        let v;
        if (mode !== 'u16' && (channels === 2 || channels === 4) && samples[s + channels - 1] === 0) v = 0; // see-through = empty
        else if (colorType === 3) {
          const k = samples[s];
          if (mode === 'index') v = k;
          else { const c = palette[k] || [0, 0, 0]; v = Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]); if (mode === 'u16') v *= 257; }
        } else if (channels <= 2) {
          const g = samples[s];
          v = mode === 'u16' ? (depth === 16 ? g : Math.round(g / max * 65535)) : depth === 16 ? g >> 8 : Math.round(g / max * 255);
        } else {
          const r = samples[s], g = samples[s + 1], b = samples[s + 2];
          const r8 = depth === 16 ? r >> 8 : r, g8 = depth === 16 ? g >> 8 : g, b8 = depth === 16 ? b >> 8 : b;
          if (mode === 'u16') v = depth === 16 ? r : (r8 << 8) | g8;
          else if (mode === 'index' && colors) {
            const key = (r8 << 16) | (g8 << 8) | b8;
            v = cache.get(key);
            if (v === undefined) {
              let best = Infinity;
              colors.forEach((c, k) => { if (!c) return; const d = (c[0] - r8) ** 2 + (c[1] - g8) ** 2 + (c[2] - b8) ** 2; if (d < best) { best = d; v = k; } });
              v = v ?? 0;
              cache.set(key, v);
            }
          } else v = Math.round(0.299 * r8 + 0.587 * g8 + 0.114 * b8);
        }
        out[y * cols + x] = v;
      }
    }
    return out;
  };

  ME.bytesToBase64 = function (bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };

  ME.base64ToBytes = function (b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };

  ME.mimeOf = name => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' })[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
  ME.extOf = mime => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[mime] || 'png';
})(window.ME = window.ME || {});
