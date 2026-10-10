// Builds the restaurant data the app ships with (committed to the repo, refreshed weekly):
//
//   public/restaurants/places.json  every restaurant / fast food / cafe / ice cream shop within
//                                   10 miles of Homewood campus (OpenStreetMap, via Overpass)
//   public/restaurants/menus.json   menus with nutrition per serving:
//                                     chain:<key>   real menu items for chains the USDA analyzed
//                                                   (SR Legacy "Fast Foods" / "Restaurant Foods")
//                                     typical:<key> typical dishes for a cuisine (USDA FNDDS)
//
// Usage: node scripts/build-restaurants.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEMPLATES, CUISINE_TO_TEMPLATE } from './restaurant-templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'restaurants');
const CAMPUS = { lat: 39.3299, lon: -76.6205 }; // JHU Homewood
const RADIUS_M = 16_093; // 10 miles
const UA = 'JHUFuel/1.0 (https://github.com/VenuDhanabal744/jhu-fuel)';
const FDC = 'https://fdc.nal.usda.gov/fdc-datasets';
const SR_ZIP = 'FoodData_Central_sr_legacy_food_json_2018-04.zip';
const FNDDS_ZIP = 'FoodData_Central_survey_food_json_2024-10-31.zip';

// ---------- download helpers ----------

const CACHE = path.join(os.tmpdir(), 'jhu-fuel-fdc');

