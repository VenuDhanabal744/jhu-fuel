// The app's "backend", running entirely on this device. Views call api('/path', ...)
// exactly as they would a server; requests are routed to local handlers backed by
// IndexedDB, the published JHU menu files, and on-device recognition.

import * as store from './store.js';
import * as menus from './menus.js';
import { cleanNutrients, scaleNutrients, sumNutrients } from './nutrients.js';
import { computeTargets, DEFAULT_PROFILE } from './targets.js';
import { thumbnail } from './image.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const SOURCES = ['menu', 'estimate', 'custom', 'packaged', 'restaurant'];

class ApiError extends Error {}
const fail = (message) => {
  throw new ApiError(message);
};
const requireDate = (v, name = 'date') => (DATE_RE.test(v ?? '') ? v : fail(`Invalid ${name}`));
const num = (v, fallback) => (v === '' || v == null || !Number.isFinite(+v) ? fallback : +v);

// ---------- profile & weights ----------

async function getProfile() {
  return { ...DEFAULT_PROFILE, ...((await store.get('settings', 'profile')) ?? {}) };
}

async function latestWeight() {
  const all = await store.getAll('weights');
  return all.length ? all[all.length - 1] : null; // keyPath 'date' keeps them sorted
}

async function profilePayload() {
  const profile = await getProfile();
  const weight = (await latestWeight())?.weight_lb ?? profile.weightLb;
  return { profile, currentWeightLb: weight, ...computeTargets(profile, weight) };
}

async function saveProfile(body) {
  const prev = await getProfile();
  const next = {
    ...prev,
    name: String(body.name ?? prev.name).slice(0, 60),
    sex: body.sex === 'male' ? 'male' : 'female',
    age: num(body.age, prev.age),
    heightIn: num(body.heightIn, prev.heightIn),
    weightLb: num(body.weightLb, prev.weightLb),
    targetWeightLb: num(body.targetWeightLb, prev.targetWeightLb),
    goal: ['lose', 'maintain', 'gain'].includes(body.goal) ? body.goal : prev.goal,
    rateLbPerWeek: num(body.rateLbPerWeek, prev.rateLbPerWeek),
    activity: body.activity ?? prev.activity,
    overrides: Object.fromEntries(Object.entries(body.overrides ?? prev.overrides ?? {}).filter(([, v]) => v !== '' && v != null && Number.isFinite(+v))),
    configured: true,
  };
  const today = requireDate(body.today, 'today');
  // (Re)start the goal journey when the goal or target changes, or on first setup.
  if (!prev.configured || prev.goal !== next.goal || prev.targetWeightLb !== next.targetWeightLb) {
    next.startWeightLb = next.weightLb;
    next.startDate = today;
  }
  if (!prev.configured || prev.weightLb !== next.weightLb) await store.put('weights', { date: today, weight_lb: next.weightLb });
  await store.put('settings', next, 'profile');
  store.persist();
  return profilePayload();
}

async function logWeight({ date, weightLb }) {
  requireDate(date);
  const w = +weightLb;
  if (!(w > 50 && w < 1000)) fail('Weight must be in pounds');
  await store.put('weights', { date, weight_lb: w });
  if (date >= ((await latestWeight())?.date ?? '')) await store.put('settings', { ...(await getProfile()), weightLb: w }, 'profile');
  return { weights: await store.getAll('weights'), ...(await profilePayload()) };
}

// ---------- entries ----------

const photoUrls = new Map();
async function withPhoto(e) {
  if (!e.photo_id) return e;
  if (!photoUrls.has(e.photo_id)) {
    const blob = await store.get('photos', e.photo_id);
    photoUrls.set(e.photo_id, blob ? URL.createObjectURL(blob) : null);
  }
  return { ...e, photo_url: photoUrls.get(e.photo_id) };
}

async function listEntries(from, to = from) {
  const list = await store.getAllByIndex('entries', 'date', IDBKeyRange.bound(from, to));
  return Promise.all(list.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id).map(withPhoto));
}

async function addEntries(list) {
  const now = new Date().toISOString();
  const clean = list.map((e) => {
    if (!e?.name) fail('Each entry needs a name');
    const servings = +e.servings;
    return {
      date: requireDate(e.date),
      meal: MEALS.includes(e.meal) ? e.meal : 'snack',
      name: String(e.name).slice(0, 200),
      source: SOURCES.includes(e.source) ? e.source : 'custom',
      location: e.location ?? null,
      station: e.station ?? null,
      food_id: e.foodId ?? e.food_id ?? null,
      serving_desc: e.serving ?? e.serving_desc ?? null,
      servings: servings > 0 ? servings : 1,
      nutrients: cleanNutrients(e.nutrients),
      photo_id: e.photoId ?? null,
      confidence: e.confidence ?? null,
      created_at: now,
    };
  });
  const ids = await store.putMany('entries', clean);
  return clean.map((e, i) => ({ ...e, id: ids[i] }));
}

