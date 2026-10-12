// Barcodes: decode on-device (ZXing, WebAssembly) from a photo or live camera frames, then
// look the product up in free databases - Open Food Facts first, USDA FoodData Central as
// a fallback. Also keeps a history of recent scans.

import { cacheGet, cacheSet, getAllByIndex } from './store.js';
import { cleanNutrients, scaleNutrients } from './nutrients.js';
import { loadImage, toCanvas } from './image.js';

const ZXING_URL = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.5/dist/es/reader/index.js';
const FORMATS = ['EAN-13', 'UPC-A', 'UPC-E', 'EAN-8'];
const DAY = 86_400_000;
// The USDA's shared demo key works for light personal use (30 lookups/hour per device).
const FDC_API_KEY = 'DEMO_KEY';
// Bump when the stored product shape changes so old cached lookups are refetched.
const CACHE_PREFIX = 'barcode2:';

let zxing = null;
const loadZxing = async () => (zxing ??= await import(ZXING_URL));

/** Decode one camera frame (ImageData). Fast settings - the scanner calls this several times a second. */
export async function decodeFrame(imageData, { tryHarder = false } = {}) {
  await loadZxing();
  const results = await zxing.readBarcodes(imageData, { formats: FORMATS, tryHarder, maxNumberOfSymbols: 1 });
  return results.find((r) => r.isValid && /^\d{6,14}$/.test(r.text))?.text ?? null;
}

export async function decodeBarcode(dataUrl) {
  await loadZxing();
  const img = await loadImage(dataUrl);
  const original = toCanvas(img);
  const enhanced = toCanvas(img, { width: Math.max(1600, img.naturalWidth) });
  const ctx = enhanced.getContext('2d', { willReadFrequently: true });
  ctx.filter = 'grayscale(1) contrast(1.6)';
  ctx.drawImage(enhanced, 0, 0);
  for (const canvas of [original, enhanced]) {
    const imageData = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    const results = await zxing.readBarcodes(imageData, { formats: FORMATS, tryHarder: true, maxNumberOfSymbols: 1 });
    const hit = results.find((r) => r.isValid && /^\d{6,14}$/.test(r.text));
    if (hit) return hit.text;
  }
  return null;
}

/** UPC-A (12) and EAN-13 are the same code with/without a leading 0. */
function variants(code) {
  const digits = code.replace(/\D/g, '');
  const bare = digits.replace(/^0+/, '');
  return [...new Set([digits, bare.padStart(13, '0'), bare.padStart(12, '0')])];
}

// ---------- Open Food Facts ----------

const OFF_MAP = {
  calories: ['energy-kcal', 1],
  g_protein: ['proteins', 1],
  g_carbs: ['carbohydrates', 1],
  g_fat: ['fat', 1],
  g_fiber: ['fiber', 1],
  g_sugar: ['sugars', 1],
  g_added_sugar: ['added-sugars', 1],
  g_saturated_fat: ['saturated-fat', 1],
  g_trans_fat: ['trans-fat', 1],
  // OFF stores minerals/vitamins in grams.
  mg_cholesterol: ['cholesterol', 1e3],
  mg_sodium: ['sodium', 1e3],
  mg_potassium: ['potassium', 1e3],
  mg_calcium: ['calcium', 1e3],
  mg_iron: ['iron', 1e3],
  mg_vitamin_c: ['vitamin-c', 1e3],
  mcg_vitamin_a: ['vitamin-a', 1e6],
  mcg_vitamin_d: ['vitamin-d', 1e6],
};

function offNutrients(n, suffix) {
  const out = {};
  for (const [key, [field, mult]] of Object.entries(OFF_MAP)) {
    const v = n[field + suffix];
    if (v != null && v !== '' && Number.isFinite(+v)) out[key] = +v * mult;
  }
  if (out.calories == null) {
    const kj = n[`energy-kj${suffix}`] ?? n[`energy${suffix}`];
    if (kj != null && Number.isFinite(+kj)) out.calories = +kj / 4.184;
  }
  return out.calories == null ? null : cleanNutrients(out);
}

const tagNames = (tags = []) => [...new Set(tags.map((t) => t.replace(/^\w\w:/, '').replace(/-/g, ' ').toLowerCase()))].filter(Boolean);