async function download(url, file) {
  if (fs.existsSync(file)) return file;
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

async function loadFdc(zipName) {
  fs.mkdirSync(CACHE, { recursive: true });
  const zip = await download(`${FDC}/${zipName}`, path.join(CACHE, zipName));
  const json = execFileSync('unzip', ['-p', zip], { maxBuffer: 1024 * 1024 * 1024 });
  return Object.values(JSON.parse(json))[0];
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function overpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).elements;
    } catch (err) {
      lastErr = err;
      console.warn(`  Overpass ${url} failed (${err.message}), retrying…`);
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ---------- nutrition ----------

const NUTRIENT_NUMBERS = {
  208: 'calories', 203: 'g_protein', 205: 'g_carbs', 204: 'g_fat', 291: 'g_fiber', 269: 'g_sugar', 539: 'g_added_sugar',
  606: 'g_saturated_fat', 605: 'g_trans_fat', 601: 'mg_cholesterol', 307: 'mg_sodium', 306: 'mg_potassium',
  301: 'mg_calcium', 303: 'mg_iron', 401: 'mg_vitamin_c', 320: 'mcg_vitamin_a', 328: 'mcg_vitamin_d',
};

function per100(food) {
  const out = {};
  for (const n of food.foodNutrients ?? []) {
    const key = NUTRIENT_NUMBERS[n.nutrient?.number];
    if (key && n.amount != null && out[key] == null) out[key] = n.amount;
  }
  return out;
}

function scale(n, grams) {
  const out = {};
  for (const [k, v] of Object.entries(n)) out[k] = Math.round(v * (grams / 100) * 10) / 10;
  return out;
}

const portionText = (p) => (p.portionDescription && p.portionDescription !== 'Quantity not specified' ? p.portionDescription : [p.amount !== 1 ? p.amount : '', p.modifier].filter(Boolean).join(' ')).trim();

// ---------- chains (SR Legacy) ----------

const CHAINS = [
  ['mcdonalds', "McDonald's", /^McDONALD'S,?\s*/i],
  ['burgerking', 'Burger King', /^BURGER KING,\s*/],
  ['wendys', "Wendy's", /^WEND'?Y'?S,\s*/],
  ['kfc', 'KFC', /^KFC,\s*/],
  ['popeyes', 'Popeyes', /^POPEYES,\s*/],
  ['subway', 'Subway', /^SUBWAY,\s*/],
  ['tacobell', 'Taco Bell', /^TACO BELL,\s*/],
  ['chickfila', 'Chick-fil-A', /^CHICK-FIL-A,\s*/],
  ['dennys', "Denny's", /^DENNY'S,\s*/],
  ['applebees', "Applebee's", /^APPLEBEE'S,\s*/],
  ['pizzahut', 'Pizza Hut', /^PIZZA HUT,?\s*/],
  ['dominos', "Domino's", /^DOMINO'S\s*/],
  ['papajohns', "Papa John's", /^PAPA JOHN'S\s*/],
  ['littlecaesars', 'Little Caesars', /^LITTLE CAESARS\s*/],
  ['arbys', "Arby's", /^ARBY'S,\s*/],
  ['crackerbarrel', 'Cracker Barrel', /^CRACKER BARREL,\s*/],
  ['tgifridays', 'TGI Fridays', /^T\.G\.I\. FRIDAY'S,\s*/],
  ['olivegarden', 'Olive Garden', /^OLIVE GARDEN,\s*/],
  ['carrabbas', "Carrabba's Italian Grill", /^CARRABBA'S ITALIAN GRILL,\s*/],
  ['ontheborder', 'On The Border', /^ON THE BORDER,\s*/],
];

// Prefer the portion people actually order (6" sub, medium fries, a slice, a piece with skin).
const PORTION_PREFS = ['with skin', '6', 'slice', 'medium', 'regular', 'sandwich', 'item', 'each', 'burrito', 'biscuit', 'wrap', 'serving'];

function pickPortion(portions) {
  const usable = portions.filter((p) => p.gramWeight > 0 && !/bone and skin removed|without skin/i.test(portionText(p)));
  for (const pref of PORTION_PREFS) {
    const hit = usable.find((p) => (pref === '6' ? p.amount === 6 : portionText(p).toLowerCase().includes(pref)));
    if (hit) return hit;
  }
  return usable[0];
}

function niceName(s) {
  // "BIG MAC" -> "Big Mac", "McMUFFIN" -> "McMuffin"; drop lab notes and Subway's default toppings.
  const name = s
    .replace(/,?\s*analyzed \d{4}/i, '')
    .replace(/ on white bread.*$/i, '')
    .replace(/, meat and skin with breading/i, '')
    .replace(/\bMc([A-Z]{2,})\b/g, (_, w) => `Mc${w[0]}${w.slice(1).toLowerCase()}`)
    .replace(/\b([A-Z][A-Z'&-]{2,})\b/g, (w) => (w === 'KFC' ? w : w[0] + w.slice(1).toLowerCase()))
    .replace(/\s+/g, ' ')
    .trim();
  return name[0].toUpperCase() + name.slice(1);
}

function servingLabel(portion) {
  const text = portionText(portion)
    .replace(/\(?\d+(\.\d+)? ?oz\.?\)?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const label = /^\d/.test(text) ? text : `1 ${text || 'serving'}`;
  return `${label.replace(/^(\d+(\.\d+)?) inch sub/, '$1" sub')} (${Math.round(portion.gramWeight)} g)`;
}

function chainSection(name) {
  const n = name.toLowerCase();
  if (/mcmuffin|mcgriddle|biscuit|hotcake|breakfast|croissan|hash brown|burrito|french toast/.test(n) && !/burrito supreme|bean burrito/.test(n)) return 'Breakfast';
  if (/pizza|breadstick/.test(n)) return 'Pizza';
  if (/fries|onion ring|coleslaw|salad|mozzarella|rice|beans|mac/.test(n)) return 'Sides & salads';
  if (/sundae|mcflurry|cone|frosty|shake|parfait|ice cream/.test(n)) return 'Desserts & shakes';
  if (/chicken|nugget|strip|tender|wing|drumstick|thigh|breast/.test(n)) return 'Chicken';
  if (/sub\b|sandwich|burger|whopper|big mac|quarter pounder|filet|wrap|taco|burrito|nacho|quesadilla|enchilada|single|double|stack/.test(n)) return 'Mains';
  return 'Mains';
}

function buildChains(srFoods) {
  const menus = {};
  for (const food of srFoods) {
    const cat = food.foodCategory?.description;
    if (cat !== 'Fast Foods' && cat !== 'Restaurant Foods') continue;
    const chain = CHAINS.find(([, , re]) => re.test(food.description));
    if (!chain) continue;
    // Skip lab breakdowns that aren't things you order ("Skin and Breading", "meat only").
    if (/skin and breading|meat only|without .*sauce|without tartar|without mayonnaise|without granola|without chicken/i.test(food.description)) continue;
    const portion = pickPortion(food.foodPortions ?? []);
    if (!portion) continue;
    const [key, label, re] = chain;
    const name = niceName(food.description.replace(re, ''));
    const nutrients = scale(per100(food), portion.gramWeight);
    if (nutrients.calories == null) continue;
    menus[`chain:${key}`] ??= { name: label, kind: 'chain', source: 'USDA analysis of this chain’s food', items: [] };
    menus[`chain:${key}`].items.push({
      name,
      section: chainSection(name),
      serving: servingLabel(portion),
      nutrients,
    });
  }
  for (const m of Object.values(menus)) m.items.sort((a, b) => a.section.localeCompare(b.section) || a.name.localeCompare(b.name));
  return menus;
}

// ---------- typical cuisine menus (FNDDS) ----------

function buildTemplates(fnddsFoods) {
  const byName = new Map(fnddsFoods.map((f) => [f.description, f]));
  const menus = {};
  const missing = [];
  for (const [key, t] of Object.entries(TEMPLATES)) {
    const items = [];
    for (const [name, desc, portionMatch, servingLabel, count = 1] of t.dishes) {
      const food = byName.get(desc);
      if (!food) {
        missing.push(`${key}: ${desc}`);
        continue;
      }
      const portions = (food.foodPortions ?? []).filter((p) => p.gramWeight > 0);
      const portion =
        (portionMatch && portions.find((p) => p.portionDescription?.toLowerCase().includes(portionMatch.toLowerCase()))) ??
        portions.find((p) => /^1 (regular|small\/regular|sandwich|item|piece|cone|doughnut|serving)/i.test(p.portionDescription ?? '')) ??
        portions.find((p) => p.portionDescription === 'Quantity not specified') ??
        portions[0];
      if (!portion) {
        missing.push(`${key}: ${desc} (no portion)`);
        continue;
      }
      const grams = portion.gramWeight * count;
      const label = servingLabel ?? (portion.portionDescription === 'Quantity not specified' ? 'typical serving' : portion.portionDescription);
      items.push({ name, serving: `${label} (${Math.round(grams)} g)`, nutrients: scale(per100(food), grams) });
    }
    menus[`typical:${key}`] = { name: `Typical ${t.label}`, kind: 'typical', source: 'USDA averages for these dishes — not this restaurant’s own recipes', items };
  }
  if (missing.length) console.warn(`  ! ${missing.length} template dishes not found in FNDDS:\n    ${missing.join('\n    ')}`);
  return menus;
}

// ---------- places (OpenStreetMap) ----------

const norm = (s = '') => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
const CHAIN_MATCH = [
  ['mcdonalds', 'mcdonalds'], ['burgerking', 'burgerking'], ['wendys', 'wendys'], ['kfc', 'kfc'], ['kentuckyfriedchicken', 'kfc'],
  ['popeyes', 'popeyes'], ['subway', 'subway'], ['tacobell', 'tacobell'], ['chickfila', 'chickfila'], ['dennys', 'dennys'],
  ['applebees', 'applebees'], ['pizzahut', 'pizzahut'], ['dominos', 'dominos'], ['papajohns', 'papajohns'], ['littlecaesars', 'littlecaesars'],
  ['arbys', 'arbys'], ['crackerbarrel', 'crackerbarrel'], ['tgifridays', 'tgifridays'], ['tgifriday', 'tgifridays'], ['olivegarden', 'olivegarden'],
  ['carrabbas', 'carrabbas'], ['ontheborder', 'ontheborder'],
];

// Category used for the app's filter chips (chains get the category of their food).
const CHAIN_CATEGORY = {
  mcdonalds: 'burger', burgerking: 'burger', wendys: 'burger', kfc: 'chicken', popeyes: 'chicken', chickfila: 'chicken',
  subway: 'sandwich', arbys: 'sandwich', tacobell: 'mexican', ontheborder: 'mexican', pizzahut: 'pizza', dominos: 'pizza',
  papajohns: 'pizza', littlecaesars: 'pizza', dennys: 'breakfast', crackerbarrel: 'breakfast', applebees: 'american',
  tgifridays: 'american', olivegarden: 'italian', carrabbas: 'italian',
};

function haversineMiles(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const DEFAULT_TEMPLATE = { cafe: 'coffee', ice_cream: 'ice_cream', fast_food: 'burger', restaurant: 'american', food_court: 'american' };

function buildPlaces(elements, menus) {
  const places = [];
  for (const e of elements) {
    const t = e.tags ?? {};
    if (!t.name) continue;
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat == null) continue;
    const cuisines = (t.cuisine ?? '').split(';').map((c) => c.trim().toLowerCase()).filter(Boolean);
    const brandKey = norm(t.brand || t.name);
    const chain = CHAIN_MATCH.find(([prefix]) => brandKey.startsWith(prefix));
    // JHU's own dining locations also appear on the map - point them at the real JHU menus.
    const isJhuDining = /levering|nolan'?s on 33rd|hopkins caf[eé]|fresh food caf[eé]/i.test(t.name) && haversineMiles(CAMPUS, { lat, lon }) < 0.6;
    let menu = isJhuDining ? 'jhu' : chain && menus[`chain:${chain[1]}`] ? `chain:${chain[1]}` : null;
    if (!menu) {
      const tpl = cuisines.map((c) => CUISINE_TO_TEMPLATE[c]).find(Boolean) ?? DEFAULT_TEMPLATE[t.amenity] ?? 'american';
      menu = `typical:${tpl}`;
    }
    const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
    places.push({
      id: `${e.type[0]}${e.id}`,
      name: t.name,
      kind: t.amenity,
      cuisine: cuisines.map((c) => c.replace(/_/g, ' ')),
      brand: t.brand ?? null,
      lat: +lat.toFixed(5),
      lon: +lon.toFixed(5),
      dist: +haversineMiles(CAMPUS, { lat, lon }).toFixed(2),
      address: [street, t['addr:city']].filter(Boolean).join(', ') || null,
      hours: t.opening_hours ?? null,
      website: t.website ?? t['contact:website'] ?? null,
      phone: t.phone ?? t['contact:phone'] ?? null,
      menu,
      cat: menu === 'jhu' ? 'jhu' : menu.startsWith('chain:') ? CHAIN_CATEGORY[menu.slice(6)] : menu.slice(8),
    });
  }
  // OSM sometimes has the same place as a node and a building outline; keep the first.
  const seen = new Set();
  return places
    .sort((a, b) => a.dist - b.dist)
    .filter((p) => {
      const key = `${norm(p.name)}:${p.lat.toFixed(3)}:${p.lon.toFixed(3)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// ---------- main ----------

async function main() {
  console.log('Downloading USDA nutrition data…');
  const [srFoods, fnddsFoods] = await Promise.all([loadFdc(SR_ZIP), loadFdc(FNDDS_ZIP)]);
  const menus = { ...buildChains(srFoods), ...buildTemplates(fnddsFoods) };

  console.log('Downloading restaurants from OpenStreetMap…');
  const elements = await overpass(
    `[out:json][timeout:150];nwr["amenity"~"^(restaurant|fast_food|cafe|food_court|ice_cream)$"](around:${RADIUS_M},${CAMPUS.lat},${CAMPUS.lon});out center tags;`,
  );
  const places = buildPlaces(elements, menus);
  if (places.length < 500) throw new Error(`Only ${places.length} places found — refusing to overwrite the existing data.`);

  // Only ship menus some place uses.
  const used = new Set(places.map((p) => p.menu));
  const shipped = Object.fromEntries(Object.entries(menus).filter(([k]) => used.has(k)));

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'places.json'), JSON.stringify({ generatedAt: new Date().toISOString(), campus: CAMPUS, places }));
  fs.writeFileSync(path.join(OUT, 'menus.json'), JSON.stringify(shipped));
  const chains = places.filter((p) => p.menu.startsWith('chain:')).length;
  console.log(
    `Wrote ${places.length} places (${chains} with real chain menus) and ${Object.keys(shipped).length} menus ` +
      `(${Object.values(shipped).reduce((n, m) => n + m.items.length, 0)} dishes).`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