async function updateEntry(id, b) {
  const e = (await store.get('entries', id)) ?? fail('Not found');
  if (b.servings != null) e.servings = +b.servings > 0 ? +b.servings : fail('Servings must be positive');
  if (b.meal && MEALS.includes(b.meal)) e.meal = b.meal;
  if (b.name) e.name = String(b.name).slice(0, 200);
  if (b.date) e.date = requireDate(b.date);
  if (b.nutrients) e.nutrients = cleanNutrients(b.nutrients);
  await store.put('entries', e);
  return e;
}

async function deleteEntry(id) {
  const e = await store.get('entries', id);
  await store.del('entries', id);
  if (e?.photo_id && !(await store.getAll('entries')).some((x) => x.photo_id === e.photo_id)) await store.del('photos', e.photo_id);
  return { ok: true };
}

/** Distinct recently-logged foods, newest first. */
async function recentFoods(limit = 30) {
  const groups = new Map();
  for (const e of await store.getAll('entries')) {
    const key = `${e.name}|${e.source}|${e.location ?? ''}`;
    const g = groups.get(key);
    if (!g || e.created_at > g.last_used) groups.set(key, { ...e, last_used: e.created_at, times: (g?.times ?? 0) + 1 });
    else g.times++;
  }
  return [...groups.values()].sort((a, b) => b.last_used.localeCompare(a.last_used)).slice(0, limit);
}

// ---------- saved foods ----------

async function listFoods() {
  return (await store.getAll('foods')).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

async function addFood({ name, serving, nutrients, barcode }) {
  if (!name) fail('Name required');
  const food = {
    name: String(name).slice(0, 200),
    serving_desc: serving ?? null,
    nutrients: cleanNutrients(nutrients),
    created_at: new Date().toISOString(),
  };
  // Leave `barcode` off entirely when absent so the index only holds real codes.
  if (typeof barcode === 'string' && /^\d{6,14}$/.test(barcode)) food.barcode = barcode;
  const [id] = await store.putMany('foods', [food]);
  return { ...food, id };
}

// ---------- progress ----------

async function summary(from, to) {
  const byDate = new Map();
  for (const e of await store.getAllByIndex('entries', 'date', IDBKeyRange.bound(from, to))) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(scaleNutrients(e.nutrients, e.servings));
  }
  const days = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => ({ date, count: list.length, totals: sumNutrients(list) }));
  const loggedDates = [...new Set((await store.getAll('entries')).map((e) => e.date))].sort();
  return { days, loggedDates, weights: await store.getAll('weights'), ...(await profilePayload()) };
}

// ---------- photos & recognition (loaded lazily: they pull in big libraries) ----------

async function analyze({ image, text, meal, location, date }) {
  requireDate(date);
  const rec = await import('./recognize.js');
  if (!image) {
    if (!text?.trim()) fail('Send a photo or a description');
    return rec.analyzeText({ text: text.trim(), date, meal, location });
  }
  const result = await rec.analyzePhoto({ image, date, meal, location });
  const photoId = crypto.randomUUID();
  await store.put('photos', await thumbnail(image), photoId);
  return { ...result, photoId };
}

// ---------- backup ----------

async function exportBackup() {
  const blobToDataUrl = (blob) =>
    new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.readAsDataURL(blob);
    });
  const photos = {};
  for (const e of await store.getAll('entries')) {
    if (e.photo_id && !photos[e.photo_id]) {
      const blob = await store.get('photos', e.photo_id);
      if (blob) photos[e.photo_id] = await blobToDataUrl(blob);
    }
  }
  return {
    app: 'jhu-fuel',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: await store.get('settings', 'profile'),
    entries: await store.getAll('entries'),
    weights: await store.getAll('weights'),
    foods: await store.getAll('foods'),
    photos,
  };
}

/** Merge a backup into this device (entries are added; profile/weights/foods are upserted). */
async function importBackup(data) {
  if (data?.app !== 'jhu-fuel') fail('That file isn’t a JHU Fuel backup.');
  if (data.profile) await store.put('settings', { ...DEFAULT_PROFILE, ...data.profile }, 'profile');
  for (const w of data.weights ?? []) await store.put('weights', { date: w.date, weight_lb: +w.weight_lb });
  const existing = new Set((await store.getAll('entries')).map((e) => `${e.date}|${e.meal}|${e.name}|${e.created_at}`));
  const entries = (data.entries ?? []).filter((e) => !existing.has(`${e.date}|${e.meal}|${e.name}|${e.created_at}`)).map(({ id, ...e }) => e);
  await store.putMany('entries', entries);
  const foods = new Set((await store.getAll('foods')).map((f) => f.name));
  const newFoods = (data.foods ?? []).filter((f) => !foods.has(f.name)).map(({ id, barcode, ...f }) => (barcode ? { ...f, barcode } : f));
  await store.putMany('foods', newFoods);
  for (const [id, dataUrl] of Object.entries(data.photos ?? {})) await store.put('photos', await (await fetch(dataUrl)).blob(), id);
  return { entries: entries.length, weights: (data.weights ?? []).length };
}