function fromOpenFoodFacts(p) {
  const n = p.nutriments ?? {};
  const per100 = offNutrients(n, '_100g');
  const servingGrams = +p.serving_quantity > 0 ? +p.serving_quantity : null;
  const perServing = offNutrients(n, '_serving') ?? (per100 && servingGrams ? scaleNutrients(per100, servingGrams / 100) : null);
  if (!per100 && !perServing) return null;
  const analysis = p.ingredients_analysis_tags ?? [];
  const has = (tag) => analysis.includes(`en:${tag}`);
  const unit = /\d\s*(ml|cl|l)\b/i.test(p.serving_size || p.quantity || '') ? 'ml' : 'g';
  return {
    name: p.product_name?.trim() || 'Unnamed product',
    brand: p.brands?.split(',')[0]?.trim() || null,
    serving: perServing ? p.serving_size || `${servingGrams} ${unit}` : `100 ${unit}`,
    servingGrams: perServing ? servingGrams : 100,
    packageGrams: +p.product_quantity > 0 ? +p.product_quantity : null,
    unit,
    nutrients: perServing ?? per100,
    per100,
    image: p.image_front_small_url ?? null,
    database: 'Open Food Facts',
    nutriscore: /^[a-e]$/.test(p.nutriscore_grade ?? '') ? p.nutriscore_grade : null,
    nova: [1, 2, 3, 4].includes(+p.nova_group) ? +p.nova_group : null,
    ingredients: (p.ingredients_text_en || p.ingredients_text || '').trim().slice(0, 1200) || null,
    allergens: tagNames(p.allergens_tags),
    diet: {
      vegan: has('vegan') ? true : has('non-vegan') ? false : null,
      vegetarian: has('vegetarian') ? true : has('non-vegetarian') ? false : null,
      palmOil: has('palm-oil') ? true : has('palm-oil-free') ? false : null,
    },
  };
}

