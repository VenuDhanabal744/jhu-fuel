// Downloads JHU dining menus from Nutrislice and writes them as static JSON files the
// app reads (Nutrislice doesn't allow browsers on other sites to call its API directly).
// Runs every morning on GitHub Actions; run it locally with `npm run menus`.
//
// Output (public/data/):
//   index.json                 { generatedAt, dates: [...] }
//   locations.json             [{ slug, name, menus: [{ slug, name, meal }] }]
//   menus/YYYY-MM-DD.json      every menu served that day, normalized

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://hopkinsdining.api.nutrislice.com/menu/api';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/data');
const DAYS_BACK = 14;
const DAYS_AHEAD = 13;
// "Hopkins Café" is the dining hall formerly known as the FFC.
const LOCATION_NAMES = { 'site-1': 'Levering Kitchens' };

async function fetchJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

export function mealOf(menuName) {
  if (/breakfast|brunch/i.test(menuName)) return 'breakfast';
  if (/lunch/i.test(menuName)) return 'lunch';
  if (/dinner/i.test(menuName)) return 'dinner';
  if (/late/i.test(menuName)) return 'late-night';
  return 'all-day';
}

const NUTRIENT_KEYS = [
  'calories', 'g_protein', 'g_carbs', 'g_fat', 'g_fiber', 'g_sugar', 'g_added_sugar', 'g_saturated_fat', 'g_trans_fat',
  'mg_cholesterol', 'mg_sodium', 'mg_potassium', 'mg_calcium', 'mg_iron', 'mg_vitamin_c', 'mcg_vitamin_a', 'mcg_vitamin_d',
];

function nutrientsOf(info = {}) {
  return Object.fromEntries(
    NUTRIENT_KEYS.map((k) => {
      const v = info?.[k];
      return [k, v == null || v === '' || !Number.isFinite(+v) ? null : +v];
    }),
  );
}

function normalizeDay(day) {
  const stations = [];
  let current = null;
  for (const item of day?.menu_items ?? []) {
    if (item.is_section_title || item.is_station_header) {
      const name = (item.text || '').trim();
      if (name) {
        current = { name, items: [] };
        stations.push(current);
      }
      continue;
    }
    const f = item.food;
    if (!f) continue;
    if (!current) {
      current = { name: 'Menu', items: [] };
      stations.push(current);
    }
    const nutrients = nutrientsOf(f.rounded_nutrition_info);
    const serving = f.serving_size_info ?? {};
    current.items.push({
      foodId: f.id,
      name: f.name.trim(),
      description: (f.description || '').trim(),
      ingredients: (f.ingredients || '').trim().slice(0, 600),
      serving: {
        amount: serving.serving_size_amount ?? item.serving_size_amount ?? null,
        unit: serving.serving_size_unit ?? item.serving_size_unit ?? null,
      },
      hasNutrition: nutrients.calories != null,
      nutrients,
      icons: (f.icons?.food_icons ?? []).map((i) => i.synced_name || i.name).filter(Boolean),
    });
  }
  return stations.filter((s) => s.items.length);
}

const iso = (d) => d.toISOString().slice(0, 10);
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
function sundayOf(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return iso(d);
}

async function main() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const first = addDays(today, -DAYS_BACK);
  const last = addDays(today, DAYS_AHEAD);

  const schools = await fetchJSON(`${API}/schools/`);
  const locations = schools.map((s) => ({
    slug: s.slug,
    name: LOCATION_NAMES[s.slug] ?? s.name,
    menus: (s.active_menu_types ?? []).map((m) => ({ slug: m.slug, name: m.name, meal: mealOf(m.name) })),
  }));

  const weeks = [];
  for (let w = sundayOf(first); w <= last; w = addDays(w, 7)) weeks.push(w);

  const days = new Map(); // date -> menus[]
  let failures = 0;
  for (const loc of locations) {
    for (const menu of loc.menus) {
      for (const week of weeks) {
        const [y, m, d] = week.split('-');
        let data;
        try {
          data = await fetchJSON(`${API}/weeks/school/${loc.slug}/menu-type/${menu.slug}/${y}/${m}/${d}/`);
        } catch (err) {
          failures++;
          console.warn(`  ! ${err.message}`);
          continue;
        }
        for (const day of data.days ?? []) {
          if (day.date < first || day.date > last) continue;
          const stations = normalizeDay(day);
          if (!stations.length) continue;
          if (!days.has(day.date)) days.set(day.date, []);
          days.get(day.date).push({
            date: day.date,
            location: loc.slug,
            locationName: loc.name,
            menu: menu.slug,
            menuName: menu.name,
            meal: menu.meal,
            stations,
          });
        }
      }
    }
  }

  if (!days.size) throw new Error(`No menus downloaded (${failures} failed requests)`);
  fs.mkdirSync(path.join(OUT, 'menus'), { recursive: true });
  for (const f of fs.readdirSync(path.join(OUT, 'menus'))) fs.unlinkSync(path.join(OUT, 'menus', f));
  for (const [date, menus] of days) fs.writeFileSync(path.join(OUT, 'menus', `${date}.json`), JSON.stringify(menus));
  fs.writeFileSync(path.join(OUT, 'locations.json'), JSON.stringify(locations));
  const dates = [...days.keys()].sort();
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), dates }));
  console.log(`Wrote menus for ${dates.length} days (${dates[0]} → ${dates[dates.length - 1]})${failures ? `, ${failures} requests failed` : ''}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
