// The project folder through the File System Access API (Chrome / Edge): read, write and watch
// files. A page opened from the disk cannot read the pixels of local pictures by itself, so the user gives the tool
// the folder once (Open folder); the handle is kept in the browser and reused on the next visit.
(function (ME) {
  'use strict';

  const stamp = f => `${f.lastModified}:${f.size}`;

  class Folder {
    constructor(handle) {
      this.root = handle;
      this.name = handle.name;
      this.known = new Map(); // path -> "lastModified:size" of the version this tool has (read or written)
    }

    static get supported() { return typeof window.showDirectoryPicker === 'function'; }

    /** Ask the user for the folder. */
    static async pick() {
      return new Folder(await window.showDirectoryPicker({ id: 'gwp', mode: 'readwrite' }));
    }

    /** 'granted', 'prompt' or 'denied'. request: ask the user (needs a click). */
    async permission(request = false) {
      const opts = { mode: 'readwrite' };
      try {
        const p = await this.root.queryPermission(opts);
        if (p === 'granted' || !request) return p;
        return await this.root.requestPermission(opts);
      } catch (err) {
        return 'denied';
      }
    }

    async dirOf(path, create) {
      const parts = path.split('/');
      let dir = this.root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
      return [dir, parts[parts.length - 1]];
    }

    async handle(path, create = false) {
      const [dir, name] = await this.dirOf(path, create);
      return dir.getFileHandle(name, { create });
    }

    /** The File of path, or null if it does not exist. */
    async file(path) {
      try {
        return await (await this.handle(path)).getFile();
      } catch (err) {
        if (err.name === 'NotFoundError' || err.name === 'TypeMismatchError') return null;
        throw err;
      }
    }

    async exists(path) { return !!(await this.file(path)); }

    /** {bytes, file} of path, or null. The caller remembers the version (remember()) once it took the content. */
    async read(path) {
      const file = await this.file(path);
      if (!file) return null;
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { bytes, file };
    }

    async readText(path) {
      const r = await this.read(path);
      return r ? { text: new TextDecoder().decode(r.bytes), file: r.file } : null;
    }

    /** Write path (bytes or a string). The write is atomic: other programs see the old file until it is complete. */
    async write(path, data) {
      const h = await this.handle(path, true);
      const w = await h.createWritable();
      await w.write(data);
      await w.close();
      this.remember(path, await h.getFile());
    }

    async remove(path) {
      const [dir, name] = await this.dirOf(path, false);
      try {
        await dir.removeEntry(name);
      } catch (err) {
        if (err.name !== 'NotFoundError') throw err;
      }
      this.known.delete(path);
    }

    remember(path, file) {
      if (file) this.known.set(path, stamp(file));
      else this.known.delete(path);
    }

    /** True if file (from file()) is not the version this tool knows. */
    isNew(path, file) {
      if (!file) return this.known.has(path);
      return this.known.get(path) !== stamp(file);
    }
  }

  ME.Folder = Folder;
})(window.ME = window.ME || {});
