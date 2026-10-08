// On-device storage (IndexedDB). Everything you log lives on this phone/browser only.

const DB_NAME = 'jhu-fuel';
const VERSION = 1;

let dbPromise = null;
function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('settings');
      db.createObjectStore('entries', { keyPath: 'id', autoIncrement: true }).createIndex('date', 'date');
      db.createObjectStore('weights', { keyPath: 'date' });
      db.createObjectStore('foods', { keyPath: 'id', autoIncrement: true }).createIndex('barcode', 'barcode');
      db.createObjectStore('photos');
      db.createObjectStore('cache');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export async function get(name, key) {
  return done((await store(name)).get(key));
}

export async function getAll(name, query) {
  return done((await store(name)).getAll(query));
}

export async function getAllByIndex(name, index, query) {
  return done((await store(name)).index(index).getAll(query));
}

export async function put(name, value, key) {
  return done((await store(name, 'readwrite')).put(value, key));
}

export async function del(name, key) {
  return done((await store(name, 'readwrite')).delete(key));
}

export async function clear(name) {
  return done((await store(name, 'readwrite')).clear());
}

/** Insert several records in one transaction; returns their keys. */
export async function putMany(name, values) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const os = tx.objectStore(name);
    const keys = [];
    values.forEach((v, i) => (os.put(v).onsuccess = (e) => (keys[i] = e.target.result)));
    tx.oncomplete = () => resolve(keys);
    tx.onerror = () => reject(tx.error);
  });
}

/** Ask the browser not to evict our data under storage pressure. */
export function persist() {
  return navigator.storage?.persist?.().catch(() => false);
}

// Small key/value cache with timestamps (barcode lookups, text embeddings).
export async function cacheGet(key) {
  return get('cache', key);
}
export async function cacheSet(key, data) {
  return put('cache', { data, at: Date.now() }, key);
}
