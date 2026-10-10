// JHU dining menus, read from the static files published daily by scripts/build-menus.mjs,
// plus restaurants near campus (published weekly by scripts/build-restaurants.mjs).

import { cleanNutrients } from './nutrients.js';

const dayCache = new Map();
let locationsPromise = null;

export function getLocations() {
  locationsPromise ??= fetch('data/locations.json')
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => {
      locationsPromise = null;
      return [];
    });
  return locationsPromise;
}

/** Every menu served on a date ([] if none was published / it's outside the window). */
export async function getAllMenus(date) {
  if (!dayCache.has(date)) {
    dayCache.set(
      date,
      fetch(`data/menus/${date}.json`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => {
          dayCache.delete(date);
          return [];
        }),
    );
  }
  return dayCache.get(date);
}

export async function getMenuIndex(date) {
  return (await getAllMenus(date)).map(({ stations, ...m }) => ({
    ...m,
    stationCount: stations.length,
    itemCount: stations.reduce((n, s) => n + s.items.length, 0),
  }));
}

export async function getMenu(date, location, menu) {
  return (await getAllMenus(date)).find((m) => m.location === location && m.menu === menu) ?? null;
}

export function servingText(serving) {
  if (serving?.text) return serving.text;
  if (!serving?.amount) return '1 serving';
  const amt = +serving.amount;
  return `${Number.isFinite(amt) ? +amt.toFixed(2) : serving.amount} ${serving.unit ?? ''}`.trim();
}

/** Flattened, de-duplicated (per location+food) list of items for a date. */
export async function flatItems(date, { location, meal } = {}) {
  if (location?.startsWith('rest:')) return restaurantItems(location.slice(5));
  let menus = await getAllMenus(date);
  if (location && location !== 'any') menus = menus.filter((m) => m.location === location);
  if (meal && ['breakfast', 'lunch', 'dinner'].includes(meal)) {
    const matching = menus.filter((m) => m.meal === meal || m.meal === 'all-day');
    if (matching.length) menus = matching;
  }
  const seen = new Map();
  for (const m of menus) {
    for (const s of m.stations) {
      for (const it of s.items) {
        const key = `${m.location}:${it.foodId}`;
        if (!seen.has(key)) {
          seen.set(key, { ...it, location: m.location, locationName: m.locationName, menu: m.menu, menuName: m.menuName, meal: m.meal, station: s.name });
        }
      }
    }
  }
  return [...seen.values()];
}

export async function searchItems(date, query, limit = 60) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  return (await flatItems(date))
    .map((it) => {
      const name = it.name.toLowerCase();
      const hay = `${name} ${it.station.toLowerCase()} ${it.locationName.toLowerCase()} ${it.description.toLowerCase()}`;
      if (!terms.every((t) => hay.includes(t))) return null;
      return { it, score: (name.startsWith(q) ? 3 : 0) + (name.includes(q) ? 2 : 0) + (it.hasNutrition ? 1 : 0) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.it.name.localeCompare(b.it.name))
    .slice(0, limit)
    .map((r) => r.it);
}

// ---------- restaurants near campus (scripts/build-restaurants.mjs) ----------

let placesPromise = null;
let restaurantMenusPromise = null;

export function getPlaces() {
  placesPromise ??= fetch('restaurants/places.json')
    .then((r) => (r.ok ? r.json() : { places: [] }))
    .then((d) => d.places)
    .catch(() => {
      placesPromise = null;
      return [];
    });
  return placesPromise;
}

export function getRestaurantMenus() {
  restaurantMenusPromise ??= fetch('restaurants/menus.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => {
      restaurantMenusPromise = null;
      return {};
    });
  return restaurantMenusPromise;
}

export async function getPlace(id) {
  return (await getPlaces()).find((p) => p.id === id) ?? null;
}

/** A restaurant menu dish in the same shape as a JHU menu item. */
function dishItem(dish, i, menuKey, menu, place) {
  return {
    foodId: `${menuKey}:${i}`,
    name: dish.name,
    description: '',
    ingredients: '',
    serving: { text: dish.serving },
    hasNutrition: dish.nutrients.calories != null,
    nutrients: cleanNutrients(dish.nutrients),
    icons: [],
    location: place ? `rest:${place.id}` : menuKey,
    locationName: place?.name ?? menu.name,
    menu: menuKey,
    menuName: menu.name,
    meal: 'all-day',
    station: dish.section ?? 'Menu',
    source: 'restaurant',
    estimated: menu.kind === 'typical',
  };
}

export async function restaurantItems(placeId) {
  const [place, menus] = await Promise.all([getPlace(placeId), getRestaurantMenus()]);
  const menu = place && menus[place.menu];
  if (!menu) return [];
  return menu.items.map((d, i) => dishItem(d, i, place.menu, menu, place));
}

/** Search every restaurant dish (chain menus + typical cuisine dishes). */
export async function searchRestaurantDishes(query, limit = 20) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const out = [];
  for (const [key, menu] of Object.entries(await getRestaurantMenus())) {
    menu.items.forEach((d, i) => {
      const hay = `${d.name} ${menu.name}`.toLowerCase();
      if (terms.every((t) => hay.includes(t))) out.push(dishItem(d, i, key, menu, null));
    });
  }
  // Real chain items first, then typical dishes; shorter names (closer matches) first.
  return out.sort((a, b) => a.estimated - b.estimated || a.name.length - b.name.length).slice(0, limit);
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** "a big mac from mcdonalds" -> { place: nearest McDonald's, pattern: regex matching the name in the text }. */
export async function findRestaurantInText(text) {
  const t = norm(text);
  const [places, menus] = await Promise.all([getPlaces(), getRestaurantMenus()]);
  for (const [key, menu] of Object.entries(menus)) {
    const n = norm(menu.name);
    if (menu.kind !== 'chain' || !t.includes(n)) continue;
    const place = places.find((p) => p.menu === key); // places are sorted by distance
    // Letters of the name with anything (spaces, apostrophes) allowed between them.
    if (place) return { place, pattern: new RegExp(`\\b(from |at )?${n.split('').join('[^a-z0-9]*')}\\b`, 'i') };
  }
  return null;
}
