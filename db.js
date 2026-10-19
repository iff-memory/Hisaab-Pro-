// Storage layer: IndexedDB (survives restarts, handles lots of data).
// Falls back to memory if the browser blocks IndexedDB, so the app never crashes.
const NAME = 'hisaab', VERSION = 2, STORES = ['tx', 'people', 'meta'];
let dbp = null;
const mem = { tx: new Map(), people: new Map(), meta: new Map() };
let useMem = false;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => STORES.forEach(s => { if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' }); });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => { useMem = true; return null; });
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  if (useMem || !db) return null;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export async function all(store) {
  const r = await run(store, 'readonly', s => s.getAll());
  return useMem ? [...mem[store].values()] : r || [];
}
export async function put(store, value) {
  await open();
  if (useMem) { mem[store].set(value.id, value); return; }
  await run(store, 'readwrite', s => s.put(value));
}
export async function del(store, id) {
  await open();
  if (useMem) { mem[store].delete(id); return; }
  await run(store, 'readwrite', s => s.delete(id));
}
export async function replaceAll(data) {
  const db = await open();
  if (useMem || !db) {
    STORES.forEach(s => { mem[s].clear(); (data[s] || []).forEach(v => mem[s].set(v.id, v)); });
    return;
  }
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORES, 'readwrite');
    STORES.forEach(s => {
      const st = t.objectStore(s);
      st.clear();
      (data[s] || []).forEach(v => st.put(v));
    });
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}
export const isMemoryOnly = () => useMem;
