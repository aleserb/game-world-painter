// A project folder read and written through the local MCP server (mcp/server.mjs: /fs/*), for maps the AI agent opened
// or created by their path (open_map, create_map): the browser cannot open a folder from a path itself. The same
// interface as ME.Folder (js/folder.js); the server lets only the connected app (its session) use folders the agent
// granted.
(function (ME) {
  'use strict';

  const stamp = f => `${f.lastModified}:${f.size}`;

  class RemoteFolder {
    /** root: the full path of the folder on the disk. */
    constructor(root, name) {
      this.path = root;
      this.name = name || root.split(/[\\/]/).filter(Boolean).pop() || root;
      this.root = { remote: root, name: this.name }; // what the browser keeps to open it again
      this.known = new Map();
    }

    static get supported() { return true; }

    async req(method, op, path, body) {
      const a = ME.agent;
      if (!a?.settings.enabled) throw Object.assign(new Error('AI Agent is off: this map is opened through the MCP server'), { name: 'NotAllowedError' });
      const url = `${a.settings.url.replace(/\/+$/, '')}/fs/${op}?root=${encodeURIComponent(this.path)}&path=${encodeURIComponent(path)}`;
      return fetch(url, { method, body, cache: 'no-store', headers: { 'X-GWP-Session': a.session }, targetAddressSpace: 'loopback' });
    }

    /** 'granted' while the server lets this page use the folder, 'denied' when it does not, 'prompt' when it is out of reach. */
    async permission() {
      try {
        const r = await this.req('GET', 'stat', 'metadata.json');
        return r.ok || r.status === 404 ? 'granted' : 'denied';
      } catch (err) {
        return 'prompt';
      }
    }

    fileOf(path, size, lastModified, fetchBytes) {
      return { name: path.split('/').pop(), size, lastModified, arrayBuffer: fetchBytes, text: async () => new TextDecoder().decode(await fetchBytes()) };
    }

    async file(path) {
      const r = await this.req('GET', 'stat', path);
      if (r.status === 404) return null;
      if (!r.ok) throw httpError(r, path);
      const { size, mtime } = await r.json();
      return this.fileOf(path, size, mtime, async () => {
        const b = await this.req('GET', 'read', path);
        if (!b.ok) throw httpError(b, path);
        return b.arrayBuffer();
      });
    }

    async exists(path) { return !!(await this.file(path)); }

    async read(path) {
      const r = await this.req('GET', 'read', path);
      if (r.status === 404) return null;
      if (!r.ok) throw httpError(r, path);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const file = this.fileOf(path, +r.headers.get('X-GWP-Size') || bytes.length, +r.headers.get('X-GWP-Mtime'), async () => bytes.buffer);
      return { bytes, file };
    }

    async readText(path) {
      const r = await this.read(path);
      return r ? { text: new TextDecoder().decode(r.bytes), file: r.file } : null;
    }

    /** Written atomically by the server (a temporary file renamed over it). */
    async write(path, data) {
      const body = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const r = await this.req('PUT', 'write', path, body);
      if (!r.ok) throw httpError(r, path);
      const { size, mtime } = await r.json();
      this.remember(path, { size, lastModified: mtime });
    }

    async remove(path) {
      const r = await this.req('DELETE', 'remove', path);
      if (!r.ok && r.status !== 404) throw httpError(r, path);
      this.known.delete(path);
    }

    remember(path, file) {
      if (file) this.known.set(path, stamp(file));
      else this.known.delete(path);
    }

    isNew(path, file) {
      if (!file) return this.known.has(path);
      return this.known.get(path) !== stamp(file);
    }
  }

  function httpError(r, path) {
    const e = new Error(`${path}: the MCP server answered ${r.status}${r.status === 403 ? ' (the agent did not open this map, or another tab is connected)' : ''}`);
    if (r.status === 403) e.name = 'NotAllowedError';
    return e;
  }

  ME.RemoteFolder = RemoteFolder;
})(window.ME = window.ME || {});
