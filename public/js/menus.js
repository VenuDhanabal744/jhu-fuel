// JHU dining menus, read from the static files published daily by scripts/build-menus.mjs.

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
  if (!serving?.amount) return '1 serving';
  const amt = +serving.amount;
  return `${Number.isFinite(amt) ? +amt.toFixed(2) : serving.amount} ${serving.unit ?? ''}`.trim();
}

/** Flattened, de-duplicated (per location+food) list of items for a date. */
export async function flatItems(date, { location, meal } = {}) {
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
