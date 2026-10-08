// Browser storage of GameWorld Painter (IndexedDB): the handle of the project folder, so the folder does not have to be
// picked again on the next visit. The keys start with the path of this index.html, so two copies of the tool do not
// share it.
(function (ME) {
  'use strict';
  const DB = 'gwp';
  const STORE = 'kv';
  const PREFIX = location.pathname + '|';
  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  ME.store = {
    available: typeof indexedDB !== 'undefined',
    get: key => run('readonly', s => s.get(PREFIX + key)),
    set: (key, value) => run('readwrite', s => s.put(value, PREFIX + key)),
    del: key => run('readwrite', s => s.delete(PREFIX + key)),
    /** Remove every key that starts with prefix. */
    async clear(prefix) {
      const keys = await run('readonly', s => s.getAllKeys());
      const mine = keys.filter(k => typeof k === 'string' && k.startsWith(PREFIX + prefix));
      if (mine.length) await run('readwrite', s => { mine.forEach(k => s.delete(k)); return null; });
    },
  };
})(window.ME = window.ME || {});