// ---------- router ----------

const routes = [
  ['GET', /^\/status$/, async () => {
    const { recognizerStatus } = await import('./recognize.js');
    return { recognizer: recognizerStatus(), configured: (await getProfile()).configured };
  }],
  ['GET', /^\/profile$/, () => profilePayload()],
  ['PUT', /^\/profile$/, (_m, _q, body) => saveProfile(body ?? {})],
  ['GET', /^\/weights$/, () => store.getAll('weights')],
  ['POST', /^\/weights$/, (_m, _q, body) => logWeight(body ?? {})],
  ['DELETE', /^\/weights\/(\d{4}-\d{2}-\d{2})$/, async ([, date]) => {
    await store.del('weights', date);
    return { weights: await store.getAll('weights'), ...(await profilePayload()) };
  }],
  ['GET', /^\/locations$/, () => menus.getLocations()],
  ['GET', /^\/menus$/, (_m, q) => menus.getMenuIndex(requireDate(q.get('date')))],
  ['GET', /^\/menu$/, async (_m, q) => (await menus.getMenu(requireDate(q.get('date')), q.get('location'), q.get('menu'))) ?? fail('Menu not found')],
  ['GET', /^\/search$/, async (_m, q) => {
    const text = (q.get('q') ?? '').trim();
    const lower = text.toLowerCase();
    return {
      menu: await menus.searchItems(requireDate(q.get('date')), text),
      restaurants: await menus.searchRestaurantDishes(text),
      custom: (await listFoods()).filter((f) => f.name.toLowerCase().includes(lower)),
      recent: (await recentFoods(100)).filter((f) => f.name.toLowerCase().includes(lower)).slice(0, 15),
    };
  }],
  ['POST', /^\/analyze$/, (_m, _q, body) => analyze(body ?? {})],
  ['GET', /^\/restaurants$/, () => menus.getPlaces()],
  ['GET', /^\/restaurants\/([nwr]\d+)$/, async ([, id]) => {
    const place = (await menus.getPlace(id)) ?? fail('Restaurant not found');
    const menu = (await menus.getRestaurantMenus())[place.menu] ?? null;
    return { place, menu: menu && { name: menu.name, kind: menu.kind, source: menu.source }, items: await menus.restaurantItems(id) };
  }],
  ['GET', /^\/entries$/, (_m, q) => listEntries(requireDate(q.get('date')))],
  ['POST', /^\/entries$/, (_m, _q, body) => addEntries(Array.isArray(body) ? body : [body])],
  ['PATCH', /^\/entries\/(\d+)$/, ([, id], _q, body) => updateEntry(+id, body ?? {})],
  ['DELETE', /^\/entries\/(\d+)$/, ([, id]) => deleteEntry(+id)],
  ['GET', /^\/recent$/, () => recentFoods(30)],
  ['GET', /^\/foods$/, () => listFoods()],
  ['POST', /^\/foods$/, (_m, _q, body) => addFood(body ?? {})],
  ['DELETE', /^\/foods\/(\d+)$/, async ([, id]) => (await store.del('foods', +id), { ok: true })],
  ['GET', /^\/summary$/, (_m, q) => summary(requireDate(q.get('from'), 'from'), requireDate(q.get('to'), 'to'))],
  ['POST', /^\/barcode$/, async (_m, _q, body) => {
    const { decodeBarcode, lookupBarcode } = await import('./barcode.js');
    const code = (await decodeBarcode(body?.image)) ?? fail('No barcode found. Get closer so the barcode fills most of the photo, with good light and no glare.');
    return { code, product: await lookupBarcode(code) };
  }],
  ['GET', /^\/barcode\/(\d{6,14})$/, async ([, code]) => {
    const { lookupBarcode } = await import('./barcode.js');
    return { code, product: await lookupBarcode(code) };
  }],
  ['POST', /^\/label$/, async (_m, _q, body) => (await import('./label.js')).scanLabel(body?.image)],
  ['GET', /^\/backup$/, () => exportBackup()],
  ['POST', /^\/backup$/, (_m, _q, body) => importBackup(body)],
];

export async function api(path, { method = 'GET', body } = {}) {
  const [pathname, query = ''] = path.split('?');
  for (const [m, re, handler] of routes) {
    const match = m === method && re.exec(pathname);
    if (match) return handler(match, new URLSearchParams(query), body);
  }
  throw new Error(`Unknown request ${method} ${path}`);
}