async function openFoodFacts(code) {
  for (const c of variants(code)) {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${c}.json?fields=product_name,brands,quantity,product_quantity,serving_size,serving_quantity,serving_quantity_unit,nutriments,image_front_small_url,nutriscore_grade,nova_group,ingredients_text,ingredients_text_en,allergens_tags,ingredients_analysis_tags`,
      { signal: AbortSignal.timeout(12_000) },
    );
    if (!res.ok) continue;
    const data = await res.json();
    if (data.status === 1 && data.product) {
      const product = fromOpenFoodFacts(data.product);
      if (product) return product;
    }
  }
  return null;
}

// ---------- USDA FoodData Central (branded foods) ----------

const FDC_MAP = {
  208: ['calories', 1],
  203: ['g_protein', 1],
  205: ['g_carbs', 1],
  204: ['g_fat', 1],
  291: ['g_fiber', 1],
  269: ['g_sugar', 1],
  539: ['g_added_sugar', 1],
  606: ['g_saturated_fat', 1],
  605: ['g_trans_fat', 1],
  601: ['mg_cholesterol', 1],
  307: ['mg_sodium', 1],
  306: ['mg_potassium', 1],
  301: ['mg_calcium', 1],
  303: ['mg_iron', 1],
  401: ['mg_vitamin_c', 1],
  320: ['mcg_vitamin_a', 1],
  318: ['mcg_vitamin_a', 0.3], // IU -> mcg RAE (approx.)
  328: ['mcg_vitamin_d', 1],
  324: ['mcg_vitamin_d', 1 / 40], // IU -> mcg
};

async function usda(code) {
  const key = FDC_API_KEY;
  const bare = code.replace(/^0+/, '');
  const res = await fetch(
    `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${key}&dataType=Branded&pageSize=5&query=${bare.padStart(14, '0')}`,
    { signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) return null;
  const food = (await res.json()).foods?.find((f) => (f.gtinUpc ?? '').replace(/^0+/, '') === bare);
  if (!food) return null;
  // Branded nutrient values are per 100 g/ml; scale to the label serving.
  const unitCode = (food.servingSizeUnit ?? '').toLowerCase();
  const unit = unitCode.startsWith('m') ? 'ml' : 'g';
  const servingGrams = food.servingSize && /^(g|grm|ml|mlt)$/.test(unitCode) ? +food.servingSize : null;
  const out = {};
  for (const n of food.foodNutrients ?? []) {
    const map = FDC_MAP[n.nutrientNumber];
    if (map && out[map[0]] == null && n.value != null) out[map[0]] = n.value * map[1];
  }
  if (out.calories == null) return null;
  const per100 = cleanNutrients(out);
  const brand = food.brandName || food.brandOwner;
  // "packageWeight": e.g. "16 oz/454 g"
  const pkg = /(\d+(?:\.\d+)?)\s*(g|ml)\b/i.exec(food.packageWeight ?? '');
  return {
    name: titleCase(food.description),
    brand: brand ? titleCase(brand) : null,
    serving: servingGrams ? food.householdServingFullText || `${servingGrams} ${unit}` : `100 ${unit}`,
    servingGrams: servingGrams ?? 100,
    packageGrams: pkg ? +pkg[1] : null,
    unit,
    nutrients: servingGrams ? scaleNutrients(per100, servingGrams / 100) : per100,
    per100,
    image: null,
    database: 'USDA FoodData Central',
    nutriscore: null,
    nova: null,
    ingredients: food.ingredients ? food.ingredients.slice(0, 1200) : null,
    allergens: [],
    diet: {},
  };
}

/** "Greek Yogurt — Chobani", unless the name already says the brand. */
export function withBrand(name, brand) {
  if (!brand || name?.toLowerCase().includes(brand.toLowerCase())) return name;
  return [name, brand].filter(Boolean).join(' — ');
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Look up a barcode: your saved foods first, then the cache, then the public databases. */
export async function lookupBarcode(code) {
  const digits = code.replace(/\D/g, '');
  if (!/^\d{6,14}$/.test(digits) || digits.replace(/^0+/, '').length < 6) return null;
  for (const v of variants(digits)) {
    const [saved] = (await getAllByIndex('foods', 'barcode', v)).slice(-1);
    if (saved) {
      // Your own numbers win, but keep the database's extras (picture, ingredients, Nutri-Score).
      const extra = (await cacheGet(`${CACHE_PREFIX}${digits.replace(/^0+/, '')}`))?.data ?? {};
      return { ...extra, name: saved.name, brand: null, serving: saved.serving_desc, servingGrams: null, per100: null, nutrients: saved.nutrients, database: 'My foods', savedId: saved.id };
    }
  }

  const cacheKey = `${CACHE_PREFIX}${digits.replace(/^0+/, '')}`;
  const hit = await cacheGet(cacheKey);
  if (hit && (hit.data || Date.now() - hit.at < DAY)) return hit.data;

  let product = null;
  try {
    product = (await openFoodFacts(digits)) ?? (await usda(digits));
  } catch (err) {
    if (hit) return hit.data;
    throw new Error('Couldn’t reach the food databases. Check your internet connection.', { cause: err });
  }
  await cacheSet(cacheKey, product);
  return product;
}

// ---------- scan history ----------

const HISTORY_KEY = 'barcode-history';
const HISTORY_MAX = 40;

/** Recent scans, newest first: [{ code, name, brand, image, calories, serving, at }]. */
export async function scanHistory() {
  return (await cacheGet(HISTORY_KEY))?.data ?? [];
}

// UPC-A "016000275287" and EAN-13 "0016000275287" are the same product.
const sameCode = (a, b) => a.replace(/^0+/, '') === b.replace(/^0+/, '');

export async function recordScan(code, product) {
  const list = (await scanHistory()).filter((x) => !sameCode(x.code, code));
  list.unshift({
    code,
    name: product?.name ?? null,
    brand: product?.brand ?? null,
    image: product?.image ?? null,
    calories: product?.nutrients?.calories ?? null,
    serving: product?.serving ?? null,
    at: Date.now(),
  });
  await cacheSet(HISTORY_KEY, list.slice(0, HISTORY_MAX));
}

export async function forgetScan(code) {
  await cacheSet(HISTORY_KEY, (await scanHistory()).filter((x) => !sameCode(x.code, code)));
}
